"""Opt-in local device pairing. Only read credentials; no client storage assumptions."""
from contextlib import contextmanager
from hashlib import sha256
from hmac import compare_digest
import os
import re
import sqlite3
from secrets import randbelow, token_urlsafe
from threading import RLock
from time import monotonic
from uuid import uuid4

from .trip_store import TripStore

TTL = 300
ATTEMPTS = 5
MAX_DEVICES = 16


class Devices:
    def __init__(self, directory, *, clock=monotonic):
        self.path = TripStore(directory).path.parent / "devices.sqlite3"
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
        self.clock = clock
        self.lock = RLock()
        self.pending = None
        with self.db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY, label TEXT NOT NULL, digest TEXT NOT NULL UNIQUE
            )""")

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=3)
        try:
            with db:
                yield db
        finally:
            db.close()

    def list(self):
        with self.lock, self.db() as db:
            return [{"id": i, "label": label}
                    for i, label in db.execute("SELECT id,label FROM devices ORDER BY label,id")]

    def issue(self, label):
        if not isinstance(label, str) or not label.strip() or len(label)>80:
            raise ValueError("Invalid device label")
        with self.lock:
            if len(self.list()) >= MAX_DEVICES:
                raise ValueError("Device limit reached")
            code = f"{randbelow(1000000):06d}"
            # One pending pairing per process. New issue replaces old one.
            self.pending = (code, label.strip(), self.clock()+TTL, ATTEMPTS)
            return {"code":code,"expires_in":TTL}

    def redeem(self, code):
        with self.lock:
            pending = self.pending
            if pending is None:
                raise ValueError("Pairing unavailable")
            expected, label, until, remaining = pending
            if self.clock() >= until:
                self.pending = None
                raise ValueError("Pairing unavailable")
            # Every submission, including a malformed code, costs an attempt.
            self.pending = (expected,label,until,remaining-1) if remaining>1 else None
            if not isinstance(code,str) or not re.fullmatch(r"[0-9]{6}",code) or not compare_digest(code,expected):
                raise ValueError("Pairing unavailable")
            # Consume before creating credentials, even if storage fails.
            self.pending = None
            token = "dev_" + token_urlsafe(32)
            key = uuid4().hex
            with self.db() as db:
                db.execute("BEGIN IMMEDIATE")
                if db.execute("SELECT COUNT(*) FROM devices").fetchone()[0]>=MAX_DEVICES:
                    raise ValueError("Device limit reached")
                db.execute("INSERT INTO devices VALUES (?,?,?)",
                           (key,label,sha256(token.encode("ascii")).hexdigest()))
            return {"id":key,"token":token}

    def authorized(self, token):
        if not isinstance(token,str) or not re.fullmatch(r"dev_[A-Za-z0-9_-]{43}",token):
            return False
        digest = sha256(token.encode("ascii")).hexdigest()
        with self.lock, self.db() as db:
            return db.execute("SELECT 1 FROM devices WHERE digest=?",(digest,)).fetchone() is not None

    def revoke(self, key):
        if not isinstance(key,str) or not re.fullmatch(r"[a-f0-9]{32}",key):
            raise ValueError("Invalid device ID")
        with self.lock, self.db() as db:
            if db.execute("DELETE FROM devices WHERE id=?",(key,)).rowcount!=1:
                raise ValueError("Unknown device")
