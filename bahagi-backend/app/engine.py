"""The BAHAGI brain: holds the live state and applies the rules.

SILIP   sensor readings (ESP32) + residents' photos (checked for fakes, cross-checked by AI and by the sensor)
TAYA    rain forecast counts as a supporting signal (never enough on its own)
PASYA   a reading is CONFIRMED when at least MIN_SOURCES independent signals within CORROBORATE_M agree.
        Confirmed readings -> per-home flood map (by elevation, with a safety buffer) -> the smallest cut Meralco
        can make: open a transformer, or remote-disconnect smart meters only.
        Nothing switches until a person approves (dashboard button or the APPROVE button on the box lid).
BABALA  on approval: open the relay(s), text people near the cut homes, and send a WATCH text to homes near the water.
"""
import hashlib
import json
import statistics
import threading
import time
from datetime import datetime, timezone

from . import config, forecast, photocheck, sms
from .grid import Grid, haversine_m
from .levels import LABEL, LEVEL_DEPTH_M, hazard_for, is_danger, level_for_cm, real_depth_m


def iso(ts=None):
    return datetime.fromtimestamp(ts or time.time(), tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _d(a, b):
    return haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])


class Engine:
    def __init__(self, grid: Grid | None = None):
        self.lock = threading.RLock()
        self.grid = grid or Grid()
        # Messenger-bot reports already resolved by a cut. Kept on disk so a backend restart doesn't pull them back
        # in from Firebase and let them drive a new recommendation.
        self.resolved_path = config.DATA / "resolved_reports.json"
        try:
            self.resolved_ids: set[str] = set(json.loads(self.resolved_path.read_text(encoding="utf-8")))
        except Exception:
            self.resolved_ids = set()
        self.reset()

    # ------------------------------------------------------------------ state
    def reset(self):
        with self.lock:
            sp = self.grid.sensor_pole()
            self.sensor = {"poleId": sp, "street": self.grid.poles[sp]["street"], "depthCm": 0.0, "distanceCm": None,
                           "level": "normal", "at": None, "online": False, "lastSeen": 0.0}
            self.open_switches: set[str] = set()       # transformers currently OPEN (relay cut)
            self.off_meters: set[str] = set()          # smart meters remotely disconnected
            self.reports: list[dict] = []
            self.recommendation: dict | None = None
            self.rec_seq = 0
            self.rejected_keys: set[str] = set()        # don't nag again for a cut the dispatcher rejected
            self.queued: list[dict] = []                # optional nearby-street cuts, offered after a street is cut
            self.sms_state = {"status": "idle", "recipients": 0, "message": "", "error": None, "at": None}
            self.log: list[dict] = []
            self.fmap: dict = {}
            self._seen_hashes: set[str] = set()
            self._dhashes: list[int] = []
            self.report_seq = 0
            # the box's own health, sent with every reading (firmware v3+); None until the box says
            self.box = {"uptimeS": None, "rssi": None, "lcdOk": None, "dryCm": None, "boot": None, "sensorOk": None,
                        "everSeen": False}
            self.events: list[dict] = []                # things that happened, for the dashboard's alerts feed
            self.event_seq = 0
            self.bridge = getattr(self, "bridge", None) or \
                {"enabled": False, "ok": None, "error": None, "at": None, "count": 0}   # Messenger bot (Firebase)
            self.add_log("BAHAGI backend started. All transformers ON.")

    def add_event(self, severity, kind, title, detail="", street=None):
        """severity: critical | warning | info. Shown in the dashboard's alerts feed for 30 minutes."""
        self.event_seq += 1
        self.events.insert(0, {"id": f"e{self.event_seq}", "severity": severity, "kind": kind, "title": title,
                               "detail": detail, "street": street, "ts": time.time(), "active": False})
        del self.events[50:]

    def add_log(self, text):
        self.log.insert(0, {"at": iso(), "text": text})
        del self.log[200:]

    # ------------------------------------------------------------------ SILIP: sensor
    def sensor_reading(self, depth_cm: float, distance_cm=None, sensor_ok=True, lid_approved=False, lid_restore=False,
                       esp_cut: dict | None = None, pole_id=None, health: dict | None = None):
        """Called for every ESP32 post. Returns the relays (S1..S3) the box must have OPEN."""
        with self.lock:
            now = time.time()
            prev_level = self.sensor["level"]
            was_online = self.sensor["online"]
            first_contact = not self.box["everSeen"]     # first post since this backend started
            if not was_online and self.box["everSeen"]:
                self.add_event("info", "box_back", f"Pole box {pole_id or self.sensor['poleId']} is back online")
            self.box["everSeen"] = True
            self._box_health(health or {}, sensor_ok)
            self.sensor.update(online=True, lastSeen=now, at=iso(now))
            if pole_id and pole_id in self.grid.poles:
                self.sensor["poleId"] = pole_id
                self.sensor["street"] = self.grid.poles[pole_id]["street"]
            if sensor_ok and depth_cm is not None:
                self.sensor["depthCm"] = round(float(depth_cm), 1)
                self.sensor["distanceCm"] = distance_cm
                self.sensor["level"] = level_for_cm(float(depth_cm))
            if self.sensor["level"] != prev_level:
                self.add_log(f"Pole {self.sensor['poleId']} reads {self.sensor['depthCm']} cm "
                             f"({LABEL[self.sensor['level']]}, about {real_depth_m(self.sensor['depthCm'])} m real).")
            if lid_approved:            # a person pressed APPROVE on the box lid: that IS a human decision
                # it approves the box's OWN street only (Estero for P1), never another street's card
                self._queue_suggestions()
                self._apply_cut([self.grid.poles[self.sensor["poleId"]]["switch"]], [],
                                who="the APPROVE button on the box lid")
            if lid_restore:
                self._apply_restore(who="the box lid (held 2 s)")
            # The box already shows a cut we don't know about because the BACKEND restarted: adopt it, but only on the
            # first post after a restart. Later posts can still show a street the dispatcher just restored (the box
            # hasn't heard the restore yet); adopting those would cut the street again on its own.
            if esp_cut and first_contact and not lid_restore:
                for sw, is_cut in esp_cut.items():
                    if is_cut and sw in self.grid.switches and sw not in self.open_switches:
                        self.open_switches.add(sw)
                        self.add_log(f"Box reports {self.grid.label(sw)} already OFF; dashboard updated.")
                    hid = self.grid.meter_relays.get(sw)
                    if is_cut and hid and hid not in self.off_meters \
                            and self.grid.homes[hid]["switch"] not in self.open_switches:
                        self.off_meters.add(hid)
                        self.add_log(f"Box reports smart meter {hid} already OFF; dashboard updated.")
            self.decide()
            return self.relays_open()

    def relays_open(self):
        """Relays the box must hold OPEN: every open transformer, plus the relay of each smart meter that is off.
        A meter's relay also opens when its transformer is open, because in the model that house is wired
        through its meter relay only."""
        out = set(self.open_switches)
        for key, hid in self.grid.meter_relays.items():
            if hid in self.off_meters or self.grid.homes[hid]["switch"] in self.open_switches:
                out.add(key)
        return sorted(out)

    def _box_health(self, h: dict, sensor_ok: bool):
        b = self.box
        up, boot = h.get("uptimeS"), h.get("boot")
        if up is not None:
            restarted = b["uptimeS"] is not None and up + 5 < b["uptimeS"]
            first = b["uptimeS"] is None and up < 120          # first post right after a boot
            if restarted or (first and boot == "brownout"):
                if boot == "brownout":
                    self.add_event("critical", "box_restart", "Pole box restarted: power dip (brownout)",
                                   "The supply sagged. Power the box from a 2 A or stronger charger or power bank, "
                                   "not a laptop USB port.")
                elif boot in ("crash", "watchdog"):
                    self.add_event("critical", "box_restart", f"Pole box restarted after a {boot}",
                                   "The ESP32 reset itself. If this repeats, check the power and the wiring.")
                elif restarted:
                    self.add_event("warning", "box_restart", "Pole box restarted",
                                   f"Reason reported by the box: {boot or 'unknown'}.")
                self.add_log(f"Pole box restarted (reason: {boot or 'unknown'}).")
        if b["sensorOk"] is not None and b["sensorOk"] and not sensor_ok:
            self.add_log("Sensor stopped reading the water (no echo).")
        for k in ("uptimeS", "rssi", "lcdOk", "dryCm", "boot"):
            if h.get(k) is not None:
                b[k] = h[k]
        b["sensorOk"] = sensor_ok

    def check_offline(self):
        with self.lock:
            if self.sensor["online"] and time.time() - self.sensor["lastSeen"] > config.SENSOR_OFFLINE_S:
                self.sensor["online"] = False
                self.add_log(f"Sensor {self.sensor['poleId']} went offline.")
                self.add_event("critical", "box_offline", f"Pole box {self.sensor['poleId']} went offline",
                               "No reading for 10 s. Check its power and the Wi-Fi hotspot.", self.sensor["street"])

    # ------------------------------------------------------------------ SILIP: photo reports
    def add_report(self, *, channel, street=None, pole_id=None, lat=None, lon=None, level, confidence, model, reason,
                   scene="not_checked", photo_bytes=None, photo_url=None, sender=None, exif=None,
                   ts=None, duplicate_hint=False, external_id=None, live_wire=False):
        with self.lock:
            if external_id and external_id in self.resolved_ids:
                return None                      # already resolved by an earlier cut: don't bring it back
            g = self.grid
            gps = lat is not None and lon is not None
            sw = None
            if pole_id and pole_id in g.poles:                     # where is it? pole id > street > GPS
                sw = g.poles[pole_id]["switch"]
            elif street and g.switch_for_street(street):
                sw = g.switch_for_street(street)
                pole_id = g.nearest_pole(lat, lon, switch=sw)[0] if gps else g.switches[sw].poles[0]["id"]
            elif gps:
                pid, dist = g.nearest_pole(lat, lon)
                if dist <= 300:
                    pole_id, sw = pid, g.poles[pid]["switch"]
            pole = g.poles.get(pole_id) if pole_id else None

            flags = []                                             # any flag = the photo does not count
            if scene not in ("street_flood", "not_checked"):
                flags.append(f"AI: not a street flood ({scene.replace('_', ' ')})")
            exif = exif or {}
            if exif.get("ageH") is not None and exif["ageH"] > config.PHOTO_MAX_AGE_H:
                flags.append(f"old photo: taken {exif['ageH']:.0f} h ago")
            if exif.get("gps") and pole:
                dm = haversine_m(exif["gps"][0], exif["gps"][1], pole["lat"], pole["lon"])
                if dm > config.PHOTO_MAX_DIST_M:
                    flags.append(f"photo's GPS is {dm:.0f} m from {pole['street']}")
            if gps and pole:
                dm = haversine_m(lat, lon, pole["lat"], pole["lon"])
                if dm > config.PHOTO_MAX_DIST_M:
                    flags.append(f"sender is {dm:.0f} m from {pole['street']}")

            duplicate, dup_why = False, ""
            if photo_bytes:
                h = hashlib.sha256(photo_bytes).hexdigest()
                if h in self._seen_hashes:
                    duplicate, dup_why = True, "exact copy of an earlier photo"
                self._seen_hashes.add(h)
                dh = photocheck.dhash(photo_bytes)
                if dh is not None:
                    if not duplicate and any(photocheck.hamming(dh, o) <= 6 for o in self._dhashes):
                        duplicate, dup_why = True, "same picture as an earlier report (resized or re-saved)"
                    self._dhashes.append(dh)
            sender_key = hashlib.sha256(sender.encode()).hexdigest()[:12] if sender else None   # don't keep numbers
            if sender_key and not duplicate:          # same sender, same transformer, within 10 min = one signal
                for r in self.reports:
                    if r.get("senderKey") == sender_key and r["switchId"] == sw and time.time() - r["ts"] < 600:
                        duplicate, dup_why = True, "same sender within 10 min"
                        break
            if duplicate_hint and not duplicate:
                duplicate, dup_why = True, "the Messenger bot already marked this photo as a duplicate"
            self.report_seq += 1
            rid = external_id or f"r{self.report_seq}"
            rep = {"id": rid, "channel": channel, "street": g.street_of_switch(sw) if sw else (street or "unknown"),
                   "switchId": sw, "transformer": g.switches[sw].name if sw else None, "poleId": pole_id,
                   "level": level, "confidence": round(confidence, 2), "model": model, "reason": reason,
                   "scene": scene, "flags": flags, "exifTakenAt": exif.get("takenAt"), "at": iso(ts), "ts": ts or time.time(),
                   "liveWireRisk": bool(live_wire),
                   "duplicate": duplicate, "duplicateWhy": dup_why, "contradicted": False, "counts": False,
                   "photoUrl": photo_url, "senderKey": sender_key}
            self.reports.insert(0, rep)
            del self.reports[100:]
            note = (f" · duplicate ({dup_why}), ignored" if duplicate else "") + \
                   (f" · NOT counted: {'; '.join(flags)}" if flags else "")
            self.add_log(f"{channel} report: {rep['street']} at {LABEL.get(level, level)} "
                         f"({int(confidence * 100)}% sure){note}.")
            if flags:
                self.add_event("info", "photo_rejected", f"{channel} photo from {rep['street']} not counted",
                               "; ".join(flags), rep["street"])
            elif duplicate:
                self.add_event("info", "photo_duplicate", f"Duplicate {channel} photo from {rep['street']} ignored",
                               dup_why, rep["street"])
            elif live_wire:
                self.add_event("critical", "live_wire", f"Resident photo: water near live equipment on {rep['street']}",
                               reason, rep["street"])
            self.decide()
            return rep

    # ------------------------------------------------------------------ PASYA: evidence
    def evidence(self):
        now = time.time()
        g = self.grid
        sp = g.poles[self.sensor["poleId"]]
        online = self.sensor["online"]
        s_surface = sp["elev"] + real_depth_m(self.sensor["depthCm"])
        s_danger = online and is_danger(self.sensor["level"])
        sensors = [{"lat": sp["lat"], "lon": sp["lon"], "surface": s_surface}] if online else []
        photos = []
        for r in self.reports:
            r["counts"], r["contradicted"] = False, False
            if r["duplicate"] or r["flags"] or not r["poleId"] or r["confidence"] < 0.5 \
                    or now - r["ts"] > config.REPORT_WINDOW_MIN * 60:
                continue
            p = g.poles[r["poleId"]]
            surface = p["elev"] + LEVEL_DEPTH_M.get(r["level"], 0)
            # the sensor cross-check: a working sensor nearby says the water is much lower than the photo claims
            if online and is_danger(r["level"]) and _d(p, sp) <= config.CORROBORATE_M and surface > s_surface + 0.30:
                r["contradicted"] = True
                continue
            r["counts"] = True
            if is_danger(r["level"]):
                photos.append({"kind": "photo", "id": r["id"], "lat": p["lat"], "lon": p["lon"], "surface": surface,
                               "switchId": r["switchId"], "poleId": r["poleId"], "street": r["street"]})
        rain = forecast.heavy_rain_soon()
        ground = ([{"kind": "sensor", "id": self.sensor["poleId"], "lat": sp["lat"], "lon": sp["lon"],
                    "surface": s_surface, "switchId": sp["switch"], "poleId": self.sensor["poleId"],
                    "street": sp["street"]}] if s_danger else []) + photos
        confirmed = []
        for gp in ground:
            n_sensor = 1 if s_danger and _d(gp, sp) <= config.CORROBORATE_M else 0
            near = [p["id"] for p in photos if _d(gp, p) <= config.CORROBORATE_M]
            sensor_alone = gp["kind"] == "sensor" and config.SENSOR_ALONE     # a measurement, not a claim
            if sensor_alone or n_sensor + min(len(near), 2) + (1 if rain else 0) >= config.MIN_SOURCES:
                confirmed.append({**gp, "support": {"sensor": bool(n_sensor), "photos": near, "rain": rain}})
        points = []
        for gp in confirmed:
            if gp["kind"] == "photo":
                if online and _d(gp, sp) <= config.CORROBORATE_M:
                    continue                 # the sensor measures this spot; its reading is used instead
                gp = {**gp, "surface": statistics.median(p["surface"] for p in photos
                                                         if _d(gp, p) <= config.CORROBORATE_M)}
            points.append(gp)
        return {"sensorDanger": s_danger, "sensors": sensors, "photos": photos, "confirmed": confirmed,
                "points": points, "rain": rain}

    def sources(self, ev=None):
        ev = ev or self.evidence()
        return {"sensor": ev["sensorDanger"], "photo": bool(ev["photos"]), "openData": ev["rain"]}

    # ------------------------------------------------------------------ PASYA: decide
    def _key(self, sws, ms):
        return ",".join(sorted(sws)) + "|" + ",".join(sorted(ms))

    def _candidates(self, ev):
        """ONE CUT PER STREET. Streets with their own report or sensor reading come first; then, if SUGGEST_NEIGHBORS,
        nearby streets the flood map puts at risk but nobody reported, marked as an optional suggestion."""
        g = self.grid
        plan = g.plan_cut(self.fmap)
        direct = list(dict.fromkeys(gp["switchId"] for gp in ev["confirmed"]))
        rank_of = lambda t: direct.index(t["switchId"]) if t["switchId"] in direct else len(direct)
        out = []
        for t in sorted(plan["perTransformer"], key=rank_of):
            sw = t["switchId"]
            if sw in self.open_switches:
                continue
            if t["action"] == "open":
                sws, ms = [sw], []
            elif t["action"] == "meters":
                sws, ms = [], [h for h in t["homesInDanger"] if g.homes[h].get("meter") == "smart" and h not in self.off_meters]
            else:
                continue
            if not sws and not ms:
                continue
            is_direct = sw in direct
            if not is_direct and not config.SUGGEST_NEIGHBORS:
                continue
            if is_direct:
                lines = []
                for gp in ev["confirmed"]:
                    if gp["switchId"] != sw:
                        continue
                    sp = gp["support"]
                    parts = (["pole sensor"] if sp["sensor"] else []) + \
                            ([f"{len(sp['photos'])} photo(s)"] if sp["photos"] else []) + (["heavy rain forecast"] if sp["rain"] else [])
                    line = f"{gp['street']}: " + " + ".join(parts)
                    if line not in lines:
                        lines.append(line)
                evidence, reason = "; ".join(lines), t["reason"]
            else:
                src = ", ".join(dict.fromkeys(g.street_of_switch(d) for d in direct)) or "a nearby street"
                evidence = f"No report or sensor on {t['street']}: suggested because of the water on {src}"
                reason = f"Optional: {t['reason']}"
            out.append({"switchIds": sws, "meterIds": ms, "street": t["street"], "suggested": not is_direct,
                        "evidence": evidence, "reason": reason, "plan": [{**t, "reason": reason}]})
        return out

    def _still_valid(self, c):
        g = self.grid
        return all(s not in self.open_switches for s in c["switchIds"]) and \
            all(m not in self.off_meters and g.homes[m]["switch"] not in self.open_switches for m in c["meterIds"])

    def _queue_suggestions(self):
        """Before a street is cut (which clears its reports), remember the optional nearby-street cuts its water
        suggested, so the dispatcher is still offered them one by one afterwards."""
        if not config.SUGGEST_NEIGHBORS:
            return
        ev = self.evidence()
        if not ev["points"]:
            return
        self.fmap = self.grid.flood_map(ev["points"], ev["sensors"])
        have = {self._key(q["switchIds"], q["meterIds"]) for q in self.queued}
        for c in self._candidates(ev):
            k = self._key(c["switchIds"], c["meterIds"])
            if c["suggested"] and k not in have:
                self.queued.append(c)
                have.add(k)

    def decide(self):
        with self.lock:
            ev = self.evidence()
            rec = self.recommendation
            g = self.grid
            if ev["points"]:
                self.fmap = g.flood_map(ev["points"], ev["sensors"])
                live = self._candidates(ev)
            else:
                self.fmap = {}
                live = []
                if not self.queued:
                    self.rejected_keys = set()
            self.queued = [q for q in self.queued if self._still_valid(q)]
            cands, keys = [], set()
            for c in live + self.queued:
                k = self._key(c["switchIds"], c["meterIds"])
                if k not in keys and k not in self.rejected_keys:
                    cands.append(c)
                    keys.add(k)
            if rec and rec["status"] == "pending":
                if self._key(rec["switchIds"], rec["meterIds"]) in keys:
                    return                       # keep the card the dispatcher is looking at
                rec["status"] = "expired"
                self.add_log("Water went down before approval; recommendation withdrawn.")
            if not cands:
                return
            c = cands[0]
            sws, ms = c["switchIds"], c["meterIds"]
            cut_now = {h["id"] for s in sws for h in g.switches[s].homes} | set(ms)
            off_after = {h["id"] for s in self.open_switches | set(sws) for h in g.switches[s].homes} | self.off_meters | set(ms)
            watch = sorted(h for h, v in self.fmap.items() if h in g.homes and h not in off_after
                           and v.get("risk") in ("flooded", "buffer", "watch"))
            self.rec_seq += 1
            self.recommendation = {
                "id": f"rec-{self.rec_seq}", "switchId": sws[0] if sws else None, "switchIds": sws, "meterIds": ms,
                "transformers": [g.switches[s].name for s in sws], "street": c["street"],
                "homesCut": len(cut_now), "homesKept": g.total_homes() - len(off_after), "watchHomes": watch,
                "plan": c["plan"], "status": "pending", "suggested": c["suggested"],
                "evidence": c["evidence"], "reason": c["reason"], "createdAt": iso()}
            where = [g.label(s) for s in sws] + [f"{m} smart meter ({g.homes[m]['street']})" for m in ms]
            self.add_log(f"PASYA{' (optional suggestion)' if c['suggested'] else ''}: {', '.join(where)}. "
                         f"Cuts {len(cut_now)} homes, warns {len(watch)}. Evidence: {c['evidence']}. Waiting for a dispatcher.")

    # ------------------------------------------------------------------ dispatcher actions
    def approve(self, rec_id, who="the dashboard"):
        with self.lock:
            rec = self.recommendation
            if not rec or rec["id"] != rec_id or rec["status"] != "pending":
                return False
            if not rec.get("suggested"):
                self._queue_suggestions()
            self._apply_cut(rec["switchIds"], rec["meterIds"], who=who)
            self.decide()                        # show the next street's card (if any) right away
            return True

    def reject(self, rec_id, who="the dashboard"):
        with self.lock:
            rec = self.recommendation
            if not rec or rec["id"] != rec_id or rec["status"] != "pending":
                return False
            rec["status"] = "rejected"
            k = self._key(rec["switchIds"], rec["meterIds"])
            self.rejected_keys.add(k)
            self.queued = [q for q in self.queued if self._key(q["switchIds"], q["meterIds"]) != k]
            self.add_log(f"Dispatcher rejected {rec['id']} ({rec.get('street')}) on {who}. That street stays ON.")
            self.decide()                        # offer the next street's card (if any)
            return True

    def restore(self, who="the dashboard", switches=None):
        with self.lock:
            self._apply_restore(who=who, switches=switches)

    def _apply_cut(self, switch_ids, meter_ids, who):
        g = self.grid
        sws = [s for s in switch_ids if s in g.switches and s not in self.open_switches]
        ms = [m for m in (meter_ids or []) if m in g.homes and g.homes[m].get("meter") == "smart"
              and m not in self.off_meters and g.homes[m]["switch"] not in self.open_switches | set(sws)]
        if not sws and not ms:
            return
        self.open_switches.update(sws)
        self.off_meters.update(ms)
        rec = self.recommendation
        watch = []
        if rec and rec["status"] == "pending" and set(sws) <= set(rec["switchIds"]) and set(ms) <= set(rec["meterIds"]):
            rec.update(status="approved", approvedAt=iso(), approvedBy=who)
            watch = rec.get("watchHomes", [])
        what = [f"{g.label(s)} opened" for s in sws] + [f"smart meter {m} disconnected" for m in ms]
        self.add_log(f"Approved on {who}: {', '.join(what)}.")
        self.add_event("info", "cut", f"Power cut approved on {who}", ", ".join(what))
        self._text(sws, ms, restored=False, watch=watch)
        self._resolve_reports(set(sws) | {g.homes[m]["switch"] for m in ms})

    def _resolve_reports(self, switch_ids):
        """A cut resolves the residents' reports on those transformers: remove them, so old photos can't keep
        pushing new recommendations (or re-cut a street after it is restored)."""
        done = [r for r in self.reports if r.get("switchId") in switch_ids]
        if not done:
            return
        self.reports = [r for r in self.reports if r.get("switchId") not in switch_ids]
        ext = {r["id"] for r in done if str(r["id"]).startswith("fb-")}
        if ext:
            self.resolved_ids |= ext
            try:
                self.resolved_path.write_text(json.dumps(sorted(self.resolved_ids)[-500:]), encoding="utf-8")
            except Exception:
                pass                             # memory still has them; only a restart could bring them back
        streets = ", ".join(sorted({r["street"] for r in done}))
        self.add_log(f"{len(done)} resident report(s) on {streets} resolved by this cut and removed.")

    def _apply_restore(self, who, switches=None):
        if switches:
            sws = set(switches) & self.open_switches
            ms = set(switches) & self.off_meters
        else:
            sws, ms = set(self.open_switches), set(self.off_meters)
        if not sws and not ms:
            return
        self.open_switches -= sws
        self.off_meters -= ms
        what = [f"{self.grid.label(s)} closed" for s in sorted(sws)] + [f"meter {m} reconnected" for m in sorted(ms)]
        self.add_log(f"Restore on {who}: {', '.join(what)}. Power is back ON there.")
        self.add_event("info", "restore", f"Power restored on {who}", ", ".join(what))
        if self.recommendation and self.recommendation["status"] in ("approved", "pending"):
            self.recommendation["status"] = "restored"
        self._text(sorted(sws), sorted(ms), restored=True)

    # ------------------------------------------------------------------ BABALA
    def _phones_near(self, home_ids, skip=()):
        phones, seen = [], set(skip)
        for hid in home_ids:
            h = self.grid.homes[hid]
            for s in sms.recipients_near(h["lat"], h["lon"]):
                if s["phone"] not in seen:
                    seen.add(s["phone"])
                    phones.append(s["phone"])
        return phones

    def _text(self, switch_ids, meter_ids, restored, watch=()):
        g = self.grid
        homes = [h["id"] for s in switch_ids for h in g.switches[s].homes] + list(meter_ids)
        where = ", ".join(dict.fromkeys([g.street_of_switch(s) for s in switch_ids] +
                                        [g.homes[m]["street"] for m in meter_ids])).rstrip(".")
        if restored:
            msg = f"BAHAGI: Power is back ON on {where}. Check for water near outlets before using appliances. - Meralco"
        else:
            msg = (f"BAHAGI ALERT: Power to flooded homes on {where} was switched OFF for your safety (floodwater near "
                   f"live lines). Stay away from poles and wires. Power returns when the water goes down. - Meralco")
        phones = self._phones_near(homes)
        sent, err = sms.send(phones, msg) if phones else (0, None)
        total = sent
        if not restored and watch:
            wmsg = ("BAHAGI WATCH: Floodwater is close to your home. Your power is still ON. Lift or unplug appliances "
                    "on the floor; we will text you before any cut. - Meralco")
            wphones = self._phones_near(watch, skip=phones)
            if wphones:
                wsent, werr = sms.send(wphones, wmsg)
                total += wsent
                err = err or werr
        self.sms_state.update(status="failed" if err else "sent", recipients=total, message=msg, error=err, at=iso())
        self.add_log(f"SMS {'FAILED: ' + err if err else f'sent to {total} people near the affected homes'}.")
        if err:
            self.add_event("critical", "sms_failed", "SMS alerts failed to send", str(err)[:200])

    def restore_street(self, sw, who="the dashboard"):
        """Restore one transformer, plus any smart meter cut with it (on that street, or by the same approval)."""
        with self.lock:
            targets = {sw} | {m for m in self.off_meters if self.grid.homes[m]["switch"] == sw}
            rec = self.recommendation
            if rec and sw in rec.get("switchIds", []):
                targets |= set(rec.get("meterIds", []))
            self._apply_restore(who=who, switches=sorted(targets))

    # ------------------------------------------------------------------ alerts for the dashboard
    def alerts(self):
        """Active problems right now + what happened in the last 30 minutes."""
        with self.lock:
            self.check_offline()
            now = time.time()
            s, b, g = self.sensor, self.box, self.grid
            pid, street = s["poleId"], s["street"]
            out = []

            def add(aid, sev, kind, title, detail="", st=None):
                out.append({"id": aid, "severity": sev, "kind": kind, "title": title, "detail": detail,
                            "street": st, "ts": now, "active": True})

            if not b["everSeen"]:
                add("box-waiting", "warning", "box_waiting", f"Waiting for pole box {pid}",
                    "No reading yet. Check that the box is powered and connected to the BAHAGI hotspot.", street)
            elif not s["online"]:
                add("box-offline", "critical", "box_offline", f"Pole box {pid} is offline",
                    f"Last reading {int(now - s['lastSeen'])} s ago. Check its power and the Wi-Fi hotspot.", street)
            else:
                if b["sensorOk"] is False:
                    add("sensor-error", "critical", "sensor_error", f"Sensor at {pid} can’t read the water",
                        "No echo. Check the sensor’s 4 wires and that it points straight down at the water.", street)
                lvl = s["level"]
                if is_danger(lvl):
                    add(f"flood-{pid}", "critical", "flood", f"{LABEL[lvl]}-deep water at {pid} · {street}",
                        f"{s['depthCm']} cm on the gauge, about {real_depth_m(s['depthCm'])} m in real life.", street)
                elif lvl == "gutter":
                    add(f"flood-{pid}", "warning", "flood", f"{LABEL[lvl]}-deep water at {pid} · {street}",
                        f"{s['depthCm']} cm on the gauge. Below the cut level.", street)
                if b["rssi"] is not None and b["rssi"] < -80:
                    add("weak-wifi", "warning", "weak_wifi", f"Weak Wi-Fi at pole box {pid}",
                        f"Signal {b['rssi']} dBm. Move the box or the laptop closer.", street)
                if b["lcdOk"] is False:
                    add("lcd-missing", "warning", "lcd_missing", f"Pole box {pid}: screen not detected",
                        "Check the screen’s 4 wires (SDA, SCL, VCC, GND). The box still works.", street)
            rec = self.recommendation
            if rec and rec["status"] == "pending":
                where = [g.label(x) for x in rec["switchIds"]] + [f"smart meter {m}" for m in rec["meterIds"]]
                add(f"approval-{rec['id']}", "critical", "approval", "Cut waiting for approval: " + ", ".join(where),
                    f"Cuts {rec['homesCut']} homes, keeps {rec['homesKept']} lit. Evidence: {rec['evidence']}.",
                    rec["street"].split(", ")[0])
            if self.sms_state["status"] == "failed":
                add("sms-failed", "critical", "sms_failed", "The last SMS alert failed to send",
                    str(self.sms_state.get("error") or "")[:200])
            for m in sorted(self.off_meters):
                add(f"meter-{m}", "info", "meter_off", f"Smart meter {m} is OFF",
                    f"Only that home on {g.homes[m]['street']} is cut. It comes back with its street’s restore.",
                    g.homes[m]["street"])
            br = self.bridge
            if br["enabled"] and br["ok"] is False:
                add("bot-link", "warning", "bot_link", "Can’t reach the Messenger bot’s reports",
                    str(br["error"] or "")[:200])
            rank = {"critical": 0, "warning": 1, "info": 2}
            out.sort(key=lambda a: rank[a["severity"]])
            recent = [e for e in self.events if now - e["ts"] < 1800][:20]
            box = {k: v for k, v in b.items() if k != "everSeen"}
            box.update(online=s["online"], lastSeenS=(round(now - s["lastSeen"]) if b["everSeen"] else None))
            return {"active": out, "recent": recent, "box": box}

    # ------------------------------------------------------------------ customer view
    def customer_status(self, lat=None, lon=None, home_id=None):
        with self.lock:
            g = self.grid
            if not home_id and lat is not None and lon is not None:
                hid, d = g.nearest_home(lat, lon)
                home_id = hid if d <= 150 else None
            if not home_id or home_id not in g.homes:
                return None
            h = self._home_out(home_id)
            msg = {"off": "Power to your area is OFF for your safety (flood near live lines). It returns when the water "
                          "goes down; you will get a text.",
                   "meter_off": "Your smart meter was switched OFF remotely because water reached your home. Your "
                                "neighbours stay ON. It returns when the water goes down.",
                   "on": "Your power is ON."}[h["power"]]
            if h["power"] == "on" and h["risk"] in ("watch", "buffer", "flooded"):
                msg += " Floodwater is near: lift or unplug appliances on the floor."
            return {**h, "message": msg}

    # ------------------------------------------------------------------ output for the dashboard
    def _home_out(self, hid):
        h = self.grid.homes[hid]
        power = "off" if h["switch"] in self.open_switches else "meter_off" if hid in self.off_meters else "on"
        f = self.fmap.get(hid, {"risk": "dry", "localDepthM": None})
        return {"id": hid, "switchId": h["switch"], "transformer": h["transformer"], "street": h["street"],
                "meter": h.get("meter", "traditional"), "elev": h["elev"], "lat": h["lat"], "lon": h["lon"],
                "power": power, "risk": f["risk"], "localDepthM": f["localDepthM"]}

    def state(self):
        with self.lock:
            self.check_offline()
            g = self.grid
            ev = self.evidence()
            lvl = self.sensor["level"]
            sensor_sw = g.poles[self.sensor["poleId"]]["switch"]
            streets = []
            for sw, t in g.switches.items():
                photo_lvls = [r["level"] for r in self.reports if r["switchId"] == sw and r["counts"]]
                worst = max([lvl if sw == sensor_sw else "normal"] + photo_lvls,
                            key=lambda x: ["normal", "gutter", "knee", "waist", "chest"].index(x))
                streets.append({"id": sw, "name": t.street, "transformer": t.name, "label": t.label,
                                "homes": len(t.homes), "relay": t.relay, "switchOpen": sw in self.open_switches,
                                "smartMeters": sum(1 for h in t.homes if h.get("meter") == "smart"),
                                "metersOff": sorted(m for m in self.off_meters if g.homes[m]["switch"] == sw),
                                "hazard": hazard_for(worst)})
            sp = g.poles[self.sensor["poleId"]]
            s = {k: v for k, v in self.sensor.items() if k != "lastSeen"}
            s.update(transformer=sp["transformer"], depthM=real_depth_m(self.sensor["depthCm"]),
                     waterSurfaceM=round(sp["elev"] + real_depth_m(self.sensor["depthCm"]), 2), poleElevM=sp["elev"])
            reports = [{k: v for k, v in r.items() if k not in ("ts", "senderKey")} for r in self.reports[:20]]
            rec = self.recommendation
            sms_out = dict(self.sms_state)
            if sms_out["status"] == "idle":
                sms_out["status"] = "ready"
            homes = [self._home_out(h) for h in g.homes]
            return {"sensor": s, "streets": streets, "homes": homes,
                    "summary": {"homes": len(homes), "on": sum(h["power"] == "on" for h in homes),
                                "off": sum(h["power"] != "on" for h in homes),
                                "atRisk": sum(h["risk"] in ("flooded", "buffer") for h in homes),
                                "watch": sum(h["risk"] == "watch" for h in homes)},
                    "reports": reports, "sources": self.sources(ev),
                    "recommendation": rec if rec and rec["status"] in ("pending", "approved", "rejected") else None,
                    "sms": sms_out, "log": self.log[:40], "forecast": forecast.get_forecast()}
