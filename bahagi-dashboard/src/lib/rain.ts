import { config } from '../config'

/** One forecast step: `mm` of rain over `hours` hours starting at `ts`. */
export interface RainStep { ts: number; mm: number; hours: number }

export async function fetchRain(lat: number, lng: number): Promise<RainStep[]> {
  if (config.rainProvider === 'openweathermap') {
    if (!config.owmKey) throw new Error('VITE_OWM_KEY is not set')
    const r = await fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lng}&cnt=16&appid=${config.owmKey}`)
    if (!r.ok) throw new Error(`OpenWeatherMap returned ${r.status}`)
    const j = await r.json()
    return j.list.map((x: { dt: number; rain?: { '3h'?: number } }) => ({ ts: x.dt * 1000, mm: x.rain?.['3h'] ?? 0, hours: 3 }))
  }
  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=precipitation&forecast_days=3&timezone=Asia%2FManila`,
  )
  if (!r.ok) throw new Error(`Open-Meteo returned ${r.status}`)
  const j = await r.json()
  const from = Date.now() - 3_600_000
  return (j.hourly.time as string[])
    .map((t, i) => ({ ts: new Date(`${t}:00+08:00`).getTime(), mm: (j.hourly.precipitation[i] as number) ?? 0, hours: 1 }))
    .filter((s) => s.ts >= from)
    .slice(0, 48)
}

// Hourly rain bands modelled on PAGASA's rainfall warning levels (mm in 1 hour). Adjust to taste.
export type Band = 'none' | 'yellow' | 'orange' | 'red'
export const rainBand = (mmPerHour: number): Band => (mmPerHour >= 30 ? 'red' : mmPerHour >= 15 ? 'orange' : mmPerHour >= 7.5 ? 'yellow' : 'none')

export const BAND_STYLE: Record<Band, { label: string; bar: string; chip: string; rank: number }> = {
  none: { label: 'Light or none', bar: 'bg-stone-400', chip: 'bg-stone-100 text-stone-700', rank: 0 },
  yellow: { label: 'Yellow · heavy', bar: 'bg-yellow-400', chip: 'bg-yellow-100 text-yellow-800', rank: 1 },
  orange: { label: 'Orange · intense', bar: 'bg-meralco', chip: 'bg-meralco text-white', rank: 2 },
  red: { label: 'Red · torrential', bar: 'bg-red-600', chip: 'bg-red-600 text-white', rank: 3 },
}
