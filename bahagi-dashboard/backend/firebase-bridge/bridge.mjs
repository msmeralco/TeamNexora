/**
 * BAHAGI Firebase bridge — runs on the laptop next to the BAHAGI backend (START_BAHAGI.bat).
 *
 *  1. Commands: the dashboard queues approve / reject / restore in /commands. The bridge calls the backend's
 *     existing endpoints (which publish the switch command to IoT Core and send the SMS), then writes the
 *     result and the new power state back to Firebase. Every open dashboard updates from that write.
 *  2. Heartbeat: /status/worker every 10 s, so the dashboard can warn when nothing is executing approvals.
 *  3. Mirror (optional, MIRROR=...): copies the backend's live sensors / alerts / recommendations / street power
 *     into Firebase every 2 s, only when they change. Use it while the pole box still posts to the laptop.
 *
 * Reports are NOT mirrored: they live in Firebase (/reports) with photos in Supabase. Save them with report-store.ts.
 *
 *   npm install
 *   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json FIREBASE_DATABASE_URL=https://<db>.firebaseio.com npm start
 */
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app'
import { getDatabase, ServerValue } from 'firebase-admin/database'
import { readFileSync } from 'node:fs'

const DB_URL = process.env.FIREBASE_DATABASE_URL
const BACKEND = (process.env.BACKEND_URL ?? 'http://localhost:8000/api').replace(/\/$/, '')
const MIRROR = new Set((process.env.MIRROR ?? 'sensors,alerts,recommendations,power').split(',').map((s) => s.trim()).filter(Boolean))
const KEY = process.env.FIREBASE_SERVICE_ACCOUNT // path to the JSON key; or use GOOGLE_APPLICATION_CREDENTIALS
const EMULATOR = !!process.env.FIREBASE_DATABASE_EMULATOR_HOST

if (!DB_URL) { console.error('Set FIREBASE_DATABASE_URL'); process.exit(1) }
initializeApp({
  credential: EMULATOR ? undefined : KEY ? cert(JSON.parse(readFileSync(KEY, 'utf8'))) : applicationDefault(),
  databaseURL: DB_URL,
  ...(EMULATOR ? { projectId: process.env.GCLOUD_PROJECT ?? 'demo-bahagi' } : {}),
})
const db = getDatabase()
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a)

