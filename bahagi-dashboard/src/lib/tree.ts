import type { FlatStreet, Region, Scope } from '../types'

export function streetsIn(regions: Region[], scope: Scope): FlatStreet[] {
  const out: FlatStreet[] = []
  for (const r of regions)
    for (const c of r.cities)
      for (const b of c.barangays)
        for (const s of b.streets) {
          if (
            scope.type === 'all' ||
            (scope.type === 'region' && r.id === scope.id) ||
            (scope.type === 'city' && c.id === scope.id) ||
            (scope.type === 'barangay' && b.id === scope.id) ||
            (scope.type === 'street' && s.id === scope.id)
          ) out.push({ ...s, barangayId: b.id, barangayName: b.name })
        }
  return out
}

export function scopeLabel(regions: Region[], scope: Scope): string {
  if (scope.type === 'all') return 'All regions'
  for (const r of regions) {
    if (scope.type === 'region' && r.id === scope.id) return r.name
    for (const c of r.cities) {
      if (scope.type === 'city' && c.id === scope.id) return `${c.name}, ${r.name}`
      for (const b of c.barangays) {
        if (scope.type === 'barangay' && b.id === scope.id) return `${b.name}, ${c.name}`
        for (const s of b.streets) if (scope.type === 'street' && s.id === scope.id) return `${s.name}, ${b.name}`
      }
    }
  }
  return 'All regions'
}
