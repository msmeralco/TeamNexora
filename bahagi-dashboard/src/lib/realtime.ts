import { config } from '../config'
import type { SensorReading } from '../types'
import { api } from './api'

export type LinkStatus = 'connecting' | 'live' | 'mock' | 'offline'

/**
 * ESP32 + HC-SR04 → AWS IoT Core (MQTT) → browser over WebSocket.
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
