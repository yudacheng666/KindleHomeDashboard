"""Time-window scheduler and local service facade (single process).

No network on import. A window must be explicitly supplied for auto polling.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Event, Thread, Lock, RLock
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


def parse_schedule(value):
    if (not isinstance(value, dict) or set(value) != {"enabled", "windows"}
            or type(value["enabled"]) is not bool or not isinstance(value["windows"], list)
            or len(value["windows"]) > 32 or (value["enabled"] and not value["windows"])):
        raise ValueError("Invalid bus schedule")
    windows = []
    for row in value["windows"]:
        if (not isinstance(row, dict) or set(row) != {"days", "start", "end"}
                or not isinstance(row["days"], list) or len(row["days"]) > 7):
            raise ValueError("Invalid bus window")
        w = Window(tuple(row["days"]), row["start"], row["end"])
        if len(set(w.days)) != len(w.days):
            raise ValueError("Duplicate weekday")
        windows.append(w)
    return value["enabled"], tuple(windows)


class Runtime:
    def __init__(self, bus, *, windows=(), timezone_name="Asia/Shanghai",
                 clock=lambda: datetime.now(timezone.utc), web_settings=False):
        self.bus = bus
        self.windows = tuple(windows)
        self.zone = ZoneInfo(timezone_name)
        self.clock = clock
        self.stop = Event()
        self.failed = Event()
        self.thread = None
        self.lifecycle = Lock()
        self.settings_lock = RLock()
        self.web_settings = web_settings
        if web_settings:
            try:
                stored = bus.gate.load_schedule()
                if stored is not None:
                    enabled, self.windows = parse_schedule(stored)
                    bus.set_enabled(enabled)
            except (ValueError, TypeError, RecursionError):
                self.windows = ()
                bus.set_enabled(False, config_error=True)

    def schedule_view(self):
        with self.settings_lock:
            return {"editable": self.web_settings, "enabled": self.bus.gate.enabled,
                    "timezone": self.zone.key,
                    "windows": [{"days": list(w.days), "start": w.start, "end": w.end}
                                for w in self.windows]}

    def configure_schedule(self, value):
        if not self.web_settings:
            raise ValueError("Bus web settings unavailable")
        enabled, windows = parse_schedule(value)
        with self.settings_lock:
            self.bus.gate.save_schedule(value)
            self.windows = windows
            self.bus.set_enabled(enabled)
            return self.schedule_view()

    def active(self):
        with self.settings_lock:
            local = self.clock().astimezone(self.zone)
            return any(w.contains(local) for w in self.windows)

    def read(self):
        with self.settings_lock:
            view = self.bus.read()
            if self.failed.is_set():
                return BusView(view.trip, Snapshot("service_error", self.clock()))
            if not self.active() and view.snapshot.status not in (
                    "blocked", "disabled", "config_error", "unconfigured", "needs_selection"):
                return BusView(view.trip, Snapshot("paused", self.clock()))
            return view

    def step(self):
        with self.settings_lock:
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
