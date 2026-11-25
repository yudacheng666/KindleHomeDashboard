"""Experimental direct bus adapter. No polling or networking at import time."""
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
import json
import re
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, HTTPRedirectHandler, build_opener

BASE = "https://api.shmaas.net"
MAX_BODY = 1_048_576


class BusError(Exception):
    """Sanitized failure; do not expose request parameters or raw responses."""


class AccessBlocked(BusError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@dataclass(frozen=True)
class Stop:
    # These values must come from a locally verified route and direction.
    line_name: str
    stop_name: str
    stop_id: str
    direction: str
    city_code: str = "310100"

    def __post_init__(self):
        if not all(isinstance(v, str) and v.strip() for v in
                   (self.line_name, self.stop_name, self.stop_id)):
            raise ValueError("Missing private bus configuration")
        if self.direction not in ("0", "1") or not re.fullmatch(r"[0-9]{6}", self.city_code):
            raise ValueError("Invalid bus direction or city code")


@dataclass(frozen=True)
class Vehicle:
    position: int
    eta_min: int
    distance_m: int | None
    stops_remaining: int | None


@dataclass(frozen=True)
class Snapshot:
    status: str
    fetched_at: datetime
    vehicles: tuple[Vehicle, ...] = ()
    scheduled_departures: int = 0


def _number(value):
    # Observed API returns numeric strings. Do not interpret missing values,
    # negative sentinels, booleans, or descriptive text as zero.
    if isinstance(value, bool):
        return None
    s = str(value).strip()
    return int(s) if re.fullmatch(r"[0-9]{1,8}", s) else None


def parse(payload: dict, fetched_at: datetime) -> Snapshot:
    if not isinstance(payload, dict) or type(payload.get("errCode")) is not int:
        raise BusError("Invalid provider response")
    if payload["errCode"] in (-2903031, -2903032, -2903041, -2903051):
        raise AccessBlocked("Provider access restricted")
    if payload["errCode"] != 0 or not isinstance(payload.get("data"), dict):
        raise BusError("Provider rejected request")
    data = payload["data"]
    arrivals = data.get("stopArriveInfo")
    if not isinstance(arrivals, dict):
        raise BusError("Missing arrival record")
    vehicles = []
    seen = set()
    for i, prefix in enumerate(("current", "next"), 1):
        eta = _number(arrivals.get(prefix + "BusArriveTime"))
        distance = _number(arrivals.get(prefix + "BusDistance"))
        remaining = _number(arrivals.get(prefix + "BusStopCount"))
        plate = arrivals.get(prefix + "LicensePlate")
        # Vehicle identifiers are used transiently for deduplication only.
        identity = plate.strip() if isinstance(plate, str) else ""
        if eta is None or (identity and identity in seen):
            continue
        if eta == 0 and not identity and distance is None:
            continue
        if identity:
            seen.add(identity)
        vehicles.append(Vehicle(i, eta, distance, remaining))
    schedule = data.get("dispatchCarSchedule")
    departures = schedule.get("dispatchCars") if isinstance(schedule, dict) else None
    return Snapshot("live" if vehicles else "no_live_data", fetched_at,
                    tuple(vehicles), len(departures) if isinstance(departures, list) else 0)


def fetch(stop: Stop, timeout: float = 8.0) -> Snapshot:
    body = json.dumps({"lineName": stop.line_name, "stopName": stop.stop_name,
                       "stopId": stop.stop_id, "direction": stop.direction}).encode()
    req = Request(BASE + "/traffic/v1/getbusstoparrivedetails", data=body, method="POST",
                  headers={"Content-Type": "application/json", "Accept": "application/json",
                           "X-Saic-CityCode": stop.city_code,
                           "User-Agent": "KindleHomeDashboard/0.1-experimental"})
    try:
        with build_opener(NoRedirect()).open(req, timeout=timeout) as response:
            raw = response.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                raise BusError("Response too large")
            payload = json.loads(raw)
    except HTTPError as exc:
        if exc.code in (401, 403, 429):
            raise AccessBlocked("Provider access restricted") from None
        raise BusError("HTTP request failed") from None
    except (URLError, OSError, ValueError, RecursionError):
        raise BusError("Transport or response error") from None
    return parse(payload, datetime.now(timezone.utc))


class Poller:
    """Single-stop in-memory prototype; call from a single scheduler thread.

    Defaults are provisional, not a statement of provider quota. Disabled
    until explicitly enabled by local configuration. No retries or background
    threads. Do not use as a multi-stop global rate limiter.
    """
    def __init__(self, stop: Stop, *, enabled=False, interval=30, ttl=90,
                 loader: Callable[[Stop], Snapshot] = fetch,
                 clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)):
        if interval < 30 or ttl < interval:
            raise ValueError("Invalid provisional polling limits")
        self.stop, self.enabled, self.interval, self.ttl = stop, enabled, interval, ttl
        self.loader, self.clock = loader, clock
        self.next_poll = None
        self.last = None
        self.failures = 0
        self.blocked = False

    def current(self) -> Snapshot:
        now = self.clock()
        if not self.enabled or self.blocked:
            return Snapshot("blocked" if self.blocked else "disabled", now)
        if self.last is None:
            return Snapshot("unavailable", now)
        if (now - self.last.fetched_at).total_seconds() >= self.ttl:
            return replace(self.last, status="expired", vehicles=(), scheduled_departures=0)
        return self.last

    def poll(self) -> Snapshot:
        now = self.clock()
        if not self.enabled or self.blocked or (self.next_poll and now < self.next_poll):
            return self.current()
        try:
            result = self.loader(self.stop)
        except AccessBlocked:
            self.blocked = True
            return self.current()
        except BusError:
            self.failures += 1
            self.next_poll = self.clock() + timedelta(seconds=max(self.interval, min(900, self.interval * 2 ** min(self.failures, 5))))
            if self.last and self.last.vehicles:
                self.last = replace(self.last, status="stale")
            else:
                self.last = Snapshot("error", now)
            return self.current()
        self.failures = 0
        self.next_poll = self.clock() + timedelta(seconds=self.interval)
        # An empty successful response is ambiguous, not proof of no buses.
        # Preserve the prior live data only with the stale label and original
        # timestamp, never as a new successful live reading.
        if (result.status == "no_live_data" and self.last and self.last.vehicles
                and (self.clock() - self.last.fetched_at).total_seconds() < self.ttl):
            self.last = replace(self.last, status="stale")
        else:
            self.last = result
        return self.current()
