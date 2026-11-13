"""Pull the Messenger bot's reports (Cloudflare Worker -> Firebase Realtime Database) into BAHAGI.

The bot already ran Bedrock on each photo and saved a dashboard-ready report at /reports/{id}. The database rules
make /reports and /streets publicly readable, so this needs no key: just FIREBASE_DATABASE_URL.
Each new bot report becomes a photo signal here, so it counts toward the two-signal rule like any other photo.
"""
import threading
import time

import httpx

from . import config

BOT_LEVEL = {"none": "normal", "gutter": "gutter", "knee": "knee", "waist": "waist", "chest": "chest"}
STREET_NAMES = {"estero": "Estero St.", "mabini": "Mabini St.", "rizal": "Rizal St."}


def _street_name(engine, sid):
    if sid in STREET_NAMES:
        return STREET_NAMES[sid]
    for t in engine.grid.switches.values():
        if t.street.split()[0].lower() == str(sid).lower():
            return t.street
    return None


def ingest(engine, rid: str, r: dict, seen: set):
    """Turn one bot report into a BAHAGI report (once)."""
    if rid in seen or not isinstance(r, dict):
        return False
    seen.add(rid)
    a = r.get("analysis") or {}
    level = BOT_LEVEL.get(r.get("depthLevel") or a.get("depth_level") or "none", "normal")
    ts_ms = r.get("ts")
    ts = ts_ms / 1000 if isinstance(ts_ms, (int, float)) and ts_ms > 1e11 else None
    engine.add_report(
        channel="Messenger", street=_street_name(engine, r.get("streetId")), level=level,
        confidence=float(r.get("confidence") or a.get("confidence") or 0),
        model="bedrock (Messenger bot)", reason=str(a.get("reason") or r.get("note") or "")[:200],
        scene="street_flood" if a.get("is_flood", level != "normal") else "no_flood",
        photo_url=r.get("photoUrl"), ts=ts, duplicate_hint=bool(r.get("duplicate")),
        external_id=f"fb-{rid}", live_wire=bool(r.get("liveWireRisk") or a.get("live_wire_risk")))
    return True


def _loop(engine, stop: threading.Event):
    base = config.FIREBASE_DATABASE_URL.rstrip("/")
    url = f"{base}/reports.json"
    params = {"orderBy": '"ts"', "limitToLast": "30"}
    seen: set = set()
    first = True
    while not stop.is_set():
        try:
            res = httpx.get(url, params=params, timeout=6)
            res.raise_for_status()
            data = res.json() or {}
            items = sorted(data.items(), key=lambda kv: (kv[1] or {}).get("ts", 0) if isinstance(kv[1], dict) else 0)
            new = 0
            for rid, r in items:
                if ingest(engine, rid, r, seen):
                    new += 1
            with engine.lock:
                engine.bridge.update(ok=True, error=None, at=time.time(), count=engine.bridge["count"] + new)
                if first:
                    engine.add_log(f"Messenger bot linked (Firebase): {len(items)} recent report(s) read.")
            first = False
        except Exception as e:  # offline, wrong URL, rules
            with engine.lock:
                if engine.bridge["ok"] is not False:
                    engine.add_log(f"Messenger bot link: can't read Firebase ({str(e)[:80]}).")
                engine.bridge.update(ok=False, error=str(e)[:200], at=time.time())
        stop.wait(config.FIREBASE_POLL_S)


def start(engine):
    if not config.FIREBASE_DATABASE_URL:
        return None
    engine.bridge["enabled"] = True
    stop = threading.Event()
    threading.Thread(target=_loop, args=(engine, stop), daemon=True, name="bahagi-firebase").start()
    return stop
