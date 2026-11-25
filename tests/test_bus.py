"""Synthetic unit tests; never use network or household configuration."""
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, MagicMock
from urllib.error import HTTPError

from dashboard.bus import AccessBlocked, BusError, Poller, Stop, fetch, parse

T = datetime(2026, 1, 1, tzinfo=timezone.utc)
STOP = Stop("Example line", "Example stop", "test-id", "0")
ARRIVALS = {
    "currentBusArriveTime": "3", "currentBusDistance": "600",
    "currentBusStopCount": "1", "currentLicensePlate": "fake-one",
    "nextBusArriveTime": "11", "nextBusDistance": "2400",
    "nextBusStopCount": "5", "nextLicensePlate": "fake-two",
}


def payload(arrivals=None, schedule=()):
    return {"errCode": 0, "data": {
        "stopArriveInfo": dict(ARRIVALS if arrivals is None else arrivals),
        "dispatchCarSchedule": {"dispatchCars": list(schedule)},
    }}


class ParserTests(unittest.TestCase):
    def test_two_vehicles(self):
        snap = parse(payload(), T)
        self.assertEqual(snap.status, "live")
        self.assertEqual([v.eta_min for v in snap.vehicles], [3, 11])
        self.assertEqual(snap.vehicles[0].distance_m, 600)
        self.assertEqual(snap.vehicles[1].stops_remaining, 5)
        self.assertNotIn("fake-one", repr(snap))

    def test_missing_second(self):
        snap = parse(payload({"currentBusArriveTime": "4"}), T)
        self.assertEqual(len(snap.vehicles), 1)
        self.assertIsNone(snap.vehicles[0].distance_m)

    def test_schedule_is_not_live(self):
        snap = parse(payload({"currentBusStopCount": 0}, [{"dispatchTime": "08:00"}]), T)
        self.assertEqual(snap.status, "no_live_data")
        self.assertEqual(snap.vehicles, ())
        self.assertEqual(snap.scheduled_departures, 1)

    def test_zero_eta_needs_evidence(self):
        self.assertEqual(parse(payload({"currentBusArriveTime": 0}), T).vehicles, ())
        snap = parse(payload({"currentBusArriveTime": 0, "currentBusDistance": 0}), T)
        self.assertEqual(snap.vehicles[0].eta_min, 0)

    def test_bad_numbers(self):
        for v in (None, "", "-1", True, "NaN", "unknown", "1.2", 9999999999):
            with self.subTest(v=v):
                self.assertEqual(parse(payload({"currentBusArriveTime": v}), T).vehicles, ())

    def test_duplicate_vehicle(self):
        a = dict(ARRIVALS, nextLicensePlate=ARRIVALS["currentLicensePlate"])
        self.assertEqual(len(parse(payload(a), T).vehicles), 1)

    def test_error_envelopes(self):
        for p in (None, {}, {"errCode": False}, {"errCode": 9},
                  {"errCode": 0, "data": {}}, {"errCode": 0, "data": []}):
            with self.subTest(p=p), self.assertRaises(BusError):
                parse(p, T)
        with self.assertRaises(AccessBlocked):
            parse({"errCode": -2903051}, T)

    def test_invalid_stop(self):
        with self.assertRaises(ValueError):
            Stop("a", "b", "c", "2")


class TransportTests(unittest.TestCase):
    @patch("dashboard.bus.build_opener")
    def test_transport_request(self, opener):
        response = MagicMock()
        opener.return_value.open.return_value.__enter__.return_value = response
        response.read.return_value = json.dumps(payload()).encode()
        snap = fetch(STOP)
        request = opener.return_value.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.shmaas.net/traffic/v1/getbusstoparrivedetails")
        self.assertEqual(request.method, "POST")
        self.assertEqual(json.loads(request.data)["stopId"], "test-id")
        self.assertEqual(len(snap.vehicles), 2)

    @patch("dashboard.bus.build_opener")
    def test_http_access_denied(self, opener):
        opener.return_value.open.side_effect = HTTPError("https://example.invalid", 429, "limit", {}, None)
        with self.assertRaises(AccessBlocked):
            fetch(STOP)

    @patch("dashboard.bus.build_opener")
    def test_bad_json(self, opener):
        opener.return_value.open.return_value.__enter__.return_value.read.return_value = b"not json"
        with self.assertRaises(BusError):
            fetch(STOP)


class PollerTests(unittest.TestCase):
    def setUp(self):
        self.now = T
        self.calls = 0
        self.answer = payload()
        self.failure = None

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)

    def loader(self, stop):
        self.calls += 1
        if self.failure:
            raise self.failure
        return parse(self.answer, self.now)

    def new(self, **kwargs):
        return Poller(STOP, loader=self.loader, clock=lambda: self.now, **kwargs)

    def test_disabled_default(self):
        p = self.new()
        self.assertEqual(p.poll().status, "disabled")
        self.assertEqual(self.calls, 0)

    def test_rate_limit(self):
        p = self.new(enabled=True)
        self.assertEqual(p.poll().status, "live")
        self.advance(29)
        p.poll()
        self.assertEqual(self.calls, 1)
        self.advance(1)
        p.poll()
        self.assertEqual(self.calls, 2)

    def test_stale_and_expired(self):
        p = self.new(enabled=True)
        p.poll()
        self.advance(30)
        self.answer = payload({})
        stale = p.poll()
        self.assertEqual(stale.status, "stale")
        self.assertEqual(stale.fetched_at, T)
        self.advance(60)
        self.assertEqual(p.current().status, "expired")
        self.assertEqual(p.current().vehicles, ())
        self.answer = payload()
        self.assertEqual(p.poll().status, "live")

    def test_fresh_empty_after_expiry(self):
        p = self.new(enabled=True)
        p.poll()
        self.advance(90)
        self.answer = payload({}, [{"dispatchTime": "08:00"}])
        snap = p.poll()
        self.assertEqual(snap.status, "no_live_data")
        self.assertEqual(snap.vehicles, ())
        self.assertEqual(snap.scheduled_departures, 1)
        self.assertEqual(snap.fetched_at, self.now)

    def test_failure_backoff(self):
        p = self.new(enabled=True)
        p.poll()
        self.advance(30)
        self.failure = BusError("test")
        self.assertEqual(p.poll().status, "stale")
        self.advance(30)
        p.poll()
        self.assertEqual(self.calls, 2)
        self.advance(30)
        self.failure = None
        self.assertEqual(p.poll().status, "live")

    def test_access_block_stops_requests(self):
        p = self.new(enabled=True)
        self.failure = AccessBlocked("test")
        self.assertEqual(p.poll().status, "blocked")
        self.advance(86400)
        self.assertEqual(p.poll().status, "blocked")
        self.assertEqual(self.calls, 1)


if __name__ == "__main__":
    unittest.main()
