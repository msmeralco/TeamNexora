# BAHAGI Messenger bot (Cloudflare Worker)

Messenger photo → Bedrock (flood? depth? live-wire risk?) → photo to **Supabase Storage** → report to **Firebase Realtime Database**.

| What | Where |
|---|---|
| Bot runtime | Cloudflare Workers |
| Streets, reports, bot sessions, duplicate-photo hashes | Firebase Realtime Database |
| Flood photos | Supabase Storage (public bucket `flood-photos`) |
| Image analysis | AWS Bedrock |

## Firebase data layout

```
/streets/{streetId}      { name, barangayId, switchId, lat, lng }      ← import firebase-seed/streets.json
/reports/{reportId}      { id, barangayId, streetId, source, photoUrl, note, estimatedCm,
                           depthLevel, confidence, duplicate, liveWireRisk, analysis, imageHash, ts }
/botSessions/{psid}      photo waiting for the sender's location (expires after 15 min)
/imageHashes/{sha256}    when that photo was last reported (24 h duplicate check)
```
`ts` is a Firebase server timestamp in ms, so the dashboard can read `/reports` directly with the Firebase JS SDK, e.g.
`query(ref(db, 'reports'), orderByChild('ts'), limitToLast(50))`.

## Setup

### 1. Firebase Realtime Database
1. Firebase console → Build → **Realtime Database** → Create database (Singapore `asia-southeast1` is closest).
2. Copy the database URL shown at the top of the **Data** tab into `FIREBASE_DATABASE_URL` in `wrangler.toml`.
3. **Rules** tab → paste `database.rules.json` → Publish. (Public read of `streets` and `reports` for the dashboard; nobody else can write. The Worker's service account bypasses rules.)
4. **Data** tab → hover the root → ⋮ → *Add child* `streets`, then on the `streets` node ⋮ → **Import JSON** → `firebase-seed/streets.json`.
   (Import at `/streets`, not at the root: importing at the root replaces the whole database.)
5. Project settings → **Service accounts** → *Generate new private key* → save the `.json` file (don't commit it).

### 2. Supabase (images only)
SQL Editor → run `supabase-storage.sql` (creates the public `flood-photos` bucket). No tables are needed anymore.
Project Settings → API Keys → copy the **secret** key (`sb_secret_…`); the legacy `service_role` key also works.

### 3. Cloudflare
```bash
npm install
npx wrangler login

npx wrangler secret put VERIFY_TOKEN          # any string; same value goes in Meta's "Verify token"
npx wrangler secret put APP_SECRET            # Meta app → App settings → Basic → App secret
npx wrangler secret put PAGE_ACCESS_TOKEN     # Messenger → Page access token
npx wrangler secret put SUPABASE_URL          # https://<project>.supabase.co
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY

# The service-account file is multi-line, so pipe it in instead of pasting:
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT < path/to/service-account.json
#   Windows PowerShell:
#   Get-Content path\to\service-account.json -Raw | npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
```
Edit `wrangler.toml`: `FIREBASE_DATABASE_URL`, `BEDROCK_MODEL_ID` (required), `AWS_REGION`.

### 4. Deploy and connect Meta
```bash
npm run check     # type-check + build without deploying
npm run deploy
```
- Open `https://bahagi-messenger.<you>.workers.dev/health`: every value should be `true` and `firebase.auth` should be `service-account`.
- Meta app → Messenger → Webhooks: Callback URL = the workers.dev URL, Verify token = your `VERIFY_TOKEN`. Subscribe the Page to `messages`, `messaging_postbacks`.
- `npm run tail` to watch logs while you message the Page (logs also show in the Cloudflare dashboard).

### Local dev
Copy `.dev.vars.example` → `.dev.vars`, fill it in (the service account JSON on one line), then `npm run dev`.

## Troubleshooting
| Log message | Fix |
|---|---|
| `Rejected POST: bad signature` | `APP_SECRET` is from a different Meta app than the Page's webhook. |
| `Firebase … 401 Permission denied` | Service account is from a different Firebase project than `FIREBASE_DATABASE_URL`. |
| `Firebase … 404` / `Firebase … 423` | Wrong `FIREBASE_DATABASE_URL` (copy it exactly, including the region domain). |
| `No streets in Firebase` | Import `firebase-seed/streets.json` at `/streets`. |
| `Supabase upload → 400 Bucket not found` | Run `supabase-storage.sql`, or set `SUPABASE_BUCKET`. |
| `Supabase upload → 403` | Use the secret/service_role key, not the publishable/anon key. |
| `Messenger API error: 190` | Page access token expired; generate a new one. |
