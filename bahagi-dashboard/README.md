# BAHAGI dashboard (Vite + React + TypeScript + Tailwind v4)

    npm install
    cp .env.example .env
    npm run dev

`VITE_USE_MOCK=true` runs with sample data and simulated sensors. Set it to `false` once the backend is up.

## Integration points
- `src/lib/realtime.ts`: ESP32 + HC-SR04 → AWS IoT Core (MQTT over WSS). Topic from `VITE_MQTT_TOPIC`; payload `{"pole":"P1","level_cm":5.1}`.
- `src/lib/api.ts`: REST contract for the backend (regions, reports from Bedrock, recommendations, approve/reject, presigned IoT URL).
- Approve/Reject only calls the backend. The backend publishes the switch command to IoT Core and sends the SMS.
- Power state: approving an `open` recommendation marks the street OFF (black tile + crossed bolt on the map, OFF tag in the sidebar, header chip). The outage card restores it via `POST /streets/:id/restore`; the backend publishes `close` and sends the SMS. If water is still above the gutter level the dispatcher must confirm.
- Approving a cut clears that street's reports from the Reports list (backend should archive them). Restoring power triggers a second SMS ("power restored"); both endpoints return `{ smsSent, smsFailed? }` and the dashboard shows the result.
- Recommendations appear only for streets with at least one non-duplicate resident report.
- Forecast page: rain from Open-Meteo (default, no key) or OpenWeatherMap (`VITE_RAIN_PROVIDER`, `VITE_OWM_KEY`); 5/25/100-year hazard comes from `street.noah` (extract it from the NOAH shapefiles in the backend).
- `src/config.ts`: flood-level thresholds (demo 1:10 scale or real MMDA scale).
