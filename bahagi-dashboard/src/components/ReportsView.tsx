import { config } from '../config'
import { ago, levelFromCm, LEVEL_STYLE } from '../lib/level'
import type { FlatStreet, Report } from '../types'

function MessengerBanner() {
  const link = config.messengerPage ? `https://m.me/${config.messengerPage}` : ''
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b-4 border-meralco bg-ink px-6 py-3 text-sm text-white">
      <div>
        <p className="font-bold">Residents report through Messenger</p>
        <p className="text-stone-400">
          {link ? 'Photos sent to the BAHAGI page appear here within seconds.' : 'Set VITE_MESSENGER_PAGE to show the bot link.'}
        </p>
      </div>
      {link && (
        <div className="flex items-center gap-2">
          <a href={link} target="_blank" rel="noreferrer" className="rounded bg-meralco px-3 py-1.5 font-bold hover:bg-meralco-dark">Open bot</a>
          <button onClick={() => navigator.clipboard.writeText(link)} className="rounded border border-stone-500 px-3 py-1.5 font-semibold hover:bg-ink-soft">
            Copy link
          </button>
        </div>
      )}
    </div>
  )
}

export default function ReportsView({ reports, streets }: { reports: Report[]; streets: FlatStreet[] }) {
  const name = (r: Report) => {
    const st = streets.find((s) => s.id === r.streetId)
    const bg = streets.find((s) => s.barangayId === r.barangayId)?.barangayName ?? r.barangayId
    return st ? `${st.name}, ${bg}` : bg
  }

  return (
    <div className="h-full overflow-y-auto">
      <MessengerBanner />
      {!reports.length ? (
        <div className="p-10 text-center">
          <p className="text-lg font-bold">No resident reports here yet</p>
          <p className="text-stone-500">Photos sent to the BAHAGI Messenger page will appear in this list.</p>
        </div>
      ) : (
        <div className="grid gap-4 p-6 md:grid-cols-2 xl:grid-cols-3">
          {reports.map((r) => {
            const lvl = LEVEL_STYLE[levelFromCm(r.estimatedCm)]
            const fresh = !r.duplicate && Date.now() - r.ts < 120_000
            return (
              <article key={r.id} className={`overflow-hidden rounded-lg bg-white shadow ${r.duplicate ? 'opacity-60' : ''}`}>
                {r.photoUrl
                  ? <img src={r.photoUrl} alt="Resident flood photo" className="h-40 w-full object-cover" />
                  : <div className="grid h-40 place-items-center bg-stone-200 text-sm text-stone-500">No photo (text report)</div>}
                <div className="space-y-2 p-4 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-bold">
                      {name(r)}
                      {fresh && <span className="rounded-sm bg-ink px-1.5 text-[10px] font-black leading-4 text-meralco">NEW</span>}
                    </span>
                    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ${lvl.chip}`}>{lvl.label} · {r.estimatedCm} cm</span>
                  </div>
                  <p className="text-stone-700">{r.note}</p>
                  <p className="text-xs text-stone-500">
                    <span className="capitalize">{r.source}</span> · {ago(r.ts)} · AI confidence {Math.round(r.confidence * 100)}%
                  </p>
                  {r.duplicate && <p className="rounded bg-stone-100 px-2 py-1 text-xs font-semibold">Duplicate photo, ignored</p>}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
