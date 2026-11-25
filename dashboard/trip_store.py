"""Local-only, atomic trip persistence. No implicit data directory."""
from dataclasses import asdict
import json
import os
from pathlib import Path
import tempfile

from .routes import Line, Station, Trip, Route, select, revalidate

MAX_CONFIG = 32768
SOURCE = Path(__file__).resolve().parents[1]


class TripStore:
    """One saved trip in an explicitly chosen existing private directory."""

    def __init__(self, directory):
        root = Path(directory)
        if not root.is_absolute():
            raise ValueError("Use an absolute private data directory")
        root = root.resolve()
        if (root == SOURCE or SOURCE in root.parents
                or any((p / ".git").exists() for p in (root, *root.parents))
                or not root.is_dir()):
            raise ValueError("Data directory must be outside a Git worktree")
        self.path = root / "bus-trip.json"

    def save(self, route: Route, boarding: int, destination: int) -> Trip:
        trip = select(route, boarding, destination)
        raw = json.dumps({"version": 1, "trip": asdict(trip)},
                         ensure_ascii=False).encode("utf-8")
        if len(raw) > MAX_CONFIG:
            raise ValueError("Trip configuration too large")
        fd, temporary = tempfile.mkstemp(prefix=".bus-trip-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temporary, self.path)
            # The private volume is expected to be a Linux filesystem.
            dfd = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return trip

    def load(self) -> Trip | None:
        """Restore a saved selection, not a verified live route."""
        try:
            if self.path.is_symlink():
                raise ValueError("Invalid config file")
            with self.path.open("rb") as f:
                raw = f.read(MAX_CONFIG + 1)
        except FileNotFoundError:
            return None
        try:
            if len(raw) > MAX_CONFIG:
                raise ValueError("Oversized configuration")
            p = json.loads(raw)
            if type(p["version"]) is not int or p["version"] != 1:
                raise ValueError("Unknown configuration version")
            d = p["trip"]
            return Trip(Line(**d["line"]), Station(**d["boarding"]),
                        Station(**d["destination"]), d["board_index"],
                        d["destination_index"])
        except (KeyError, TypeError, ValueError, RecursionError):
            raise ValueError("Invalid saved trip; reconfigure locally") from None

    def restore_verified(self, route: Route) -> Trip | None:
        trip = self.load()
        return revalidate(trip, route) if trip is not None else None
