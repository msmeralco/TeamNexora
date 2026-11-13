"""End-to-end: flood -> two signals -> per-home flood map -> smallest cut Meralco can make -> approve -> relay + SMS
-> restore. Plus the fake-photo checks."""
import io
import os
from datetime import datetime, timedelta

os.environ["FORECAST_ENABLED"] = "0"      # tests must not depend on the internet
os.environ["SMS_PROVIDER"] = "console"
os.environ["FIREBASE_DATABASE_URL"] = ""   # no network in tests

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app import config  # noqa: E402
from app.main import app, engine  # noqa: E402

c = TestClient(app)


def post(depth, **kw):
    return c.post("/esp/reading", json={"poleId": "P1", "depthCm": depth, "sensorOk": True, **kw}).json()


def homes():
    return {h["id"]: h for h in c.get("/state").json()["homes"]}


def jpeg(seed=0, size=(320, 240), exif_time=None, quality=90):
    im = Image.new("RGB", size)
    px = im.load()
    for x in range(size[0]):
        for y in range(size[1]):
            px[x, y] = ((x * 3 + seed * 40) % 256, (y * 5 + seed * 70) % 256, ((x + y) * seed) % 256)
    buf = io.BytesIO()
    kw = {"quality": quality}
    if exif_time:
        ex = Image.Exif()
        ex[306] = exif_time.strftime("%Y:%m:%d %H:%M:%S")
        kw["exif"] = ex
    im.save(buf, "JPEG", **kw)
    return buf.getvalue()


def setup_function(_):
    c.post("/sim/reset")


def test_dry_all_on():
    assert post(0.0) == {"cut": []}
    s = c.get("/state").json()
    assert all(not st["switchOpen"] for st in s["streets"])
    assert s["sensor"]["online"] and s["sensor"]["level"] == "normal"
    assert s["recommendation"] is None and s["summary"]["off"] == 0


def test_sensor_alone_recommends_its_own_street():
    post(5.4)                                  # knee
    s = c.get("/state").json()
    assert s["sensor"]["level"] == "knee" and s["sources"]["sensor"] is True
    rec = s["recommendation"]
    assert rec["switchIds"] == ["S1"] and rec["meterIds"] == [] and not rec["suggested"]   # Estero only
    assert post(5.4) == {"cut": []}            # still nothing switches before approval


def test_sensor_alone_needs_a_second_signal_when_turned_off(monkeypatch):
    monkeypatch.setattr(config, "SENSOR_ALONE", False)
    post(5.4)
    assert c.get("/state").json()["recommendation"] is None


def test_one_street_per_card_then_optional_neighbor():
    post(5.4)
    r = c.post("/reports", data={"channel": "Messenger", "street": "Estero St.", "level": "knee", "sender": "0917"})
    assert r.status_code == 200 and r.json()["switchId"] == "S1" and r.json()["counts"]
    rec = c.get("/state").json()["recommendation"]
    assert rec["status"] == "pending" and not rec["suggested"]
    assert rec["switchIds"] == ["S1"] and rec["meterIds"] == []      # Estero only, nothing bundled in
    assert rec["homesCut"] == 4 and rec["homesKept"] == 8
    assert {"M1", "M2"} <= set(rec["watchHomes"])                     # neighbours get a warning text
    assert post(5.4) == {"cut": []}                                   # nothing switches before approval
    c.post(f"/recommendations/{rec['id']}/approve")
    nxt = c.get("/state").json()["recommendation"]
    assert nxt["suggested"] and nxt["meterIds"] == ["M1"] and nxt["switchIds"] == []   # optional, its own card
    assert post(5.4) == {"cut": ["S1"]}                               # only Estero is cut so far
    c.post(f"/recommendations/{nxt['id']}/approve")
    assert post(5.4) == {"cut": ["S1", "S4"]}


def test_optional_neighbor_can_be_rejected():
    post(0.0)
    c.post("/reports", data={"street": "Rizal St.", "level": "knee", "sender": "a"})
    c.post("/reports", data={"street": "Rizal St.", "level": "knee", "sender": "b"})
    rec = c.get("/state").json()["recommendation"]
    c.post(f"/recommendations/{rec['id']}/approve")
    nxt = c.get("/state").json()["recommendation"]
    assert nxt["suggested"] and nxt["switchIds"] == ["S2"]            # Mabini (lower) offered, not forced
    c.post(f"/recommendations/{nxt['id']}/reject")
    post(0.0)
    assert engine.open_switches == {"S3"}                            # only Rizal is cut
    assert c.get("/state").json()["recommendation"]["status"] == "rejected"


