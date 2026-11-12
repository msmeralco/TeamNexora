import type { Env } from './env'

/**
 * Supabase Storage (images only — all other data lives in Firebase).
 * Works with both key styles:
 *   - new secret key  "sb_secret_..."  → sent on the apikey header only (it is not a JWT)
 *   - legacy service_role JWT "eyJ..." → sent on apikey + Authorization: Bearer
 */
export async function uploadPhoto(env: Env, path: string, bytes: ArrayBuffer, contentType: string): Promise<string> {
  const base = env.SUPABASE_URL.replace(/\/+$/, '')
  const bucket = env.SUPABASE_BUCKET || 'flood-photos'
  const key = env.SUPABASE_SERVICE_KEY
  const headers: Record<string, string> = { apikey: key, 'Content-Type': contentType, 'x-upsert': 'true' }
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`

  const res = await fetch(`${base}/storage/v1/object/${bucket}/${path}`, { method: 'POST', headers, body: bytes })
  if (!res.ok) throw new Error(`Supabase upload → ${res.status} ${await res.text()}`)
  return `${base}/storage/v1/object/public/${bucket}/${path}`
}
