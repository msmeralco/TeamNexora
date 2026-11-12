import { useEffect, useMemo, useState } from 'react'
import { config } from '../config'
import { BAND_STYLE, fetchRain, rainBand, type RainStep } from '../lib/rain'
import type { FlatStreet, Hazard } from '../types'

const HAZ: Record<Hazard, { label: string; chip: string; rank: number }> = {
  none: { label: 'None', chip: 'bg-stone-100 text-stone-600', rank: 0 },
  low: { label: 'Low · 0.1–0.5 m', chip: 'bg-yellow-100 text-yellow-800', rank: 1 },
  medium: { label: 'Medium · 0.5–1.5 m', chip: 'bg-meralco text-white', rank: 2 },
  high: { label: 'High · over 1.5 m', chip: 'bg-red-600 text-white', rank: 3 },
}
const PERIODS = [
  ['y5', '5-year', '20% chance each year'],
  ['y25', '25-year', '4% chance each year'],
  ['y100', '100-year', '1% chance each year'],
] as const

export default function ForecastView({ streets }: { streets: FlatStreet[] }) {
  const lat = streets.length ? streets.reduce((a, s) => a + s.lat, 0) / streets.length : null
  const lng = streets.length ? streets.reduce((a, s) => a + s.lng, 0) / streets.length : null
  const key = lat === null ? '' : `${lat.toFixed(3)},${lng!.toFixed(3)}`

  const [steps, setSteps] = useState<RainStep[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (lat === null || lng === null) return
    let dead = false
    setLoading(true); setError('')
    fetchRain(lat, lng)
      .then((s) => !dead && setSteps(s))
      .catch((e: Error) => !dead && setError(`Could not load the rain forecast (${e.message}).`))
      .finally(() => !dead && setLoading(false))
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const stats = useMemo(() => {
    const t0 = Date.now()
    const total24 = steps.filter((s) => s.ts < t0 + 24 * 3_600_000).reduce((a, s) => a + s.mm, 0)
    const peak = Math.max(0, ...steps.map((s) => s.mm / s.hours))
    return { total24, peak, band: rainBand(peak) }
  }, [steps])

  // Simple placeholder for the TAYA model: near-term rain band + how deep a 5-year storm floods this street.
  const outlook = (s: FlatStreet) => {
    const score = HAZ[s.noah?.y5 ?? 'none'].rank + BAND_STYLE[stats.band].rank
    return stats.band === 'none' || score < 2
      ? { label: 'Low', chip: 'bg-green-100 text-green-800' }
      : score >= 4 ? { label: 'High risk', chip: 'bg-red-600 text-white' } : { label: 'Watch', chip: 'bg-meralco text-white' }
  }

  if (!streets.length) return <div className="p-8 text-stone-500">Select a region, city, barangay or street to see its forecast.</div>

  return (
    <div className="h-full space-y-6 overflow-y-auto p-6">
      <section className="rounded-lg bg-white p-5 shadow">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-black">Rain forecast, next 48 hours</h2>
            <p className="text-sm text-stone-500">
              {config.rainProvider === 'openweathermap' ? 'OpenWeatherMap' : 'Open-Meteo'} · centered on the selected area
            </p>
          </div>
          {!loading && !error && (
            <div className="flex gap-2 text-sm">
              <span className="rounded-full bg-stone-100 px-3 py-1">{stats.total24.toFixed(0)} mm in 24 h</span>
              <span className={`rounded-full px-3 py-1 font-bold ${BAND_STYLE[stats.band].chip}`}>
                Peak {stats.peak.toFixed(1)} mm/h · {BAND_STYLE[stats.band].label}
              </span>
            </div>
          )}
        </div>
        {loading && <p className="text-sm text-stone-500">Loading forecast…</p>}
        {error && <p role="alert" className="rounded bg-red-100 px-3 py-2 text-sm font-semibold text-red-800">{error}</p>}
        {!loading && !error && (
          <>
            <div className="flex h-32 items-end gap-px">
              {steps.map((s) => {
                const rate = s.mm / s.hours
                return (
                  <div key={s.ts} className="flex h-full flex-1 items-end" title={`${new Date(s.ts).toLocaleString('en-PH', { weekday: 'short', hour: 'numeric' })} · ${s.mm.toFixed(1)} mm`}>
                    <div className={`w-full rounded-t-sm ${BAND_STYLE[rainBand(rate)].bar}`} style={{ height: `${Math.max(2, Math.min(100, (rate / 30) * 100))}%` }} />
                  </div>
                )
              })}
            </div>
            <div className="mt-1 flex justify-between text-xs text-stone-500"><span>Now</span><span>+24 h</span><span>+48 h</span></div>
          </>
        )}
      </section>

      <section className="overflow-x-auto rounded-lg bg-white shadow">
        <div className="border-b border-stone-200 p-5">
          <h2 className="font-black">Flood hazard by storm size</h2>
          <p className="text-sm text-stone-500">How deep each street floods in a 5-, 25- and 100-year rain, from UP NOAH hazard maps.</p>
        </div>
        <table className="w-full text-left text-sm">
          <thead className="bg-ink text-white">
            <tr>
              <th className="px-5 py-3 font-semibold">Street</th>
              {PERIODS.map(([k, label, chance]) => (
                <th key={k} className="px-3 py-3 font-semibold">{label}<span className="block text-xs font-normal text-stone-400">{chance}</span></th>
              ))}
              <th className="px-3 py-3 font-semibold">Outlook now</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-200">
            {streets.map((s) => {
              const o = outlook(s)
              return (
                <tr key={s.id}>
                  <td className="px-5 py-3"><b>{s.name}</b><span className="block text-xs text-stone-500">{s.barangayName} · {s.switchId}</span></td>
                  {PERIODS.map(([k]) => {
                    const h = s.noah?.[k]
                    return (
                      <td key={k} className="px-3 py-3">
                        {h ? <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${HAZ[h].chip}`}>{HAZ[h].label}</span> : <span className="text-xs text-stone-400">No NOAH data</span>}
                      </td>
                    )
                  })}
                  <td className="px-3 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${o.chip}`}>{o.label}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="border-t border-stone-200 p-4 text-xs text-stone-500">
          Hazard data: UP NOAH (DOST), licensed ODbL; credit Project NOAH. Outlook combines the rain band above with each street's 5-year hazard and is a placeholder for the BAHAGI forecast model.
        </p>
      </section>
    </div>
  )
}
