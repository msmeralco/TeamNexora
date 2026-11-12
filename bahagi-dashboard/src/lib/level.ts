import { config } from '../config'
import type { Level } from '../types'

export function levelFromCm(cm: number): Level {
  const t = config.thresholds
  if (cm >= t.waist) return 'waist'
  if (cm >= t.knee) return 'knee'
  if (cm >= t.gutter) return 'gutter'
  return 'dry'
}

export const LEVEL_STYLE: Record<Level, { hex: string; label: string; chip: string }> = {
  dry: { hex: '#16a34a', label: 'Dry', chip: 'bg-green-100 text-green-800' },
  gutter: { hex: '#eab308', label: 'Gutter', chip: 'bg-yellow-100 text-yellow-800' },
  knee: { hex: '#f26522', label: 'Knee', chip: 'bg-meralco text-white' },
  waist: { hex: '#dc2626', label: 'Waist', chip: 'bg-red-600 text-white' },
}

export const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}