def test_dry_sensor_stops_a_neighbor_suggestion():
    post(0.0)                                                        # the Estero sensor says Estero is dry
    c.post("/reports", data={"street": "Mabini St.", "level": "knee", "sender": "a"})
    c.post("/reports", data={"street": "Mabini St.", "level": "knee", "sender": "b"})
    rec = c.get("/state").json()["recommendation"]
    assert rec["switchIds"] == ["S2"]
    c.post(f"/recommendations/{rec['id']}/approve")
    nxt = c.get("/state").json()["recommendation"]
    assert nxt["status"] == "approved" and nxt["id"] == rec["id"]    # nothing optional for Estero: it's measured dry


def test_grid_rules_smart_vs_traditional():
    g = engine.grid
    only_smart = g.plan_cut({"M1": {"risk": "buffer"}})
    assert only_smart["switchIds"] == [] and only_smart["meterIds"] == ["M1"] and only_smart["homesCut"] == 1
    trad = g.plan_cut({"M1": {"risk": "buffer"}, "M3": {"risk": "flooded"}})
    assert trad["switchIds"] == ["S2"] and trad["meterIds"] == [] and trad["homesCut"] == 4


def test_two_photos_from_different_people_recommend_mabini_only():
    post(0.0)
    c.post("/reports", data={"street": "Mabini St.", "level": "knee", "sender": "a"})
    c.post("/reports", data={"street": "Mabini St.", "level": "waist", "sender": "b"})
    rec = c.get("/state").json()["recommendation"]
    assert rec["status"] == "pending" and rec["switchIds"] == ["S2"]


def test_photos_on_one_street_do_not_cut_the_next_street():
    post(0.0)
    c.post("/reports", data={"street": "Rizal St.", "level": "knee", "sender": "a"})
    c.post("/reports", data={"street": "Rizal St.", "level": "knee", "sender": "b"})
    rec = c.get("/state").json()["recommendation"]
    assert rec["switchIds"] == ["S3"] and rec["meterIds"] == [] and not rec["suggested"]   # Rizal only
    assert "M2" in rec["watchHomes"]                                # lower Mabini homes get a warning text
    c.post(f"/recommendations/{rec['id']}/approve")
    nxt = c.get("/state").json()["recommendation"]
    assert nxt["suggested"] and nxt["switchIds"] == ["S2"]          # Mabini only as an optional extra
    assert engine.open_switches == {"S3"}


def test_cut_removes_the_reports_it_resolved():
    post(0.0)
    c.post("/reports", data={"street": "Mabini St.", "level": "knee", "sender": "a"})
    c.post("/reports", data={"street": "Mabini St.", "level": "waist", "sender": "b"})
    c.post("/reports", data={"street": "Rizal St.", "level": "gutter", "sender": "c"})
    rec = c.get("/state").json()["recommendation"]
    c.post(f"/recommendations/{rec['id']}/approve")
    assert [r["street"] for r in engine.reports] == ["Rizal St."]       # Mabini's reports are resolved and gone
    engine.restore_street("S2")
    post(0.0)
    assert engine.recommendation["status"] == "restored"         # old photos don't make a new recommendation


def test_resolved_bot_report_is_not_imported_again():
    engine.resolved_ids.add("fb-test1")
    assert engine.add_report(channel="Messenger", street="Mabini St.", level="knee", confidence=0.9, model="m",
                             reason="", external_id="fb-test1") is None
    assert engine.reports == []
    engine.resolved_ids.discard("fb-test1")


def test_sensor_contradicts_fake_photos():
    post(0.0)                                  # the pole sensor on Estero reads dry
    for who in ("a", "b"):
        c.post("/reports", data={"street": "Estero St.", "level": "waist", "sender": who})
    s = c.get("/state").json()
    assert all(r["contradicted"] and not r["counts"] for r in s["reports"])
    assert s["recommendation"] is None


def test_ai_scene_check_rejects_bathtub(monkeypatch):
    monkeypatch.setattr(config, "SENSOR_ALONE", False)
    post(5.4)
    rep = engine.add_report(channel="Web", street="Estero St.", level="knee", confidence=0.9, model="test",
                            reason="", scene="indoor_or_bathtub")
    assert rep["flags"] and not rep["counts"]
    assert c.get("/state").json()["recommendation"] is None


