"""Offline private backup/restore. Never replace a live data directory.

Only known application files are copied. Restore creates a fresh directory
and conservatively blocks paid-capable providers pending a reviewed reactivation.
"""
import argparse
from contextlib import contextmanager, closing
from hashlib import sha256
import fcntl
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat

from .trip_store import TripStore

FILES = ("bus-trip.json", "bus-budget.sqlite3", "household.sqlite3", "weather-settings.json", "weather-budget.sqlite3")
MANIFEST = "manifest.json"
MAX_FILE = 64 * 1024 * 1024


def private_root(directory):
    return TripStore(directory).path.parent


def new_path(directory):
    p = Path(directory)
    if not p.is_absolute() or p.name in ("", ".", ".."):
        raise ValueError("Absolute new directory required")
    root = private_root(p.parent) / p.name
    if root.exists() or root.is_symlink():
        raise ValueError("Destination already exists")
    return root


@contextmanager
def offline(root):
    fd = os.open(root / "service.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def read_file(path, limit=MAX_FILE):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("Invalid or oversized backup file")
        raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("Oversized backup file")
        return raw


def write_file(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def fresh_directory(root):
    root.mkdir(mode=0o700)
    try:
        yield
        sync_directory(root)
        sync_directory(root.parent)
    except BaseException:
        shutil.rmtree(root)
        raise


def validate(root, names):
    if "bus-trip.json" in names:
        if TripStore(str(root)).load() is None:
            raise ValueError("Missing trip")
    if "weather-settings.json" in names:
        from .weather_service import config
        if "weather-budget.sqlite3" not in names:
            raise ValueError("Missing weather budget")
        config(json.loads(read_file(root/"weather-settings.json",8192)))
    for name in ("bus-budget.sqlite3", "household.sqlite3", "weather-budget.sqlite3"):
        if name not in names:
            continue
        with closing(sqlite3.connect((root / name).as_uri() + "?mode=ro", uri=True)) as db:
            db.execute("PRAGMA query_only=ON")
            if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError("Database integrity failure")
            if db.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("Database foreign key failure")
            if name == "household.sqlite3":
                if db.execute("PRAGMA user_version").fetchone()[0] != 1:
                    raise ValueError("Unsupported household schema")
                for table in ("tasks","completions","posters","menus","shopping","display_settings"):
                    db.execute("SELECT * FROM " + table + " LIMIT 1").fetchone()
                if db.execute("SELECT seconds,include_week,include_shopping,autoplay FROM display_settings WHERE id=1").fetchone() is None:
                    raise ValueError("Missing display settings")
            elif name == "weather-budget.sqlite3":
                if db.execute("SELECT last_day,blocked,backup_blocked FROM state WHERE id=1").fetchone() is None:
                    raise ValueError("Missing weather budget state")
                db.execute("SELECT day,used FROM request_days").fetchall()
            else:
                if db.execute("SELECT day,used,next_at,blocked,eta_next_at FROM budget WHERE id=1").fetchone() is None:
                    raise ValueError("Missing request budget")


def backup(source, destination):
    source = private_root(source)
    if (source / MANIFEST).exists() or (source / MANIFEST).is_symlink():
        raise ValueError("Source must be an active data volume, not a backup")
    dest = new_path(destination)
    if source == dest or source in dest.parents:
        raise ValueError("Keep backup separate from active volume")
    with offline(source), fresh_directory(dest):
        hashes = {}
        for name in FILES:
            path = source / name
            if not path.exists() and not path.is_symlink():
                continue
            # The service is stopped, but an SQLite journal may still exist
            # after an unclean shutdown. Use SQLite backup, not raw DB copies.
            if name.endswith(".sqlite3"):
                if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE:
                    raise ValueError("Invalid database file")
                write_file(dest / name, b"")
                with closing(sqlite3.connect(path.as_uri()+"?mode=ro", uri=True)) as src, closing(sqlite3.connect(dest / name)) as dst:
                    src.backup(dst)
                    if dst.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
                        raise ValueError("Cannot create standalone database snapshot")
                raw = read_file(dest / name)
                with (dest / name).open("rb") as stream:
                    os.fsync(stream.fileno())
            else:
                raw = read_file(path, 32768)
                write_file(dest / name, raw)
            hashes[name] = sha256(raw).hexdigest()
        if not hashes:
            raise ValueError("No application data to back up")
        validate(dest, hashes)
        if {p.name for p in dest.iterdir()} != set(hashes):
            raise ValueError("Unexpected snapshot sidecar")
        write_file(dest / MANIFEST, json.dumps({"version":1,"files":hashes},sort_keys=True).encode())


def restore(source, destination):
    source = private_root(source)
    dest = new_path(destination)
    if source in dest.parents:
        raise ValueError("Keep restored volume separate")
    manifest = json.loads(read_file(source / MANIFEST, 4096))
    if not isinstance(manifest, dict) or set(manifest) != {"version","files"} or type(manifest["version"]) is not int or manifest["version"] != 1:
        raise ValueError("Unknown backup format")
    hashes = manifest["files"]
    if not isinstance(hashes, dict) or not hashes or not set(hashes).issubset(FILES):
        raise ValueError("Invalid backup inventory")
    if {p.name for p in source.iterdir()} != set(hashes) | {MANIFEST}:
        raise ValueError("Unexpected backup files")
    with fresh_directory(dest):
        for name, expected in hashes.items():
            raw = read_file(source / name, 32768 if name.endswith(".json") else MAX_FILE)
            if sha256(raw).hexdigest() != expected:
                raise ValueError("Backup checksum mismatch")
            write_file(dest / name, raw)
        validate(dest, hashes)
        # An old backup cannot prove that provider access was not blocked
        # after it was taken. Never restore an automatically enabled gate.
        from .budget import RequestGate
        gate = RequestGate(TripStore(str(dest)))
        with gate._db() as db:
            db.execute("UPDATE budget SET blocked=1 WHERE id=1")
        with gate.path.open("rb") as stream:
            os.fsync(stream.fileno())
        # A restored count may omit requests made after the backup. Block
        # QWeather even for old backups that predate the weather module.
        from .weather import RequestLedger
        weather_ledger=RequestLedger(str(dest))
        weather_ledger.block()
        if "weather-settings.json" in hashes:
            from .weather_service import config
            weather_path=dest/"weather-settings.json"
            settings=config(json.loads(read_file(weather_path,8192)))
            settings.update(enabled=False,consent=False)
            with weather_path.open("wb") as stream:
                stream.write(json.dumps(settings,ensure_ascii=False).encode())
                stream.flush()
                os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("backup","restore"))
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    args = parser.parse_args()
    try:
        (backup if args.operation == "backup" else restore)(args.source, args.destination)
    except Exception:
        print("Backup/restore failed. Check private paths, stopped service, integrity and destination.")
        return 1
    print("Private backup complete." if args.operation == "backup" else
          "New restored volume ready. Bus and QWeather access blocked pending review. Original volume unchanged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
