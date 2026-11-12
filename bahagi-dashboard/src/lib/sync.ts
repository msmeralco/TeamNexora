/**
 * BAHAGI live data layer: every screen of the dashboard reads from here, and every change is pushed
 * to all open dashboards the moment it lands in the database (no polling).
 *
 * Firebase Realtime Database layout
 *   /regions/{regionId}                 Region tree (cities > barangays > streets > poles), keyed by id or as arrays
 *   /reports/{id}                       Report — resident reports from Messenger / Viber / SMS / web. photoPath → Supabase Storage
 *   /archive/reports/{id}               reports cleared after a street was cut (written by the backend bridge)
 *   /recommendations/{id}               Recommendation (PASYA)
 *   /power/{streetId}                   { off: true, since, switchId }  — present = street has no power
 *   /sensors/{poleId}                   { level_cm | levelCm | distance_cm, ts, online }  — written by the pole box
 *   /alerts/{active|recent}/{id}, /alerts/box   AlertFeed
 *   /commands/{pushId}                  { type: approve|reject|restore, ..., status: queued → running → done|error, smsSent, smsFailed, error }
 *   /status/worker                      { lastSeen } heartbeat from the backend bridge
 *   /dispatchers/{uid}: true            browsers allowed to approve / restore
 *   /devices/{uid}: true                pole boxes allowed to write /sensors
 *
 * Supabase Storage: bucket VITE_SUPABASE_BUCKET (default "report-photos"), objects under reports/YYYY/MM/{reportId}.jpg
 *
 * The browser never switches anything itself: it records the decision and queues a command; the backend bridge
 * publishes the switch command, sends the SMS, then writes the power state back here for every dashboard to see.
 */
import {
  equalTo, get, limitToLast, onValue, orderByChild, push, query, ref, runTransaction, serverTimestamp, set, update,
  type DataSnapshot,
} from 'firebase/database'
import { config } from '../config'
import type { AlertFeed, Alert, Pole, Recommendation, Region, Report, SensorReading } from '../types'
import { db, signIn } from './firebase'
import { mockRecs, mockRegions, mockReports } from './mockData'
import { photoUrls, removeReportPhoto, uploadReportPhoto } from './supabase'
import { streetsIn } from './tree'

export type Unsub = () => void
/** What the backend reports after an action. pending = the bridge has not answered yet; the screen updates by itself when it does. */
export interface SmsResult { smsSent: number; smsFailed?: number; pending?: boolean }
export interface NewReport { photo?: Blob; note: string; barangayId: string; streetId?: string; estimatedCm?: number; liveWireRisk?: boolean }

const MAX_REPORTS = 500

// ---------- helpers ----------

/** RTDB stores lists as objects keyed by id (or as index-keyed arrays). Both come back as T[] with id filled in. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function list<T>(v: any): T[] {
  if (!v) return []
  if (Array.isArray(v)) return v.filter((x) => x != null)
  return Object.entries(v).filter(([, x]) => x != null && typeof x === 'object').map(([id, x]) => ({ id, ...(x as object) }) as T)
}

/** Plain value lists (e.g. evidence lines): array or index-keyed object. */
const values = (v: unknown): string[] => (Array.isArray(v) ? v : Object.values(v ?? {})).filter((x): x is string => typeof x === 'string')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRegions(v: any): Region[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return list<any>(v).map((r) => ({
    ...r,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cities: list<any>(r.cities).map((c) => ({
      ...c,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      barangays: list<any>(c.barangays).map((b) => ({
        ...b,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        streets: list<any>(b.streets).map((s) => ({ ...s, poles: list<Pole>(s.poles) })),
      })),
    })),
  }))
}

// browser clock vs Firebase server clock, so "last seen 5 s ago" is right even if the laptop clock is off
let serverOffset = 0
let offsetWatch: Unsub | null = null
function watchOffset() {
  if (!offsetWatch) offsetWatch = onValue(ref(db(), '.info/serverTimeOffset'), (s) => { serverOffset = Number(s.val()) || 0 })
}
const local = (serverTs: unknown) => (typeof serverTs === 'number' ? serverTs - serverOffset : Date.now())

