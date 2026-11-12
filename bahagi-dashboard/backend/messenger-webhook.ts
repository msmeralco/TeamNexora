/**
 * BAHAGI Messenger bot webhook: AWS Lambda behind an API Gateway HTTP API (public HTTPS, ANY /messenger).
 * Flow: resident sends a flood photo → asks for location → finds the nearest street → Bedrock scores depth →
 * saves a Report (the dashboard polls GET /reports) → replies on Messenger.
 * Build (Lambda Web Function): npx esbuild backend/server.ts --bundle --platform=node --target=node22 --outfile=lambda-dist/index.js
 * Env: VERIFY_TOKEN (any string you choose), APP_SECRET, PAGE_TOKEN; optional GRAPH_VERSION (e.g. v24.0, see Meta's changelog)
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const VERIFY_TOKEN = 'bahagi-nexora-2026'; 
const APP_SECRET = 'be7620e6346c18b2e8458fc2f41964aa'; 
const PAGE_TOKEN = 'EAANFD4Rf0V8BS2TnWUDpahXIJP0ybzNgwZALRXMcUWCkzecMB8FreVtxmsZAPFI994enqKtargpTTIwPI8HvDUzbOhLr44ZBrfNKILBGOoa0oMPlBVVbbDeY9O9x2tevKbuH0puuzdCAf0npsmYAPySQST1ZAABbANku0GQmGMgZBMBQbFeinAw1ZCn82jJPEILndt89uZAwWQVZC0yQIMpL7AZDZD';
const graph = `https://graph.facebook.com/v27.0`

interface Attachment { type: string; payload: { url?: string; coordinates?: { lat: number; long: number } } }
interface MsgEvent { sender: { id: string }; message?: { text?: string; attachments?: Attachment[] } }
interface HttpEvent {
  requestContext: { http: { method: string } }
  headers: Record<string, string | undefined>
  queryStringParameters?: Record<string, string | undefined>
  body?: string
  isBase64Encoded?: boolean
}
interface Draft { photoUrl: string; note: string }
interface StreetRef { id: string; name: string; barangayId: string; lat: number; lng: number }

// ---- TODO(NEXORA): wire these to your AWS services -------------------------------------------------
/** Streets from your grid twin (same data as GET /regions, flattened). */
async function listStreets(): Promise<StreetRef[]> {
  // DEMO: your three tabletop streets. Replace with the real list from your backend.
  return [
    { id: 'estero', name: 'Estero St.', barangayId: 'kapitolyo', lat: 14.5738, lng: 121.0584 },
    { id: 'mabini', name: 'Mabini St.', barangayId: 'kapitolyo', lat: 14.5731, lng: 121.0575 },
    { id: 'rizal', name: 'Rizal St.', barangayId: 'kapitolyo', lat: 14.5724, lng: 121.0566 },
  ]
}
/** Messenger photo URLs expire: download the image and put it in S3, return the stored URL. */
async function storePhoto(url: string): Promise<string> { return url }
/** Bedrock vision call: depth in cm on the MMDA scale + confidence 0..1. Reject photos that are not floods. */
async function scoreDepth(_photoUrl: string): Promise<{ estimatedCm: number; confidence: number; duplicate: boolean }> {
  return { estimatedCm: 5, confidence: 0.9, duplicate: false } // DEMO value; replace with the Bedrock call
}
/** Insert into the reports table; shape matches the dashboard's Report type. */
async function saveReport(r: Record<string, unknown>): Promise<void> {
  console.log('REPORT (demo: only logged, not saved)', JSON.stringify(r)) // replace with a DynamoDB write
}
/** Per-user "waiting for location" state. Lambda instances don't share memory, so use DynamoDB (TTL 15 min). */
const pending = new Map<string, Draft>()
// ------------------------------------------------------------------------------------------------

const km = (a: [number, number], b: [number, number]) => {
  const r = (d: number) => (d * Math.PI) / 180
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(h))
}

