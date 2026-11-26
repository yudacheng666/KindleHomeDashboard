"""Independent weather scheduler: clients read a bounded in-memory snapshot.

Only the private volume stores location and counters; credentials come from
private startup environment, never from the LAN HTTP API.
"""
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, RLock, Thread
import json
import math
import os
import tempfile
import time
from .weather import QWeather, OpenMeteo, RequestLedger, INTERVALS, WeatherError, WeatherBlocked, WeatherBudget, coordinates
from .trip_store import TripStore

KINDS = tuple(INTERVALS)
CORE = ("current", "hourly", "daily")
DEFAULT = {"enabled": False, "consent": False, "name": "", "latitude": 0, "longitude": 0}
TTL = {"current": 1800, "hourly": 5400, "daily": 10800, "rain": 900, "air": 5400, "alerts": 900}
BACKUP_INTERVAL = 1800


def config(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT):
        raise ValueError("invalid_weather_config")
    if type(value["enabled"]) is not bool or type(value["consent"]) is not bool:
        raise ValueError("invalid_weather_config")
    name = value["name"]
    if not isinstance(name, str) or len(name.strip()) > 40 or any(ord(c)<32 for c in name):
        raise ValueError("invalid_weather_name")
    lat, lon = coordinates(value["latitude"], value["longitude"])
    if value["enabled"] and (not value["consent"] or not name.strip()):
        raise ValueError("weather_consent_required")
    return {**value, "name": name.strip(), "latitude": float(lat), "longitude": float(lon)}


def number(value, low=-200, high=200):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise WeatherError("invalid_weather_value")
    return value


def optional(value, low=-200, high=200):
    return None if value is None else number(value, low, high)


def string(value, max_length=200):
    if not isinstance(value, str) or not value.strip() or len(value)>max_length:
        raise WeatherError("invalid_weather_value")
    return value


def stamp(value, *, offset_required=True):
    try:
        value = string(value, 40)
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if offset_required and parsed.tzinfo is None:
            raise ValueError()
        return value
    except (ValueError, WeatherError):
        raise WeatherError("invalid_weather_time") from None


def measure(data, unit, low=-200, high=200):
    if not isinstance(data, dict) or data.get("unit") != unit:
        raise WeatherError("invalid_weather_unit")
    return number(data.get("value"), low, high)


def q_condition(row):
    return string(row["condition"]["text"], 40)


def q_current(row, hourly=False):
    result = {"time": stamp(row["forecastTime" if hourly else "validTime"]),
              "text": q_condition(row), "temp": measure(row["temperature"], "°C")}
    if hourly:
        result["pop"] = optional(row.get("precipitation", {}).get("probability"), 0, 1)
        if result["pop"] is not None:
            result["pop"] = round(result["pop"] * 100)
    else:
        result.update(feels=measure(row["feelsLike"], "°C") if row.get("feelsLike") else None,
                      humidity=round(number(row["humidity"],0,1)*100) if row.get("humidity") is not None else None,
                      wind=measure(row["wind"]["speed"], "m/s", 0, 150) if row.get("wind", {}).get("speed") else None,
                      wind_unit="m/s")
    return result


def q_normalize(kind, raw):
    try:
        attrs = raw.get("metadata", {}).get("attributions", [])
        if kind=="rain":
            attrs = raw.get("refer", {}).get("sources", [])
        if not isinstance(attrs, list):
            raise WeatherError("invalid_attribution")
        attrs = [string(x, 1000) for x in attrs[:10]]
        if not attrs:
            attrs = ["https://developer.qweather.com/attribution.html"]
        if kind == "current":
            data = q_current(raw)
        elif kind == "hourly":
            data = [q_current(x, True) for x in raw["hours"][:24]]
        elif kind == "daily":
            data = [{"time": stamp(x["daytime"]["forecastStartTime"]), "text": q_condition(x["daytime"]),
                     "max": measure(x["temperatureMax"], "°C"), "min": measure(x["temperatureMin"], "°C")}
                    for x in raw["days"][:7]]
        elif kind == "rain":
            data = {"time": stamp(raw["updateTime"]), "summary": string(raw["summary"], 500),
                    "points": [{"time": stamp(x["fxTime"]), "mm": number(float(x["precip"]),0,1000),
                                "type": string(x["type"],20)} for x in raw["minutely"][:24]]}
        elif kind == "air":
            data = [{"code": string(x["code"],40), "name": string(x["name"],60),
                     "aqi": string(x["aqiDisplay"],30), "category": string(x["category"],60)}
                    for x in raw["indexes"][:8]]
        elif kind == "alerts":
            rows = raw["alerts"]
            if not rows and raw.get("metadata", {}).get("zeroResult") is not True:
                raise WeatherError("unconfirmed_no_alerts")
            superseded = {i for x in rows for i in x.get("messageType",{}).get("supersedes",[])}
            data = [{"id": string(x["id"],200), "headline": string(x["headline"],500),
                     "sender": x.get("senderName") or "", "issued": stamp(x["issuedTime"]),
                     "expires": stamp(x["expireTime"]), "effective": stamp(x["effectiveTime"]),
                     "type": string(x["messageType"]["code"],20),
                     "description": x.get("description") or "", "instruction": x.get("instruction") or ""}
                    for x in rows if x["id"] not in superseded]
        else:
            raise WeatherError("invalid_weather_kind")
        if kind in ("hourly","daily","air") and not data:
            raise WeatherError("empty_response")
        return data, attrs
    except WeatherError:
        raise
    except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
        raise WeatherError("invalid_response") from None


