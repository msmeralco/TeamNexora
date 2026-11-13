# BAHAGI backend

*Bahagi lang, hindi buong barangay.* The laptop server that joins the ESP32 box, the rules, your dashboard, SMS and the photo AI.

```
ESP32 box ──POST /esp/reading every 2 s──▶  BACKEND  ◀── GET /state every 2 s ── your dashboard
          ◀── reply {"cut": ["S1"]} ─────      │     ── POST approve / reject / restore ──▶
                                               ├── SILIP: resident photos  (POST /reports, /report page)
                                               ├── TAYA:  rain forecast    (Open-Meteo)
                                               ├── PASYA: 2-signal rule + per-home flood map → transformer or smart-meter cut
                                               └── BABALA: SMS near the affected homes + WATCH texts (Semaphore / Twilio / AWS SNS)
```

## Run it (5 minutes)

**Windows, one click:** double-click `START_BAHAGI.bat`. The first run installs everything (1-2 min, needs internet); if Windows asks about the firewall, tick Private and Public and click Allow. It then opens `/docs`.

**No phone signal at the venue?** Turn on Windows **Mobile hotspot** (Settings > Network & internet > Mobile hotspot, band 2.4 GHz) and put that hotspot's name and password in the ESP32 code. The laptop keeps its own internet, and the ESP32 finds the laptop by itself: the backend announces itself every 2 s on UDP port 4210 and the firmware's `BACKEND = "auto"` listens for it. On a Windows hotspot the laptop is always `192.168.137.1`.

```bash
cd bahagi-backend
python -m venv .venv
# Windows: .venv\Scripts\activate      Mac/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env                 # Mac/Linux: cp .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- **API docs with try-it buttons:** <http://localhost:8000/docs>
- **Resident report page (open on a phone):** `http://<laptop-ip>:8000/report`
- **Tests:** `pytest -q` (25 tests: flood → two signals → per-home flood map → transformer + smart-meter cut → approve → relay + SMS → restore, the fake-photo checks, the dashboard API and its alerts)

Find the laptop's IP: Windows `ipconfig` (IPv4 Address), Mac `ipconfig getifaddr en0`.
The laptop, the ESP32 and any phones must be on the **same Wi-Fi or phone hotspot**.
If Windows asks about the firewall when uvicorn starts, click **Allow**.

## Connect the ESP32

In `bahagi_firmware.ino`, set:

```cpp
const char* WIFI_SSID = "YourHotspot";
const char* WIFI_PASS = "password";
const char* BACKEND   = "http://192.168.x.x:8000";   // the laptop's IP
```

Upload, open Serial Monitor: you should see `[NET] connecting ... ok`. In `/docs` → `GET /state`, `sensor.online` becomes `true`.

## Who uses what

