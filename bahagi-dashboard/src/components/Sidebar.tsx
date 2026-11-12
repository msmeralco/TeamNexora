import { useState } from 'react'
import { config } from '../config'
import { levelFromCm, LEVEL_STYLE } from '../lib/level'
import type { Region, Scope, SensorReading } from '../types'

export type View = 'map' | 'reports' | 'forecast'

const PAD = ['pl-3', 'pl-7', 'pl-11', 'pl-16']

const Folder = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden>
    {open
      ? <path d="M2 5a2 2 0 012-2h4l2 2h6a2 2 0 012 2v1H2V5zm0 4h16v6a2 2 0 01-2 2H4a2 2 0 01-2-2V9z" />
      : <path d="M2 5a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V5z" />}
  </svg>
)

function Row(p: { depth: number; label: string; active: boolean; onClick: () => void; icon: React.ReactNode; dot?: string; off?: boolean }) {
  return (
    <button
      onClick={p.onClick}
      className={`flex w-full items-center gap-2 py-2 pr-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-meralco ${PAD[p.depth]} ${
        p.active ? 'bg-meralco font-semibold text-white' : 'text-stone-300 hover:bg-ink-soft hover:text-white'
      }`}
    >
      {p.icon}
      <span className="flex-1 truncate">{p.label}</span>
      {p.off && <span className="rounded-sm border border-meralco bg-ink px-1.5 text-[10px] font-black leading-4 text-meralco">OFF</span>}
      {p.dot && <span className="h-2.5 w-2.5 rounded-full ring-2 ring-ink" style={{ backgroundColor: p.dot }} />}
    </button>
  )
}

interface Props {
  regions: Region[]
  view: View
  setView: (v: View) => void
  scope: Scope
  setScope: (s: Scope) => void
  readings: Record<string, SensorReading>
  outages: Record<string, number>
  pending: number
}

export default function Sidebar({ regions, view, setView, scope, setScope, readings, outages, pending }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set(['ncr', 'pasig', 'kapitolyo']))
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const is = (type: Scope['type'], id: string) => scope.type === type && 'id' in scope && scope.id === id

  const nav = (v: View, label: string, badge?: number) => (
    <button
      onClick={() => setView(v)}
      className={`flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-meralco ${
        view === v ? 'bg-white text-ink' : 'text-white hover:bg-ink-soft'
      }`}
    >
      {label}
      {!!badge && <span className="rounded-full bg-meralco px-2 py-0.5 text-xs text-white">{badge}</span>}
    </button>
  )

  return (
    <aside className="flex w-72 shrink-0 flex-col bg-ink text-white">
      <div className="border-b-4 border-meralco px-4 py-4">
        <div className="text-xl font-black tracking-tight">BAHAGI</div>
        <div className="text-xs text-stone-400">Dispatcher dashboard</div>
      </div>

      <nav className="border-b border-ink-soft py-2">
        {nav('map', 'Map')}
        {nav('reports', 'Reports', pending)}
        {nav('forecast', 'Forecast')}
      </nav>

      <div className="flex items-center justify-between px-4 pb-1 pt-4 text-xs font-semibold text-stone-400">
        <span>Coverage</span>
        <button onClick={() => setScope({ type: 'all' })} className={`hover:text-white ${scope.type === 'all' ? 'text-meralco' : ''}`}>
          Show all
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {regions.map((r) => (
          <div key={r.id}>
            <Row depth={0} label={r.name} icon={<Folder open={open.has(r.id)} />} active={is('region', r.id)}
              onClick={() => { setScope({ type: 'region', id: r.id }); toggle(r.id) }} />
            {open.has(r.id) && r.cities.map((c) => (
              <div key={c.id}>
                <Row depth={1} label={c.name} icon={<Folder open={open.has(c.id)} />} active={is('city', c.id)}
                  onClick={() => { setScope({ type: 'city', id: c.id }); toggle(c.id) }} />
                {open.has(c.id) && c.barangays.map((b) => {
                  const peakOf = (poles: { id: string }[]) => Math.max(0, ...poles.map((p) => readings[p.id]?.levelCm ?? 0))
                  return (
                    <div key={b.id}>
                      <Row depth={2} label={b.name} icon={<Folder open={open.has(b.id)} />} active={is('barangay', b.id)}
                        dot={LEVEL_STYLE[levelFromCm(peakOf(b.streets.flatMap((s) => s.poles)))].hex}
                        onClick={() => { setScope({ type: 'barangay', id: b.id }); toggle(b.id) }} />
                      {open.has(b.id) && b.streets.map((s) => (
                        <Row key={s.id} depth={3} label={`${s.name} · ${s.switchId}`} active={is('street', s.id)} off={!!outages[s.id]}
                          icon={<span className="w-4 text-center text-stone-500">•</span>}
                          dot={LEVEL_STYLE[levelFromCm(peakOf(s.poles))].hex}
                          onClick={() => setScope({ type: 'street', id: s.id })} />
                      ))}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="border-t border-ink-soft px-4 py-3 text-xs text-stone-500">
        {config.useMock ? 'Sample data mode' : 'Connected to backend'}
      </div>
    </aside>
  )
}
