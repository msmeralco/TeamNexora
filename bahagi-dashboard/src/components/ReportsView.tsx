import { ago, levelFromCm, LEVEL_STYLE } from '../lib/level'
import type { FlatStreet, Report } from '../types'

export default function ReportsView({ reports, streets }: { reports: Report[]; streets: FlatStreet[] }) {
  const name = (r: Report) => {
    const st = streets.find((s) => s.id === r.streetId)
    const bg = streets.find((s) => s.barangayId === r.barangayId)?.barangayName ?? r.barangayId
    return st ? `${st.name}, ${bg}` : bg
  }

  if (!reports.length)
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <p className="text-lg font-bold">No resident reports here yet</p>
          <p className="text-stone-500">Photos sent to the BAHAGI Messenger, Viber or SMS line will appear in this list.</p>
        </div>
      </div>
    )

  return (
    <div className="grid gap-4 overflow-y-auto p-6 md:grid-cols-2 xl:grid-cols-3">
      {reports.map((r) => {
        const lvl = LEVEL_STYLE[levelFromCm(r.estimatedCm)]
        return (
          <article key={r.id} className={`overflow-hidden rounded-lg bg-white shadow ${r.duplicate ? 'opacity-60' : ''}`}>
            {r.photoUrl
              ? <img src={r.photoUrl} alt="Resident flood photo" className="h-40 w-full object-cover" />
              : <div className="grid h-40 place-items-center bg-stone-200 text-sm text-stone-500">No photo (text report)</div>}
            <div className="space-y-2 p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-bold">{name(r)}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${lvl.chip}`}>
                  {lvl.label} · {r.estimatedCm} cm
                </span>
              </div>
              <p className="text-stone-700">{r.note}</p>
              <p className="text-xs text-stone-500">
                {r.source} · {ago(r.ts)} · AI confidence {Math.round(r.confidence * 100)}%
              </p>
              {r.duplicate && <p className="rounded bg-stone-100 px-2 py-1 text-xs font-semibold">Duplicate photo, ignored</p>}
            </div>
          </article>
        )
      })}
    </div>
  )
}