| User | What they use | What they get |
|---|---|---|
| **Meralco dispatcher / control room** (the dashboard's only user) | `GET /state`, Approve / Reject / Restore | Which homes are wet (by elevation), the smallest cut Meralco can actually make, the evidence behind it, the fake-photo checks, an audit log |
| **Field crew** | APPROVE / RESTORE button on the pole box | Can act on site, even if the network is down |
| **Residents / customers** | the `/report` page (or Messenger/Viber bot), SMS, `GET /customer/status` | A warning before the water reaches the wires, power kept ON if their home is dry, a text when power returns |

**Customer benefit:** only wet homes go dark, so dry neighbours keep their ref, lights, phones and medical devices. Homes near the water get a WATCH text before anything is cut, and nobody gets electrocuted by a live line in floodwater.
**Meralco benefit:** fewer customers interrupted per flood (better reliability numbers), linemen don't wade in to check, transformers and meters switched off before they're flooded, eyes on areas with traditional meters (crowd photos), and a logged, human-approved decision for every cut.

## The team dashboard (bahagi-dashboard) and alerts

`START_BAHAGI.bat` opens **http://localhost:8000/**: your team's React dashboard, already built (in `dashboard/`), now live instead of sample data. No Node install needed on the laptop.

- **Sensor:** the dashboard reads the pole box every 2 s from `GET /api/sensors` (no AWS IoT needed).
- **Alerts bar** (`GET /api/alerts`, every 2 s), red = critical, yellow = warning, grey = info:
  - pole box **offline**, or never connected (check its power and the hotspot)
  - **sensor can't read** the water (no echo)
  - box **restarted**: a **power dip (brownout)** is called out, so you know to use a stronger supply
  - **weak Wi-Fi** at the box, box **screen not detected**
  - **knee-deep water** at a pole, **cut waiting for approval**, **SMS failed**, **smart meter off**
  - **Messenger bot link** down, a resident photo showing **water near live equipment**
  - plus *Recent events* from the last 30 minutes: cuts, restores, rejected or duplicate photos
- **Messenger bot reports:** the backend reads the bot's Firebase `/reports` every 4 s (`FIREBASE_DATABASE_URL`) and counts them as photo signals, after the same checks.
- **Approve / Reject / Restore** on the dashboard switch the real relays within 2 s. A cut or restore done with the button on the box shows on the dashboard too.
- Rebuild the dashboard after changing it: in `bahagi-dashboard`, `npm install`, then `VITE_USE_MOCK=false VITE_API_BASE=/api npm run build`, then copy `dist/` to `bahagi-backend/dashboard/`. For development, `npm run dev` with `VITE_USE_MOCK=false` proxies `/api` to this backend on port 8000.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/regions` | region > city > barangay > streets (`powerOff`, `metersOff`, NOAH) |
| GET | `/api/reports` | resident reports (web page + Messenger bot), with `counted` |
| GET | `/api/recommendations` | the current recommendation |
| POST | `/api/recommendations/{id}/approve` · `/reject` | `{smsSent, smsFailed?}` |
| POST | `/api/streets/{id}/restore` | `{smsSent, smsFailed?}` (also brings back smart meters cut with it) |
| GET | `/api/sensors` | latest pole-box reading |
| GET | `/api/alerts` | `{active, recent, box}` |

## The rules (PASYA)

Meralco's switching hierarchy is **substation > feeder > transformer > meter**. BAHAGI only recommends cuts Meralco can actually make:

1. **Per home, not per street.** Each home in `data/feeder.json` has a ground elevation and a meter type. A reading gives a water-surface height; every home within `FLOOD_REACH_M` gets `local depth = water surface - home elevation`. A winding street can be half wet: the raised house stays dry, the low corner lot floods.
2. **Buffer.** A home is cut if its local depth is at danger (`DANGER_DEPTH_M`, about knee) **or within `BUFFER_DEPTH_M` of it**, because water seeps into the next lane. Homes within `WATCH_DEPTH_M` get a **WATCH** text and keep their power.
3. **Smallest cut Meralco can make, per transformer:**
   - water at the transformer's pole, or any home in danger with a **traditional meter** → **open the transformer** (that's the only switch Meralco has for those homes);
   - only **smart-meter** homes in danger → **remote-disconnect just those meters**; the transformer stays ON.
4. **Two independent signals for photos.** A photo is confirmed only when at least `MIN_SOURCES` signals within `CORROBORATE_M` agree: the pole sensor, resident photos (up to 2 count), heavy rain forecast (≥ 7.5 mm/h in the next 3 h). Rain alone never cuts anyone. The pole sensor is a measurement, so with `SENSOR_ALONE=1` (default) a knee-level reading recommends cutting its own street by itself.
5. **One street per recommendation.** Each street with its own report or sensor reading gets its own card, one at a time. A nearby street that the flood map puts at risk but nobody reported is only offered afterwards as a separate **Optional** card (approve or reject it); its homes get a warning text either way. `SUGGEST_NEIGHBORS=0` turns those optional cards off. The lid APPROVE button only ever cuts the box's own street (Estero).
6. **A measurement beats an estimate.** Where the pole sensor is closer to a home than the photo is, the sensor's level is used.
7. **Nothing switches until a person approves**, on the dashboard or with the APPROVE button on the box lid.
8. On approval: the transformer relay opens on the box's next post (≤ 2 s), smart meters are disconnected (simulated AMI command, shown on the dashboard), and SMS goes to people within `SMS_RADIUS_M` of the **affected homes** (not the whole barangay), plus a WATCH text to homes near the water.
9. **Restore** (dashboard, or holding the lid button 2 s) closes everything and texts the same people.

> In the tabletop model, each relay (S1, S2, S3) is one transformer (TR-1, TR-2, TR-3). Smart-meter disconnects aren't wired to the box; they show on the dashboard. (Optional: wire relay K4 to one house to show a single smart meter going off.)

> Demo with the sensor only (no photo)? It works out of the box (`SENSOR_ALONE=1`). To show the two-signal rule live, set `SENSOR_ALONE=0` and send one photo from the `/report` page.

## Where AI is used (and where it isn't)

No model is trained. A general vision model on Amazon Bedrock **cross-checks** each photo: is it a real outdoor street flood (not a bathtub, indoor floor, screenshot, stock or edited image), and roughly how deep against the MMDA gauge. That answer is one more piece of evidence. **The cut is decided by fixed, explainable rules and then by a person.** The AI can stop a photo from counting; it can never cut power by itself.

## Fake or recycled photos

A photo is **not counted** if any of these is true (the dashboard shows why, in `reports[].flags`):

| Check | Catches |
|---|---|
| AI scene check | bathtub, basin, indoor floor, no flood, screenshot, meme, edited or AI-generated image |
| Exact hash + visual fingerprint (dHash) | the same photo sent twice, or a resized / re-saved / forwarded copy |
| EXIF time older than `PHOTO_MAX_AGE_H` | an old flood photo or one downloaded from the internet |
| EXIF GPS, or the sender's live GPS, more than `PHOTO_MAX_DIST_M` from the street | a photo from somewhere else |
| Same sender within 10 min | one person spamming |
| **The pole sensor nearby reads much lower** (`reports[].contradicted`) | a fake that passes everything else |

And even a photo that passes **can't trigger a cut on its own**: it needs a second, independent signal, and then a person approves. Messenger and Viber strip EXIF, so a photo without EXIF isn't penalised; the other checks still apply. Senders' numbers are stored only as a short hash.

## SMS (BABALA)

`.env` → `SMS_PROVIDER=`

| Provider | Set | Notes |
|---|---|---|
| `console` (default) | nothing | prints the texts in the terminal, nothing is sent |
| `semaphore` | `SEMAPHORE_API_KEY`, optional `SEMAPHORE_SENDER` | Philippine SMS gateway, prepaid credits |
| `twilio` | `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` | trial accounts only text verified numbers |
| `sns` | AWS credentials on the laptop, `AWS_REGION` | Amazon SNS |

Put your teammates' and judges' numbers in `data/subscribers.csv` (with a lat/lon near the demo street, see the file) to have their phones buzz during the demo. Never commit real API keys to GitHub; `.env` is for that.

## Photo AI (SILIP)

`VISION_PROVIDER=manual` (default) uses the level the resident picked on the form.
`VISION_PROVIDER=bedrock` sends the photo to a vision model on **Amazon Bedrock** (`BEDROCK_MODEL_ID`, `BEDROCK_REGION`). It needs AWS credentials on the laptop (`aws configure`) and model access enabled in the Bedrock console. If the AI call fails, the backend falls back to the resident's own level and logs why.

Messenger / Viber / SMS bots: have the bot forward the photo to `POST /reports` (multipart, same fields as the form below) with `channel=Messenger` etc.

## API for your own website

Base URL `http://<laptop-ip>:8000`. CORS is open (`CORS_ORIGINS=*`).

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/state` | | everything the dashboard shows (below) |
| POST | `/recommendations/{id}/approve` | | new state |
| POST | `/recommendations/{id}/reject` | | new state |
| POST | `/restore` | optional `{"switches": ["S1", "M1"]}` (relays and/or smart meters) | new state |
| POST | `/reports` | multipart: `photo` (file), `street` or `poleId` or `lat`+`lon`, `level`, `channel`, `sender` | the stored report |
| GET | `/forecast` | | `{source, hours:[{time, mm}], heavyRainSoon}` |
| GET | `/grid` | | substation > feeder > transformers > poles and homes (meter type, elevation, coordinates) |
| GET | `/customer/status` | `?lat=&lon=` or `?homeId=` | one home: power `on` / `off` / `meter_off`, flood risk, a message for the resident |
| POST | `/esp/reading` | the ESP32's JSON | `{"cut": [...]}` |
| POST | `/sim/reading` | `{"depthCm": 5.2}` | pretend to be the box |
| POST | `/sim/reset` | | start the demo over |

`GET /state` example (sensor at knee + one photo, before approval):

```json
{
  "sensor": {"poleId": "P1", "street": "Estero St.", "transformer": "TR-1", "depthCm": 5.4, "depthM": 0.541,
             "waterSurfaceM": 2.54, "level": "knee", "online": true},
  "streets": [
    {"id": "S1", "transformer": "TR-1", "name": "Estero St.", "homes": 4, "relay": 1, "switchOpen": false,
     "smartMeters": 1, "metersOff": [], "hazard": "high"},
    {"id": "S2", "transformer": "TR-2", "name": "Mabini St.", "homes": 4, "relay": 2, "switchOpen": false,
     "smartMeters": 2, "metersOff": [], "hazard": "low"}
  ],
  "homes": [
    {"id": "E1", "transformer": "TR-1", "meter": "traditional", "elev": 2.05, "power": "on", "risk": "flooded", "localDepthM": 0.49},
    {"id": "E3", "transformer": "TR-1", "meter": "traditional", "elev": 2.70, "power": "on", "risk": "dry", "localDepthM": -0.16},
    {"id": "M1", "transformer": "TR-2", "meter": "smart", "elev": 2.20, "power": "on", "risk": "buffer", "localDepthM": 0.34},
    {"id": "M2", "transformer": "TR-2", "meter": "smart", "elev": 2.45, "power": "on", "risk": "watch", "localDepthM": 0.09}
  ],
  "summary": {"homes": 12, "on": 12, "off": 0, "atRisk": 4, "watch": 1},
  "reports": [{"id": "r1", "street": "Estero St.", "transformer": "TR-1", "level": "knee", "confidence": 0.6,
               "scene": "street_flood", "flags": [], "duplicate": false, "contradicted": false, "counts": true,
               "photoUrl": "http://.../uploads/....jpg"}],
  "sources": {"sensor": true, "photo": true, "openData": false},
  "recommendation": {"id": "rec-1", "switchIds": ["S1"], "meterIds": ["M1"], "transformers": ["TR-1"],
                     "homesCut": 5, "homesKept": 7, "watchHomes": ["M2"], "status": "pending",
                     "evidence": "Estero St.: pole sensor + 1 photo(s)",
                     "reason": "water at pole P1, P1b: open TR-1 · only smart-meter homes in danger (M1): disconnect that meter, TR-2 stays ON",
                     "plan": [{"switchId": "S1", "transformer": "TR-1", "action": "open", "homesInDanger": ["E1", "E2", "E4"]}]},
  "sms": {"status": "ready", "recipients": 0},
  "log": [{"at": "...", "text": "PASYA: TR-1 (Estero St.), M1 smart meter (Mabini St.). Cuts 5 homes, keeps 7 lit, warns 1. ..."}]
}
```

`recommendation.status`: `pending` (show Approve / Reject), `approved`, `rejected`, or `null` when there's nothing to decide.
`sms.status`: `ready`, `sending`, `sent`, `failed`.

Minimal fetch from any website:

```js
const API = "http://192.168.x.x:8000";
const s = await (await fetch(`${API}/state`)).json();
if (s.recommendation?.status === "pending") {
  await fetch(`${API}/recommendations/${s.recommendation.id}/approve`, { method: "POST" });
}
```

## Demo script (2 minutes)

1. `POST /sim/reset` (or restart the server). All 3 streets lit.
2. Pour water into the container until the box shows **KNEE**. Dashboard: sensor = knee, 1 source.
3. A teammate sends a flood photo of "Estero St." from the `/report` page on their phone. Dashboard: **2 sources → recommendation: open S1, cut 4 homes, keep 8**.
4. Point at the recommendation: **open TR-1, disconnect only M1's smart meter, keep 7 lit, warn M2.** Say why: the raised house E3 is dry but shares TR-1 and has a traditional meter, so Meralco can't spare it; M1 is a low corner lot on Mabini, but it has a smart meter, so only that home goes off.
5. Press **Approve** on the dashboard (or APPROVE on the lid). Estero St. goes dark within 2 s; Mabini and Rizal stay lit; the SMS and WATCH texts go out.
6. (Q&A) Send a bathtub photo or the same photo twice from `/report`: it's received but **not counted**, with the reason shown.
7. Drain the water. **Restore**. Estero St. lights up and the "power back" text goes out.

## Files

```
app/main.py      routes (FastAPI)          app/engine.py   state + rules (SILIP / PASYA / BABALA)
app/grid.py      grid twin, smallest cut   app/forecast.py TAYA (Open-Meteo)
app/sms.py       SMS providers             app/vision.py   photo AI (Bedrock) / manual
app/levels.py    water levels, cm -> m     app/config.py   settings from .env
app/photocheck.py EXIF time/GPS, dHash     data/subscribers.csv  who gets the SMS
data/feeder.json transformers, poles, homes (meter type, elevation)
static/report.html  resident report page   tests/test_flow.py    end-to-end tests
```

State lives in memory: restarting the server starts the demo fresh (the box's current relay state is picked up again automatically).