/** Subscribe after sign-in; returns an unsubscribe that also works if sign-in has not finished yet. */
function live(path: string | ReturnType<typeof query>, onSnap: (s: DataSnapshot) => void, onError?: (e: Error) => void): Unsub {
  let off: Unsub | null = null
  let dead = false
  signIn()
    .then(() => {
      if (dead) return
      watchOffset()
      const r = typeof path === 'string' ? ref(db(), path) : path
      off = onValue(r, onSnap, (e) => onError?.(new Error(e.message.includes('permission') ? `${e.message}. Check the database rules.` : e.message)))
    })
    .catch((e: Error) => onError?.(e))
  return () => { dead = true; off?.() }
}

const SEV: Record<Alert['severity'], number> = { critical: 0, warning: 1, info: 2 }

async function permission<T>(p: Promise<T>): Promise<T> {
  try { return await p } catch (e) {
    const msg = (e as Error).message ?? ''
    if (/permission/i.test(msg)) {
      const u = await signIn()
      throw new Error(`this browser is not an approved dispatcher. In Firebase, add  dispatchers/${u.uid}: true  then try again`)
    }
    throw e
  }
}

function waitForCommand(key: string): Promise<SmsResult> {
  return new Promise((resolve, reject) => {
    let off: Unsub = () => {}
    const t = setTimeout(() => { off(); resolve({ smsSent: 0, pending: true }) }, config.commandTimeoutMs)
    off = onValue(ref(db(), `commands/${key}`), (s) => {
      const c = s.val()
      if (c?.status === 'done') { clearTimeout(t); off(); resolve({ smsSent: c.smsSent ?? 0, smsFailed: c.smsFailed || undefined }) }
      if (c?.status === 'error') { clearTimeout(t); off(); reject(new Error(c.error ?? 'the backend could not carry it out')) }
    })
  })
}

async function queue(cmd: Record<string, unknown>): Promise<string> {
  const u = await signIn()
  const r = push(ref(db(), 'commands'))
  await permission(set(r, { ...cmd, by: u.uid, status: 'queued', ts: serverTimestamp() }))
  return r.key!
}

// ---------- mock mode: same interface, in memory, so the UI code has a single path ----------

const mem = {
  regions: mockRegions,
  reports: mockReports,
  recs: mockRecs,
  power: Object.fromEntries(streetsIn(mockRegions, { type: 'all' }).filter((s) => s.powerOff).map((s) => [s.id, Date.now()])) as Record<string, number>,
}
type MemKey = keyof typeof mem
const memSubs: { [K in MemKey]: Set<(v: (typeof mem)[K]) => void> } = { regions: new Set(), reports: new Set(), recs: new Set(), power: new Set() }
function memOn<K extends MemKey>(k: K, cb: (v: (typeof mem)[K]) => void): Unsub {
  memSubs[k].add(cb); cb(mem[k])
  return () => memSubs[k].delete(cb)
}
function memSet<K extends MemKey>(k: K, v: (typeof mem)[K]) { mem[k] = v; memSubs[k].forEach((cb) => cb(v)) }

// ---------- public API ----------

