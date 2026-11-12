import { config } from '../config'
import type { SensorReading } from '../types'
import { api } from './api'
import { sync } from './sync'

export type LinkStatus = 'connecting' | 'live' | 'mock' | 'offline'

/**
 * Pole box (ESP32 + HC-SR04) → Firebase /sensors/{pole} → browser (VITE_SENSOR_SOURCE=firebase, default)
 * or pole box → BAHAGI backend → GET /api/sensors every 2 s  (VITE_SENSOR_SOURCE=poll)
 * or ESP32 → AWS IoT Core (MQTT) → browser over WebSocket                    (VITE_SENSOR_SOURCE=mqtt)
 * ESP32 payload: {"pole":"P1","level_cm":5.1}  (or {"pole":"P1","distance_cm":14.9} → level = sensorHeight − distance)
 * Returns a disconnect function.
 */
export function connectRealtime(
  poleIds: string[],
  onReading: (r: SensorReading) => void,
  onStatus: (s: LinkStatus) => void,
): () => void {
  let dead = false
  let stop = () => {}

  if (config.useMock) {
    onStatus('mock')
    const base: Record<string, number> = Object.fromEntries(poleIds.map((id) => [id, id === 'P1' ? 5.1 : 0.4]))
    const tick = () =>
      poleIds.forEach((id) =>
        onReading({ poleId: id, levelCm: Math.max(0, base[id] + (Math.random() - 0.5) * 0.6), ts: Date.now() }),
      )
    tick()
    const t = setInterval(tick, 2000)
    return () => clearInterval(t)
  }

  if (config.sensorSource === 'firebase') {
    // Pole box writes /sensors/{pole} in Firebase; every dashboard gets each new reading pushed to it
    onStatus('connecting')
    let last: { online: boolean; ts: number }[] = []
    const judge = () => {
      const fresh = last.some((r) => r.online && Date.now() - r.ts < config.offlineAfterMs)
      onStatus(fresh ? 'live' : last.length ? 'offline' : 'connecting')
    }
    const off = sync.sensors((rows) => {
      last = rows
      rows.forEach((r) => onReading({ poleId: r.poleId, levelCm: r.levelCm, ts: r.ts }))
      judge()
    }, () => onStatus('offline'))
    const t = setInterval(judge, 5000) // the box going quiet fires no event, so re-check
    return () => { off(); clearInterval(t) }
  }

  if (config.sensorSource === 'poll') {
    // BAHAGI backend: the pole box posts to the laptop every 2 s; we read the latest values back
    onStatus('connecting')
    const tick = () =>
      api.sensors()
        .then((rows) => {
          if (dead) return
          rows.forEach((r) => onReading({ poleId: r.poleId, levelCm: Math.max(0, r.levelCm), ts: r.online ? Date.now() : r.ts }))
          onStatus(rows.some((r) => r.online) ? 'live' : rows.length ? 'offline' : 'connecting')
        })
        .catch(() => !dead && onStatus('offline'))
    tick()
    const t = setInterval(tick, config.pollMs)
    return () => { dead = true; clearInterval(t) }
  }

  ;(async () => {
    try {
      onStatus('connecting')
      const { url } = await api.iotUrl()
      const { connect } = await import('mqtt')
      if (dead) return
      const client = connect(url, { reconnectPeriod: 3000 })
      client.on('connect', () => { onStatus('live'); client.subscribe(config.mqttTopic) })
      client.on('close', () => onStatus('offline'))
      client.on('message', (_topic, buf) => {
        try {
          const p = JSON.parse(buf.toString())
          const cm = p.level_cm ?? config.sensorHeightCm - p.distance_cm
          if (typeof p.pole === 'string' && Number.isFinite(cm))
            onReading({ poleId: p.pole, levelCm: Math.max(0, cm), ts: p.ts ?? Date.now() })
        } catch { /* ignore malformed payloads */ }
      })
      stop = () => client.end(true)
    } catch { onStatus('offline') }
  })()

  return () => { dead = true; stop() }
}
