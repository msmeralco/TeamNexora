# BAHAGI dashboard (Vite + React + TypeScript + Tailwind v4)

    npm install firebase @supabase/supabase-js
    cp .env.example .env      # fill in Firebase + Supabase
    npm run dev

`VITE_USE_MOCK=true` runs on sample data in memory (no Firebase needed). With `VITE_USE_MOCK=false` the whole dashboard runs live from **Firebase Realtime Database**, with report photos in **Supabase Storage**. Nothing polls: every change is pushed to every open dashboard the moment it hits the database.

## Firebase + Supabase setup (once)

1. **Firebase**: create a project and a Realtime Database (Singapore / asia-southeast1). Add a Web app and copy its config into `.env`. In Authentication → Sign-in method, turn on **Anonymous**.
2. **Rules**: paste `firebase/database.rules.json` into Realtime Database → Rules → Publish (or `firebase deploy --only database` from `./firebase`).
3. **Data**: `npx vite-node scripts/export-firebase-seed.ts` writes `firebase-seed.json` from the sample data. Import it in Realtime Database → ⋮ → Import JSON (this replaces the database).
4. **Dispatchers**: open the dashboard and click Approve once. The error shows this browser's uid; add `dispatchers/<uid>: true` in the database. Only those browsers can approve or restore. Pole boxes that write `/sensors` go under `devices/<uid>: true` the same way.
5. **Supabase**: create a project, run `supabase/storage.sql` in the SQL Editor (makes the `report-photos` bucket and the upload policy), and put the URL + **anon** key in `.env`.
6. **Bridge**: on the laptop next to the BAHAGI backend: `cd backend/firebase-bridge && npm install && cp .env.example .env` (add a service-account key), then `npm start`. It carries out approvals and restores through the backend's existing endpoints and mirrors the laptop's sensors, alerts, recommendations and power state into Firebase. The dashboard shows a critical alert when the bridge isn't running.

## Database layout

| Path | What | Written by |
|---|---|---|
| `/regions/{id}` | region → cities → barangays → streets → poles (keyed by id) | seed / admin |
| `/reports/{id}` | `Report`, with `photoPath` = object path in Supabase bucket | Messenger webhook (`report-store.ts`), web form (`sync.submitReport`) |
| `/archive/reports/{id}` | reports cleared after a street was cut | bridge |
| `/recommendations/{id}` | `Recommendation` | backend (via bridge mirror) |
| `/recommendations/{id}/status` | pending → approved/rejected, in a transaction (one dispatcher wins) | dashboard |
| `/commands/{pushId}` | approve / reject / restore, `queued → running → done/error`, `smsSent` | dashboard queues, bridge runs |
| `/power/{streetId}` | `{ off, since, switchId }`; present = street has no power | bridge, after the switch actually moved |
| `/sensors/{poleId}` | `{ level_cm or distance_cm, ts: {".sv":"timestamp"} }` | pole box (or bridge mirror) |
| `/alerts/{active,recent}/{id}`, `/alerts/box` | `AlertFeed` | backend (via bridge mirror) |
| `/status/worker` | bridge heartbeat every 10 s | bridge |

Safety stays the same: **the browser never switches anything.** It records the decision and queues a command; the bridge calls the backend (IoT Core + SMS) and writes `/power` only after that succeeds. If the backend fails, the recommendation goes back to pending and the dispatcher sees the error.

Pole box straight to Firebase (`VITE_SENSOR_SOURCE=firebase`, the default): `PUT {databaseURL}/sensors/P1.json?auth=<idToken>` with `{"level_cm":5.1,"ts":{".sv":"timestamp"}}`. Until the box does that, the bridge mirror copies `/api/sensors` from the laptop.

Note: the backend still computes recommendations from its own reports. Point the Messenger webhook at `saveReport()` (Firebase + Supabase), and have the backend read reports from Firebase (`/reports`) so PASYA sees them too.

## Integration points (original)
- `src/lib/realtime.ts`: ESP32 + HC-SR04 → AWS IoT Core (MQTT over WSS). Topic from `VITE_MQTT_TOPIC`; payload `{"pole":"P1","level_cm":5.1}`.
- `src/lib/sync.ts`: the live Firebase/Supabase data layer the dashboard uses. `src/lib/api.ts`: REST contract of the laptop backend (now called by the bridge; the dashboard only uses it for `poll`/`mqtt` sensors) (regions, reports from Bedrock, recommendations, approve/reject, presigned IoT URL).
- Approve/Reject only calls the backend. The backend publishes the switch command to IoT Core and sends the SMS.
- Power state: approving an `open` recommendation marks the street OFF (black tile + crossed bolt on the map, OFF tag in the sidebar, header chip). The outage card restores it via `POST /streets/:id/restore`; the backend publishes `close` and sends the SMS. If water is still above the gutter level the dispatcher must confirm.
- Approving a cut clears that street's reports from the Reports list (backend should archive them). Restoring power triggers a second SMS ("power restored"); both endpoints return `{ smsSent, smsFailed? }` and the dashboard shows the result.
- Recommendations appear only for streets with at least one non-duplicate resident report.
- Map page: the UP NOAH flood hazard layer can be switched between 5-, 25- and 100-year return periods using each street's `street.noah` classes.
- Forecast page: rain from Open-Meteo (default, no key) or OpenWeatherMap (`VITE_RAIN_PROVIDER`, `VITE_OWM_KEY`), displayed with an OpenStreetMap basemap; 5/25/100-year hazard comes from `street.noah` (extract it from the NOAH shapefiles in the backend).
- Messenger bot: `backend/messenger-webhook.ts` is the Lambda webhook (Meta verification, signature check, photo → location → street → Bedrock → saved report → Messenger reply). Fill in the TODO functions. The dashboard polls `/reports` and `/recommendations` every 10 s in live mode and shows the bot link from `VITE_MESSENGER_PAGE`.
- `src/config.ts`: flood-level thresholds (demo 1:10 scale or real MMDA scale).
