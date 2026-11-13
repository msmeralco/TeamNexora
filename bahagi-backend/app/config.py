"""Settings, read from environment variables (or a .env file next to the app)."""
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv():
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = re.split(r"\s+#", v, 1)[0]          # drop an inline "   # comment"
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()


def env(name, default=""):
    return os.environ.get(name, default)


# --- water levels on the tabletop gauge (cm). Same as the ESP32 firmware and the dashboard.
GUTTER_CM = float(env("GUTTER_CM", "1"))
KNEE_CM = float(env("KNEE_CM", "5"))
WAIST_CM = float(env("WAIST_CM", "8"))
CHEST_CM = float(env("CHEST_CM", "11"))
DANGER_LEVEL = env("DANGER_LEVEL", "knee")          # act at this level or higher

# --- decision rules
REPORT_WINDOW_MIN = float(env("REPORT_WINDOW_MIN", "30"))   # photo reports older than this don't count
SENSOR_OFFLINE_S = float(env("SENSOR_OFFLINE_S", "10"))     # no ESP32 post for this long = offline
MIN_SOURCES = int(env("MIN_SOURCES", "2"))                  # independent signals needed before recommending
SENSOR_ALONE = env("SENSOR_ALONE", "1") == "1"              # the pole sensor (a measurement) may recommend on its own
SUGGEST_NEIGHBORS = env("SUGGEST_NEIGHBORS", "1") == "1"    # offer nearby streets with no report as OPTIONAL extra cuts
CORROBORATE_M = float(env("CORROBORATE_M", "150"))          # signals must be this close to back each other up

# --- flood model (per home, by elevation; not per street)
DANGER_DEPTH_M = float(env("DANGER_DEPTH_M", "0.45"))       # water this deep at a home = cut it (about knee)
BUFFER_DEPTH_M = float(env("BUFFER_DEPTH_M", "0.25"))       # safety buffer: cut homes within 25 cm of danger too
WATCH_DEPTH_M = float(env("WATCH_DEPTH_M", "0.60"))         # warn (SMS only) homes within 60 cm of danger
FLOOD_REACH_M = float(env("FLOOD_REACH_M", "200"))          # how far one reading/photo is trusted to describe

# --- photo checks
PHOTO_MAX_AGE_H = float(env("PHOTO_MAX_AGE_H", "3"))        # EXIF says older than this = old photo, not counted
PHOTO_MAX_DIST_M = float(env("PHOTO_MAX_DIST_M", "400"))    # sender's GPS this far from the street = not counted
TZ_OFFSET_H = float(env("TZ_OFFSET_H", "8"))                # phones write EXIF time in local time (PH = +8)

# --- forecast (Open-Meteo, free, no key)
FORECAST_LAT = float(env("FORECAST_LAT", "14.5995"))
FORECAST_LON = float(env("FORECAST_LON", "120.9842"))
HEAVY_RAIN_MM_H = float(env("HEAVY_RAIN_MM_H", "7.5"))
FORECAST_EVERY_S = float(env("FORECAST_EVERY_S", "600"))
FORECAST_ENABLED = env("FORECAST_ENABLED", "1") == "1"

# --- SMS: console | semaphore | twilio | sns
SMS_PROVIDER = env("SMS_PROVIDER", "console")
SMS_RADIUS_M = float(env("SMS_RADIUS_M", "100"))   # around each affected HOME
SEMAPHORE_API_KEY = env("SEMAPHORE_API_KEY")
SEMAPHORE_SENDER = env("SEMAPHORE_SENDER", "")
TWILIO_SID = env("TWILIO_SID")
TWILIO_TOKEN = env("TWILIO_TOKEN")
TWILIO_FROM = env("TWILIO_FROM")
AWS_REGION = env("AWS_REGION", "ap-southeast-1")

# --- photo AI: bedrock | manual
VISION_PROVIDER = env("VISION_PROVIDER", "manual")
BEDROCK_REGION = env("BEDROCK_REGION", "us-east-1")
BEDROCK_MODEL_ID = env("BEDROCK_MODEL_ID", "anthropic.claude-3-5-sonnet-20240620-v1:0")

# --- web
# --- Messenger bot reports (the Cloudflare Worker saves them to Firebase; /reports is publicly readable)
FIREBASE_DATABASE_URL = env("FIREBASE_DATABASE_URL", "https://bahagi-f57d7-default-rtdb.asia-southeast1.firebasedatabase.app/")
FIREBASE_POLL_S = float(env("FIREBASE_POLL_S", "4"))
DASHBOARD_DIR = ROOT / "dashboard"            # the team's React dashboard, built (served at /)

CORS_ORIGINS = [o.strip() for o in env("CORS_ORIGINS", "*").split(",") if o.strip()]
PUBLIC_URL = env("PUBLIC_URL", "")      # e.g. http://192.168.1.10:8000, used for photo links

DATA = ROOT / "data"
UPLOADS = ROOT / "uploads"
STATIC = ROOT / "static"