export const sync = {
  regions(cb: (r: Region[]) => void, onError?: (e: Error) => void): Unsub {
    if (config.useMock) return memOn('regions', cb)
    return live('regions', (s) => cb(toRegions(s.val())), onError)
  },

  /** Newest first, photos resolved from Supabase. */
  reports(cb: (r: Report[]) => void, onError?: (e: Error) => void): Unsub {
    if (config.useMock) return memOn('reports', cb)
    let seq = 0
    const onSnap = async (s: DataSnapshot) => {
      const mine = ++seq
      const rows = list<Report>(s.val()).map((r) => ({ ...r, ts: local(r.ts) })).sort((a, b) => b.ts - a.ts)
      const paths = rows.filter((r) => r.photoPath && !r.photoUrl).map((r) => r.photoPath!)
      let urls: Record<string, string> = {}
      if (paths.length) {
        try { urls = await photoUrls(paths) } catch (e) { onError?.(e as Error) }
      }
      if (mine !== seq) return // a newer snapshot arrived while we were signing URLs
      cb(rows.map((r) => (r.photoPath && !r.photoUrl && urls[r.photoPath] ? { ...r, photoUrl: urls[r.photoPath] } : r)))
    }
    try {
      return live(query(ref(db(), 'reports'), orderByChild('ts'), limitToLast(MAX_REPORTS)), onSnap, onError)
    } catch (e) { onError?.(e as Error); return () => {} }
  },

  recommendations(cb: (r: Recommendation[]) => void, onError?: (e: Error) => void): Unsub {
    if (config.useMock) return memOn('recs', cb)
    return live('recommendations', (s) => cb(list<Recommendation>(s.val()).map((r) => ({ ...r, evidence: values(r.evidence) }))), onError)
  },

  /** streetId → when it was cut (local ms). */
  power(cb: (o: Record<string, number>) => void, onError?: (e: Error) => void): Unsub {
    if (config.useMock) return memOn('power', cb)
    return live('power', (s) => {
      const v = (s.val() ?? {}) as Record<string, { off?: boolean; since?: number } | boolean>
      cb(Object.fromEntries(
        Object.entries(v)
          .filter(([, p]) => p === true || (typeof p === 'object' && p && p.off !== false))
          .map(([id, p]) => [id, typeof p === 'object' ? local(p.since) : Date.now()]),
      ))
    }, onError)
  },

  alerts(cb: (f: AlertFeed) => void, onError?: (e: Error) => void): Unsub {
    if (config.useMock) { cb({ active: [], recent: [], box: null }); return () => {} }
    return live('alerts', (s) => {
      const v = s.val() ?? {}
      const fix = (a: Alert) => ({ ...a, ts: local(a.ts) })
      cb({
        active: list<Alert>(v.active).map(fix).sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.ts - a.ts),
        recent: list<Alert>(v.recent).map(fix).sort((a, b) => b.ts - a.ts),
        box: v.box ?? null,
      })
    }, onError)
  },

  /** Latest reading per pole, as the pole box wrote it to /sensors. */
  sensors(cb: (r: (SensorReading & { online: boolean })[]) => void, onError?: (e: Error) => void): Unsub {
    return live('sensors', (s) => {
      const v = (s.val() ?? {}) as Record<string, { level_cm?: number; levelCm?: number; distance_cm?: number; ts?: number; online?: boolean }>
      cb(Object.entries(v).flatMap(([poleId, p]) => {
        const cm = p.levelCm ?? p.level_cm ?? (p.distance_cm != null ? config.sensorHeightCm - p.distance_cm : NaN)
        return Number.isFinite(cm) ? [{ poleId, levelCm: Math.max(0, cm), ts: local(p.ts), online: p.online !== false }] : []
      }))
    }, onError)
  },

  /** true/false = connected to Firebase or not. Stays quiet for the first few seconds so the page does not flash "offline" while it starts. */
  connection(cb: (online: boolean) => void): Unsub {
    if (config.useMock) { cb(true); return () => {} }
    let ever = false
    const t = setTimeout(() => !ever && cb(false), 8000)
    const off = live('.info/connected', (s) => {
      if (s.val() === true) { ever = true; cb(true) } else if (ever) cb(false)
    }, () => cb(false))
    return () => { clearTimeout(t); off() }
  },

  /** Last heartbeat of the backend bridge (local ms), or null if it has never connected. */
  worker(cb: (lastSeen: number | null) => void): Unsub {
    if (config.useMock) { cb(Date.now()); return () => {} }
    return live('status/worker', (s) => cb(s.val()?.lastSeen ? local(s.val().lastSeen) : null))
  },

  /**
   * Approve or reject a recommendation. Only one dispatcher can decide it: the status flips pending → approved|rejected
   * in a transaction, so a second dispatcher clicking at the same time gets "already approved".
   */
  async decide(rec: Recommendation, decision: 'approve' | 'reject'): Promise<SmsResult> {
    const next = decision === 'approve' ? 'approved' : 'rejected'
    if (config.useMock) {
      memSet('recs', mem.recs.map((r) => (r.id === rec.id ? { ...r, status: next } : r)))
      if (decision === 'approve' && rec.action === 'open') {
        memSet('power', { ...mem.power, [rec.streetId]: Date.now() })
        memSet('reports', mem.reports.filter((r) => r.streetId !== rec.streetId))
      }
      if (decision === 'approve' && rec.action === 'close') { const p = { ...mem.power }; delete p[rec.streetId]; memSet('power', p) }
      return { smsSent: decision === 'approve' ? 12 : 0 }
    }
    const u = await signIn()
    const res = await permission(runTransaction(ref(db(), `recommendations/${rec.id}/status`), (cur) =>
      cur === null ? null : cur === 'pending' ? next : undefined))
    const now = res.snapshot.val()
    if (!res.committed || now !== next)
      throw new Error(now ? `it was already ${now} by another dispatcher` : 'this recommendation no longer exists')
    await update(ref(db(), `recommendations/${rec.id}`), { decidedBy: u.uid, decidedAt: serverTimestamp() }).catch(() => {})
    const key = await queue({ type: decision, recId: rec.id, streetId: rec.streetId, switchId: rec.switchId, action: rec.action })
    return decision === 'approve' ? waitForCommand(key) : { smsSent: 0 }
  },

  /** Dispatcher restores power on a street. The bridge closes the switch, sends "power restored", and clears /power/{street}. */
  async restore(streetId: string): Promise<SmsResult> {
    if (config.useMock) { const p = { ...mem.power }; delete p[streetId]; memSet('power', p); return { smsSent: 12 } }
    return waitForCommand(await queue({ type: 'restore', streetId }))
  },

  /** A report sent from a web form: photo → Supabase Storage, report → Firebase /reports. Every dashboard sees it at once. */
  async submitReport(r: NewReport): Promise<string> {
    if (config.useMock) {
      const id = `web-${Date.now()}`
      const photoUrl = r.photo ? URL.createObjectURL(r.photo) : undefined
      memSet('reports', [{ id, source: 'web', note: r.note, barangayId: r.barangayId, streetId: r.streetId, estimatedCm: r.estimatedCm ?? 0, confidence: 0, liveWireRisk: r.liveWireRisk, photoUrl, ts: Date.now() }, ...mem.reports])
      return id
    }
    await signIn()
    const node = push(ref(db(), 'reports'))
    const id = node.key!
    const photoPath = r.photo ? await uploadReportPhoto(r.photo, id) : undefined
    const row = {
      source: 'web', note: r.note, barangayId: r.barangayId, estimatedCm: r.estimatedCm ?? 0, confidence: 0, ts: serverTimestamp(),
      ...(r.streetId ? { streetId: r.streetId } : {}),
      ...(photoPath ? { photoPath } : {}),
      ...(r.liveWireRisk ? { liveWireRisk: true } : {}),
    }
    try { await set(node, row) } catch (e) { if (photoPath) await removeReportPhoto(photoPath); throw e }
    return id
  },

  /** One-off read of a street's reports (e.g. to show what will be cleared before approving a cut). */
  async reportsForStreet(streetId: string): Promise<Report[]> {
    if (config.useMock) return mem.reports.filter((r) => r.streetId === streetId)
    await signIn()
    const s = await get(query(ref(db(), 'reports'), orderByChild('streetId'), equalTo(streetId)))
    return list<Report>(s.val())
  },
}
