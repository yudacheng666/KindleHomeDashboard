"""Fictional local pairing tests; no external devices or network."""
from pathlib import Path
from tempfile import TemporaryDirectory
from secrets import token_urlsafe
import unittest
from unittest.mock import patch

from dashboard.devices import Devices, TTL, ATTEMPTS, MAX_DEVICES
from dashboard.http_api import API, LocalServer
from dashboard.household import Household
from dashboard.backup import backup, restore


class DeviceTests(unittest.TestCase):
    def setUp(self):
        self.temp=TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.volume=self.root/"volume"
        self.volume.mkdir()
        self.now=0
        self.devices=Devices(str(self.volume),clock=lambda:self.now)

    def pair(self,label="Fictional device"):
        return self.devices.redeem(self.devices.issue(label)["code"])

    def test_single_use_and_expiry(self):
        code=self.devices.issue("Example")["code"]
        self.now+=TTL
        with self.assertRaises(ValueError):
            self.devices.redeem(code)
        with self.assertRaises(ValueError):
            self.devices.redeem(code)
        code=self.devices.issue("Example")["code"]
        result=self.devices.redeem(code)
        self.assertTrue(self.devices.authorized(result["token"]))
        with self.assertRaises(ValueError):
            self.devices.redeem(code)

    def test_attempt_limit_and_replacement(self):
        with patch("dashboard.devices.randbelow",side_effect=[123456,654321]):
            old=self.devices.issue("Old")["code"]
            code=self.devices.issue("New")["code"]
        for _ in range(ATTEMPTS):
            with self.assertRaises(ValueError):
                self.devices.redeem(old)
        with self.assertRaises(ValueError):
            self.devices.redeem(code)
        self.assertEqual(self.devices.list(),[])

    def test_persistence_revocation_and_digest_only(self):
        a=self.pair("Example A")
        b=self.pair("Example B")
        self.assertNotEqual(a["token"],b["token"])
        self.assertEqual(self.devices.path.stat().st_mode & 0o777,0o600)
        self.assertNotIn(a["token"].encode(),self.devices.path.read_bytes())
        pending=self.devices.issue("Example pending")["code"]
        restarted=Devices(str(self.volume))
        with self.assertRaises(ValueError):
            restarted.redeem(pending)
        self.assertTrue(restarted.authorized(a["token"]))
        self.assertTrue(restarted.authorized(b["token"]))
        self.assertEqual(set(restarted.list()[0]),{"id","label"})
        restarted.revoke(a["id"])
        self.assertFalse(self.devices.authorized(a["token"]))
        self.assertTrue(self.devices.authorized(b["token"]))

    def test_limit_and_read_only(self):
        first=self.pair()
        api=API(None,token_urlsafe(32),token_urlsafe(32),devices=self.devices)
        self.assertTrue(api.authorized("Bearer "+first["token"]))
        self.assertFalse(api.authorized("Bearer "+first["token"],admin=True))
        with self.assertRaises(ValueError):
            LocalServer(api,0)
        for _ in range(MAX_DEVICES-1):
            self.pair()
        with self.assertRaises(ValueError):
            self.devices.issue("Too many")

    def test_backup_excludes_device_authorization(self):
        a=self.pair()
        Household(str(self.volume))
        snap=self.root/"snapshot"
        dest=self.root/"restored"
        backup(str(self.volume),str(snap))
        self.assertFalse((snap/"devices.sqlite3").exists())
        restore(str(snap),str(dest))
        self.assertFalse(Devices(str(dest)).authorized(a["token"]))

if __name__=="__main__":
    unittest.main()
