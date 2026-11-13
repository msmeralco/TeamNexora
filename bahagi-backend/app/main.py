"""BAHAGI backend (FastAPI).

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8000
Docs: http://<laptop-ip>:8000/docs   (every endpoint, try-it-out buttons)
"""
import asyncio
import os
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, dashboard_api, discovery, firebase_bridge, forecast, photocheck, vision
from .engine import Engine
from .levels import LEVELS

engine = Engine()


@asynccontextmanager
async def lifespan(_app):
    async def ticker():                       # marks the sensor offline when the ESP32 stops posting
        while True:
            engine.check_offline()
            await asyncio.sleep(2)
    task = asyncio.create_task(ticker())
    beacon = discovery.start(int(os.environ.get("BAHAGI_PORT", "8000")))   # the ESP32 finds us by itself
    bridge = firebase_bridge.start(engine)            # Messenger bot reports (Firebase), if configured
    print("\n  BAHAGI is running. Dashboard: http://localhost:8000/   API docs: http://localhost:8000/docs")
    print("  The box finds this laptop by itself. Addresses: " + ", ".join(discovery.addresses()) + "\n", flush=True)
    await asyncio.to_thread(forecast.get_forecast)    # warm the forecast cache (skipped quietly when offline)
    yield
    beacon.set()
    if bridge:
        bridge.set()
    task.cancel()


app = FastAPI(title="BAHAGI backend", version="2.0",
              description="Bahagi lang, hindi buong barangay. ESP32 ↔ rules ↔ dashboard ↔ SMS.", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])
config.UPLOADS.mkdir(exist_ok=True)
app.mount("/uploads", StaticFiles(directory=config.UPLOADS), name="uploads")
app.mount("/static", StaticFiles(directory=config.STATIC), name="static")
dashboard_api.engine = engine
app.include_router(dashboard_api.router)
if (config.DASHBOARD_DIR / "assets").is_dir():      # the team's dashboard, built: served at /
    app.mount("/assets", StaticFiles(directory=config.DASHBOARD_DIR / "assets"), name="dashboard-assets")


# ====================================================================== ESP32
class EspReading(BaseModel):
    poleId: str = "P1"
    depthCm: float | None = None
    distanceCm: float | None = None
    level: str | None = None              # the box's own level; the backend recomputes it from depthCm
    sensorOk: bool = True
    pending: bool = False                 # the box is showing "CUT S1? PRESS OK"
    cut: dict[str, bool] = Field(default_factory=dict)
    lidApproved: bool = False
    lidRestore: bool = False
    # box health (firmware v3+): shown as alerts on the dashboard
    uptimeS: int | None = None            # seconds since the ESP32 started (a drop = it restarted)
    rssi: int | None = None               # Wi-Fi signal, dBm
    lcdOk: bool | None = None             # the screen answered at boot
    dryCm: float | None = None            # the calibrated sensor-to-dry-floor distance
    boot: str | None = None               # why it last started: power_on, brownout, crash, watchdog, reset_button


@app.post("/esp/reading", tags=["ESP32"])
def esp_reading(r: EspReading):
    """The box posts here every 2 s. Reply = the relays that must be OPEN (cut): S1..S3 = transformers TR-1..TR-3,
    S4 = house M1's smart meter (in the model, relay K4 stands in for a remote meter disconnect)."""
    health = {"uptimeS": r.uptimeS, "rssi": r.rssi, "lcdOk": r.lcdOk, "dryCm": r.dryCm, "boot": r.boot}
    cut = engine.sensor_reading(r.depthCm, r.distanceCm, r.sensorOk, r.lidApproved, r.lidRestore, r.cut, r.poleId,
                                health=health)
    return {"cut": cut}


# ====================================================================== dashboard
@app.get("/state", tags=["Dashboard"])
def state():
    """Everything the Meralco dispatcher's dashboard shows: sensor, transformers (streets), every home's power and flood
    risk, reports (with fake-photo checks), sources, recommendation (transformers to open + smart meters to
    disconnect), SMS, log, forecast."""
    return engine.state()


@app.post("/recommendations/{rec_id}/approve", tags=["Dashboard"])
def approve(rec_id: str):
    """Dispatcher approves: relays open on the box's next post (≤2 s) and the SMS goes out."""
    if not engine.approve(rec_id, who="the dashboard"):
        raise HTTPException(409, "No pending recommendation with that id")
    return engine.state()


@app.post("/recommendations/{rec_id}/reject", tags=["Dashboard"])
def reject(rec_id: str):
    if not engine.reject(rec_id, who="the dashboard"):
        raise HTTPException(409, "No pending recommendation with that id")
    return engine.state()


