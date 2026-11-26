"""Time-window scheduler and local service facade (single process).

No network on import. A window must be explicitly supplied for auto polling.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Event, Thread, Lock
from zoneinfo import ZoneInfo

from .bus import Snapshot
from .service import BusView


@dataclass(frozen=True)
class Window:
    days: tuple[int, ...]
    start: int  # minutes after local midnight
    end: int

    def __post_init__(self):
        if (not self.days or any(type(d) is not int or not 0 <= d <= 6 for d in self.days)
                or type(self.start) is not int or type(self.end) is not int
                or not 0 <= self.start < 1440 or not 0 <= self.end <= 1440
                or self.start == self.end):
            raise ValueError("Invalid schedule window")

    def contains(self, local):
        minute = local.hour * 60 + local.minute
        day = local.weekday()
        if self.start < self.end:
            return day in self.days and self.start <= minute < self.end
        return ((day in self.days and minute >= self.start)
                or ((day - 1) % 7 in self.days and minute < self.end))


class Runtime:
    def __init__(self, bus, *, windows=(), timezone_name="Asia/Shanghai",
                 clock=lambda: datetime.now(timezone.utc)):
        self.bus = bus
        self.windows = tuple(windows)
        self.zone = ZoneInfo(timezone_name)
        self.clock = clock
        self.stop = Event()
        self.failed = Event()
        self.thread = None
        self.lifecycle = Lock()

    def active(self):
        local = self.clock().astimezone(self.zone)
        return any(w.contains(local) for w in self.windows)

    def read(self):
        view = self.bus.read()
        if self.failed.is_set():
            return BusView(view.trip, Snapshot("service_error", self.clock()))
        if not self.active() and view.snapshot.status not in (
                "blocked", "disabled", "config_error", "unconfigured", "needs_selection"):
            return BusView(view.trip, Snapshot("paused", self.clock()))
        return view

    def step(self):
        if self.active() and not self.failed.is_set():
            try:
                self.bus.tick()
            except Exception:
                # Unexpected storage/runtime failures fail closed. No raw
                # exceptions or household configuration in service logs.
                self.failed.set()

    def _loop(self):
        while not self.stop.is_set():
            self.step()
            self.stop.wait(2)

    def start(self):
        with self.lifecycle:
            if self.thread is not None or self.stop.is_set():
                raise RuntimeError("Runtime already started or stopped")
            self.thread = Thread(target=self._loop, name="bus-scheduler", daemon=True)
            self.thread.start()

    def close(self):
        with self.lifecycle:
            self.stop.set()
            if self.thread is not None:
                self.thread.join(timeout=15)
                if self.thread.is_alive():
                    raise RuntimeError("Scheduler did not stop")
