import { analyzeFlood } from "./bedrock";
import type { Env } from "./env";
import * as db from "./firebase";
import { uploadPhoto } from "./storage";

interface Attachment {
  type: string;
  payload?: { url?: string; coordinates?: { lat: number; long: number } };
}
interface MsgEvent {
  sender?: { id: string };
  message?: {
    mid?: string;
    is_echo?: boolean;
    text?: string;
    attachments?: Attachment[];
  };
  postback?: { mid?: string; title?: string; payload?: string };
  // delivery / read / reaction receipts arrive as other keys and are ignored
}

// Meta may deliver the same event twice (retries); remember recent message ids per isolate.
const seenMids = new Set<string>();

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // 1. Meta webhook verification
    if (request.method === "GET") {
      if (url.pathname === "/health") return Response.json(health(env));
      if (!url.searchParams.has("hub.mode"))
        return new Response("BAHAGI Messenger bot is running");
      const ok =
        url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === env.VERIFY_TOKEN;
      return ok
        ? new Response(url.searchParams.get("hub.challenge") ?? "", {
            status: 200,
          })
        : new Response("Verification failed", { status: 403 });
    }

    // 2. Messenger events
    if (request.method === "POST") {
      const raw = await request.text();
      if (
        !(await verifySignature(
          raw,
          request.headers.get("x-hub-signature-256"),
          env.APP_SECRET,
        ))
      ) {
        console.warn(
          "Rejected POST: bad signature. APP_SECRET must belong to the same Meta app.",
        );
        return new Response("Invalid signature", { status: 401 });
      }
      let body: { object?: string; entry?: { messaging?: MsgEvent[] }[] };
      try {
        body = JSON.parse(raw);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (body.object !== "page")
        return new Response("Unsupported event", { status: 404 });

      // Answer Meta right away; Bedrock can take several seconds, so work continues in the background.
      ctx.waitUntil(processBody(env, body));
      return new Response("EVENT_RECEIVED", { status: 200 });
    }
    return new Response("Method Not Allowed", { status: 405 });
  },
};

async function processBody(
  env: Env,
  body: { entry?: { messaging?: MsgEvent[] }[] },
) {
  for (const entry of body.entry ?? [])
    for (const ev of entry.messaging ?? []) {
      const psid = ev.sender?.id;
      // Only real user messages and button taps. Replying to delivery/read receipts
      // (or to our own echoes) makes the bot answer itself in an endless loop.
      if (!psid || (!ev.message && !ev.postback) || ev.message?.is_echo)
        continue;
      const mid = ev.message?.mid ?? ev.postback?.mid;
      if (mid) {
        if (seenMids.has(mid)) continue;
        seenMids.add(mid);
        if (seenMids.size > 500)
          seenMids.delete(seenMids.values().next().value!);
      }
      try {
        await handle(env, psid, ev);
      } catch (err) {
        console.error("handle failed", err);
        await reply(env, psid, {
          text: "Pasensya po, may problema sa system. Subukan ulit mamaya. Sorry, something went wrong. Please try again.",
        }).catch(() => {});
      }
    }
}

async function handle(env: Env, psid: string, ev: MsgEvent) {
  const msg = ev.message;
  const text = (msg?.text ?? ev.postback?.title ?? "").trim();
  const image = msg?.attachments?.find((a) => a.type === "image")?.payload?.url;
  const loc = msg?.attachments?.find((a) => a.type === "location")?.payload
    ?.coordinates;

  console.log(
    "Event from",
    psid.slice(-4),
    image ? "image" : loc ? "location" : text ? "text" : "other",
  );
  await typing(env, psid);

  if (image) return handleImage(env, psid, image, text);
  if (loc || text) {
    const session = await db.getSession(env, psid);
    if (session && !/^(hi|hello|help|get started)$/i.test(text))
      return handleLocation(env, psid, session, loc, text);
  }
  return reply(env, psid, {
    text: "Kumusta po! Ako ang BAHAGI bot. Magpadala ng litrato ng baha para ma-report sa Meralco. Hindi po lulusong sa baha malapit sa poste o kable.\n\nHi! Send a photo of the flood to report it. Please stay out of water near poles or wires.",
  });
}

async function handleImage(
  env: Env,
  psid: string,
  imageUrl: string,
  note: string,
) {
  const res = await fetch(imageUrl);
  if (!res.ok)
    throw new Error(`Could not download Messenger image: ${res.status}`);
  const bytes = await res.arrayBuffer();
  const mime = res.headers.get("content-type") ?? "image/jpeg";
  const hash = await sha256(bytes);

  const [analysis, duplicate] = await Promise.all([
    analyzeFlood(env, bytes, mime),
    db.isDuplicate(env, hash),
  ]);
  console.log("Analysis", JSON.stringify(analysis), "duplicate", duplicate);

  if (!analysis.is_flood || analysis.confidence < 0.4)
    return reply(env, psid, {
      text: "Hindi namin makita ang baha sa litrato. Magpadala po ng mas malinaw na litrato.\nWe could not see a flood in this photo. Please send a clearer one.",
    });

  const ext = mime.includes("png")
    ? "png"
    : mime.includes("webp")
      ? "webp"
      : mime.includes("gif")
        ? "gif"
        : "jpg";
  const photoUrl = await uploadPhoto(
    env,
    `${hash.slice(0, 12)}-${Date.now()}.${ext}`,
    bytes,
    mime,
  );
  await db.saveSession(env, psid, {
    photoUrl,
    imageHash: hash,
    note,
    analysis,
    duplicate,
  });
  return askLocation(
    env,
    psid,
    "Salamat po! Saan po ito? Pindutin ang button para ibahagi ang location, o i-type ang pangalan ng kalye.",
  );
}

