const env = import.meta.env

export const config = {
  useMock: env.VITE_USE_MOCK !== 'false',
  apiBase: (env.VITE_API_BASE as string) ?? '/api',
  mqttTopic: (env.VITE_MQTT_TOPIC as string) ?? 'bahagi/sensors/+/level',
  sensorHeightCm: Number(env.VITE_SENSOR_HEIGHT_CM ?? 20),
  thresholds:
    env.VITE_SCALE === 'real'
      ? { gutter: 20, knee: 48, waist: 94 } // MMDA flood gauge (cm)
      : { gutter: 2, knee: 5, waist: 9 }, // 1:10 tabletop model
  offlineAfterMs: 15_000,
  // rain forecast: 'openmeteo' (no key) or 'openweathermap' (needs VITE_OWM_KEY; the key is visible in the browser, fine for a hackathon)
  rainProvider: (env.VITE_RAIN_PROVIDER as string) === 'openweathermap' ? 'openweathermap' : 'openmeteo',
  owmKey: (env.VITE_OWM_KEY as string) ?? '',
}
