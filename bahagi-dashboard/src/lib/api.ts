import { config } from '../config'
import type { Recommendation, Region, Report } from '../types'
import { mockRecs, mockRegions, mockReports } from './mockData'

/** What the backend reports after it sends the SMS alerts for an action. */
export interface SmsResult { smsSent: number; smsFailed?: number }

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(config.apiBase + path, { headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

/**
 * Backend contract (API Gateway/Lambda behind AWS):
 *  GET  /regions                      → Region[]  (region > city > barangay > street > poles; street.powerOff=true if already cut; street.noah = NOAH 5/25/100-yr hazard class extracted from the NOAH shapefiles at the street's coordinates)
 *  GET  /reports                      → Report[]  (Messenger/Viber/SMS reports scored by Bedrock; include streetId when known)
 *  GET  /recommendations              → Recommendation[]  (PASYA: fewest switch moves)
 *  POST /recommendations/:id/approve  → backend publishes bahagi/switch/{id}/cmd {"switch":"S1","state":"open"} to IoT Core, sends the "live wire / power cut" SMS, archives the street's reports. Returns SmsResult
 *  POST /recommendations/:id/reject
 *  POST /streets/:id/restore          → dispatcher restores a street: backend publishes {"switch":"S1","state":"close"}, then sends a second SMS: "power restored". Returns SmsResult
 *  GET  /iot/ws-url                   → { url } SigV4-presigned wss:// URL for IoT Core (short-lived, no keys in the browser)
 * The browser NEVER publishes switch commands itself: a human approves, the backend acts.
 */
export const api = {
  regions: () => (config.useMock ? Promise.resolve(mockRegions) : http<Region[]>('/regions')),
  reports: () => (config.useMock ? Promise.resolve(mockReports) : http<Report[]>('/reports')),
  recommendations: () => (config.useMock ? Promise.resolve(mockRecs) : http<Recommendation[]>('/recommendations')),
  decide: (id: string, decision: 'approve' | 'reject') =>
    config.useMock ? Promise.resolve<SmsResult>({ smsSent: decision === 'approve' ? 12 : 0 }) : http<SmsResult>(`/recommendations/${id}/${decision}`, { method: 'POST' }),
  restore: (streetId: string) =>
    config.useMock ? Promise.resolve<SmsResult>({ smsSent: 12 }) : http<SmsResult>(`/streets/${streetId}/restore`, { method: 'POST' }),
  iotUrl: () => http<{ url: string }>('/iot/ws-url'),
}