def test_duplicate_and_resized_copy_do_not_count_twice():
    post(0.0)
    img = jpeg(1)
    c.post("/reports", data={"street": "Mabini St.", "level": "waist", "sender": "a"},
           files={"photo": ("a.jpg", img, "image/jpeg")})
    c.post("/reports", data={"street": "Mabini St.", "level": "waist", "sender": "b"},
           files={"photo": ("a.jpg", img, "image/jpeg")})                       # exact copy
    small = Image.open(io.BytesIO(img)).resize((160, 120))
    buf = io.BytesIO()
    small.save(buf, "JPEG", quality=60)
    c.post("/reports", data={"street": "Mabini St.", "level": "waist", "sender": "c"},
           files={"photo": ("b.jpg", buf.getvalue(), "image/jpeg")})            # resized, re-saved copy
    s = c.get("/state").json()
    assert [r["duplicate"] for r in s["reports"][:3]] == [True, True, False]
    assert s["recommendation"] is None


def test_old_photo_and_far_sender_do_not_count(monkeypatch):
    monkeypatch.setattr(config, "SENSOR_ALONE", False)
    post(5.4)
    old = jpeg(2, exif_time=datetime.now() - timedelta(days=2))
    r = c.post("/reports", data={"street": "Estero St.", "level": "knee", "sender": "a"},
               files={"photo": ("old.jpg", old, "image/jpeg")}).json()
    assert any("old photo" in f for f in r["flags"])
    r = c.post("/reports", data={"street": "Estero St.", "level": "knee", "sender": "b",
                                 "lat": "14.60", "lon": "121.00"}).json()
    assert any("sender is" in f for f in r["flags"])
    assert c.get("/state").json()["recommendation"] is None


def test_reject_keeps_lights_on_and_does_not_nag():
    post(5.4)
    c.post("/reports", data={"street": "Estero St.", "level": "knee"})
    rec = c.get("/state").json()["recommendation"]
    c.post(f"/recommendations/{rec['id']}/reject")
    post(5.6)
    s = c.get("/state").json()
    assert not s["recommendation"] or s["recommendation"]["switchIds"] != ["S1"]   # Estero isn't asked again
    assert not any(st["switchOpen"] for st in s["streets"])


def test_lid_button_approval_and_restore():
    post(6.0)
    assert post(6.0, lidApproved=True) == {"cut": ["S1"]}     # someone pressed APPROVE on the box
    assert post(0.0, lidRestore=True, cut={"S1": True}) == {"cut": []}


def test_box_already_cut_is_adopted_after_backend_restart():
    assert post(6.0, cut={"S1": True}) == {"cut": ["S1"]}
    c.post("/sim/reset")
    assert post(0.0, cut={"S4": True}) == {"cut": ["S4"]}         # M1's meter relay was already open
    assert homes()["M1"]["power"] == "meter_off"


def test_dashboard_restore_is_not_undone_by_the_box():
    post(0.0)
    engine._apply_cut(["S1", "S2"], [], who="the dashboard")
    assert post(0.0) == {"cut": ["S1", "S2", "S4"]}
    engine.restore_street("S1")                                     # dispatcher restores Estero
    # the box hasn't heard the restore yet, so its next post still shows S1 cut: that must not cut S1 again
    assert post(0.0, cut={"S1": True, "S2": True, "S4": True}) == {"cut": ["S2", "S4"]}
    assert post(0.0, cut={"S1": False, "S2": True, "S4": True}) == {"cut": ["S2", "S4"]}


def test_meter_relay_follows_its_transformer():
    engine.restore()
    engine.open_switches.add("S2")                                   # TR-2 open = M1 dark too
    assert engine.relays_open() == ["S2", "S4"]


def test_customer_status():
    post(5.4)
    c.post("/reports", data={"street": "Estero St.", "level": "knee"})
    for _ in range(2):                         # Estero, then the optional M1 smart-meter card
        rec = c.get("/state").json()["recommendation"]
        c.post(f"/recommendations/{rec['id']}/approve")
    assert c.get("/customer/status", params={"homeId": "M1"}).json()["power"] == "meter_off"
    near_m2 = c.get("/customer/status", params={"lat": 14.6418, "lon": 121.0945}).json()
    assert near_m2["id"] == "M2" and near_m2["power"] == "on" and "near" in near_m2["message"]


def test_report_page_and_docs():
    assert c.get("/report").status_code == 200
    assert c.get("/docs").status_code == 200
    assert len(c.get("/grid").json()["switches"]) == 3
