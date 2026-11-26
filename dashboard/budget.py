"""Shared, durable request budget for the experimental bus provider.

One NAS service process owns the adapter. These are conservative LOCAL limits,
not the provider's quota. No waiting, background threads or automatic unblock.
"""
import sqlite3
from datetime import datetime, timezone
from threading import RLock

from .bus import AccessBlocked, BusError, post


class BudgetWait(BusError):
    def __init__(self, message, code="local_budget_wait"):
        super().__init__(message)
        self.code = code


class RequestGate:
    def __init__(self, store, *, enabled=False, daily_limit=1000, min_gap=2,
                 request=post, clock=lambda: datetime.now(timezone.utc)):
        if (type(daily_limit) is not int or not 1 <= daily_limit <= 1000
                or type(min_gap) is not int or not 2 <= min_gap <= 3600):
            raise ValueError("Invalid local request budget")
        self.enabled, self.daily_limit, self.min_gap = enabled, daily_limit, min_gap
        self.request, self.clock = request, clock
        self.lock = RLock()
        self.path = store.path.parent / "bus-budget.sqlite3"
        # Keep the DB in the already validated private volume. Use 0600 from
        # creation, including when the process umask is permissive.
        import os
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
        with self._db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS budget (
                id INTEGER PRIMARY KEY CHECK(id=1), day TEXT NOT NULL,
                used INTEGER NOT NULL, next_at REAL NOT NULL, blocked INTEGER NOT NULL,
                eta_next_at REAL NOT NULL DEFAULT 0
            )""")
            # Compatible with earlier development snapshots.
            if "eta_next_at" not in {r[1] for r in db.execute("PRAGMA table_info(budget)")}:
                db.execute("ALTER TABLE budget ADD COLUMN eta_next_at REAL NOT NULL DEFAULT 0")
            db.execute("INSERT OR IGNORE INTO budget VALUES (1, '', 0, 0, 0, 0)")

    def _db(self):
        # A connection per operation, closed explicitly below.
        from contextlib import contextmanager
        @contextmanager
        def connection():
            db = sqlite3.connect(self.path, timeout=3)
            try:
                with db:
                    yield db
            finally:
                db.close()
        return connection()

    @property
    def blocked(self):
        with self.lock, self._db() as db:
            return bool(db.execute("SELECT blocked FROM budget WHERE id=1").fetchone()[0])

    def __call__(self, path, body, city):
        with self.lock:
            if not self.enabled:
                raise BudgetWait("Provider disabled", "bus_disabled")
            now = self.clock()
            day, timestamp = now.astimezone(timezone.utc).date().isoformat(), now.timestamp()
            eta = path == "/traffic/v1/getbusstoparrivedetails"
            with self._db() as db:
                db.execute("BEGIN IMMEDIATE")
                old_day, used, next_at, blocked, eta_next_at = db.execute(
                    "SELECT day, used, next_at, blocked, eta_next_at FROM budget WHERE id=1").fetchone()
                if blocked:
                    raise AccessBlocked("Provider access restricted")
                if day > old_day:
                    used, old_day = 0, day
                if used >= self.daily_limit:
                    raise BudgetWait("Local daily request limit reached", "local_daily_limit")
                if timestamp < next_at or (eta and timestamp < eta_next_at):
                    raise BudgetWait("Local request interval", "local_request_gap")
                # Reserve before making the network request: failed attempts
                # and restarts must not reset the budget.
                db.execute("UPDATE budget SET day=?, used=?, next_at=?, eta_next_at=? WHERE id=1",
                           (old_day, used + 1, timestamp + self.min_gap,
                            timestamp + 30 if eta else eta_next_at))
            try:
                return self.request(path, body, city)
            except AccessBlocked:
                with self._db() as db:
                    db.execute("UPDATE budget SET blocked=1 WHERE id=1")
                raise
            finally:
                # Space requests by completion as well as start time.
                with self._db() as db:
                    finished = self.clock().timestamp()
                    db.execute("UPDATE budget SET next_at=max(next_at, ?) WHERE id=1",
                               (finished + self.min_gap,))
                    if eta:
                        db.execute("UPDATE budget SET eta_next_at=max(eta_next_at, ?) WHERE id=1",
                                   (finished + 30,))
