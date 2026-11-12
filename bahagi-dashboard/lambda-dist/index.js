"use strict";

// backend/server.ts
var import_node_http = require("node:http");

// backend/messenger-webhook.ts
var import_node_crypto = require("node:crypto");
var VERIFY_TOKEN = "bahagi-nexora-2026";
var APP_SECRET = "be7620e6346c18b2e8458fc2f41964aa";
var PAGE_TOKEN = "EAANFD4Rf0V8BS2TnWUDpahXIJP0ybzNgwZALRXMcUWCkzecMB8FreVtxmsZAPFI994enqKtargpTTIwPI8HvDUzbOhLr44ZBrfNKILBGOoa0oMPlBVVbbDeY9O9x2tevKbuH0puuzdCAf0npsmYAPySQST1ZAABbANku0GQmGMgZBMBQbFeinAw1ZCn82jJPEILndt89uZAwWQVZC0yQIMpL7AZDZD";
var graph = `https://graph.facebook.com/v27.0`;
async function listStreets() {
  return [
    { id: "estero", name: "Estero St.", barangayId: "kapitolyo", lat: 14.5738, lng: 121.0584 },
    { id: "mabini", name: "Mabini St.", barangayId: "kapitolyo", lat: 14.5731, lng: 121.0575 },
    { id: "rizal", name: "Rizal St.", barangayId: "kapitolyo", lat: 14.5724, lng: 121.0566 }
  ];
}
async function storePhoto(url) {
  return url;
}
async function scoreDepth(_photoUrl) {
  return { estimatedCm: 5, confidence: 0.9, duplicate: false };
}
async function saveReport(r) {
  console.log("REPORT (demo: only logged, not saved)", JSON.stringify(r));
}
var pending = /* @__PURE__ */ new Map();
var km = (a, b) => {
  const r = (d) => d * Math.PI / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
async function findStreet(loc, text) {
  const streets = await listStreets();
  if (loc) {
    const best = streets.map((s) => ({ s, d: km([loc.lat, loc.long], [s.lat, s.lng]) })).sort((a, b) => a.d - b.d)[0];
    return best && best.d < 0.5 ? best.s : null;
  }
  const t = (text ?? "").toLowerCase();
  return t ? streets.find((s) => t.includes(s.name.toLowerCase().replace(/\./g, ""))) ?? null : null;
}
async function send(psid, message) {
  const res = await fetch(`${graph}/1361897890350145/messages?access_token=${PAGE_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: psid }, messaging_type: "RESPONSE", message })
  });
  if (!res.ok) console.error("Send API failed", res.status, await res.text());
}
async function finish(psid, d, street) {
  const score = await scoreDepth(d.photoUrl);
  await saveReport({
    id: crypto.randomUUID(),
    barangayId: street.barangayId,
    streetId: street.id,
    source: "messenger",
    photoUrl: d.photoUrl,
    note: d.note,
    ...score,
    ts: Date.now()
  });
  pending.delete(psid);
  await send(psid, { text: `Salamat po! Natanggap namin ang report sa ${street.name}. Ipinadala na sa Meralco dispatcher. Huwag lumusong sa baha malapit sa poste o kable.` });
}
async function handle(ev) {
  const psid = ev.sender.id;
  const m = ev.message;
  if (!m) return;
  const loc = m.attachments?.find((a) => a.type === "location")?.payload.coordinates;
  const img = m.attachments?.find((a) => a.type === "image")?.payload.url;
  const draft = img ? { photoUrl: await storePhoto(img), note: m.text ?? "" } : pending.get(psid);
  if (!draft) return send(psid, { text: "Kumusta po! Magpadala ng litrato ng baha para ma-report. Send a photo of the flood to report it." });
  const street = await findStreet(loc, m.text);
  if (!street) {
    pending.set(psid, draft);
    return send(psid, {
      text: "Saan po ito? Pindutin ang button para ibahagi ang location, o i-type ang pangalan ng kalye.",
      quick_replies: [{ content_type: "location" }]
    });
  }
  return finish(psid, draft, street);
}
function validSignature(raw, header) {
  const expected = "sha256=" + (0, import_node_crypto.createHmac)("sha256", APP_SECRET).update(raw).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(header ?? "");
  return a.length === b.length && (0, import_node_crypto.timingSafeEqual)(a, b);
}
var handler = async (e) => {
  if (e.requestContext.http.method === "GET") {
    const q = e.queryStringParameters ?? {};
    return q["hub.mode"] === "subscribe" && q["hub.verify_token"] === VERIFY_TOKEN ? { statusCode: 200, body: q["hub.challenge"] ?? "" } : { statusCode: 403, body: "forbidden" };
  }
  const raw = e.isBase64Encoded ? Buffer.from(e.body ?? "", "base64").toString() : e.body ?? "";
  if (!validSignature(raw, e.headers["x-hub-signature-256"])) {
    console.warn("Rejected POST: bad signature. Check that APP_SECRET is the secret of the same Meta app.");
    return { statusCode: 401, body: "bad signature" };
  }
  const body = JSON.parse(raw);
  if (body.object !== "page") return { statusCode: 404, body: "" };
  for (const entry of body.entry ?? [])
    for (const ev of entry.messaging ?? []) {
      console.log("Message event from", ev.sender?.id, "types:", (ev.message?.attachments ?? []).map((a) => a.type).join(",") || (ev.message?.text ? "text" : "other"));
      await handle(ev).catch((err) => console.error("handle failed", err));
    }
  return { statusCode: 200, body: "EVENT_RECEIVED" };
};

// backend/server.ts
var [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "0.0.0.0:3000").split(":");
(0, import_node_http.createServer)(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url ?? "/", "http://localhost");
    const out = await handler({
      requestContext: { http: { method: req.method ?? "GET" } },
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v])),
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: Buffer.concat(chunks).toString("utf8")
      // raw body: needed for Meta's signature check
    });
    res.writeHead(out.statusCode, { "Content-Type": "text/plain" }).end(out.body);
  } catch (err) {
    console.error(err);
    res.writeHead(500).end("error");
  }
}).listen(Number(port), host);
