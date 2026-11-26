"""Weather provider primitives. No network or private storage on import.

QWeather requests are reserved durably before transmission, including failures.
Never retry inside the HTTP transport or forward credentials on redirects.
"""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import gzip
import io
import json
import math
import os
import re
import sqlite3
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from urllib.error import HTTPError
from .trip_store import TripStore

LIMIT = 40000
MAX_RESPONSE = 1024 * 1024
BILLING_ZONE = timezone(timedelta(hours=8))
INTERVALS = {"current": 600, "hourly": 1800, "daily": 3600,
             "rain": 600, "air": 1800, "alerts": 600}


class WeatherError(Exception):
    """Fixed diagnostic category, never an upstream URL or response."""


class WeatherBudget(WeatherError):
    pass


class WeatherBlocked(WeatherError):
    pass


class RequestLedger:
    """Account-independent local counter; credential changes cannot reset it.

    Also enforce a rolling 32-day cap, conservatively covering billing timezone
    differences. A backwards clock fails closed. Only the owning NAS volume is
    counted: this cannot enforce the vendor account's global usage.
    """
    def __init__(self, directory, clock=lambda: datetime.now(timezone.utc)):
        self.path = TripStore(directory).path.parent / "weather-budget.sqlite3"
        self.clock = clock
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            if self.path.is_symlink() or not self.path.is_file() or self.path.stat().st_mode & 0o077:
                raise WeatherBudget("invalid_budget_storage")
            with closing(self._connect()) as db:
                db.execute("SELECT day, used FROM request_days LIMIT 1")
                if db.execute("SELECT last_day, blocked, backup_blocked FROM state WHERE id=1").fetchone() is None:
                    raise WeatherBudget("invalid_budget_storage")
        else:
            os.close(fd)
            with closing(self._connect()) as db, db:
                db.execute("CREATE TABLE request_days(day TEXT PRIMARY KEY, used INTEGER NOT NULL CHECK(used BETWEEN 0 AND 40000))")
                db.execute("CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), last_day TEXT NOT NULL, blocked INTEGER NOT NULL CHECK(blocked IN (0,1)), backup_blocked INTEGER NOT NULL CHECK(backup_blocked IN (0,1)))")
                db.execute("INSERT INTO state VALUES(1, '', 0, 0)")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=3)
        db.execute("PRAGMA synchronous=FULL")
        return db

    def _day(self):
        now = self.clock()
        if now.tzinfo is None:
            raise WeatherBudget("invalid_clock")
        return now.astimezone(BILLING_ZONE).date()

    def reserve(self):
        day = self._day()
        today = day.isoformat()
        oldest = (day - timedelta(days=31)).isoformat()
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            last, blocked = db.execute("SELECT last_day, blocked FROM state WHERE id=1").fetchone()
            if blocked:
                raise WeatherBlocked("provider_blocked")
            if last > today:
                raise WeatherBudget("clock_reversed")
            used = db.execute("SELECT COALESCE(SUM(used),0) FROM request_days WHERE day>=?", (oldest,)).fetchone()[0]
            if used >= LIMIT:
                raise WeatherBudget("request_limit")
            db.execute("INSERT INTO request_days VALUES(?,1) ON CONFLICT(day) DO UPDATE SET used=used+1", (today,))
            db.execute("UPDATE state SET last_day=? WHERE id=1", (today,))
            db.execute("DELETE FROM request_days WHERE day<?", (oldest,))

    def block(self):
        with closing(self._connect()) as db, db:
            db.execute("UPDATE state SET blocked=1 WHERE id=1")

    def block_backup(self):
        with closing(self._connect()) as db, db:
            db.execute("UPDATE state SET backup_blocked=1 WHERE id=1")

    def usage(self):
        day = self._day()
        with closing(self._connect()) as db:
            count = db.execute("SELECT COALESCE(SUM(used),0) FROM request_days WHERE day LIKE ?", (day.strftime("%Y-%m")+"%",)).fetchone()[0]
            rolling = db.execute("SELECT COALESCE(SUM(used),0) FROM request_days WHERE day>=?", ((day-timedelta(days=31)).isoformat(),)).fetchone()[0]
            blocked, backup_blocked = db.execute("SELECT blocked,backup_blocked FROM state WHERE id=1").fetchone()
        return {"month": day.strftime("%Y-%m"), "used": count, "rolling_used": rolling,
                "limit": LIMIT, "blocked": bool(blocked), "backup_blocked": bool(backup_blocked)}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise WeatherError("redirect_refused")


