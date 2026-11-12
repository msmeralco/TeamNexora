import L from 'leaflet'
import { useEffect } from 'react'
import { Circle, CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMap } from 'react-leaflet'
import OutageCard from './OutageCard'
import { config } from '../config'
import { levelFromCm, LEVEL_STYLE } from '../lib/level'
import type { FlatStreet, Recommendation, SensorReading } from '../types'

// Outage marker: black tile, orange crossed-out bolt, pulsing orange ring. Looks nothing like the round water-level dots.
const outageIcon = L.divIcon({
  className: '',
  iconSize: [44, 44],
  iconAnchor: [22, 22],
  html: `<div class="relative grid h-11 w-11 place-items-center">
    <span class="absolute inset-0 animate-ping rounded-md bg-meralco opacity-60 motion-reduce:animate-none"></span>
    <span class="relative grid h-11 w-11 place-items-center rounded-md border-2 border-meralco bg-ink">
      <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="#f26522" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/><path d="M3 3l18 18" stroke="#fff"/></svg>
    </span></div>`,
})

function Fit({ points }: { points: [number, number][] }) {
  const map = useMap()
  const key = JSON.stringify(points)
  useEffect(() => {
    if (!points.length) return
    if (points.length === 1) map.setView(points[0], 17)
    else map.fitBounds(L.latLngBounds(points), { padding: [70, 70], maxZoom: 16 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key])
  return null
}

interface Props {
  streets: FlatStreet[]
  readings: Record<string, SensorReading>
  recs: Recommendation[]
  now: number
  outages: Record<string, number>
  onDecide: (id: string, d: 'approve' | 'reject') => void
  onRestore: (streetId: string) => void
}

export default function MapView({ streets, readings, recs, now, outages, onDecide, onRestore }: Props) {
  const points = streets.map((s) => [s.lat, s.lng] as [number, number])
  const poles = streets.flatMap((s) => s.poles.map((p) => ({ ...p, off: !!outages[s.id] })))
  const peakOf = (s: (typeof streets)[number]) => {
    const live = s.poles.map((p) => readings[p.id]).filter((r) => r && now - r.ts < config.offlineAfterMs)
    return live.length ? Math.max(...live.map((r) => r.levelCm)) : null
  }

  return (
    <div className="relative h-full w-full">
      <MapContainer center={[14.6, 121.04]} zoom={11} className="h-full w-full [&_.leaflet-tile]:max-w-none">
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />
        <Fit points={points} />
        {streets.map((s) => (
          <Circle key={s.id} center={[s.lat, s.lng]} radius={90}
            pathOptions={outages[s.id]
              ? { color: '#141414', weight: 3, dashArray: '2 6', fillColor: '#141414', fillOpacity: 0.18 }
              : { color: '#f26522', weight: 2, dashArray: '6 6', fillOpacity: 0.06 }} />
        ))}
        {poles.map((p) => {
          const r = readings[p.id]
          const online = !!r && now - r.ts < config.offlineAfterMs
          const lvl = r ? levelFromCm(r.levelCm) : 'dry'
          if (p.off)
            return (
              <Marker key={p.id} position={[p.lat, p.lng]} icon={outageIcon}>
                <Tooltip permanent direction="top" offset={[0, -24]}>
                  {p.id} · POWER OFF{online ? ` · ${r.levelCm.toFixed(1)} cm` : ''}
                </Tooltip>
              </Marker>
            )
          return (
            <CircleMarker key={p.id} center={[p.lat, p.lng]} radius={12}
              pathOptions={{ color: '#141414', weight: 3, fillColor: online ? LEVEL_STYLE[lvl].hex : '#9ca3af', fillOpacity: 1 }}>
              <Tooltip permanent direction="top" offset={[0, -10]}>
                {p.id} · {online ? `${r.levelCm.toFixed(1)} cm` : 'offline'}
              </Tooltip>
            </CircleMarker>
          )
        })}
      </MapContainer>

      <div className="absolute right-4 top-4 z-[1000] flex max-h-[calc(100%-2rem)] w-80 flex-col gap-3 overflow-y-auto">
        {streets.filter((s) => outages[s.id]).map((s) => (
          <OutageCard key={s.id} street={s} peakCm={peakOf(s)} since={outages[s.id]} onRestore={() => onRestore(s.id)} />
        ))}
        {recs.length === 0 && !streets.some((s) => outages[s.id]) && (
          <div className="rounded-lg bg-white p-4 text-sm shadow-lg">
            <p className="font-semibold">No action needed</p>
            <p className="text-stone-500">No resident reports on these streets, so BAHAGI has nothing to recommend.</p>
          </div>
        )}
        {recs.map((r) => (
          <div key={r.id} className="overflow-hidden rounded-lg bg-white shadow-lg">
            <div className="border-l-4 border-meralco bg-ink px-4 py-3 text-white">
              <p className="text-xs text-stone-400">BAHAGI recommends</p>
              <p className="font-bold">{r.title}</p>
            </div>
            <div className="space-y-3 p-4 text-sm">
              <p>Cuts <b>{r.homesCut}</b> homes · keeps <b>{r.homesKept}</b> lit</p>
              <ul className="list-disc space-y-1 pl-4 text-stone-600">
                {r.evidence.map((e) => <li key={e}>{e}</li>)}
              </ul>
              {r.status === 'pending' ? (
                <div className="flex gap-2">
                  <button onClick={() => onDecide(r.id, 'approve')}
                    className="flex-1 rounded bg-meralco py-2 font-bold text-white hover:bg-meralco-dark focus-visible:outline-2 focus-visible:outline-ink">
                    Approve
                  </button>
                  <button onClick={() => onDecide(r.id, 'reject')}
                    className="flex-1 rounded border border-ink py-2 font-bold hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-meralco">
                    Reject
                  </button>
                </div>
              ) : (
                <p className={`rounded px-3 py-2 font-semibold ${r.status === 'approved' ? 'bg-meralco-soft text-meralco-dark' : 'bg-stone-100 text-stone-600'}`}>
                  {r.status === 'approved' ? 'Approved. Switch command and SMS are being sent.' : 'Rejected. No switch was changed.'}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="absolute bottom-6 left-4 z-[1000] flex gap-3 rounded-lg bg-white px-3 py-2 text-xs shadow-lg">
        {(Object.keys(LEVEL_STYLE) as (keyof typeof LEVEL_STYLE)[]).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: LEVEL_STYLE[k].hex }} />
            {LEVEL_STYLE[k].label}
          </span>
        ))}
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-gray-400" />Offline</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-meralco bg-ink" />Power off</span>
      </div>
    </div>
  )
}
