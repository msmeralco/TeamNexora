"""Cheap checks against fake or recycled flood photos. No model training involved.

* EXIF time:  a photo taken hours ago (an old flood, a downloaded picture) doesn't count.
* EXIF GPS:   a photo taken far from the street it claims doesn't count.
* dHash:      a 64-bit "visual fingerprint". A resized / re-saved / screenshotted copy of an earlier photo has almost
              the same fingerprint, so it counts as a duplicate even though its bytes differ.
Messenger and Viber strip EXIF, so a photo with no EXIF is NOT penalised; the other safeguards still apply
(AI scene check, sender GPS from the report page, the sensor cross-check, two-signal rule, a human approves).
"""
import io
from datetime import datetime, timedelta, timezone

from . import config

try:
    from PIL import Image
except Exception:            # Pillow missing: the checks just report "not checked"
    Image = None


def _open(data):
    if not Image or not data:
        return None
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
        return im
    except Exception:
        return None


def _deg(v):
    try:
        d, m, s = (float(x) for x in v)
        return d + m / 60 + s / 3600
    except Exception:
        return None


def exif_info(data):
    """{"takenAt": iso | None, "ageH": float | None, "gps": [lat, lon] | None}"""
    out = {"takenAt": None, "ageH": None, "gps": None}
    im = _open(data)
    if im is None:
        return out
    try:
        ex = im.getexif()
        sub = ex.get_ifd(0x8769)
        raw = sub.get(36867) or ex.get(306)                 # DateTimeOriginal, else DateTime
        if raw:
            off = sub.get(36881)                             # OffsetTimeOriginal, e.g. "+08:00"
            if off and len(str(off)) >= 6:
                sign = -1 if str(off)[0] == "-" else 1
                hh, mm = str(off)[1:].split(":")[:2]
                tz = timezone(sign * timedelta(hours=int(hh), minutes=int(mm)))
            else:
                tz = timezone(timedelta(hours=config.TZ_OFFSET_H))
            t = datetime.strptime(str(raw).strip()[:19], "%Y:%m:%d %H:%M:%S").replace(tzinfo=tz)
            out["takenAt"] = t.isoformat()
            out["ageH"] = round((datetime.now(timezone.utc) - t).total_seconds() / 3600, 2)
        gps = ex.get_ifd(0x8825)
        if gps and 2 in gps and 4 in gps:
            lat, lon = _deg(gps[2]), _deg(gps[4])
            if lat is not None and lon is not None:
                if str(gps.get(1, "N")).upper().startswith("S"):
                    lat = -lat
                if str(gps.get(3, "E")).upper().startswith("W"):
                    lon = -lon
                out["gps"] = [round(lat, 6), round(lon, 6)]
    except Exception:
        pass
    return out


def dhash(data, size=8):
    """64-bit difference hash, or None if the bytes aren't a readable image."""
    im = _open(data)
    if im is None:
        return None
    g = im.convert("L").resize((size + 1, size))
    px = list(g.tobytes())
    bits = 0
    for row in range(size):
        for col in range(size):
            left, right = px[row * (size + 1) + col], px[row * (size + 1) + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return bits


def hamming(a, b):
    return bin(a ^ b).count("1")
