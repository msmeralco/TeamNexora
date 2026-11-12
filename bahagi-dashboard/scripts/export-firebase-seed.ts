/**
 * Turns the sample data (src/lib/mockData.ts) into firebase-seed.json for Firebase → Realtime Database → ⋮ → Import JSON.
 *   npx vite-node scripts/export-firebase-seed.ts
 * Importing REPLACES the whole database, so do it once on an empty project. Add your dispatcher uid afterwards.
 */
import { writeFileSync } from 'node:fs'
import { mockRecs, mockRegions, mockReports } from '../src/lib/mockData'

const byId = <T extends { id: string }>(xs: T[], f: (x: T) => object = (x) => x) =>
  Object.fromEntries(xs.map((x) => { const { id, ...rest } = f(x) as T; return [id, rest] }))

const power: Record<string, object> = {}
const regions = byId(mockRegions, (r) => ({
  ...r,
  cities: byId(r.cities, (c) => ({
    ...c,
    barangays: byId(c.barangays, (b) => ({
      ...b,
      streets: byId(b.streets, ({ powerOff, ...s }) => {
        if (powerOff) power[s.id] = { off: true, since: Date.now(), switchId: s.switchId }
        return { ...s, poles: byId(s.poles) }
      }),
    })),
  })),
}))

const seed = {
  regions,
  reports: byId(mockReports),
  recommendations: byId(mockRecs),
  power,
  dispatchers: { 'PASTE-YOUR-UID-HERE': true },
  devices: { 'PASTE-POLE-BOX-UID-HERE': true },
}
// Firebase rejects undefined values
writeFileSync('firebase-seed.json', JSON.stringify(seed, (_k, v) => (v === undefined ? null : v), 2))
console.log('Wrote firebase-seed.json')
