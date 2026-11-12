export type Level = 'dry' | 'gutter' | 'knee' | 'waist'

/** UP NOAH flood hazard class at a street: low 0.1–0.5 m, medium 0.5–1.5 m, high over 1.5 m. */
export type Hazard = 'none' | 'low' | 'medium' | 'high'
export interface NoahHazard { y5: Hazard; y25: Hazard; y100: Hazard }

export interface Pole { id: string; name: string; lat: number; lng: number }
/** One street = one or more ESP32 pole sensors + one switch (S1, S2…) on the feeder. */
export interface Street { id: string; name: string; switchId: string; lat: number; lng: number; poles: Pole[]; powerOff?: boolean; noah?: NoahHazard }
export interface Barangay { id: string; name: string; lat: number; lng: number; streets: Street[] }
/** Street with its parents attached, used by the map, header and filters. */
export type FlatStreet = Street & { barangayId: string; barangayName: string }
export interface City { id: string; name: string; barangays: Barangay[] }
export interface Region { id: string; name: string; cities: City[] }

export type Scope =
  | { type: 'all' }
  | { type: 'region' | 'city' | 'barangay' | 'street'; id: string }

/** One MQTT message from an ESP32 pole sensor, after normalising. */
export interface SensorReading { poleId: string; levelCm: number; ts: number }

export interface Report {
  id: string
  barangayId: string
  streetId?: string
  source: 'messenger' | 'viber' | 'sms'
  photoUrl?: string
  note: string
  estimatedCm: number
  confidence: number // 0..1 from the vision model
  duplicate?: boolean
  ts: number
}

export interface Recommendation {
  id: string
  barangayId: string
  streetId: string
  switchId: string
  action: 'open' | 'close'
  title: string
  homesCut: number
  homesKept: number
  evidence: string[]
  status: 'pending' | 'approved' | 'rejected'
}