def wmo(code):
    code = number(code, 0, 99)
    if code == 0: return "晴"
    if code in (1,2): return "少云 / 多云"
    if code == 3: return "阴"
    if code in (45,48): return "雾"
    if code in (51,53,55,56,57): return "毛毛雨"
    if code in (61,63,65,66,67,80,81,82): return "雨"
    if code in (71,73,75,77,85,86): return "雪"
    if code in (95,96,99): return "雷雨"
    return "天气现象未知"


def meteo_normalize(raw):
    try:
        c, h, d = raw["current"], raw["hourly"], raw["daily"]
        cu, hu, du = raw["current_units"], raw["hourly_units"], raw["daily_units"]
        if (cu["temperature_2m"] != "°C" or cu["apparent_temperature"] != "°C" or
            cu["relative_humidity_2m"] != "%" or cu["wind_speed_10m"] != "km/h" or
            hu["temperature_2m"] != "°C" or hu["precipitation_probability"] != "%" or
            du["temperature_2m_max"] != "°C" or du["temperature_2m_min"] != "°C"):
            raise WeatherError("invalid_weather_unit")
        now = stamp(c["time"],offset_required=False)
        result = {"current": {"time": now, "text": wmo(c["weather_code"]),
                   "temp": number(c["temperature_2m"]), "feels": optional(c.get("apparent_temperature")),
                   "humidity": optional(c.get("relative_humidity_2m"),0,100),
                   "wind": optional(c.get("wind_speed_10m"),0,500), "wind_unit":"km/h"}}
        result["hourly"] = [{"time": stamp(t,offset_required=False), "text": wmo(h["weather_code"][i]),
                             "temp": number(h["temperature_2m"][i]), "pop": optional(h["precipitation_probability"][i],0,100)}
                            for i,t in enumerate(h["time"]) if t >= now][:24]
        result["daily"] = [{"time": string(t,10), "text": wmo(d["weather_code"][i]),
                            "max": number(d["temperature_2m_max"][i]), "min": number(d["temperature_2m_min"][i])}
                           for i,t in enumerate(d["time"])][:7]
        if not result["hourly"] or not result["daily"]:
            raise WeatherError("empty_response")
        return result
    except WeatherError:
        raise
    except (KeyError, TypeError, IndexError, ValueError, AttributeError):
        raise WeatherError("invalid_response") from None


