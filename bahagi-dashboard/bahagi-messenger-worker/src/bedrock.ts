import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

export interface Analysis {
  is_flood: boolean;
  depth_level: "none" | "gutter" | "knee" | "waist" | "chest";
  estimated_cm: number; // real-world cm on the MMDA scale
  live_wire_risk: boolean;
  confidence: number; // 0..1
  reason: string;
}

const SYSTEM =
  "You analyse photos that residents send during floods in Metro Manila for a power utility safety team. Reply with JSON only, no prose.";
const PROMPT = `Is this a photo of a flooded street or area? Estimate the flood depth using the MMDA gauge: gutter is about 20 cm, knee about 48 cm, waist about 94 cm, chest about 114 cm. Also say whether the water is touching or near electrical equipment (poles, wires, transformers, meters).
Return exactly this JSON: {"is_flood": boolean, "depth_level": "none"|"gutter"|"knee"|"waist"|"chest", "estimated_cm": number, "live_wire_risk": boolean, "confidence": number between 0 and 1, "reason": string under 20 words}`;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Bedrock Converse API with an image. Needs model access enabled and bedrock:InvokeModel on the IAM user. */
export async function analyzeFlood(
  env: Env,
  bytes: ArrayBuffer,
  mime: string,
): Promise<Analysis> {
  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION,
    service: "bedrock", // SigV4 name for bedrock-runtime
  });
  const format = mime.includes("png")
    ? "png"
    : mime.includes("webp")
      ? "webp"
      : mime.includes("gif")
        ? "gif"
        : "jpeg";
  const res = await aws.fetch(
    `https://bedrock-runtime.${env.AWS_REGION}.amazonaws.com/model/${encodeURIComponent(env.BEDROCK_MODEL_ID)}/converse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: [{ text: SYSTEM }],
        messages: [
          {
            role: "user",
            content: [
              { image: { format, source: { bytes: toBase64(bytes) } } },
              { text: PROMPT },
            ],
          },
        ],
        inferenceConfig: { maxTokens: 300, temperature: 0 },
      }),
    },
  );
  if (!res.ok) throw new Error(`Bedrock ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as {
    output?: { message?: { content?: { text?: string }[] } };
  };
  const text = j.output?.message?.content?.find((c) => c.text)?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match)
    throw new Error(`Bedrock returned no JSON: ${text.slice(0, 120)}`);
  const a = JSON.parse(match[0]) as Partial<Analysis>;
  return {
    is_flood: !!a.is_flood,
    depth_level: (["gutter", "knee", "waist", "chest"] as const).includes(
      a.depth_level as never,
    )
      ? a.depth_level!
      : "none",
    estimated_cm: Math.max(0, Number(a.estimated_cm) || 0),
    live_wire_risk: !!a.live_wire_risk,
    confidence: Math.min(1, Math.max(0, Number(a.confidence) || 0)),
    reason: String(a.reason ?? "").slice(0, 200),
  };
}
