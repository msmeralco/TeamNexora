var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/aws4fetch/dist/aws4fetch.esm.mjs
var encoder = new TextEncoder();
var HOST_SERVICES = {
  appstream2: "appstream",
  cloudhsmv2: "cloudhsm",
  email: "ses",
  marketplace: "aws-marketplace",
  mobile: "AWSMobileHubService",
  pinpoint: "mobiletargeting",
  queue: "sqs",
  "git-codecommit": "codecommit",
  "mturk-requester-sandbox": "mturk-requester",
  "personalize-runtime": "personalize"
};
var UNSIGNABLE_HEADERS = /* @__PURE__ */ new Set([
  "authorization",
  "content-type",
  "content-length",
  "user-agent",
  "presigned-expires",
  "expect",
  "x-amzn-trace-id",
  "range",
  "connection"
]);
var AwsClient = class {
  static {
    __name(this, "AwsClient");
  }
  constructor({ accessKeyId, secretAccessKey, sessionToken, service, region, cache, retries, initRetryMs }) {
    if (accessKeyId == null) throw new TypeError("accessKeyId is a required option");
    if (secretAccessKey == null) throw new TypeError("secretAccessKey is a required option");
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.sessionToken = sessionToken;
    this.service = service;
    this.region = region;
    this.cache = cache || /* @__PURE__ */ new Map();
    this.retries = retries != null ? retries : 10;
    this.initRetryMs = initRetryMs || 50;
  }
  async sign(input, init) {
    if (input instanceof Request) {
      const { method, url, headers, body } = input;
      init = Object.assign({ method, url, headers }, init);
      if (init.body == null && headers.has("Content-Type")) {
        init.body = body != null && headers.has("X-Amz-Content-Sha256") ? body : await input.clone().arrayBuffer();
      }
      input = url;
    }
    const signer = new AwsV4Signer(Object.assign({ url: input.toString() }, init, this, init && init.aws));
    const signed = Object.assign({}, init, await signer.sign());
    delete signed.aws;
    try {
      return new Request(signed.url.toString(), signed);
    } catch (e) {
      if (e instanceof TypeError) {
        return new Request(signed.url.toString(), Object.assign({ duplex: "half" }, signed));
      }
      throw e;
    }
  }
  async fetch(input, init) {
    for (let i = 0; i <= this.retries; i++) {
      const fetched = fetch(await this.sign(input, init));
      if (i === this.retries) {
        return fetched;
      }
      const res = await fetched;
      if (res.status < 500 && res.status !== 429) {
        return res;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.random() * this.initRetryMs * Math.pow(2, i)));
    }
    throw new Error("An unknown error occurred, ensure retries is not negative");
  }
};
var AwsV4Signer = class {
  static {
    __name(this, "AwsV4Signer");
  }
  constructor({ method, url, headers, body, accessKeyId, secretAccessKey, sessionToken, service, region, cache, datetime, signQuery, appendSessionToken, allHeaders, singleEncode }) {
    if (url == null) throw new TypeError("url is a required option");
    if (accessKeyId == null) throw new TypeError("accessKeyId is a required option");
    if (secretAccessKey == null) throw new TypeError("secretAccessKey is a required option");
    this.method = method || (body ? "POST" : "GET");
    this.url = new URL(url);
    this.headers = new Headers(headers || {});
    this.body = body;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.sessionToken = sessionToken;
    let guessedService, guessedRegion;
    if (!service || !region) {
      [guessedService, guessedRegion] = guessServiceRegion(this.url, this.headers);
    }
    this.service = service || guessedService || "";
    this.region = region || guessedRegion || "us-east-1";
    this.cache = cache || /* @__PURE__ */ new Map();
    this.datetime = datetime || (/* @__PURE__ */ new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
    this.signQuery = signQuery;
    this.appendSessionToken = appendSessionToken || this.service === "iotdevicegateway";
    this.headers.delete("Host");
    if (this.service === "s3" && !this.signQuery && !this.headers.has("X-Amz-Content-Sha256")) {
      this.headers.set("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD");
    }
    const params = this.signQuery ? this.url.searchParams : this.headers;
    params.set("X-Amz-Date", this.datetime);
    if (this.sessionToken && !this.appendSessionToken) {
      params.set("X-Amz-Security-Token", this.sessionToken);
    }
    this.signableHeaders = ["host", ...this.headers.keys()].filter((header) => allHeaders || !UNSIGNABLE_HEADERS.has(header)).sort();
    this.signedHeaders = this.signableHeaders.join(";");
    this.canonicalHeaders = this.signableHeaders.map((header) => header + ":" + (header === "host" ? this.url.host : (this.headers.get(header) || "").replace(/\s+/g, " "))).join("\n");
    this.credentialString = [this.datetime.slice(0, 8), this.region, this.service, "aws4_request"].join("/");
    if (this.signQuery) {
      if (this.service === "s3" && !params.has("X-Amz-Expires")) {
        params.set("X-Amz-Expires", "86400");
      }
      params.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
      params.set("X-Amz-Credential", this.accessKeyId + "/" + this.credentialString);
      params.set("X-Amz-SignedHeaders", this.signedHeaders);
    }
    if (this.service === "s3") {
      try {
        this.encodedPath = decodeURIComponent(this.url.pathname.replace(/\+/g, " "));
      } catch (e) {
        this.encodedPath = this.url.pathname;
      }
    } else {
      this.encodedPath = this.url.pathname.replace(/\/+/g, "/");
    }
    if (!singleEncode) {
      this.encodedPath = encodeURIComponent(this.encodedPath).replace(/%2F/g, "/");
    }
    this.encodedPath = encodeRfc3986(this.encodedPath);
    const seenKeys = /* @__PURE__ */ new Set();
    this.encodedSearch = [...this.url.searchParams].filter(([k]) => {
      if (!k) return false;
      if (this.service === "s3") {
        if (seenKeys.has(k)) return false;
        seenKeys.add(k);
      }
      return true;
    }).map((pair) => pair.map((p) => encodeRfc3986(encodeURIComponent(p)))).sort(([k1, v1], [k2, v2]) => k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0).map((pair) => pair.join("=")).join("&");
  }
  async sign() {
    if (this.signQuery) {
      this.url.searchParams.set("X-Amz-Signature", await this.signature());
      if (this.sessionToken && this.appendSessionToken) {
        this.url.searchParams.set("X-Amz-Security-Token", this.sessionToken);
      }
    } else {
      this.headers.set("Authorization", await this.authHeader());
    }
    return {
      method: this.method,
      url: this.url,
      headers: this.headers,
      body: this.body
    };
  }
  async authHeader() {
    return [
      "AWS4-HMAC-SHA256 Credential=" + this.accessKeyId + "/" + this.credentialString,
      "SignedHeaders=" + this.signedHeaders,
      "Signature=" + await this.signature()
    ].join(", ");
  }
  async signature() {
    const date = this.datetime.slice(0, 8);
    const cacheKey = [this.secretAccessKey, date, this.region, this.service].join();
    let kCredentials = this.cache.get(cacheKey);
    if (!kCredentials) {
      const kDate = await hmac("AWS4" + this.secretAccessKey, date);
      const kRegion = await hmac(kDate, this.region);
      const kService = await hmac(kRegion, this.service);
      kCredentials = await hmac(kService, "aws4_request");
      this.cache.set(cacheKey, kCredentials);
    }
    return buf2hex(await hmac(kCredentials, await this.stringToSign()));
  }
  async stringToSign() {
    return [
      "AWS4-HMAC-SHA256",
      this.datetime,
      this.credentialString,
      buf2hex(await hash(await this.canonicalString()))
    ].join("\n");
  }
  async canonicalString() {
    return [
      this.method.toUpperCase(),
      this.encodedPath,
      this.encodedSearch,
      this.canonicalHeaders + "\n",
      this.signedHeaders,
      await this.hexBodyHash()
    ].join("\n");
  }
  async hexBodyHash() {
    let hashHeader = this.headers.get("X-Amz-Content-Sha256") || (this.service === "s3" && this.signQuery ? "UNSIGNED-PAYLOAD" : null);
    if (hashHeader == null) {
      if (this.body && typeof this.body !== "string" && !("byteLength" in this.body)) {
        throw new Error("body must be a string, ArrayBuffer or ArrayBufferView, unless you include the X-Amz-Content-Sha256 header");
      }
      hashHeader = buf2hex(await hash(this.body || ""));
    }
    return hashHeader;
  }
};
async function hmac(key, string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(string));
}
__name(hmac, "hmac");
async function hash(content) {
  return crypto.subtle.digest("SHA-256", typeof content === "string" ? encoder.encode(content) : content);
}
__name(hash, "hash");
var HEX_CHARS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
function buf2hex(arrayBuffer) {
  const buffer = new Uint8Array(arrayBuffer);
  let out = "";
  for (let idx = 0; idx < buffer.length; idx++) {
    const n = buffer[idx];
    out += HEX_CHARS[n >>> 4 & 15];
    out += HEX_CHARS[n & 15];
  }
  return out;
}
__name(buf2hex, "buf2hex");
function encodeRfc3986(urlEncodedStr) {
  return urlEncodedStr.replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
__name(encodeRfc3986, "encodeRfc3986");
function guessServiceRegion(url, headers) {
  const { hostname, pathname } = url;
  if (hostname.endsWith(".on.aws")) {
    const match2 = hostname.match(/^[^.]{1,63}\.lambda-url\.([^.]{1,63})\.on\.aws$/);
    return match2 != null ? ["lambda", match2[1] || ""] : ["", ""];
  }
  if (hostname.endsWith(".r2.cloudflarestorage.com")) {
    return ["s3", "auto"];
  }
  if (hostname.endsWith(".backblazeb2.com")) {
    const match2 = hostname.match(/^(?:[^.]{1,63}\.)?s3\.([^.]{1,63})\.backblazeb2\.com$/);
    return match2 != null ? ["s3", match2[1] || ""] : ["", ""];
  }
  const match = hostname.replace("dualstack.", "").match(/([^.]{1,63})\.(?:([^.]{0,63})\.)?amazonaws\.com(?:\.cn)?$/);
  let service = match && match[1] || "";
  let region = match && match[2];
  if (region === "us-gov") {
    region = "us-gov-west-1";
  } else if (region === "s3" || region === "s3-accelerate") {
    region = "us-east-1";
    service = "s3";
  } else if (service === "iot") {
    if (hostname.startsWith("iot.")) {
      service = "execute-api";
    } else if (hostname.startsWith("data.jobs.iot.")) {
      service = "iot-jobs-data";
    } else {
      service = pathname === "/mqtt" ? "iotdevicegateway" : "iotdata";
    }
  } else if (service === "autoscaling") {
    const targetPrefix = (headers.get("X-Amz-Target") || "").split(".")[0];
    if (targetPrefix === "AnyScaleFrontendService") {
      service = "application-autoscaling";
    } else if (targetPrefix === "AnyScaleScalingPlannerFrontendService") {
      service = "autoscaling-plans";
    }
  } else if (region == null && service.startsWith("s3-")) {
    region = service.slice(3).replace(/^fips-|^external-1/, "");
    service = "s3";
  } else if (service.endsWith("-fips")) {
    service = service.slice(0, -5);
  } else if (region && /-\d$/.test(service) && !/-\d$/.test(region)) {
    [service, region] = [region, service];
  }
  return [HOST_SERVICES[service] || service, region || ""];
}
__name(guessServiceRegion, "guessServiceRegion");

// src/bedrock.ts
var SYSTEM = "You analyse photos that residents send during floods in Metro Manila for a power utility safety team. Reply with JSON only, no prose.";
var PROMPT = `Is this a photo of a flooded street or area? Estimate the flood depth using the MMDA gauge: gutter is about 20 cm, knee about 48 cm, waist about 94 cm, chest about 114 cm. Also say whether the water is touching or near electrical equipment (poles, wires, transformers, meters).
Return exactly this JSON: {"is_flood": boolean, "depth_level": "none"|"gutter"|"knee"|"waist"|"chest", "estimated_cm": number, "live_wire_risk": boolean, "confidence": number between 0 and 1, "reason": string under 20 words}`;
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
}
__name(toBase64, "toBase64");
async function analyzeFlood(env, bytes, mime) {
  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION,
    service: "bedrock"
    // SigV4 name for bedrock-runtime
  });
  const format = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "jpeg";
  const res = await aws.fetch(
    `https://bedrock-runtime.${env.AWS_REGION}.amazonaws.com/model/${encodeURIComponent(env.BEDROCK_MODEL_ID)}/converse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: [{ text: SYSTEM }],
        messages: [{ role: "user", content: [{ image: { format, source: { bytes: toBase64(bytes) } } }, { text: PROMPT }] }],
        inferenceConfig: { maxTokens: 300, temperature: 0 }
      })
    }
  );
  if (!res.ok) throw new Error(`Bedrock ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const text = j.output?.message?.content?.find((c) => c.text)?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Bedrock returned no JSON: ${text.slice(0, 120)}`);
  const a = JSON.parse(match[0]);
  return {
    is_flood: !!a.is_flood,
    depth_level: ["gutter", "knee", "waist", "chest"].includes(a.depth_level) ? a.depth_level : "none",
    estimated_cm: Math.max(0, Number(a.estimated_cm) || 0),
    live_wire_risk: !!a.live_wire_risk,
    confidence: Math.min(1, Math.max(0, Number(a.confidence) || 0)),
    reason: String(a.reason ?? "").slice(0, 200)
  };
}
__name(analyzeFlood, "analyzeFlood");

// src/firebase.ts
var SESSION_TTL_MS = 15 * 6e4;
var DUPLICATE_WINDOW_MS = 24 * 60 * 6e4;
var SERVER_TIMESTAMP = { ".sv": "timestamp" };
var cachedToken = null;
var b64url = /* @__PURE__ */ __name((data) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}, "b64url");
async function accessToken(env) {
  if (cachedToken && cachedToken.expires > Date.now() + 6e4) return cachedToken.value;
  let sa;
  try {
    sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole service-account .json file as the secret.");
  }
  if (!sa.client_email || !sa.private_key) throw new Error("FIREBASE_SERVICE_ACCOUNT is missing client_email or private_key");
  const pem = sa.private_key.replace(/\\n/g, "\n").replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1e3);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: tokenUri,
    iat: now,
    exp: now + 3600
  }))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` })
  });
  if (!res.ok) throw new Error(`Google OAuth \u2192 ${res.status} ${await res.text()}`);
  const j = await res.json();
  cachedToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1e3 };
  return j.access_token;
}
__name(accessToken, "accessToken");
async function rtdb(env, path, method, body) {
  if (!env.FIREBASE_DATABASE_URL) throw new Error("FIREBASE_DATABASE_URL is not set in wrangler.toml");
  const url = new URL(`${env.FIREBASE_DATABASE_URL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}.json`);
  const headers = { "Content-Type": "application/json" };
  if (env.FIREBASE_SERVICE_ACCOUNT) headers.Authorization = `Bearer ${await accessToken(env)}`;
  else if (env.FIREBASE_DB_SECRET) url.searchParams.set("auth", env.FIREBASE_DB_SECRET);
  else throw new Error("Set FIREBASE_SERVICE_ACCOUNT (recommended) or FIREBASE_DB_SECRET");
  const res = await fetch(url, { method, headers, body: body === void 0 ? void 0 : JSON.stringify(body) });
  if (!res.ok) throw new Error(`Firebase ${method} /${path} \u2192 ${res.status} ${await res.text()}`);
  return await res.json();
}
__name(rtdb, "rtdb");
async function listStreets(env) {
  const obj = await rtdb(env, "streets", "GET");
  if (!obj) console.warn("No streets in Firebase. Import firebase-seed/streets.json at /streets (see README).");
  return Object.entries(obj ?? {}).map(([id, s]) => ({ id, ...s, lat: Number(s.lat), lng: Number(s.lng) }));
}
__name(listStreets, "listStreets");
async function isDuplicate(env, hash2) {
  const ts = await rtdb(env, `imageHashes/${hash2}`, "GET");
  return typeof ts === "number" && Date.now() - ts < DUPLICATE_WINDOW_MS;
}
__name(isDuplicate, "isDuplicate");
async function getSession(env, psid) {
  const s = await rtdb(env, `botSessions/${psid}`, "GET");
  return s && Date.now() - s.createdAt < SESSION_TTL_MS ? s : null;
}
__name(getSession, "getSession");
var saveSession = /* @__PURE__ */ __name((env, psid, s) => rtdb(env, `botSessions/${psid}`, "PUT", { ...s, createdAt: Date.now() }), "saveSession");
async function saveReport(env, psid, r) {
  const id = crypto.randomUUID();
  await rtdb(env, "", "PATCH", {
    [`reports/${id}`]: { id, ...r, ts: SERVER_TIMESTAMP },
    [`imageHashes/${r.imageHash}`]: SERVER_TIMESTAMP,
    [`botSessions/${psid}`]: null
  });
  return id;
}
__name(saveReport, "saveReport");

