import { useEffect, useMemo, useState } from 'react'
import ForecastView from './components/ForecastView'
import MapView from './components/MapView'
import ReportsView from './components/ReportsView'
import Sidebar, { type View } from './components/Sidebar'
import { config } from './config'
import { api } from './lib/api'
import { levelFromCm, LEVEL_STYLE } from './lib/level'
import { connectRealtime, type LinkStatus } from './lib/realtime'
import { scopeLabel, streetsIn } from './lib/tree'
import type { Recommendation, Region, Report, Scope, SensorReading } from './types'

const LINK_TEXT: Record<LinkStatus, string> = {
  connecting: 'Connecting to sensors…',
  live: 'Live from AWS IoT Core',
  mock: 'Simulated sensors',
  offline: 'Sensor link offline',
}

export default function App() {
  const [regions, setRegions] = useState<Region[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [recs, setRecs] = useState<Recommendation[]>([])
  const [readings, setReadings] = useState<Record<string, SensorReading>>({})
  const [link, setLink] = useState<LinkStatus>('connecting')
  const [view, setView] = useState<View>('map')
  const [scope, setScope] = useState<Scope>({ type: 'all' })
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // streetId → timestamp the street was cut. Seeded from the backend (street.powerOff), updated on approve/restore.
  const [outages, setOutages] = useState<Record<string, number>>({})

  useEffect(() => {
    Promise.all([api.regions(), api.reports(), api.recommendations()])
      .then(([a, b, c]) => {
        setRegions(a); setReports(b); setRecs(c)
        setOutages(Object.fromEntries(streetsIn(a, { type: 'all' }).filter((s) => s.powerOff).map((s) => [s.id, Date.now()])))
      })
      .catch((e: Error) => setError(`Could not load data from the backend (${e.message}). Check VITE_API_BASE or set VITE_USE_MOCK=true.`))
  }, [])

  const poleIds = useMemo(() => streetsIn(regions, { type: 'all' }).flatMap((s) => s.poles.map((p) => p.id)), [regions])

  useEffect(() => {
    if (!poleIds.length) return
    return connectRealtime(poleIds, (r) => setReadings((prev) => ({ ...prev, [r.poleId]: r })), setLink)
  }, [poleIds])

  // Live mode: new Messenger reports and recommendations arrive via the backend, so refresh every 10 s
  useEffect(() => {
    if (config.useMock) return
    const t = setInterval(() => {
      Promise.all([api.reports(), api.recommendations()]).then(([b, c]) => { setReports(b); setRecs(c) }).catch(() => {})
    }, 10_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 7000)
    return () => clearTimeout(t)
  }, [notice])

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t) }, [])

  const scoped = useMemo(() => streetsIn(regions, scope), [regions, scope])
  const streetIds = new Set(scoped.map((s) => s.id))
  const barangayIds = new Set(scoped.map((s) => s.barangayId))
  // a recommendation only shows once residents have reported (non-duplicate) on that street
  const reported = new Set(reports.filter((r) => r.streetId && !r.duplicate).map((r) => r.streetId))
  const scopedRecs = recs.filter((r) => streetIds.has(r.streetId) && reported.has(r.streetId))
  // a report without a street (text-only, unlocated) still shows for its barangay
  const scopedReports = reports.filter((r) => (r.streetId ? streetIds.has(r.streetId) : scope.type !== 'street' && barangayIds.has(r.barangayId)))
  const scopedPoles = scoped.flatMap((s) => s.poles)
  const live = scopedPoles.filter((p) => readings[p.id] && now - readings[p.id].ts < config.offlineAfterMs)
  const peak = Math.max(0, ...live.map((p) => readings[p.id].levelCm))
  const pendingAll = recs.filter((r) => r.status === 'pending' && reported.has(r.streetId)).length

  const decide = async (id: string, d: 'approve' | 'reject') => {
    const rec = recs.find((r) => r.id === id)
    try {
      const sms = await api.decide(id, d)
      setRecs((rs) => rs.map((r) => (r.id === id ? { ...r, status: d === 'approve' ? 'approved' : 'rejected' } : r)))
      if (rec && d === 'approve' && rec.action === 'open') {
        // the reports that justified the cut are handled: clear them from the list
        setReports((rs) => rs.filter((r) => r.streetId !== rec.streetId))
        setNotice(`Approved ${rec.switchId}. Power-cut warning SMS sent to ${sms.smsSent} residents. Reports for this street were cleared.`)
      }
      if (rec && d === 'approve')
        setOutages((o) => { const n = { ...o }; if (rec.action === 'open') n[rec.streetId] = Date.now(); else delete n[rec.streetId]; return n })
    } catch (e) { setError(`Could not ${d} the recommendation (${(e as Error).message}). Nothing was switched.`) }
  }

  const restore = async (streetId: string) => {
    try {
      const sms = await api.restore(streetId)
      const name = streetsIn(regions, { type: 'all' }).find((s) => s.id === streetId)?.name ?? 'the street'
      setNotice(`Power restored on ${name}. "Power restored" SMS sent to ${sms.smsSent} residents.`)
      if (sms.smsFailed) setError(`${sms.smsFailed} "power restored" SMS failed to send. Power is restored; check the SMS provider.`)
      setOutages((o) => { const n = { ...o }; delete n[streetId]; return n })
    } catch (e) { setError(`Could not restore power (${(e as Error).message}). The street is still marked off.`) }
  }
  const outCount = scoped.filter((s) => outages[s.id]).length

  return (
    <div className="flex h-screen bg-stone-100 text-ink">
      <Sidebar regions={regions} view={view} setView={setView} scope={scope} setScope={setScope} readings={readings} outages={outages} pending={pendingAll} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-300 bg-white px-6 py-3">
          <div>
            <h1 className="text-lg font-black">{view === 'map' ? 'Flood and grid map' : view === 'reports' ? 'Resident reports' : 'Flood forecast'}</h1>
            <p className="text-sm text-stone-500">{scopeLabel(regions, scope)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={`rounded-full px-3 py-1 font-bold ${LEVEL_STYLE[levelFromCm(peak)].chip}`}>
              Peak water {peak.toFixed(1)} cm
            </span>
            {outCount > 0 && (
              <span className="rounded-full bg-ink px-3 py-1 font-bold text-meralco">
                {outCount} {outCount > 1 ? 'streets' : 'street'} without power
              </span>
            )}
            <span className="rounded-full bg-stone-100 px-3 py-1">{live.length}/{scopedPoles.length} sensors online</span>
            <span className="rounded-full bg-stone-100 px-3 py-1">{scopedRecs.filter((r) => r.status === 'pending').length} awaiting approval</span>
            <span className={`rounded-full px-3 py-1 font-semibold ${link === 'offline' ? 'bg-red-100 text-red-800' : 'bg-ink text-white'}`}>
              {LINK_TEXT[link]}
            </span>
          </div>
        </header>

        {notice && <div role="status" className="border-l-4 border-meralco bg-ink px-6 py-2 text-sm font-semibold text-white">{notice}</div>}
        {error && <div role="alert" className="bg-red-600 px-6 py-2 text-sm font-semibold text-white">{error}</div>}

        <main className="min-h-0 flex-1">
          {view === 'forecast'
            ? <ForecastView streets={scoped} />
            : view === 'map'
            ? <MapView streets={scoped} readings={readings} recs={scopedRecs} now={now} outages={outages} onDecide={decide} onRestore={restore} />
            : <ReportsView reports={scopedReports} streets={scoped} />}
        </main>
      </div>
    </div>
  )
}