def get_json(url, headers):
    """Bound both compressed and decompressed bytes; never expose raw errors."""
    try:
        opener = build_opener(ProxyHandler({}), NoRedirect())
        request = Request(url, headers={**headers, "Accept": "application/json",
                                        "Accept-Encoding": "gzip", "User-Agent": "KindleHomeDashboard/1"})
        with opener.open(request, timeout=5) as response:
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise WeatherError("response_too_large")
            encoding = response.headers.get("Content-Encoding", "identity").lower()
            if encoding == "gzip":
                with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
                    raw = stream.read(MAX_RESPONSE + 1)
            elif encoding != "identity":
                raise WeatherError("unsupported_encoding")
            if len(raw) > MAX_RESPONSE:
                raise WeatherError("response_too_large")
        data = json.loads(raw, parse_constant=lambda x: None)
        if not isinstance(data, dict):
            raise WeatherError("invalid_response")
        return data
    except HTTPError as exc:
        if exc.code in (401, 402, 403, 429):
            raise WeatherBlocked("provider_blocked") from None
        raise WeatherError("provider_http_error") from None
    except WeatherError:
        raise
    except Exception:
        raise WeatherError("provider_unavailable") from None


def coordinates(latitude, longitude):
    if (type(latitude) not in (int, float) or type(longitude) not in (int, float)
            or not math.isfinite(latitude) or not math.isfinite(longitude)
            or not -90 <= latitude <= 90 or not -180 <= longitude <= 180):
        raise ValueError("invalid_weather_coordinates")
    return f"{latitude:.2f}", f"{longitude:.2f}"


class QWeather:
    """Use dedicated HTTPS host and key header; no legacy shared host."""
    def __init__(self, host, key, ledger, transport=get_json):
        if not isinstance(host, str) or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,3}qweatherapi\.com", host):
            raise ValueError("invalid_weather_host")
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", key):
            raise ValueError("invalid_weather_credential")
        self.host, self._key, self.ledger, self.transport = host, key, ledger, transport

    def fetch(self, kind, latitude, longitude):
        lat, lon = coordinates(latitude, longitude)
        suffix = "/" + lat + "/" + lon
        paths = {"current": ("/weather/v1/current" + suffix, {"localTime": "true"}),
                 "hourly": ("/weather/v1/hourly" + suffix, {"hours": 24, "localTime": "true"}),
                 "daily": ("/weather/v1/daily" + suffix, {"days": 7, "localTime": "true"}),
                 "rain": ("/v7/minutely/5m", {"location": lon + "," + lat}),
                 "air": ("/airquality/v1/current" + suffix, {}),
                 "alerts": ("/weatheralert/v1/current" + suffix, {"localTime": "true"})}
        if kind not in paths:
            raise ValueError("invalid_weather_kind")
        path, params = paths[kind]
        url = "https://" + self.host + path + "?" + urlencode({**params, "lang": "zh"})
        self.ledger.reserve()
        try:
            data = self.transport(url, {"X-QW-Api-Key": self._key})
            if not isinstance(data, dict):
                raise WeatherError("invalid_response")
            code = data.get("code")
            if code in ("401", "402", "403", "429", "480", "481"):
                raise WeatherBlocked("provider_blocked")
            if code is not None and code != "200":
                raise WeatherError("provider_error")
            required = {"current": "temperature", "hourly": "hours", "daily": "days",
                        "rain": "minutely", "air": "indexes", "alerts": "alerts"}[kind]
            if kind == "alerts" and data.get("metadata", {}).get("zeroResult") is True:
                if data.get("alerts") not in (None, []):
                    raise WeatherError("invalid_response")
                data = {**data, "alerts": []}
            if not isinstance(data.get(required), dict if kind == "current" else list):
                raise WeatherError("invalid_response")
            if kind not in ("alerts", "current") and not data[required]:
                raise WeatherError("empty_response")
            return data
        except WeatherBlocked:
            self.ledger.block()
            raise
        except WeatherError:
            raise
        except Exception:
            raise WeatherError("invalid_response") from None


class OpenMeteo:
    """Non-commercial public forecast; deliberately no fake alerts or nowcast."""
    def __init__(self, transport=get_json):
        self.transport = transport

    def fetch(self, latitude, longitude):
        lat, lon = coordinates(latitude, longitude)
        params = {"latitude": lat, "longitude": lon, "timezone": "auto",
                  "forecast_days": 7,
                  "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m",
                  "hourly": "temperature_2m,weather_code,precipitation_probability",
                  "daily": "weather_code,temperature_2m_max,temperature_2m_min"}
        data = self.transport("https://api.open-meteo.com/v1/forecast?" + urlencode(params), {})
        if not isinstance(data, dict) or data.get("error") or any(not isinstance(data.get(k), dict) for k in ("current","hourly","daily")):
            raise WeatherError("invalid_response")
        return data