async function backend(path, method = 'GET') {
  const res = await fetch(BACKEND + path, { method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  return res.json()
}

// ---------- 1. commands ----------

async function archiveReports(streetId, updates) {
  const snap = await db.ref('reports').orderByChild('streetId').equalTo(streetId).get()
  snap.forEach((r) => {
    updates[`reports/${r.key}`] = null
    updates[`archive/reports/${r.key}`] = { ...r.val(), archivedAt: ServerValue.TIMESTAMP }
  })
}

async function run(key, c) {
  if (c.type === 'reject') return backend(`/recommendations/${c.recId}/reject`, 'POST').then(() => ({}))
  if (c.type === 'approve') return backend(`/recommendations/${c.recId}/approve`, 'POST')
  if (c.type === 'restore') return backend(`/streets/${c.streetId}/restore`, 'POST')
  throw new Error(`unknown command type ${c.type}`)
}

async function handle(key) {
  const cref = db.ref(`commands/${key}`)
  // claim it, so two bridges (or a restart) never run the same command twice
  const claim = await cref.transaction((c) => (c && c.status === 'queued' ? { ...c, status: 'running', startedAt: Date.now() } : undefined))
  if (!claim.committed) return
  const c = claim.snapshot.val()
  log(`▶ ${c.type} ${c.switchId ?? ''} ${c.streetId ?? ''}`)
  try {
    const res = (await run(key, c)) ?? {}
    const updates = {
      [`commands/${key}/status`]: 'done',
      [`commands/${key}/smsSent`]: res.smsSent ?? 0,
      [`commands/${key}/smsFailed`]: res.smsFailed ?? 0,
      [`commands/${key}/doneAt`]: ServerValue.TIMESTAMP,
    }
    if (c.type === 'approve' && c.action === 'open') {
      updates[`power/${c.streetId}`] = { off: true, since: ServerValue.TIMESTAMP, switchId: c.switchId ?? null }
      await archiveReports(c.streetId, updates)
    }
    if ((c.type === 'approve' && c.action === 'close') || c.type === 'restore') updates[`power/${c.streetId}`] = null
    await db.ref().update(updates)
    log(`✔ ${c.type} done, SMS ${res.smsSent ?? 0}`)
  } catch (e) {
    log(`✖ ${c.type} failed: ${e.message}`)
    const updates = { [`commands/${key}/status`]: 'error', [`commands/${key}/error`]: String(e.message).slice(0, 300), [`commands/${key}/doneAt`]: ServerValue.TIMESTAMP }
    // nothing was switched: put the recommendation back so a dispatcher can try again
    if (c.type === 'approve') updates[`recommendations/${c.recId}/status`] = 'pending'
    await db.ref().update(updates)
  }
}

db.ref('commands').orderByChild('status').equalTo('queued').on('child_added', (s) => {
  handle(s.key).catch((e) => log('command error', e.message))
})

// ---------- 2. heartbeat ----------

const beat = () => db.ref('status/worker').set({ lastSeen: ServerValue.TIMESTAMP, backend: BACKEND, mirror: [...MIRROR] }).catch(() => {})
beat()
setInterval(beat, 10_000)
db.ref('status/worker').onDisconnect().update({ disconnectedAt: ServerValue.TIMESTAMP })

// ---------- 3. mirror ----------

const last = {}
async function put(path, value) {
  const j = JSON.stringify(value)
  if (last[path] === j) return
  last[path] = j
  await db.ref(path).set(value)
}
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]))

async function mirror() {
  if (MIRROR.has('sensors')) {
    const rows = await backend('/sensors')
    await put('sensors', Object.fromEntries(rows.map((r) => [r.poleId, { levelCm: r.levelCm, online: !!r.online, ts: r.ts ?? Date.now() }])))
  }
  if (MIRROR.has('alerts')) {
    const f = await backend('/alerts')
    await put('alerts', { active: byId(f.active ?? []), recent: byId(f.recent ?? []), box: f.box ?? null })
  }
  if (MIRROR.has('recommendations')) {
    const rows = await backend('/recommendations')
    const cur = (await db.ref('recommendations').get()).val() ?? {}
    const next = {}
    for (const r of rows) {
      // a dispatcher already decided it here and the command has not reached the backend yet: keep the decision
      const fb = cur[r.id]
      next[r.id] = fb && fb.status !== 'pending' && r.status === 'pending' ? { ...r, status: fb.status, decidedBy: fb.decidedBy ?? null } : r
    }
    await put('recommendations', next)
  }
  if (MIRROR.has('power')) {
    // a cut or restore done with the button on the pole box shows on the dashboard too
    const regions = await backend('/regions')
    const off = regions.flatMap((g) => g.cities.flatMap((c) => c.barangays.flatMap((b) => b.streets.filter((s) => s.powerOff).map((s) => s.id))))
    const cur = (await db.ref('power').get()).val() ?? {}
    const updates = {}
    for (const id of off) if (!cur[id]) updates[id] = { off: true, since: ServerValue.TIMESTAMP }
    for (const id of Object.keys(cur)) if (!off.includes(id)) updates[id] = null
    if (Object.keys(updates).length) await db.ref('power').update(updates)
  }
}

if (MIRROR.size) {
  let failing = false
  const tick = () => mirror()
    .then(() => { if (failing) log('backend reachable again'); failing = false })
    .catch((e) => { if (!failing) log(`mirror: ${e.message}`); failing = true })
    .finally(() => setTimeout(tick, 2000))
  tick()
}

log(`BAHAGI bridge up. Firebase ${DB_URL}, backend ${BACKEND}, mirror: ${[...MIRROR].join(', ') || 'off'}`)
