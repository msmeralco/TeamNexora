"""Water levels shared by the sensor, the photo AI and the rules."""
from . import config

LEVELS = ["normal", "gutter", "knee", "waist", "chest"]
LABEL = {"normal": "Normal", "gutter": "Gutter", "knee": "Knee", "waist": "Waist", "chest": "Chest"}


def level_for_cm(cm: float) -> str:
    if cm >= config.CHEST_CM:
        return "chest"
    if cm >= config.WAIST_CM:
        return "waist"
    if cm >= config.KNEE_CM:
        return "knee"
    if cm >= config.GUTTER_CM:
        return "gutter"
    return "normal"


def rank(level: str) -> int:
    return LEVELS.index(level) if level in LEVELS else 0


def is_danger(level: str) -> bool:
    return rank(level) >= rank(config.DANGER_LEVEL)


def hazard_for(level: str) -> str:
    r = rank(level)
    return "high" if r >= rank("knee") else "medium" if r == rank("gutter") else "low"


# Real-world depth of each level (MMDA flood gauge), in metres. The tabletop depth in cm is mapped onto this.
LEVEL_DEPTH_M = {"normal": 0.0, "gutter": 0.20, "knee": 0.48, "waist": 0.94, "chest": 1.14}


def real_depth_m(cm: float) -> float:
    """Tabletop centimetres -> real metres, linear between the gauge marks."""
    pts = [(0.0, 0.0), (config.GUTTER_CM, 0.20), (config.KNEE_CM, 0.48), (config.WAIST_CM, 0.94),
           (config.CHEST_CM, 1.14)]
    cm = max(0.0, float(cm or 0))
    for (c0, m0), (c1, m1) in zip(pts, pts[1:]):
        if cm <= c1:
            return round(m0 + (m1 - m0) * (cm - c0) / (c1 - c0), 3)
    (c0, m0), (c1, m1) = pts[-2], pts[-1]
    return round(m1 + (m1 - m0) * (cm - c1) / (c1 - c0), 3)
