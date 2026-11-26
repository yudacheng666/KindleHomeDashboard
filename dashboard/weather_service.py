"""Independent weather scheduler: clients read a bounded in-memory snapshot.

Only the private volume stores location and counters; credentials come from
private startup environment, never from the LAN HTTP API.
"""
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
import stat
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
MAX_LOCATIONS = 3
SECONDARY_INTERVALS = {"current": 1200, "rain": 600, "alerts": 900}
LOCATION_KEYS = {"name", "latitude", "longitude"}


def location(value, *, required=True):
    if not isinstance(value, dict) or set(value) != LOCATION_KEYS:
        raise ValueError("invalid_weather_location")
    name = value["name"]
    if not isinstance(name, str) or len(name.strip()) > 40 or any(ord(c)<32 for c in name) or (required and not name.strip()):
        raise ValueError("invalid_weather_name")
    lat, lon = coordinates(value["latitude"], value["longitude"])
    return {"name": name.strip(), "latitude": float(lat), "longitude": float(lon)}


def config(value):
    if not isinstance(value, dict) or set(value) not in (set(DEFAULT), set(DEFAULT)|{"additional"}):
        raise ValueError("invalid_weather_config")
    if type(value["enabled"]) is not bool or type(value["consent"]) is not bool:
        raise ValueError("invalid_weather_config")
    main = location({k:value[k] for k in LOCATION_KEYS}, required=value["enabled"])
    extra = value.get("additional", [])
    if not isinstance(extra, list) or len(extra) >= MAX_LOCATIONS:
        raise ValueError("invalid_weather_locations")
    extra = [location(x) for x in extra]
    if extra and not main["name"]:
        raise ValueError("primary_location_required")
    positions = [(x["latitude"],x["longitude"]) for x in [main]+extra]
    if len(set(positions)) != len(positions):
        raise ValueError("duplicate_weather_location")
    if value["enabled"] and not value["consent"]:
        raise ValueError("weather_consent_required")
    return {**main, "enabled":value["enabled"], "consent":value["consent"], "additional":extra}


def locations(settings):
    return [{k:settings[k] for k in LOCATION_KEYS}]+settings.get("additional", [])


