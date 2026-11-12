export type Level = 'dry' | 'gutter' | 'knee' | 'waist'

/** UP NOAH flood hazard class at a street: low 0.1–0.5 m, medium 0.5–1.5 m, high over 1.5 m. */
export type Hazard = 'none' | 'low' | 'medium' | 'high'
export interface NoahHazard { y5: Hazard; y25: Hazard; y100: Hazard }

export interface Pole { id: string; name: string; lat: number; lng: number }
/** One street = one or more ESP32 pole sensors + one switch (S1, S2…) on the feeder. */
export interface Street { id: string; name: string; switchId: string; lat: number; lng: number; poles: Pole[]; powerOff?: boolean; noah?: NoahHazard; transformer?: string; homes?: number; metersOff?: string[] }
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
  source: 'messenger' | 'viber' | 'sms' | 'web'
  /** Object path inside the Supabase Storage bucket, e.g. "reports/2026/11/-Nx3abc.jpg". The dashboard turns it into photoUrl. */
  photoPath?: string
  photoUrl?: string
  note: string
  estimatedCm: number
  confidence: number // 0..1 from the vision model
  duplicate?: boolean
  counted?: boolean // false = BAHAGI checked it and is not using it (copy, old, far, not a flood, sensor disagrees)
  liveWireRisk?: boolean
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

/** One line in the alerts feed: a box problem, a flood, a decision waiting, or something that just happened. */
export interface Alert {
  id: string
  severity: 'critical' | 'warning' | 'info'
  kind: string // box_offline, box_waiting, box_restart, sensor_error, weak_wifi, lcd_missing, flood, approval, sms_failed, meter_off, live_wire, cut, restore, photo_rejected…
  title: string
  detail: string
  streetId?: string | null
  active: boolean // true = still true right now; false = an event from the last 30 minutes
  ts: number
}

/** The pole box's own health, as it reports it with every reading. */
export interface BoxHealth {
  online: boolean
  lastSeenS: number | null
  uptimeS: number | null
  rssi: number | null
  lcdOk: boolean | null
  sensorOk: boolean | null
  dryCm: number | null
  boot: string | null // power_on, brownout, crash, watchdog, reset_button…
}

export interface AlertFeed { active: Alert[]; recent: Alert[]; box: BoxHealth | null }
