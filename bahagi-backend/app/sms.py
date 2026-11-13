"""BABALA: text everyone within SMS_RADIUS_M of the flooded pole.

Providers: console (prints, for testing), semaphore (PH), twilio, sns (AWS). Set SMS_PROVIDER in .env.
Recipients come from data/subscribers.csv (name, phone, lat, lon); add your own phones for the demo.
"""
import csv

import httpx

from . import config
from .grid import haversine_m


def load_subscribers():
    path = config.DATA / "subscribers.csv"
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [{"name": r["name"], "phone": r["phone"].strip(), "lat": float(r["lat"]), "lon": float(r["lon"])}
                for r in csv.DictReader(f) if r.get("phone")]


def recipients_near(lat, lon, radius_m=None):
    radius_m = radius_m or config.SMS_RADIUS_M
    return [s for s in load_subscribers() if haversine_m(lat, lon, s["lat"], s["lon"]) <= radius_m]


def send(phones, message):
    """Send one message to many numbers. Returns (sent_count, error_or_None)."""
    if not phones:
        return 0, None
    p = config.SMS_PROVIDER.lower()
    try:
        if p == "semaphore":
            if not config.SEMAPHORE_API_KEY:
                return 0, "SEMAPHORE_API_KEY missing"
            data = {"apikey": config.SEMAPHORE_API_KEY, "number": ",".join(phones), "message": message}
            if config.SEMAPHORE_SENDER:
                data["sendername"] = config.SEMAPHORE_SENDER
            r = httpx.post("https://api.semaphore.co/api/v4/messages", data=data, timeout=15)
            r.raise_for_status()
            return len(phones), None
        if p == "twilio":
            if not (config.TWILIO_SID and config.TWILIO_TOKEN and config.TWILIO_FROM):
                return 0, "TWILIO_SID / TWILIO_TOKEN / TWILIO_FROM missing"
            url = f"https://api.twilio.com/2010-04-01/Accounts/{config.TWILIO_SID}/Messages.json"
            n = 0
            for ph in phones:
                r = httpx.post(url, auth=(config.TWILIO_SID, config.TWILIO_TOKEN),
                               data={"To": ph, "From": config.TWILIO_FROM, "Body": message}, timeout=15)
                r.raise_for_status()
                n += 1
            return n, None
        if p == "sns":
            import boto3
            sns = boto3.client("sns", region_name=config.AWS_REGION)
            for ph in phones:
                sns.publish(PhoneNumber=ph, Message=message)
            return len(phones), None
        # console
        for ph in phones:
            print(f"[SMS → {ph}] {message}")
        return len(phones), None
    except Exception as e:
        return 0, f"{p}: {str(e)[:160]}"
