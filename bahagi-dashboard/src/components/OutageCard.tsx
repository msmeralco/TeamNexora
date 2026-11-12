import { useState } from 'react'
import { ago, levelFromCm, LEVEL_STYLE } from '../lib/level'
import type { FlatStreet } from '../types'

interface Props { street: FlatStreet; peakCm: number | null; since: number; onRestore: () => void }

export default function OutageCard({ street, peakCm, since, onRestore }: Props) {
  const [confirm, setConfirm] = useState(false)
  const lvl = peakCm === null ? null : levelFromCm(peakCm)
  const safe = lvl === 'dry'

  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-lg ring-2 ring-ink">
      <div className="flex items-center gap-3 bg-ink px-4 py-3 text-white">
        <svg viewBox="0 0 24 24" className="h-6 w-6 shrink-0" fill="none" stroke="#f26522" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M13 2 4 14h7l-1 8 9-12h-7z" /><path d="M3 3l18 18" stroke="#fff" />
        </svg>
        <div>
          <p className="text-xs text-stone-400">Power off · since {ago(since)}</p>
          <p className="font-bold">{street.name} · {street.switchId}</p>
        </div>
      </div>
      <div className="space-y-3 p-4 text-sm">
        {lvl === null ? (
          <p className="rounded bg-stone-100 px-3 py-2 font-semibold text-stone-600">No sensor reading. Check the street before restoring.</p>
        ) : safe ? (
          <p className="rounded bg-green-100 px-3 py-2 font-semibold text-green-800">Water is down to {peakCm!.toFixed(1)} cm. Safe to restore.</p>
        ) : (
          <p className="rounded bg-yellow-100 px-3 py-2 font-semibold text-yellow-900">
            Water is still {peakCm!.toFixed(1)} cm ({LEVEL_STYLE[lvl].label.toLowerCase()}).
          </p>
        )}
        {!confirm ? (
          <button onClick={() => (safe ? onRestore() : setConfirm(true))}
            className={`w-full rounded py-2 font-bold focus-visible:outline-2 focus-visible:outline-ink ${
              safe ? 'bg-meralco text-white hover:bg-meralco-dark' : 'border border-ink hover:bg-stone-100'
            }`}>
            Restore power
          </button>
        ) : (
          <div className="space-y-2">
            <p className="font-semibold">Restore while water is still present?</p>
            <div className="flex gap-2">
              <button onClick={onRestore} className="flex-1 rounded bg-meralco py-2 font-bold text-white hover:bg-meralco-dark">Restore anyway</button>
              <button onClick={() => setConfirm(false)} className="flex-1 rounded border border-ink py-2 font-bold hover:bg-stone-100">Keep off</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