async function handleLocation(
  env: Env,
  psid: string,
  session: db.Session,
  loc: { lat: number; long: number } | undefined,
  text: string,
) {
  const streets = await db.listStreets(env);
  const street = loc
    ? nearest(streets, loc.lat, loc.long)
    : byName(streets, text);
  if (!street)
    return askLocation(
      env,
      psid,
      "Hindi namin mahanap ang kalye. Pakibahagi ang location, o i-type ang pangalan ng kalye.",
    );

  const a = session.analysis;
  const scale = Number(env.DEPTH_SCALE ?? 0.1);
  const estimatedCm = Math.round(a.estimated_cm * scale * 10) / 10;
  const reportId = await db.saveReport(env, psid, {
    barangayId: street.barangayId,
    streetId: street.id,
    source: "messenger",
    photoUrl: session.photoUrl,
    note: session.note ?? "",
    estimatedCm,
    depthLevel: a.depth_level,
    confidence: a.confidence,
    duplicate: !!session.duplicate,
    liveWireRisk: a.live_wire_risk,
    analysis: a,
    imageHash: session.imageHash,
  });

  console.log("Report saved", reportId, street.id);

  const warn = a.live_wire_risk
    ? "\n\n⚠️ May kuryente po malapit. Lumayo sa tubig at kable. Live wire risk nearby: stay away."
    : "";
  return reply(env, psid, {
    text: `Natanggap na po ang report sa ${street.name} (${a.depth_level}-deep). Ipinadala na sa Meralco dispatcher. Salamat!${warn}`,
  });
}

// ---------- helpers ----------
const askLocation = (env: Env, psid: string, text: string) =>
  reply(env, psid, { text, quick_replies: [{ content_type: "location" }] });

function nearest(
  streets: db.Street[],
  lat: number,
  lng: number,
): db.Street | null {
  const km = (s: db.Street) => {
    const r = (d: number) => (d * Math.PI) / 180;
    const h =
      Math.sin(r(s.lat - lat) / 2) ** 2 +
      Math.cos(r(lat)) * Math.cos(r(s.lat)) * Math.sin(r(s.lng - lng) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  };
  const best = streets
    .map((s) => ({ s, d: km(s) }))
    .sort((a, b) => a.d - b.d)[0];
  return best && best.d < 0.5 ? best.s : null; // within 500 m of a known street
}

function byName(streets: db.Street[], text: string): db.Street | null {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\b(st|street|ave|avenue|rd|road|blvd)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const t = norm(text);
  return t
    ? (streets.find((s) => {
        const k = norm(s.name);
        return k.length >= 3 && t.includes(k);
      }) ?? null)
    : null;
}

/** Which settings are present (never the values). Open https://<worker>/health after deploying. */
function health(env: Env) {
  const set = (v?: string) => !!v && !v.includes("REPLACE_");
  return {
    messenger: {
      VERIFY_TOKEN: set(env.VERIFY_TOKEN),
      APP_SECRET: set(env.APP_SECRET),
      PAGE_ACCESS_TOKEN: set(env.PAGE_ACCESS_TOKEN),
      GRAPH_VERSION: env.GRAPH_VERSION ?? "v26.0",
    },
    firebase: {
      FIREBASE_DATABASE_URL: set(env.FIREBASE_DATABASE_URL),
      auth: env.FIREBASE_SERVICE_ACCOUNT
        ? "service-account"
        : env.FIREBASE_DB_SECRET
          ? "database-secret"
          : "MISSING",
    },
    supabaseStorage: {
      SUPABASE_URL: set(env.SUPABASE_URL),
      SUPABASE_SERVICE_KEY: set(env.SUPABASE_SERVICE_KEY),
      bucket: env.SUPABASE_BUCKET || "flood-photos",
    },
    aws: {
      AWS_ACCESS_KEY_ID: set(env.AWS_ACCESS_KEY_ID),
      AWS_SECRET_ACCESS_KEY: set(env.AWS_SECRET_ACCESS_KEY),
      BEDROCK_MODEL_ID: set(env.BEDROCK_MODEL_ID),
    },
  };
}

const graph = (env: Env) =>
  `https://graph.facebook.com/${env.GRAPH_VERSION || "v26.0"}/me/messages?access_token=${encodeURIComponent(env.PAGE_ACCESS_TOKEN)}`;

async function send(env: Env, body: object) {
  const res = await fetch(graph(env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    console.error("Messenger API error:", res.status, await res.text());
}
const reply = (env: Env, psid: string, message: object) =>
  send(env, { recipient: { id: psid }, messaging_type: "RESPONSE", message });
const typing = (env: Env, psid: string) =>
  send(env, { recipient: { id: psid }, sender_action: "typing_on" });

async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifySignature(
  body: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const received = signature.replace(/^sha256=/, "");
  if (received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}