def intervals(index):
    return INTERVALS if index == 0 else SECONDARY_INTERVALS


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
        if len(attrs)>50:
            raise WeatherError("invalid_attribution")
        attrs = [string(x, 1000) for x in attrs]
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
            if len(rows)>100:
                raise WeatherError("too_many_alerts")
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
        zone=ZoneInfo(raw["timezone"])
        def local_stamp(t):
            value=datetime.fromisoformat(stamp(t,offset_required=False))
            return (value if value.tzinfo else value.replace(tzinfo=zone)).isoformat()
        now = local_stamp(c["time"])
        result = {"current": {"time": now, "text": wmo(c["weather_code"]),
                   "temp": number(c["temperature_2m"]), "feels": optional(c.get("apparent_temperature")),
                   "humidity": optional(c.get("relative_humidity_2m"),0,100),
                   "wind": optional(c.get("wind_speed_10m"),0,500), "wind_unit":"km/h"}}
        result["hourly"] = [{"time": local_stamp(t), "text": wmo(h["weather_code"][i]),
                             "temp": number(h["temperature_2m"][i]), "pop": optional(h["precipitation_probability"][i],0,100)}
                            for i,t in enumerate(h["time"]) if t >= c["time"]][:24]
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
                 monotonic=time.monotonic, q_transport=None, backup_transport=None, timezone_name="Asia/Shanghai"):
        root = TripStore(directory).path.parent
        self.path = root / "weather-settings.json"
        self.lock = RLock()
        self.stop = Event()
        self.wake = Event()
        self.thread = None
        self.clock, self.monotonic = clock, monotonic
        self.display_zone = ZoneInfo(timezone_name)
        self.settings = config(DEFAULT)
        self.error = ""
        self.primary = None
        self.primary_blocked = False
        self.backup_blocked = False
        self.ledger = None
        self.generation = 0
        self.search_busy = False
        self.search_after = None
        self.records = {}
        self.failures = {}
        self.due = {}
        self.backup_records = {}
        self.backup_due = {}
        self.backup = OpenMeteo(**({"transport":backup_transport} if backup_transport else {}))
        try:
            if self.path.exists() or self.path.is_symlink():
                fd = os.open(self.path, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                with os.fdopen(fd,"rb") as stream:
                    info=os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size>8192:
                        raise ValueError("private_weather_settings_required")
                    self.settings = config(json.loads(stream.read(8193)))
                if not (root/"weather-budget.sqlite3").exists():
                    raise ValueError("missing_weather_budget")
            self.ledger = RequestLedger(str(root), clock)
            self.backup_blocked = self.ledger.usage()["backup_blocked"]
        except Exception:
            self.error = "storage_error"
            self.ledger = None
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

    def search_locations(self, body):
        # Explicit user request, independent of scheduled collection. No
        # household search terms are stored or logged.
        if set(body) != {"keyword", "consent"} or body["consent"] is not True or not isinstance(body["keyword"], str):
            raise ValueError("invalid_city_search")
        with self.lock:
            if not self.ledger or self.stop.is_set():
                return {"status": "unavailable", "locations": []}
            if self.primary is None:
                return {"status": "not_configured", "locations": []}
            if self.search_busy or (self.search_after is not None and self.monotonic() < self.search_after):
                return {"status": "wait", "locations": []}
            primary = self.primary
            self.search_busy = True
        try:
            return {"status": "ok", "locations": primary.search(body["keyword"])}
        except WeatherBlocked:
            return {"status": "blocked", "locations": []}
        except WeatherBudget:
            return {"status": "budget", "locations": []}
        except WeatherError:
            return {"status": "unavailable", "locations": []}
        finally:
            with self.lock:
                self.search_after = self.monotonic() + 3
                self.search_busy = False

    def configure(self, value):
        legacy = isinstance(value, dict) and "additional" not in value
        value = config(value)
        with self.lock:
            if legacy and self.settings.get("additional"):
                raise ValueError("reload_multi_location_settings")
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
            self.backup_due.clear()
            self.wake.set()
            return self.settings_view()

    def _record(self,data,attrs,source):
        return {"data":data,"attributions":attrs,"source":source,
                "fetched_at":self.clock().astimezone(self.display_zone).isoformat(),"mono":self.monotonic()}

    def _fresh(self,kind,record,now):
        return record is not None and 0 <= now-record["mono"] <= TTL[kind]

    def step(self):
        # A single scheduler shares the durable account budget across all
        # locations. One primary request and at most one fallback per step.
        with self.lock:
            if self.stop.is_set() or not self.settings["enabled"] or not self.settings["consent"] or not self.ledger:
                return
            generation = self.generation
            places = locations(self.settings)
            now = self.monotonic()
            primary = self.primary
            blocked = self.ledger.usage()["blocked"]
            pending = [(i,k) for i in range(len(places)) for k in intervals(i)
                       if now >= self.due.get((i,k),0)] if primary and not blocked else []
            task = min(pending, key=lambda t:self.due.get(t,0)) if pending else None
            if task:
                i,kind = task
                self.due[task] = now + intervals(i)[kind]
        if task:
            with self.lock:
                if self.stop.is_set() or generation != self.generation:
                    return
            place = places[i]
            try:
                data,attrs = q_normalize(kind,primary.fetch(kind,place["latitude"],place["longitude"]))
                if kind in ("current","rain"):
                    age = (self.clock()-datetime.fromisoformat(data["time"].replace("Z","+00:00"))).total_seconds()
                    if not -300 <= age <= TTL[kind]:
                        raise WeatherError("source_time_outdated")
                record = self._record(data,attrs,"QWeather")
                with self.lock:
                    if generation == self.generation:
                        self.records[task] = record
                        self.failures.pop(task,None)
            except Exception as exc:
                with self.lock:
                    if isinstance(exc, WeatherBlocked):
                        self.primary_blocked = True
                        blocked = True
                    if generation == self.generation:
                        count = self.failures.get(task,0)+1
                        self.failures[task] = count
                        self.due[task] = self.monotonic()+min(3600,intervals(i)[kind]*(2**min(count,4)))
        with self.lock:
            if self.stop.is_set() or generation != self.generation or self.backup_blocked or not self.ledger:
                return
            now = self.monotonic()
            pending = [j for j in range(len(places))
                       if now >= self.backup_due.get(j,0) and
                       (not primary or blocked or any((j,k) in self.failures for k in (CORE if j==0 else ("current",))))]
            if not pending:
                return
            j = min(pending,key=lambda x:self.backup_due.get(x,0))
            self.backup_due[j] = now + BACKUP_INTERVAL
        place = places[j]
        try:
            normalized = meteo_normalize(self.backup.fetch(place["latitude"],place["longitude"]))
            age = (self.clock()-datetime.fromisoformat(normalized["current"]["time"])).total_seconds()
            if not -300 <= age <= TTL["current"]:
                raise WeatherError("source_time_outdated")
            records = {(j,k):self._record(v,["Open-Meteo (CC BY 4.0)"],"Open-Meteo")
                       for k,v in normalized.items() if k in intervals(j)}
            with self.lock:
                if generation == self.generation:
                    self.backup_records.update(records)
        except WeatherBlocked:
            self.ledger.block_backup()
            with self.lock:
                self.backup_blocked=True
                self.backup_records.clear()
        except Exception:
            pass

    def _location_view(self,index,place,now):
        sections={}
        for kind in intervals(index):
            task=(index,kind)
            primary=self.records.get(task)
            backup=self.backup_records.get(task)
            chosen=None
            if task not in self.failures and self._fresh(kind,primary,now):
                chosen=primary
            elif self._fresh(kind,backup,now):
                chosen=backup
            if chosen is None:
                sections[kind]={"status":"unavailable"}
                continue
            data=chosen["data"]
            if kind in ("current","rain"):
                age=(self.clock()-datetime.fromisoformat(data["time"].replace("Z","+00:00"))).total_seconds()
                if not -300<=age<=TTL[kind]:
                    sections[kind]={"status":"unavailable"}
                    continue
            if kind=="hourly":
                data=[x for x in data if datetime.fromisoformat(x["time"].replace("Z","+00:00"))>=self.clock()]
                if not data:
                    sections[kind]={"status":"unavailable"}
                    continue
            if kind=="alerts":
                moment=self.clock()
                data=[x for x in data if datetime.fromisoformat(x["expires"].replace("Z","+00:00"))>moment]
                if not data and chosen["data"]:
                    sections[kind]={"status":"unavailable"}
                    continue
            sections[kind]={k:v for k,v in chosen.items() if k!="mono"}
            sections[kind].update(status="available",data=data)
        return {"status":"ready" if any(x["status"]=="available" for x in sections.values()) else "waiting",
                "name":place["name"],"sections":sections}

    def read(self):
        with self.lock:
            if not self.settings["enabled"]:
                return {"status":"disabled","sections":{}}
            if not self.ledger:
                return {"status":"storage_error","sections":{}}
            now=self.monotonic()
            views=[self._location_view(i,p,now) for i,p in enumerate(locations(self.settings))]
            return {**views[0],"additional":views[1:]}

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
