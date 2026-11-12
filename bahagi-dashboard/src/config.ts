const env = import.meta.env

const src = env.VITE_SENSOR_SOURCE as string

export const config = {
  // true = sample data in memory; false = everything comes from Firebase Realtime Database (+ Supabase for photos)
  useMock: env.VITE_USE_MOCK !== 'false',
  apiBase: (env.VITE_API_BASE as string) ?? '/api',
  firebase: {
    apiKey: (env.VITE_FIREBASE_API_KEY as string) ?? '',
    authDomain: (env.VITE_FIREBASE_AUTH_DOMAIN as string) ?? '',
    databaseURL: (env.VITE_FIREBASE_DATABASE_URL as string) ?? '',
    projectId: (env.VITE_FIREBASE_PROJECT_ID as string) ?? '',
    appId: (env.VITE_FIREBASE_APP_ID as string) ?? '',
  },
  firebaseEmulator: (env.VITE_FIREBASE_EMULATOR as string) ?? '',
  supabase: {
    url: (env.VITE_SUPABASE_URL as string) ?? '',
    anonKey: (env.VITE_SUPABASE_ANON_KEY as string) ?? '',
    bucket: (env.VITE_SUPABASE_BUCKET as string) ?? 'report-photos',
    // public bucket = plain URLs; private bucket = signed URLs that last an hour
    publicBucket: env.VITE_SUPABASE_PUBLIC_BUCKET !== 'false',
  },
  // how long the dashboard waits for the backend bridge to switch + send SMS before saying "queued"
  commandTimeoutMs: 20_000,
  // the backend bridge writes a heartbeat every 10 s; older than this = shown as offline
  workerStaleMs: 30_000,
  // 'firebase' (default) = pole box writes /sensors/{pole} in Firebase; 'poll' = GET /api/sensors every 2 s; 'mqtt' = AWS IoT Core
  sensorSource: src === 'mqtt' ? 'mqtt' : src === 'poll' ? 'poll' : 'firebase',
  pollMs: 2000,
  mqttTopic: (env.VITE_MQTT_TOPIC as string) ?? 'bahagi/sensors/+/level',
  sensorHeightCm: Number(env.VITE_SENSOR_HEIGHT_CM ?? 20),
  thresholds:
    env.VITE_SCALE === 'real'
      ? { gutter: 20, knee: 48, waist: 94 } // MMDA flood gauge (cm)
      : { gutter: 1, knee: 4.8, waist: 8 }, // 1:10 tabletop model (same lines as the pole box and the Messenger bot)
  // Facebook Page username or ID of the BAHAGI Messenger bot (builds https://m.me/<page>)
  messengerPage: (env.VITE_MESSENGER_PAGE as string) ?? '',
  offlineAfterMs: 15_000,
  // rain forecast: 'openmeteo' (no key) or 'openweathermap' (needs VITE_OWM_KEY; the key is visible in the browser, fine for a hackathon)
  rainProvider: (env.VITE_RAIN_PROVIDER as string) === 'openweathermap' ? 'openweathermap' : 'openmeteo',
  owmKey: (env.VITE_OWM_KEY as string) ?? '',
}
