"""TAYA: hourly rain from Open-Meteo (free, no key). Cached; the server keeps working if it's offline."""
import time

import httpx

from . import config

_cache = {"at": 0.0, "data": None}


def get_forecast(force=False):
    now = time.time()
    if not config.FORECAST_ENABLED:
        return {"source": "disabled", "hours": []}
    if not force and _cache["data"] and now - _cache["at"] < config.FORECAST_EVERY_S:
        return _cache["data"]
    try:
        r = httpx.get("https://api.open-meteo.com/v1/forecast", timeout=6, params={
            "latitude": config.FORECAST_LAT, "longitude": config.FORECAST_LON,
            "hourly": "precipitation", "forecast_hours": 6, "timezone": "Asia/Manila"})
        r.raise_for_status()
        h = r.json()["hourly"]
        hours = [{"time": t, "mm": float(mm or 0)} for t, mm in zip(h["time"], h["precipitation"])]
        data = {"source": "open-meteo", "hours": hours}
    except Exception as e:          # offline at the venue: say so instead of guessing
        data = {"source": "unavailable", "hours": [], "error": str(e)[:120]}
    _cache.update(at=now, data=data)
    return data


def heavy_rain_soon(fc=None):
    fc = fc or get_forecast()
    return any(h["mm"] >= config.HEAVY_RAIN_MM_H for h in fc.get("hours", [])[:3])
