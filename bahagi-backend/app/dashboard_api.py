"""The API the team's React dashboard (msmeralco/TeamNexora · bahagi-dashboard) already expects, at /api.

    GET  /api/regions                     region > city > barangay > street (+ powerOff, NOAH hazard)
    GET  /api/reports                     resident reports (web page + Messenger bot), newest first
    GET  /api/recommendations             PASYA's recommendation(s)
    POST /api/recommendations/{id}/approve | /reject      -> {smsSent, smsFailed?}
    POST /api/streets/{id}/restore        -> {smsSent, smsFailed?}
    GET  /api/sensors                     latest reading per pole (the dashboard polls this instead of MQTT)
    GET  /api/alerts                      box errors + flood alerts + what happened recently

Street ids match the Messenger bot's Firebase seed (estero, mabini, rizal), so bot reports line up.
"""
import time

from fastapi import APIRouter, HTTPException

from .levels import LABEL, LEVEL_DEPTH_M

router = APIRouter(prefix="/api", tags=["Team dashboard"])
engine = None            # set by main.py

REGION = {"id": "ncr", "name": "NCR"}
CITY = {"id": "pasig", "name": "Pasig City"}
BARANGAY = {"id": "kapitolyo", "name": "Brgy. Kapitolyo", "lat": 14.5733, "lng": 121.0575}
# display positions and NOAH hazard per transformer, same as the dashboard's sample data and the bot's seed
STREETS = {
    "S1": {"id": "estero", "lat": 14.5738, "lng": 121.0584, "noah": {"y5": "high", "y25": "high", "y100": "high"}},
    "S2": {"id": "mabini", "lat": 14.5731, "lng": 121.0575, "noah": {"y5": "medium", "y25": "high", "y100": "high"}},
    "S3": {"id": "rizal", "lat": 14.5724, "lng": 121.0566, "noah": {"y5": "low", "y25": "medium", "y100": "high"}},
}


def street_id(sw):
    if sw in STREETS:
        return STREETS[sw]["id"]
    return engine.grid.street_of_switch(sw).split()[0].lower() if sw else None


def switch_for(street_id_):
    for sw in engine.grid.switches:
        if street_id(sw) == street_id_:
            return sw
    return None


def gauge_cm(level):
    """A level as centimetres on the dashboard's 1:10 tabletop gauge."""
    return round(LEVEL_DEPTH_M.get(level, 0) * 10, 1)


@router.get("/regions")
def regions():
    g = engine.grid
    streets = []
    for sw, t in g.switches.items():
        d = STREETS.get(sw, {})
        poles = [{"id": pid, "name": f"Pole {pid} · {t.street}", "lat": d.get("lat", p["lat"]), "lng": d.get("lng", p["lon"])}
                 for pid, p in g.poles.items() if p["switch"] == sw and p.get("sensor")]
        streets.append({"id": street_id(sw), "name": t.street, "switchId": sw, "transformer": t.name,
                        "lat": d.get("lat", t.poles[0]["lat"]), "lng": d.get("lng", t.poles[0]["lon"]),
                        "poles": poles, "powerOff": sw in engine.open_switches, "noah": d.get("noah"),
                        "homes": len(t.homes),
                        "metersOff": sorted(m for m in engine.off_meters if g.homes[m]["switch"] == sw)})
    return [{**REGION, "cities": [{**CITY, "barangays": [{**BARANGAY, "streets": streets}]}]}]


@router.get("/reports")
def reports():
    with engine.lock:
        engine.evidence()                    # refreshes which reports count right now
        rows = list(engine.reports[:40])
    out = []
    for r in rows:
        why = "; ".join(r.get("flags") or []) or (r.get("duplicateWhy") or "")
        if r.get("contradicted"):
            why = "the pole sensor nearby reads much lower"
        note = r.get("reason") or ""
        if not r.get("counts") and why:
            note = f"Not counted: {why}. {note}".strip()
        out.append({"id": r["id"], "barangayId": BARANGAY["id"], "streetId": street_id(r.get("switchId")),
                    "source": str(r.get("channel") or "web").lower(),
                    "photoUrl": r.get("photoUrl"), "note": note, "estimatedCm": gauge_cm(r["level"]),
                    "confidence": r.get("confidence", 0), "duplicate": bool(r.get("duplicate")),
                    "counted": bool(r.get("counts")), "level": r["level"],
                    "liveWireRisk": bool(r.get("liveWireRisk")), "ts": int(r["ts"] * 1000)})
    return out


@router.get("/recommendations")
def recommendations():
    rec = engine.state()["recommendation"]
    if not rec:
        return []
    g = engine.grid
    sws, ms = rec.get("switchIds", []), rec.get("meterIds", [])
    first = sws[0] if sws else (g.homes[ms[0]]["switch"] if ms else None)
    parts = [f"Open {g.switches[s].name} · {g.street_of_switch(s)}" for s in sws] + \
            [f"switch off smart meter {m} ({g.homes[m]['street']})" for m in ms]
    evidence = [rec.get("evidence") or ""] + [p["reason"] for p in rec.get("plan", []) if p.get("action") != "none"]
    if rec.get("watchHomes"):
        evidence.append(f"Warning text only (power stays on): {', '.join(rec['watchHomes'])}")
    return [{"id": rec["id"], "barangayId": BARANGAY["id"], "streetId": street_id(first),
             "switchId": " + ".join([*sws, *ms]) or (first or ""), "action": "open",
             "title": ("Optional: " if rec.get("suggested") else "") + ("; ".join(parts) or "Recommendation"), "homesCut": rec["homesCut"], "homesKept": rec["homesKept"],
             "evidence": [e for e in evidence if e], "status": rec["status"]}]


def _sms():
    s = engine.sms_state
    return {"smsSent": s.get("recipients", 0), **({"smsFailed": 1} if s.get("status") == "failed" else {})}


@router.post("/recommendations/{rec_id}/approve")
def approve(rec_id: str):
    if not engine.approve(rec_id, who="the dashboard"):
        raise HTTPException(409, "That recommendation is no longer waiting for approval")
    return _sms()


@router.post("/recommendations/{rec_id}/reject")
def reject(rec_id: str):
    if not engine.reject(rec_id, who="the dashboard"):
        raise HTTPException(409, "That recommendation is no longer waiting for approval")
    return {"smsSent": 0}


@router.post("/streets/{sid}/restore")
def restore(sid: str):
    sw = switch_for(sid)
    if not sw:
        raise HTTPException(404, f"Unknown street {sid}")
    before = engine.sms_state.get("at")
    engine.restore_street(sw, who="the dashboard")
    return _sms() if engine.sms_state.get("at") != before else {"smsSent": 0}


@router.get("/sensors")
def sensors():
    s = engine.sensor
    if not engine.box["everSeen"]:
        return []
    return [{"poleId": s["poleId"], "levelCm": s["depthCm"], "level": s["level"], "online": s["online"],
             "ts": int(s["lastSeen"] * 1000), "sensorOk": engine.box["sensorOk"]}]


@router.get("/alerts")
def alerts():
    a = engine.alerts()
    for x in a["active"] + a["recent"]:
        x["streetId"] = next((street_id(sw) for sw, t in engine.grid.switches.items() if t.street == x.get("street")), None)
        x["ts"] = int(x["ts"] * 1000)
    return a


@router.get("/levels")
def levels():
    """The gauge, for the dashboard legend."""
    return {k: {"label": LABEL[k], "gaugeCm": gauge_cm(k), "realM": v} for k, v in LEVEL_DEPTH_M.items()}
