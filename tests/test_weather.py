"""Weather provider contract tests; all network responses are synthetic."""
from datetime import datetime, timezone, timedelta
from tempfile import TemporaryDirectory
import sqlite3
import unittest
from urllib.parse import urlparse, parse_qs

from dashboard.weather import (LIMIT, RequestLedger, QWeather, OpenMeteo,
                               WeatherBudget, WeatherBlocked, WeatherError, coordinates)


class WeatherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = datetime(2026, 1, 15, tzinfo=timezone.utc)
        self.ledger = RequestLedger(self.tmp.name, lambda: self.now)

    def test_reservation_survives_restart(self):
        self.ledger.reserve()
        self.assertEqual(RequestLedger(self.tmp.name, lambda: self.now).usage()["used"], 1)

    def test_limit_rolling_and_new_month(self):
        with sqlite3.connect(self.ledger.path) as db:
            db.execute("INSERT INTO request_days VALUES(?,?)", ("2026-01-15", LIMIT-1))
        self.ledger.reserve()
        with self.assertRaises(WeatherBudget):
            self.ledger.reserve()
        self.now += timedelta(days=18)
        self.assertEqual(self.ledger.usage()["used"], 0)
        with self.assertRaises(WeatherBudget):
            self.ledger.reserve()
        self.now += timedelta(days=15)
        self.ledger.reserve()
        self.assertEqual(self.ledger.usage()["rolling_used"], 1)

    def test_clock_reversal(self):
        self.ledger.reserve()
        self.now -= timedelta(days=1)
        with self.assertRaises(WeatherBudget):
            self.ledger.reserve()

    def test_coordinates(self):
        self.assertEqual(coordinates(1.234, -2.345), ("1.23", "-2.35"))
        for p in ((float("nan"), 2), (91, 0), (0, 181), (True, 2)):
            with self.assertRaises(ValueError):
                coordinates(*p)

    def test_host_and_key_validation(self):
        for host in ("evil.example", "evil.qweatherapi.com.evil.example", "https://sample.qweatherapi.com",
                     "sample.qweatherapi.com/path", "sample.qweatherapi.com:443"):
            with self.assertRaises(ValueError):
                QWeather(host, "placeholder_test_key", self.ledger)

    def test_six_endpoints_and_key_header(self):
        calls = []
        def fake(url, headers):
            calls.append((url, headers))
            path = urlparse(url).path
            if "/current/" in path and "/weather/" in path:
                return {"temperature": {"value": 20, "unit": "°C"}}
            if "/hourly/" in path:
                return {"hours": [{}]}
            if "/daily/" in path:
                return {"days": [{}]}
            if "/minutely/" in path:
                return {"code": "200", "minutely": [{}]}
            if "/airquality/" in path:
                return {"indexes": [{}]}
            return {"metadata": {"zeroResult": True}}
        api = QWeather("example.test.qweatherapi.com", "placeholder_test_key", self.ledger, fake)
        for kind in ("current", "hourly", "daily", "rain", "air", "alerts"):
            result = api.fetch(kind, 1.23, 2.34)
            self.assertIsInstance(result, dict)
        self.assertEqual(result["alerts"], [])
        self.assertEqual(self.ledger.usage()["used"], 6)
        for url, headers in calls:
            self.assertEqual(urlparse(url).scheme, "https")
            self.assertNotIn("placeholder_test_key", url)
            self.assertEqual(headers, {"X-QW-Api-Key": "placeholder_test_key"})
        self.assertEqual(parse_qs(urlparse(calls[3][0]).query)["location"], ["2.34,1.23"])

    def test_failure_count_and_block_persist(self):
        def fail(url, headers):
            raise WeatherBlocked("provider_blocked")
        api = QWeather("example.qweatherapi.com", "placeholder_test_key", self.ledger, fail)
        with self.assertRaises(WeatherBlocked):
            api.fetch("current", 1, 2)
        restored = RequestLedger(self.tmp.name, lambda: self.now)
        self.assertEqual(restored.usage()["used"], 1)
        with self.assertRaises(WeatherBlocked):
            restored.reserve()

    def test_missing_alert_is_not_zero(self):
        api = QWeather("example.qweatherapi.com", "placeholder_test_key", self.ledger,
                       lambda u,h: {"metadata": {}})
        with self.assertRaises(WeatherError):
            api.fetch("alerts", 1, 2)
        self.assertEqual(self.ledger.usage()["used"], 1)

    def test_backup_does_not_send_key(self):
        def fake(url, headers):
            self.assertEqual(urlparse(url).hostname, "api.open-meteo.com")
            self.assertEqual(headers, {})
            return {"current": {}, "hourly": {}, "daily": {}}
        result = OpenMeteo(fake).fetch(1, 2)
        self.assertNotIn("alerts", result)
        self.assertEqual(self.ledger.usage()["used"], 0)
