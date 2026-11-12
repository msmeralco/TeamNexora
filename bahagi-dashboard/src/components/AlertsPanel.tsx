import { useState } from 'react'
import { ago } from '../lib/level'
import type { AlertFeed, Alert, BoxHealth } from '../types'

const STYLE: Record<Alert['severity'], { row: string; tag: string; label: string }> = {
  critical: { row: 'bg-red-600 text-white', tag: 'bg-white text-red-700', label: 'Critical' },
  warning: { row: 'bg-yellow-100 text-yellow-950', tag: 'bg-yellow-400 text-ink', label: 'Warning' },
  info: { row: 'bg-stone-100 text-ink', tag: 'bg-ink text-white', label: 'Info' },
}

const BOOT: Record<string, string> = {
  power_on: 'normal power-on',
  brownout: 'power dip (brownout)',
  crash: 'crash',
  watchdog: 'watchdog reset',
  reset_button: 'reset button',
  software: 'software reset',
}

function boxLine(b: BoxHealth) {
  const parts = [b.online ? 'Pole box online' : 'Pole box offline']
  if (b.uptimeS != null) parts.push(`up ${b.uptimeS < 120 ? `${b.uptimeS}s` : `${Math.round(b.uptimeS / 60)} min`}`)
  if (b.rssi != null) parts.push(`Wi-Fi ${b.rssi} dBm`)
  if (b.dryCm != null) parts.push(`calibrated dry = ${b.dryCm.toFixed(1)} cm`)
  if (b.boot) parts.push(`last start: ${BOOT[b.boot] ?? b.boot}`)
  return parts.join(' · ')
}

function Row({ a }: { a: Alert }) {
  const s = STYLE[a.severity]
  return (
    <div className={`flex items-start gap-3 px-6 py-2 text-sm ${s.row}`} role={a.severity === 'critical' ? 'alert' : undefined}>
      <span className={`mt-0.5 shrink-0 rounded px-2 py-0.5 text-xs font-black uppercase tracking-wide ${s.tag}`}>{s.label}</span>
      <div className="min-w-0">
        <p className="font-bold">{a.title}</p>
        {a.detail && <p className="opacity-90">{a.detail}</p>}
      </div>
      {!a.active && <span className="ml-auto shrink-0 text-xs opacity-75">{ago(a.ts)}</span>}
    </div>
  )
}

/** Live alerts from the BAHAGI backend: pole-box errors, floods, approvals waiting, and what happened recently. */
export default function AlertsPanel({ feed, reachable, workerSeen, workerOnline }: { feed: AlertFeed | null; reachable: boolean; workerSeen: number | null; workerOnline: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const [showRecent, setShowRecent] = useState(false)

  if (!reachable)
    return (
      <div role="alert" className="flex items-center gap-3 bg-red-600 px-6 py-2 text-sm text-white">
        <span className="rounded bg-white px-2 py-0.5 text-xs font-black uppercase tracking-wide text-red-700">Critical</span>
        <p><b>Can’t reach the Firebase database.</b> Check this computer’s internet connection; the page reconnects and catches up by itself.</p>
      </div>
    )
  if (!feed) return null

  // the backend bridge is what actually moves switches and sends SMS; if it is down, approvals only queue
  const bridge: Alert[] = workerOnline ? [] : [{
    id: 'bridge-offline', severity: 'critical', kind: 'bridge_offline', active: true, ts: Date.now(),
    title: workerSeen ? `BAHAGI backend bridge offline (last seen ${ago(workerSeen)})` : 'BAHAGI backend bridge has not connected',
    detail: 'Approvals and restores are saved and will run when it is back. Start it on the laptop: npm start in backend/firebase-bridge.',
  }]
  const active = [...bridge, ...feed.active]
  const shown = showAll ? active : active.slice(0, 3)
  const critical = active.filter((a) => a.severity === 'critical').length

  return (
    <div className="border-b border-stone-300">
      {active.length === 0 ? (
        <div className="flex items-center gap-3 bg-green-50 px-6 py-2 text-sm text-green-900">
          <span className="rounded bg-green-700 px-2 py-0.5 text-xs font-black uppercase tracking-wide text-white">All clear</span>
          <p className="font-semibold">No errors or floods right now.</p>
        </div>
      ) : (
        shown.map((a) => <Row key={a.id} a={a} />)
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-white px-6 py-1.5 text-xs text-stone-600">
        {feed.box && <span>{boxLine(feed.box)}</span>}
        <span className="ml-auto flex gap-3">
          {active.length > 3 && (
            <button onClick={() => setShowAll((v) => !v)} className="font-bold text-ink underline">
              {showAll ? 'Show fewer' : `Show all ${active.length} alerts${critical ? ` (${critical} critical)` : ''}`}
            </button>
          )}
          <button onClick={() => setShowRecent((v) => !v)} className="font-bold text-ink underline">
            {showRecent ? 'Hide recent events' : `Recent events (${feed.recent.length})`}
          </button>
        </span>
      </div>
      {showRecent && (
        <div className="max-h-56 overflow-y-auto border-t border-stone-200">
          {feed.recent.length === 0
            ? <p className="px-6 py-2 text-sm text-stone-500">Nothing in the last 30 minutes.</p>
            : feed.recent.map((a) => <Row key={a.id} a={a} />)}
        </div>
      )}
    </div>
  )
}
