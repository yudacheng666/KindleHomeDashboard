"""Shared bus service core for future Kindle and phone endpoints.

Only trusted in-process callers today; an HTTP/auth layer is not included.
A single scheduler invokes tick(); display reads never call the provider.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import RLock

from .budget import RequestGate
from .bus import BusError, Poller, Snapshot, parse, post
from .routes import Line, Route, Trip, search, detail, revalidate
from .trip_store import TripStore


@dataclass(frozen=True)
class BusView:
    trip: Trip | None
    snapshot: Snapshot


class BusService:
    def __init__(self, directory, *, enabled=False, clock=lambda: datetime.now(timezone.utc),
                 request=post, daily_limit=1000):
        self.clock = clock
        self.store = TripStore(directory)
        self.gate = RequestGate(self.store, enabled=enabled, clock=clock,
                                request=request, daily_limit=daily_limit)
        self.lock = RLock()
        self.trip = self.store.load()
        self.poller = None
        self.restore_status = "unverified" if self.trip else "unconfigured"
        self.restore_after = None
        self.search_cache = None
        self.route_cache = None

    def search_lines(self, keyword, city="310100"):
        with self.lock:
            now = self.clock()
            key = (keyword, city)
            if self.search_cache and self.search_cache[0] == key and now < self.search_cache[1]:
                return self.search_cache[2]
            lines = search(keyword, city, request=self.gate)
            self.search_cache = (key, now + timedelta(seconds=60), lines)
            return lines

    def get_route(self, line: Line, direction=None):
        with self.lock:
            now = self.clock()
            if not self.search_cache or now >= self.search_cache[1] or line not in self.search_cache[2]:
                raise ValueError("Search for this route first")
            key = (line, direction)
            if self.route_cache and self.route_cache[0] == key and now < self.route_cache[1]:
                return self.route_cache[2]
            route = detail(line, direction, request=self.gate)
            self.route_cache = (key, now + timedelta(minutes=10), route)
            return route

    def save_trip(self, route: Route, boarding: int, destination: int):
        with self.lock:
            if (not self.route_cache or self.clock() >= self.route_cache[1]
                    or route != self.route_cache[2]):
                raise ValueError("Route selection expired; select again")
            trip = self.store.save(route, boarding, destination)
            self._activate(trip)
            return self.read()

    def _activate(self, trip):
        self.trip = trip
        self.poller = Poller(trip.eta_stop(), enabled=self.gate.enabled,
                             clock=self.clock, loader=self._load_eta)
        self.restore_status = "verified"
        self.restore_after = None

    def _load_eta(self, stop):
        p = self.gate("/traffic/v1/getbusstoparrivedetails",
                      {"lineName": stop.line_name, "stopName": stop.stop_name,
                       "stopId": stop.stop_id, "direction": stop.direction},
                      stop.city_code)
        return parse(p, self.clock())

    def read(self):
        with self.lock:
            now = self.clock()
            if self.gate.blocked:
                return BusView(self.trip, Snapshot("blocked", now))
            if not self.gate.enabled:
                return BusView(self.trip, Snapshot("disabled", now))
            if self.poller:
                return BusView(self.trip, self.poller.current())
            return BusView(self.trip, Snapshot(self.restore_status, now))

    def tick(self):
        with self.lock:
            if not self.gate.enabled or self.gate.blocked:
                return self.read()
            if self.trip and self.poller is None and self.restore_status != "needs_selection":
                now = self.clock()
                if self.restore_after is None or now >= self.restore_after:
                    try:
                        route = detail(self.trip.line, request=self.gate)
                        verified = revalidate(self.trip, route)
                    except ValueError:
                        self.restore_status = "needs_selection"
                    except BusError:
                        self.restore_status = "unverified"
                        self.restore_after = self.clock() + timedelta(seconds=60)
                    else:
                        self._activate(verified)
                        # The route detail just consumed a request. ETA must
                        # wait for the next scheduler tick, not fire immediately.
                        return self.read()
            elif self.poller:
                self.poller.poll()
            return self.read()
