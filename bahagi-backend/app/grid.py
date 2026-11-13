"""PASYA's grid twin: who is fed by which transformer, how high each home sits, and the smallest cut Meralco can make.

Meralco's switching hierarchy:  substation > feeder > distribution TRANSFORMER > meter.
  * The smallest switchable block is a TRANSFORMER: opening it darkens every home on it.
  * A single home can be cut on its own ONLY if it has a SMART (AMI) meter (remote disconnect).
  * A home with a TRADITIONAL meter can't be switched alone, so if it is in danger its whole transformer opens.

Flooding is modelled per home, not per street: water finds its own level, so a street that bends or slopes can be
half wet. A reading (sensor or photo) gives a water-surface height; every home within FLOOD_REACH_M gets
    local depth = water surface - home's ground elevation
and a class: flooded (>= DANGER_DEPTH_M), buffer (within BUFFER_DEPTH_M of danger: water may seep there),
watch (within WATCH_DEPTH_M: SMS warning only), or dry. Flooded and buffer homes are cut; watch homes are warned.
A working sensor beats an estimate: if a sensor is closer to a home than the photo is, the sensor's level is used.
"""
import json
import math

from . import config

RISKS = ["dry", "watch", "buffer", "flooded"]


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def risk_for(local_depth_m):
    if local_depth_m is None:
        return "dry"
    if local_depth_m >= config.DANGER_DEPTH_M:
        return "flooded"
    if local_depth_m >= config.DANGER_DEPTH_M - config.BUFFER_DEPTH_M:
        return "buffer"
    if local_depth_m >= config.DANGER_DEPTH_M - config.WATCH_DEPTH_M - 1e-9:
        return "watch"
    return "dry"


class Transformer:
    def __init__(self, d):
        self.switch = d["switch"]                      # relay channel in the box: S1 / S2 / S3
        self.name = d.get("transformer", d["switch"])  # TR-1 ...
        self.street = d.get("street", "")
        self.relay = d.get("relay")
        self.poles = d.get("poles", [])
        self.homes = d.get("homes", [])

    @property
    def label(self):
        return f"{self.name} ({self.street})" if self.street else self.name

    def subtree_homes(self):
        return len(self.homes)


class Grid:
    def __init__(self, path=None):
        raw = json.loads((path or config.DATA / "feeder.json").read_text(encoding="utf-8"))
        self.substation = raw["substation"]
        self.feeder = raw.get("feeder", {})
        self.switches: dict[str, Transformer] = {}
        self.poles: dict[str, dict] = {}
        self.homes: dict[str, dict] = {}
        for t in raw["transformers"]:
            tr = Transformer(t)
            self.switches[tr.switch] = tr
            for p in tr.poles:
                self.poles[p["id"]] = {**p, "switch": tr.switch, "street": tr.street, "transformer": tr.name}
            for h in tr.homes:
                self.homes[h["id"]] = {**h, "switch": tr.switch, "street": tr.street, "transformer": tr.name}
        # smart meters wired to a relay of their own in the tabletop model: relay key ("S4") -> home id
        self.meter_relays = {f"S{h['relay']}": hid for hid, h in self.homes.items()
                             if h.get("meter") == "smart" and h.get("relay")}

    # ------------------------------------------------------------------ lookups
    def total_homes(self):
        return len(self.homes)

    def street_of_switch(self, sw):
        return self.switches[sw].street

    def label(self, sw):
        return self.switches[sw].label

    def switch_for_street(self, street):
        s = (street or "").lower().replace(".", "").strip()
        for sw, t in self.switches.items():
            if t.street.lower().replace(".", "").strip() in (s, s.replace(" street", " st")) or s in (
                    sw.lower(), t.name.lower()):
                return sw
        return None

    def nearest_pole(self, lat, lon, switch=None):
        best, bd = None, 1e18
        for pid, p in self.poles.items():
            if switch and p["switch"] != switch:
                continue
            d = haversine_m(lat, lon, p["lat"], p["lon"])
            if d < bd:
                best, bd = pid, d
        return best, bd

    def nearest_home(self, lat, lon):
        best, bd = None, 1e18
        for hid, h in self.homes.items():
            d = haversine_m(lat, lon, h["lat"], h["lon"])
            if d < bd:
                best, bd = hid, d
        return best, bd

    def sensor_pole(self):
        for pid, p in self.poles.items():
            if p.get("sensor"):
                return pid
        return next(iter(self.poles))

    # ------------------------------------------------------------------ flood model
    def flood_map(self, points, sensors=()):
        """points: confirmed readings [{lat, lon, surface}]; sensors: every ONLINE sensor [{lat, lon, surface}].
        Returns {id: {"risk", "localDepthM"}} for every home and pole."""
        out = {}
        for kind, items in (("home", self.homes), ("pole", self.poles)):
            for iid, it in items.items():
                near = [(haversine_m(it["lat"], it["lon"], p["lat"], p["lon"]), p) for p in points]
                near = [(d, p) for d, p in near if d <= config.FLOOD_REACH_M]
                if not near:
                    out[iid] = {"risk": "dry", "localDepthM": None}
                    continue
                surface = max(p["surface"] for _, p in near)
                closest = min(d for d, _ in near)
                for s in sensors:           # a measurement closer than the estimate wins
                    ds = haversine_m(it["lat"], it["lon"], s["lat"], s["lon"])
                    if ds <= config.FLOOD_REACH_M and ds < closest - 1:
                        surface = min(surface, s["surface"] + 0.05)
                local = round(surface - it["elev"], 2)
                out[iid] = {"risk": risk_for(local), "localDepthM": local}
        return out

    # ------------------------------------------------------------------ the smallest cut Meralco can actually make
    def plan_cut(self, fmap):
        """Per transformer: open it, or remote-disconnect only its smart meters, or leave it alone."""
        per, switches, meters, watch = [], [], [], []
        for sw, t in self.switches.items():
            wet_poles = [p["id"] for p in t.poles if fmap.get(p["id"], {}).get("risk") == "flooded"]
            hit = [h for h in t.homes if fmap.get(h["id"], {}).get("risk") in ("flooded", "buffer")]
            trad = [h["id"] for h in hit if h.get("meter") != "smart"]
            smart = [h["id"] for h in hit if h.get("meter") == "smart"]
            if wet_poles:
                action, why = "open", f"water at pole {', '.join(wet_poles)}: open {t.name}"
            elif trad:
                action, why = "open", (f"{', '.join(trad)} {'is' if len(trad) == 1 else 'are'} in danger with a "
                                       f"traditional meter (can't be cut alone): open {t.name}")
            elif smart:
                action, why = "meters", (f"only smart-meter homes in danger ({', '.join(smart)}): disconnect "
                                         f"{'that meter' if len(smart) == 1 else 'those meters'}, {t.name} stays ON")
            else:
                action, why = "none", ""
            if action == "open":
                switches.append(sw)
            elif action == "meters":
                meters += smart
            if action != "open":
                watch += [h["id"] for h in t.homes if fmap.get(h["id"], {}).get("risk") == "watch"]
            per.append({"switchId": sw, "transformer": t.name, "street": t.street, "action": action, "reason": why,
                        "homes": [h["id"] for h in t.homes],
                        "homesInDanger": [h["id"] for h in hit]})
        cut = sum(len(self.switches[s].homes) for s in switches) + len(meters)
        return {"switchIds": switches, "meterIds": meters, "homesCut": cut, "homesKept": self.total_homes() - cut,
                "watchHomes": watch, "perTransformer": per}
