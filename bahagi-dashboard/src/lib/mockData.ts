// SAMPLE DATA ONLY (coordinates and NOAH hazard classes are illustrative). Replace via the backend: GET /regions, /reports, /recommendations.
import type { Recommendation, Region, Report } from '../types'

const now = Date.now()

export const mockRegions: Region[] = [
  {
    id: 'ncr', name: 'NCR',
    cities: [
      {
        id: 'pasig', name: 'Pasig City',
        barangays: [
          { id: 'kapitolyo', name: 'Brgy. Kapitolyo', lat: 14.5733, lng: 121.0575,
            streets: [
              { id: 'estero', name: 'Estero St.', switchId: 'S1', noah: { y5: 'high', y25: 'high', y100: 'high' }, lat: 14.5738, lng: 121.0584,
                poles: [{ id: 'P1', name: 'Pole P1 · Estero St.', lat: 14.5738, lng: 121.0584 }] },
              { id: 'mabini', name: 'Mabini St.', switchId: 'S2', noah: { y5: 'medium', y25: 'high', y100: 'high' }, lat: 14.5731, lng: 121.0575,
                poles: [{ id: 'P2', name: 'Pole P2 · Mabini St.', lat: 14.5731, lng: 121.0575 }] },
              { id: 'rizal', name: 'Rizal St.', switchId: 'S3', noah: { y5: 'low', y25: 'medium', y100: 'high' }, lat: 14.5724, lng: 121.0566,
                poles: [{ id: 'P3', name: 'Pole P3 · Rizal St.', lat: 14.5724, lng: 121.0566 }] },
            ] },
          { id: 'ugong', name: 'Brgy. Ugong', lat: 14.5645, lng: 121.0679,
            streets: [{ id: 'ugong-norte', name: 'Ugong Norte Rd.', switchId: 'S4', noah: { y5: 'low', y25: 'medium', y100: 'medium' }, lat: 14.5649, lng: 121.0684,
              poles: [{ id: 'P4', name: 'Pole P4 · Ugong Norte Rd.', lat: 14.5649, lng: 121.0684 }] }] },
        ],
      },
      {
        id: 'qc', name: 'Quezon City',
        barangays: [
          { id: 'bahay-toro', name: 'Brgy. Bahay Toro', lat: 14.6692, lng: 121.0278,
            streets: [{ id: 'visayas', name: 'Visayas Ave.', switchId: 'S5', noah: { y5: 'none', y25: 'low', y100: 'medium' }, lat: 14.6696, lng: 121.0283,
              poles: [{ id: 'P5', name: 'Pole P5 · Visayas Ave.', lat: 14.6696, lng: 121.0283 }] }] },
        ],
      },
      {
        id: 'marikina', name: 'Marikina City',
        barangays: [
          { id: 'tumana', name: 'Brgy. Tumana', lat: 14.6576, lng: 121.0955,
            streets: [{ id: 'riverbanks', name: 'Riverbanks Rd.', switchId: 'S6', noah: { y5: 'high', y25: 'high', y100: 'high' }, lat: 14.6581, lng: 121.0961,
              poles: [{ id: 'P6', name: 'Pole P6 · Riverbanks Rd.', lat: 14.6581, lng: 121.0961 }] }] },
        ],
      },
    ],
  },
]

export const mockReports: Report[] = [
  { id: 'r1', barangayId: 'kapitolyo', streetId: 'estero', source: 'messenger', note: 'Tubig na hanggang tuhod sa Estero St.', estimatedCm: 5, confidence: 0.91, ts: now - 90_000 },
  { id: 'r2', barangayId: 'kapitolyo', streetId: 'estero', source: 'viber', note: 'May nakalubog na poste', estimatedCm: 6, confidence: 0.84, ts: now - 240_000 },
  { id: 'r3', barangayId: 'kapitolyo', streetId: 'estero', source: 'messenger', note: 'Same photo as earlier', estimatedCm: 5, confidence: 0.91, duplicate: true, ts: now - 600_000 },
  { id: 'r4', barangayId: 'tumana', streetId: 'riverbanks', source: 'sms', note: 'Umaapaw na ang ilog', estimatedCm: 2, confidence: 0.55, ts: now - 1_200_000 },
]

export const mockRecs: Recommendation[] = [
  {
    id: 'rec1', barangayId: 'kapitolyo', streetId: 'estero', switchId: 'S1', action: 'open',
    title: 'Open switch S1 · Estero St.',
    homesCut: 4, homesKept: 8,
    evidence: ['Pole sensor P1 at knee level', 'Resident photo agrees (91%)', 'Rain forecast + NOAH high-hazard'],
    status: 'pending',
  },
]