async function findStreet(loc?: { lat: number; long: number }, text?: string): Promise<StreetRef | null> {
  const streets = await listStreets()
  if (loc) {
    const best = streets.map((s) => ({ s, d: km([loc.lat, loc.long], [s.lat, s.lng]) })).sort((a, b) => a.d - b.d)[0]
    return best && best.d < 0.5 ? best.s : null // within 500 m of a known street
  }
  const t = (text ?? '').toLowerCase()
  return t ? streets.find((s) => t.includes(s.name.toLowerCase().replace(/\./g, ''))) ?? null : null
}

async function send(psid: string, message: object) {
  const res = await fetch(`${graph}/1361897890350145/messages?access_token=${PAGE_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, messaging_type: 'RESPONSE', message }),
  })
  if (!res.ok) console.error('Send API failed', res.status, await res.text())
}

async function finish(psid: string, d: Draft, street: StreetRef) {
  const score = await scoreDepth(d.photoUrl)
  await saveReport({
    id: crypto.randomUUID(), barangayId: street.barangayId, streetId: street.id, source: 'messenger',
    photoUrl: d.photoUrl, note: d.note, ...score, ts: Date.now(),
  })
  pending.delete(psid)
  await send(psid, { text: `Salamat po! Natanggap namin ang report sa ${street.name}. Ipinadala na sa Meralco dispatcher. Huwag lumusong sa baha malapit sa poste o kable.` })
}

async function handle(ev: MsgEvent) {
  const psid = ev.sender.id
  const m = ev.message
  if (!m) return
  const loc = m.attachments?.find((a) => a.type === 'location')?.payload.coordinates
  const img = m.attachments?.find((a) => a.type === 'image')?.payload.url
  const draft = img ? { photoUrl: await storePhoto(img), note: m.text ?? '' } : pending.get(psid)

  if (!draft) return send(psid, { text: 'Kumusta po! Magpadala ng litrato ng baha para ma-report. Send a photo of the flood to report it.' })

  const street = await findStreet(loc, m.text)
  if (!street) {
    pending.set(psid, draft)
    return send(psid, {
      text: 'Saan po ito? Pindutin ang button para ibahagi ang location, o i-type ang pangalan ng kalye.',
      quick_replies: [{ content_type: 'location' }],
    })
  }
  return finish(psid, draft, street)
}

function validSignature(raw: string, header?: string) {
  const expected = 'sha256=' + createHmac('sha256', APP_SECRET).update(raw).digest('hex')
  const a = Buffer.from(expected), b = Buffer.from(header ?? '')
  return a.length === b.length && timingSafeEqual(a, b)
}

export const handler = async (e: HttpEvent) => {
  if (e.requestContext.http.method === 'GET') {
    // Meta's webhook verification handshake
    const q = e.queryStringParameters ?? {}
    return q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === VERIFY_TOKEN
      ? { statusCode: 200, body: q['hub.challenge'] ?? '' }
      : { statusCode: 403, body: 'forbidden' }
  }
  const raw = e.isBase64Encoded ? Buffer.from(e.body ?? '', 'base64').toString() : e.body ?? ''
  if (!validSignature(raw, e.headers['x-hub-signature-256'])) {
    console.warn('Rejected POST: bad signature. Check that APP_SECRET is the secret of the same Meta app.')
    return { statusCode: 401, body: 'bad signature' }
  }
  const body = JSON.parse(raw)
  if (body.object !== 'page') return { statusCode: 404, body: '' }
  for (const entry of body.entry ?? [])
    for (const ev of entry.messaging ?? []) {
      console.log('Message event from', ev.sender?.id, 'types:', (ev.message?.attachments ?? []).map((a: Attachment) => a.type).join(',') || (ev.message?.text ? 'text' : 'other'))
      await handle(ev)
        .catch((err) => console.error('handle failed', err))
    }
  return { statusCode: 200, body: 'EVENT_RECEIVED' }
}