class WeatherService:
    def __init__(self, directory, env, *, clock=lambda: datetime.now(timezone.utc),
                 monotonic=time.monotonic, q_transport=None, backup_transport=None):
        root = TripStore(directory).path.parent
        self.path = root / "weather-settings.json"
        self.lock = RLock()
        self.stop = Event()
        self.wake = Event()
        self.thread = None
        self.clock, self.monotonic = clock, monotonic
        self.settings = dict(DEFAULT)
        self.error = ""
        self.primary = None
        self.ledger = None
        self.generation = 0
        self.records = {}
        self.failures = {}
        self.due = {}
        self.backup_records = {}
        self.backup_due = 0
        self.backup = OpenMeteo(**({"transport":backup_transport} if backup_transport else {}))
        try:
            if self.path.exists() or self.path.is_symlink():
                fd = os.open(self.path, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                with os.fdopen(fd,"rb") as stream:
                    if os.fstat(stream.fileno()).st_mode & 0o077:
                        raise ValueError("private_weather_settings_required")
                    self.settings = config(json.loads(stream.read(8193)))
                if not (root/"weather-budget.sqlite3").exists():
                    raise ValueError("missing_weather_budget")
            self.ledger = RequestLedger(str(root), clock)
        except Exception:
            self.error = "storage_error"
            return
        try:
            host,key = env.get("KHD_QWEATHER_HOST",""),env.get("KHD_QWEATHER_KEY","")
            if host or key:
                self.primary = QWeather(host,key,self.ledger,**({"transport":q_transport} if q_transport else {}))
        except ValueError:
            self.error = "credential_error"

    def settings_view(self):
        with self.lock:
            usage = self.ledger.usage() if self.ledger else None
            return {**self.settings, "primary_configured":self.primary is not None,
                    "error":self.error, "budget":usage}

    def configure(self, value):
        value = config(value)
        with self.lock:
            if not self.ledger or self.error=="storage_error":
                raise ValueError("weather_storage_unavailable")
            if value == self.settings:
                return self.settings_view()
            fd,temp = tempfile.mkstemp(prefix=".weather-",dir=self.path.parent)
            try:
                with os.fdopen(fd,"w",encoding="utf-8") as out:
                    json.dump(value,out,ensure_ascii=False)
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temp,self.path)
                directory = os.open(self.path.parent,os.O_RDONLY|os.O_DIRECTORY)
                try: os.fsync(directory)
                finally: os.close(directory)
            finally:
                if os.path.exists(temp): os.unlink(temp)
            self.settings = value
            self.generation += 1
            self.records.clear()
            self.backup_records.clear()
            self.failures.clear()
            self.due.clear()
            self.backup_due=0
            self.wake.set()
            return self.settings_view()

    def _record(self,data,attrs,source):
        return {"data":data,"attributions":attrs,"source":source,
                "fetched_at":self.clock().isoformat(),"mono":self.monotonic()}

    def _fresh(self,kind,record,now):
        return record is not None and 0 <= now-record["mono"] <= TTL[kind]

    def step(self):
        # Only the dedicated worker invokes this method. Never hold the lock
        # while doing network I/O; settings changes invalidate in-flight data.
        with self.lock:
            if not self.settings["enabled"] or not self.settings["consent"] or not self.ledger:
                return
            generation = self.generation
            lat,lon = self.settings["latitude"],self.settings["longitude"]
            now = self.monotonic()
            primary = self.primary
            blocked = self.ledger.usage()["blocked"]
            kind = next((k for k in KINDS if now>=self.due.get(k,0)),None) if primary and not blocked else None
            if kind:
                self.due[kind] = now + INTERVALS[kind]
            need_backup = (not primary or blocked or any(k in self.failures for k in CORE))
            backup_due = need_backup and now >= self.backup_due
            if backup_due:
                self.backup_due = now + BACKUP_INTERVAL
        if kind:
            try:
                data,attrs=q_normalize(kind,primary.fetch(kind,lat,lon))
                record=self._record(data,attrs,"QWeather")
                with self.lock:
                    if generation==self.generation:
                        self.records[kind]=record
                        self.failures.pop(kind,None)
            except Exception:
                with self.lock:
                    if generation==self.generation:
                        self.failures[kind]="unavailable"
                        if kind in CORE and self.monotonic()>=self.backup_due:
                            self.backup_due=self.monotonic()+BACKUP_INTERVAL
                            backup_due=True
        if backup_due:
            with self.lock:
                if generation != self.generation or not self.settings["enabled"]:
                    return
            try:
                normalized=meteo_normalize(self.backup.fetch(lat,lon))
                records={k:self._record(v,["Open-Meteo (CC BY 4.0)"],"Open-Meteo") for k,v in normalized.items()}
                with self.lock:
                    if generation==self.generation:
                        self.backup_records=records
            except Exception:
                pass

    def read(self):
        with self.lock:
            if not self.settings["enabled"]:
                return {"status":"disabled","sections":{}}
            if not self.ledger:
                return {"status":"storage_error","sections":{}}
            now=self.monotonic()
            sections={}
            for kind in KINDS:
                primary=self.records.get(kind)
                backup=self.backup_records.get(kind)
                chosen=None
                if kind not in self.failures and self._fresh(kind,primary,now):
                    chosen=primary
                elif self._fresh(kind,backup,now):
                    chosen=backup
                if chosen is None:
                    sections[kind]={"status":"unavailable"}
                else:
                    data=chosen["data"]
                    if kind=="alerts":
                        moment=self.clock()
                        data=[x for x in data if datetime.fromisoformat(x["expires"].replace("Z","+00:00"))>moment]
                        # Expired/cancelled or superseded alerts are not a fresh
                        # affirmative "no warnings" result.
                        if not data and chosen["data"]:
                            sections[kind]={"status":"unavailable"}
                            continue
                    sections[kind]={k:v for k,v in chosen.items() if k!="mono"}
                    sections[kind].update(status="available",data=data)
            return {"status":"ready" if any(x["status"]=="available" for x in sections.values()) else "waiting",
                    "name":self.settings["name"],"sections":sections}

    def _loop(self):
        while not self.stop.is_set():
            try: self.step()
            except Exception:
                # A damaged ledger must not allow a QWeather request. Other
                # modules stay available. Never emit private exception details.
                with self.lock:
                    self.error="storage_error"
                    self.ledger=None
                    self.records.clear()
                    self.backup_records.clear()
            self.wake.wait(2)
            self.wake.clear()

    def start(self):
        self.thread=Thread(target=self._loop,name="weather-scheduler",daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=15)
