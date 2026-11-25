"""Private backup verification using only temporary, fictional data."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from dashboard.backup import backup, restore, offline, MANIFEST
from dashboard.budget import RequestGate
from dashboard.household import Household
from dashboard.routes import Line, Route, Station
from dashboard.trip_store import TripStore, SOURCE


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "active"
        self.source.mkdir(mode=0o700)
        self.snapshot = self.root / "snapshot"
        self.restored = self.root / "restored"
        self.store = TripStore(str(self.source))
        route = Route(Line("example", "Example line", "0", "A", "C"),
                      tuple(Station(str(i), n) for i,n in enumerate("ABC")))
        self.trip = self.store.save(route, 0, 2)
        self.gate = RequestGate(self.store)
        with self.gate._db() as db:
            db.execute("UPDATE budget SET day='2026-01-05',used=42 WHERE id=1")
        self.home = Household(str(self.source))
        self.day = "2026-01-05"
        task = self.home.add_task("Example task", self.day)
        self.home.add_poster("Example poster", None, self.day, task_id=task)
        self.home.set_menu(self.day,"dinner",["Example dish"],["Example ingredient"])
        self.home.import_ingredients(self.day,self.day)
        self.home.set_display_settings(120,True,True,True)

    def save(self):
        backup(str(self.source),str(self.snapshot))

    def test_roundtrip_and_permissions(self):
        expected = self.home.view(self.day)
        self.save()
        restore(str(self.snapshot),str(self.restored))
        self.assertEqual(TripStore(str(self.restored)).load(),self.trip)
        self.assertEqual(Household(str(self.restored)).view(self.day),expected)
        restored_gate = RequestGate(TripStore(str(self.restored)))
        self.assertTrue(restored_gate.blocked)
        self.assertFalse(self.gate.blocked)
        with restored_gate._db() as db:
            self.assertEqual(db.execute("SELECT used FROM budget WHERE id=1").fetchone()[0],42)
        for directory in (self.snapshot,self.restored):
            self.assertEqual(directory.stat().st_mode & 0o777,0o700)
            for path in directory.iterdir():
                self.assertEqual(path.stat().st_mode & 0o777,0o600)

    def test_no_overwrite_or_nested_directory(self):
        self.save()
        with self.assertRaises(ValueError):
            self.save()
        with self.assertRaises(ValueError):
            restore(str(self.snapshot),str(self.source))
        with self.assertRaises(ValueError):
            backup(str(self.source),str(self.source/"nested"))
        self.assertEqual(self.store.load(),self.trip)

    def test_active_service_lock(self):
        with offline(self.source):
            with self.assertRaises(BlockingIOError):
                self.save()
        self.assertFalse(self.snapshot.exists())

    def test_corrupt_snapshot_rejected(self):
        self.save()
        path = self.snapshot/"household.sqlite3"
        with path.open("ab") as f:
            f.write(b"corrupt")
        with self.assertRaises(ValueError):
            restore(str(self.snapshot),str(self.restored))
        self.assertFalse(self.restored.exists())
        self.assertEqual(self.store.load(),self.trip)

    def test_unexpected_manifest_path_and_extra_file(self):
        self.save()
        (self.snapshot/"unexpected").write_text("fictional")
        with self.assertRaises(ValueError):
            restore(str(self.snapshot),str(self.restored))
        (self.snapshot/"unexpected").unlink()
        manifest = self.snapshot/MANIFEST
        data = json.loads(manifest.read_text())
        data["files"]["../outside"] = "0"*64
        manifest.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            restore(str(self.snapshot),str(self.restored))
        self.assertFalse(self.restored.exists())

    def test_source_symlink_rejected(self):
        self.store.path.unlink()
        self.store.path.symlink_to(self.source/"household.sqlite3")
        with self.assertRaises(OSError):
            self.save()
        self.assertFalse(self.snapshot.exists())

    def test_empty_and_public_destination_rejected(self):
        empty = self.root/"empty"
        empty.mkdir()
        with self.assertRaises(ValueError):
            backup(str(empty),str(self.snapshot))
        self.assertFalse(self.snapshot.exists())
        with self.assertRaises(ValueError):
            backup(str(self.source),str(SOURCE/"example-snapshot"))

    def test_household_only_backup_stays_blocked(self):
        self.store.path.unlink()
        self.gate.path.unlink()
        self.save()
        restore(str(self.snapshot),str(self.restored))
        self.assertIsNone(TripStore(str(self.restored)).load())
        self.assertTrue(RequestGate(TripStore(str(self.restored))).blocked)
        self.assertEqual(Household(str(self.restored)).view(self.day),self.home.view(self.day))


if __name__=="__main__":
    unittest.main()
