import type { Analysis } from './bedrock'
import type { Env } from './env'

/**
 * Firebase Realtime Database over its REST API.
 * (The Firebase Admin SDK needs Node APIs that Workers don't have, so we sign a
 * Google OAuth token ourselves with WebCrypto and call https://<db>/<path>.json.)
 *
 * Data layout:
 *   /streets/{streetId}      { name, barangayId, switchId, lat, lng }        (seed once)
 *   /reports/{reportId}      dashboard-ready report, ts = server timestamp
 *   /botSessions/{psid}      photo waiting for a location (15 min)
 *   /imageHashes/{sha256}    server timestamp of the last report with that photo (24 h dedupe)
 */

export interface Street { id: string; name: string; barangayId: string; switchId?: string; lat: number; lng: number }
export interface Session { photoUrl: string; imageHash: string; note: string; analysis: Analysis; duplicate: boolean; createdAt: number }
export interface Report {
  id: string; barangayId: string; streetId: string; source: 'messenger'
  photoUrl: string; note: string; estimatedCm: number; depthLevel: Analysis['depth_level']
  confidence: number; duplicate: boolean; liveWireRisk: boolean; analysis: Analysis; imageHash: string
}

const SESSION_TTL_MS = 15 * 60_000
const DUPLICATE_WINDOW_MS = 24 * 60 * 60_000
const SERVER_TIMESTAMP = { '.sv': 'timestamp' }

// ---------- auth ----------

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }
let cachedToken: { value: string; expires: number } | null = null // lives as long as the Worker isolate

const b64url = (data: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function accessToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value

  let sa: ServiceAccount
  try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT!) } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole service-account .json file as the secret.') }
  if (!sa.client_email || !sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT is missing client_email or private_key')

  const pem = sa.private_key.replace(/\\n/g, '\n').replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])

  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token'
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: tokenUri, iat: now, exp: now + 3600,
  }))}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  })
  if (!res.ok) throw new Error(`Google OAuth → ${res.status} ${await res.text()}`)
  const j = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 }
  return j.access_token
}

// ---------- REST ----------

async function rtdb<T>(env: Env, path: string, method: 'GET' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  if (!env.FIREBASE_DATABASE_URL) throw new Error('FIREBASE_DATABASE_URL is not set in wrangler.toml')
  const url = new URL(`${env.FIREBASE_DATABASE_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}.json`)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.FIREBASE_SERVICE_ACCOUNT) headers.Authorization = `Bearer ${await accessToken(env)}`
  else if (env.FIREBASE_DB_SECRET) url.searchParams.set('auth', env.FIREBASE_DB_SECRET) // legacy database secret
  else throw new Error('Set FIREBASE_SERVICE_ACCOUNT (recommended) or FIREBASE_DB_SECRET')

  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error(`Firebase ${method} /${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

// ---------- data ----------

export async function listStreets(env: Env): Promise<Street[]> {
  const obj = await rtdb<Record<string, Omit<Street, 'id'>> | null>(env, 'streets', 'GET')
  if (!obj) console.warn('No streets in Firebase. Import firebase-seed/streets.json at /streets (see README).')
  return Object.entries(obj ?? {}).map(([id, s]) => ({ id, ...s, lat: Number(s.lat), lng: Number(s.lng) }))
}

/** Same photo already reported in the last 24 h? */
export async function isDuplicate(env: Env, hash: string): Promise<boolean> {
  const ts = await rtdb<number | null>(env, `imageHashes/${hash}`, 'GET')
  return typeof ts === 'number' && Date.now() - ts < DUPLICATE_WINDOW_MS
}

export async function getSession(env: Env, psid: string): Promise<Session | null> {
  const s = await rtdb<Session | null>(env, `botSessions/${psid}`, 'GET')
  return s && Date.now() - s.createdAt < SESSION_TTL_MS ? s : null
}

export const saveSession = (env: Env, psid: string, s: Omit<Session, 'createdAt'>) =>
  rtdb(env, `botSessions/${psid}`, 'PUT', { ...s, createdAt: Date.now() })

/** Saves the report, marks the photo hash as seen and clears the session, in one atomic multi-path update. */
export async function saveReport(env: Env, psid: string, r: Omit<Report, 'id'>): Promise<string> {
  const id = crypto.randomUUID()
  await rtdb(env, '', 'PATCH', {
    [`reports/${id}`]: { id, ...r, ts: SERVER_TIMESTAMP },
    [`imageHashes/${r.imageHash}`]: SERVER_TIMESTAMP,
    [`botSessions/${psid}`]: null,
  })
  return id
}