// src/storage.ts
async function uploadPhoto(env, path, bytes, contentType) {
  const base = env.SUPABASE_URL.replace(/\/+$/, "");
  const bucket = env.SUPABASE_BUCKET || "flood-photos";
  const key = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, "Content-Type": contentType, "x-upsert": "true" };
  if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${base}/storage/v1/object/${bucket}/${path}`, { method: "POST", headers, body: bytes });
  if (!res.ok) throw new Error(`Supabase upload \u2192 ${res.status} ${await res.text()}`);
  return `${base}/storage/v1/object/public/${bucket}/${path}`;
}
__name(uploadPhoto, "uploadPhoto");

// src/index.ts
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname === "/health") return Response.json(health(env));
      if (!url.searchParams.has("hub.mode")) return new Response("BAHAGI Messenger bot is running");
      const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env.VERIFY_TOKEN;
      return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("Verification failed", { status: 403 });
    }
    if (request.method === "POST") {
      const raw = await request.text();
      if (!await verifySignature(raw, request.headers.get("x-hub-signature-256"), env.APP_SECRET)) {
        console.warn("Rejected POST: bad signature. APP_SECRET must belong to the same Meta app.");
        return new Response("Invalid signature", { status: 401 });
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (body.object !== "page") return new Response("Unsupported event", { status: 404 });
      ctx.waitUntil(processBody(env, body));
      return new Response("EVENT_RECEIVED", { status: 200 });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }
};
async function processBody(env, body) {
  for (const entry of body.entry ?? [])
    for (const ev of entry.messaging ?? []) {
      const psid = ev.sender?.id;
      if (!psid || ev.message?.is_echo) continue;
      try {
        await handle(env, psid, ev);
      } catch (err) {
        console.error("handle failed", err);
        await reply(env, psid, { text: "Pasensya po, may problema sa system. Subukan ulit mamaya. Sorry, something went wrong. Please try again." }).catch(() => {
        });
      }
    }
}
__name(processBody, "processBody");
async function handle(env, psid, ev) {
  const msg = ev.message;
  const text = (msg?.text ?? ev.postback?.title ?? "").trim();
  const image = msg?.attachments?.find((a) => a.type === "image")?.payload?.url;
  const loc = msg?.attachments?.find((a) => a.type === "location")?.payload?.coordinates;
  console.log("Event from", psid.slice(-4), image ? "image" : loc ? "location" : text ? "text" : "other");
  await typing(env, psid);
  if (image) return handleImage(env, psid, image, text);
  if (loc || text) {
    const session = await getSession(env, psid);
    if (session && !/^(hi|hello|help|get started)$/i.test(text)) return handleLocation(env, psid, session, loc, text);
  }
  return reply(env, psid, {
    text: "Kumusta po! Ako ang BAHAGI bot. Magpadala ng litrato ng baha para ma-report sa Meralco. Hindi po lulusong sa baha malapit sa poste o kable.\n\nHi! Send a photo of the flood to report it. Please stay out of water near poles or wires."
  });
}
__name(handle, "handle");
async function handleImage(env, psid, imageUrl, note) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Could not download Messenger image: ${res.status}`);
  const bytes = await res.arrayBuffer();
  const mime = res.headers.get("content-type") ?? "image/jpeg";
  const hash2 = await sha256(bytes);
  const [analysis, duplicate] = await Promise.all([analyzeFlood(env, bytes, mime), isDuplicate(env, hash2)]);
  console.log("Analysis", JSON.stringify(analysis), "duplicate", duplicate);
  if (!analysis.is_flood || analysis.confidence < 0.4)
    return reply(env, psid, { text: "Hindi namin makita ang baha sa litrato. Magpadala po ng mas malinaw na litrato.\nWe could not see a flood in this photo. Please send a clearer one." });
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "jpg";
  const photoUrl = await uploadPhoto(env, `${hash2.slice(0, 12)}-${Date.now()}.${ext}`, bytes, mime);
  await saveSession(env, psid, { photoUrl, imageHash: hash2, note, analysis, duplicate });
  return askLocation(env, psid, "Salamat po! Saan po ito? Pindutin ang button para ibahagi ang location, o i-type ang pangalan ng kalye.");
}
__name(handleImage, "handleImage");
async function handleLocation(env, psid, session, loc, text) {
  const streets = await listStreets(env);
  const street = loc ? nearest(streets, loc.lat, loc.long) : byName(streets, text);
  if (!street) return askLocation(env, psid, "Hindi namin mahanap ang kalye. Pakibahagi ang location, o i-type ang pangalan ng kalye.");
  const a = session.analysis;
  const scale = Number(env.DEPTH_SCALE ?? 0.1);
  const estimatedCm = Math.round(a.estimated_cm * scale * 10) / 10;
  const reportId = await saveReport(env, psid, {
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
    imageHash: session.imageHash
  });
  console.log("Report saved", reportId, street.id);
  const warn = a.live_wire_risk ? "\n\n\u26A0\uFE0F May kuryente po malapit. Lumayo sa tubig at kable. Live wire risk nearby: stay away." : "";
  return reply(env, psid, {
    text: `Natanggap na po ang report sa ${street.name} (${a.depth_level}-deep). Ipinadala na sa Meralco dispatcher. Salamat!${warn}`
  });
}
__name(handleLocation, "handleLocation");
var askLocation = /* @__PURE__ */ __name((env, psid, text) => reply(env, psid, { text, quick_replies: [{ content_type: "location" }] }), "askLocation");
function nearest(streets, lat, lng) {
  const km = /* @__PURE__ */ __name((s) => {
    const r = /* @__PURE__ */ __name((d) => d * Math.PI / 180, "r");
    const h = Math.sin(r(s.lat - lat) / 2) ** 2 + Math.cos(r(lat)) * Math.cos(r(s.lat)) * Math.sin(r(s.lng - lng) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }, "km");
  const best = streets.map((s) => ({ s, d: km(s) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d < 0.5 ? best.s : null;
}
__name(nearest, "nearest");
function byName(streets, text) {
  const norm = /* @__PURE__ */ __name((s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(st|street|ave|avenue|rd|road|blvd)\b/g, "").replace(/\s+/g, " ").trim(), "norm");
  const t = norm(text);
  return t ? streets.find((s) => {
    const k = norm(s.name);
    return k.length >= 3 && t.includes(k);
  }) ?? null : null;
}
__name(byName, "byName");
function health(env) {
  const set = /* @__PURE__ */ __name((v) => !!v && !v.includes("REPLACE_"), "set");
  return {
    messenger: { VERIFY_TOKEN: set(env.VERIFY_TOKEN), APP_SECRET: set(env.APP_SECRET), PAGE_ACCESS_TOKEN: set(env.PAGE_ACCESS_TOKEN), GRAPH_VERSION: env.GRAPH_VERSION ?? "v26.0" },
    firebase: { FIREBASE_DATABASE_URL: set(env.FIREBASE_DATABASE_URL), auth: env.FIREBASE_SERVICE_ACCOUNT ? "service-account" : env.FIREBASE_DB_SECRET ? "database-secret" : "MISSING" },
    supabaseStorage: { SUPABASE_URL: set(env.SUPABASE_URL), SUPABASE_SERVICE_KEY: set(env.SUPABASE_SERVICE_KEY), bucket: env.SUPABASE_BUCKET || "flood-photos" },
    aws: { AWS_ACCESS_KEY_ID: set(env.AWS_ACCESS_KEY_ID), AWS_SECRET_ACCESS_KEY: set(env.AWS_SECRET_ACCESS_KEY), BEDROCK_MODEL_ID: set(env.BEDROCK_MODEL_ID) }
  };
}
__name(health, "health");
var graph = /* @__PURE__ */ __name((env) => `https://graph.facebook.com/${env.GRAPH_VERSION || "v26.0"}/me/messages?access_token=${encodeURIComponent(env.PAGE_ACCESS_TOKEN)}`, "graph");
async function send(env, body) {
  const res = await fetch(graph(env), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) console.error("Messenger API error:", res.status, await res.text());
}
__name(send, "send");
var reply = /* @__PURE__ */ __name((env, psid, message) => send(env, { recipient: { id: psid }, messaging_type: "RESPONSE", message }), "reply");
var typing = /* @__PURE__ */ __name((env, psid) => send(env, { recipient: { id: psid }, sender_action: "typing_on" }), "typing");
async function sha256(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");
async function verifySignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const received = signature.replace(/^sha256=/, "");
  if (received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}
__name(verifySignature, "verifySignature");
export {
  index_default as default
};
/*! Bundled license information:

aws4fetch/dist/aws4fetch.esm.mjs:
  (**
   * @license MIT <https://opensource.org/licenses/MIT>
   * @copyright Michael Hart 2024
   *)
*/
//# sourceMappingURL=index.js.map
