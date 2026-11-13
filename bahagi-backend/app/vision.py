"""SILIP from residents' photos. The AI CROSS-CHECKS; it never decides.

No model is trained here. A general vision model (Amazon Bedrock) is asked two things about each photo:
  1. Is this really an outdoor street flood? (bathtub, indoor, no flood, screenshot or edited photo = not counted)
  2. Roughly how deep, against MMDA's flood gauge (gutter / knee / waist / chest)?
Its answer is one more piece of evidence. What switches power is decided by fixed rules (two independent signals
that agree, the grid twin) and then by a person who approves.

VISION_PROVIDER=bedrock  needs AWS credentials on this laptop.
VISION_PROVIDER=manual   (default) uses the level the sender picked on the report form; scene not checked.
"""
import json
import re

from . import config
from .levels import LEVELS

SCENES = ["street_flood", "indoor_or_bathtub", "no_flood", "screen_or_edited", "unclear"]

PROMPT = """You are helping a power utility cross-check a resident's flood photo. Do not trust the sender.
1) scene: is this a real, live photo of an OUTDOOR street or neighbourhood flood?
   "street_flood" | "indoor_or_bathtub" (bathroom, tub, basin, indoor floor) | "no_flood" |
   "screen_or_edited" (photo of a screen, screenshot, meme, watermark, stock photo, collage, AI-generated or edited) |
   "unclear"
2) level against the MMDA flood gauge: gutter (about 8 in), knee (about 19 in), waist (about 37 in), chest (about 45 in).
   Use reference objects (people, tyres, curbs, doors, steps). "normal" if no street flood.
Reply with ONLY this JSON:
{"scene": "...", "level": "normal|gutter|knee|waist|chest", "confidence": 0.0-1.0, "reason": "short"}"""


def _fmt(content_type: str) -> str:
    ct = (content_type or "").lower()
    return "png" if "png" in ct else "webp" if "webp" in ct else "gif" if "gif" in ct else "jpeg"


def read_depth(image: bytes | None, content_type: str, hinted_level: str | None):
    """Return dict(level, confidence, model, reason, scene)."""
    hint = hinted_level if hinted_level in LEVELS else None
    if image and config.VISION_PROVIDER.lower() == "bedrock":
        try:
            import boto3
            br = boto3.client("bedrock-runtime", region_name=config.BEDROCK_REGION)
            resp = br.converse(
                modelId=config.BEDROCK_MODEL_ID,
                messages=[{"role": "user", "content": [
                    {"image": {"format": _fmt(content_type), "source": {"bytes": image}}},
                    {"text": PROMPT}]}],
                inferenceConfig={"maxTokens": 300, "temperature": 0})
            text = resp["output"]["message"]["content"][0]["text"]
            m = re.search(r"\{.*\}", text, re.S)
            j = json.loads(m.group(0)) if m else {}
            scene = j.get("scene") if j.get("scene") in SCENES else "unclear"
            lvl = j.get("level") if j.get("level") in LEVELS else "normal"
            return {"level": lvl, "confidence": float(j.get("confidence", 0.5)), "model": config.BEDROCK_MODEL_ID,
                    "reason": str(j.get("reason", ""))[:200], "scene": scene}
        except Exception as e:
            fallback = hint or "normal"
            return {"level": fallback, "confidence": 0.6 if hint else 0.1, "model": "bedrock-error",
                    "reason": f"AI unavailable ({str(e)[:80]}); used the sender's level", "scene": "not_checked"}
    return {"level": hint or "normal", "confidence": 0.6 if hint else 0.1, "model": "manual",
            "reason": "level chosen by the sender" if hint else "no level given", "scene": "not_checked"}