class RestoreBody(BaseModel):
    switches: list[str] | None = None     # transformer relays (S1) and/or smart meter ids (M1); omit = restore all


@app.post("/restore", tags=["Dashboard"])
def restore(body: RestoreBody | None = None):
    """Close the switches again (power back on) and text the same people."""
    engine.restore(who="the dashboard", switches=(body.switches if body else None))
    return engine.state()


@app.get("/forecast", tags=["Dashboard"])
def get_forecast():
    """TAYA: next 6 hours of rain (Open-Meteo) and whether heavy rain is coming in the next 3 hours."""
    fc = forecast.get_forecast()
    return {**fc, "heavyRainSoon": forecast.heavy_rain_soon(fc), "thresholdMmPerHour": config.HEAVY_RAIN_MM_H}


@app.get("/grid", tags=["Dashboard"])
def grid():
    """The grid twin for drawing a map: substation > feeder > transformers (relays) > poles and homes (with meter type
    and ground elevation)."""
    g = engine.grid
    return {"substation": g.substation, "feeder": g.feeder,
            "switches": [{"id": sw, "transformer": t.name, "street": t.street, "homes": len(t.homes), "relay": t.relay,
                          "open": sw in engine.open_switches, "poles": t.poles, "homeList": t.homes}
                         for sw, t in g.switches.items()]}


@app.get("/customer/status", tags=["Customers"])
def customer_status(lat: float | None = None, lon: float | None = None, homeId: str | None = None):
    """For residents (SMS keyword, Messenger bot or a page): is MY power on, and is water near me?"""
    out = engine.customer_status(lat, lon, homeId)
    if not out:
        raise HTTPException(404, "No BAHAGI home within 150 m of that location")
    return out


# ====================================================================== SILIP: resident photo reports
@app.post("/reports", tags=["Reports"])
async def report(request: Request,
                 photo: UploadFile | None = File(None),
                 channel: str = Form("Web"),
                 street: str | None = Form(None),
                 poleId: str | None = Form(None),
                 lat: float | None = Form(None),
                 lon: float | None = Form(None),
                 level: str | None = Form(None, description="sender's own guess: normal/gutter/knee/waist/chest"),
                 sender: str | None = Form(None, description="phone or chat id, used to drop repeats")):
    """A resident's flood photo (from the /report page, or forwarded by a Messenger/Viber/SMS bot).
    Checked before it counts: exact and near-duplicate copies, EXIF age and GPS, sender's distance from the street,
    AI scene check (bathtub / indoor / screenshot / edited = not counted), and the nearby sensor. Never acts alone."""
    img, ctype, url = None, "", None
    if photo is not None and photo.filename:
        img = await photo.read()
        ctype = photo.content_type or ""
        if len(img) > 8 * 1024 * 1024:
            raise HTTPException(413, "Photo too large (max 8 MB)")
        ext = {"image/png": ".png", "image/webp": ".webp"}.get(ctype, ".jpg")
        name = f"{int(time.time())}-{uuid.uuid4().hex[:6]}{ext}"
        (config.UPLOADS / name).write_bytes(img)
        base = config.PUBLIC_URL or str(request.base_url).rstrip("/")
        url = f"{base}/uploads/{name}"
    if level and level not in LEVELS:
        raise HTTPException(422, f"level must be one of {LEVELS}")
    ai = await asyncio.to_thread(vision.read_depth, img, ctype, level)
    exif = photocheck.exif_info(img) if img else {}
    rep = engine.add_report(channel=channel, street=street, pole_id=poleId, lat=lat, lon=lon, level=ai["level"],
                            confidence=ai["confidence"], model=ai["model"], reason=ai["reason"], scene=ai["scene"],
                            photo_bytes=img, photo_url=url, sender=sender, exif=exif)
    return {k: v for k, v in rep.items() if k not in ("ts", "senderKey")}


@app.get("/report", include_in_schema=False)
def report_page():
    """Phone-friendly page for residents (and judges) to send a flood photo."""
    return FileResponse(config.STATIC / "report.html")


# ====================================================================== demo helpers
class SimReading(BaseModel):
    depthCm: float


@app.post("/sim/reading", tags=["Demo"])
def sim_reading(r: SimReading):
    """Pretend to be the ESP32 (for testing without the box)."""
    engine.sensor_reading(r.depthCm)
    return {"cut": engine.relays_open()}


@app.post("/sim/reset", tags=["Demo"])
def sim_reset():
    """Start the demo over: all transformers ON, no reports, empty log."""
    engine.reset()
    return engine.state()


@app.get("/", include_in_schema=False)
def root():
    index = config.DASHBOARD_DIR / "index.html"
    if index.is_file():                              # the team's dashboard
        return FileResponse(index)
    return RedirectResponse("/docs")
