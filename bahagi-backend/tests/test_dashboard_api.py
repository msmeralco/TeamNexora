"""The team dashboard's API (/api/*), box-health alerts and the Messenger-bot bridge."""
import os
import time

os.environ["FORECAST_ENABLED"] = "0"
os.environ["SMS_PROVIDER"] = "console"
os.environ["FIREBASE_DATABASE_URL"] = ""

from fastapi.testclient import TestClient  # noqa: E402

from app import config, firebase_bridge  # noqa: E402
from app.main import app, engine  # noqa: E402

c = TestClient(app)


def esp(depth, **kw):
    body = {"poleId": "P1", "depthCm": depth, "sensorOk": True, "uptimeS": 100, "rssi": -60, "lcdOk": True,
            "boot": "power_on", **kw}
    return c.post("/esp/reading", json=body).json()


def kinds(active=True):
    a = c.get("/api/alerts").json()
    return [x["kind"] for x in (a["active"] if active else a["recent"])]


def setup_function(_):
    c.post("/sim/reset")


def test_regions_match_the_dashboard_and_bot_ids():
    r = c.get("/api/regions").json()
    streets = r[0]["cities"][0]["barangays"][0]["streets"]
    assert [s["id"] for s in streets] == ["estero", "mabini", "rizal"]
    assert [s["switchId"] for s in streets] == ["S1", "S2", "S3"]
    assert streets[0]["poles"][0]["id"] == "P1" and streets[1]["poles"] == []
    assert not any(s["powerOff"] for s in streets)


def test_waiting_then_live_sensor():
    assert kinds() == ["box_waiting"] and c.get("/api/sensors").json() == []
    esp(0.0)
    s = c.get("/api/sensors").json()
    assert s[0]["poleId"] == "P1" and s[0]["online"] and s[0]["levelCm"] == 0.0
    assert kinds() == []


def test_sensor_error_weak_wifi_and_missing_screen():
    esp(0.0, sensorOk=False, rssi=-88, lcdOk=False)
    k = kinds()
    assert "sensor_error" in k and "weak_wifi" in k and "lcd_missing" in k


def test_brownout_restart_is_reported():
    esp(0.0, uptimeS=500)
    esp(0.0, uptimeS=3, boot="brownout")
    recent = c.get("/api/alerts").json()["recent"]
    assert recent[0]["kind"] == "box_restart" and recent[0]["severity"] == "critical"
    assert "brownout" in recent[0]["title"]


def test_offline_alert():
    esp(0.0)
    engine.sensor["lastSeen"] = time.time() - 60
    assert "box_offline" in kinds()
    assert "box_offline" in kinds(active=False)


def test_flood_approval_cut_and_restore_through_the_dashboard_api():
    esp(5.4)
    assert "flood" in kinds()
    c.post("/reports", data={"street": "Estero St.", "level": "knee", "sender": "a"})
    recs = c.get("/api/recommendations").json()
    assert len(recs) == 1 and recs[0]["status"] == "pending" and recs[0]["streetId"] == "estero"
    assert recs[0]["homesCut"] == 4 and recs[0]["switchId"] == "S1"     # Estero only
    assert "approval" in kinds()
    sms = c.post(f"/api/recommendations/{recs[0]['id']}/approve").json()
    assert sms["smsSent"] >= 1
    opt = c.get("/api/recommendations").json()[0]
    assert opt["title"].startswith("Optional:") and opt["switchId"] == "M1"   # M1's meter: its own optional card
    c.post(f"/api/recommendations/{opt['id']}/approve")
    streets = c.get("/api/regions").json()[0]["cities"][0]["barangays"][0]["streets"]
    assert streets[0]["powerOff"] and streets[1]["metersOff"] == ["M1"]
    assert "meter_off" in kinds()
    assert esp(5.4) == {"cut": ["S1", "S4"]}
    esp(0.0)
    sms = c.post("/api/streets/estero/restore").json()
    assert sms["smsSent"] >= 1
    assert esp(0.0) == {"cut": ["S4"]}                  # Estero is back; M1's meter was its own decision
    c.post("/api/streets/mabini/restore")
    assert esp(0.0) == {"cut": []}
    assert "meter_off" not in kinds()


def test_reports_feed():
    esp(0.0)
    c.post("/reports", data={"street": "Mabini St.", "level": "waist", "sender": "x", "channel": "Web"})
    r = c.get("/api/reports").json()[0]
    assert r["streetId"] == "mabini" and r["estimatedCm"] == 9.4 and r["source"] == "web" and r["ts"] > 1e12


def test_messenger_bot_report_counts_as_a_photo():
    esp(5.4)
    seen = set()
    bot = {"barangayId": "kapitolyo", "streetId": "estero", "source": "messenger", "photoUrl": "https://x/p.jpg",
           "estimatedCm": 4.8, "depthLevel": "knee", "confidence": 0.88, "duplicate": False, "liveWireRisk": True,
           "analysis": {"is_flood": True, "depth_level": "knee", "confidence": 0.88, "reason": "knee-deep water"},
           "ts": int(time.time() * 1000)}
    assert firebase_bridge.ingest(engine, "-Nabc", bot, seen)
    assert not firebase_bridge.ingest(engine, "-Nabc", bot, seen)        # only once
    rep = c.get("/api/reports").json()[0]
    assert rep["id"] == "fb--Nabc" and rep["counted"] and rep["source"] == "messenger"
    assert c.get("/api/recommendations").json()[0]["status"] == "pending"
    assert "live_wire" in kinds(active=False)


def test_bot_duplicate_and_not_flood_do_not_count(monkeypatch):
    monkeypatch.setattr(config, "SENSOR_ALONE", False)
    esp(5.4)
    seen = set()
    firebase_bridge.ingest(engine, "a", {"streetId": "estero", "depthLevel": "knee", "confidence": 0.9,
                                         "duplicate": True, "ts": int(time.time() * 1000)}, seen)
    firebase_bridge.ingest(engine, "b", {"streetId": "estero", "depthLevel": "none", "confidence": 0.9,
                                         "analysis": {"is_flood": False}, "ts": int(time.time() * 1000)}, seen)
    assert c.get("/api/recommendations").json() == []


def test_dashboard_served_or_docs():
    r = c.get("/", follow_redirects=False)
    assert r.status_code in (200, 307)
