"""Offline shared service tests, no real network or private routes."""
from datetime import datetime, timedelta, timezone
from tempfile import TemporaryDirectory
import unittest

from dashboard.budget import BudgetWait, RequestGate
from dashboard.bus import AccessBlocked, BusError
from dashboard.service import BusService
from dashboard.trip_store import TripStore


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.calls = []
        self.fail = None
        self.names = "ABCD"

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)

    def request(self, path, body, city):
        self.calls.append((path, body))
        if self.fail:
            raise self.fail
        if path.endswith("querytrafficline"):
            data = {"trafficStop": [{"lineInfo": {
                "lineId": "example", "lineName": "Example line",
                "startStopName": "A", "endStopName": "D", "upDown": 0}}]}
        elif path.endswith("querybusline"):
            data = {"busLine": {
                "lineId": "example", "lineName": "Example line", "upDown": 0,
                "stop": [{"stopId": n, "stopName": n, "upDown": 0} for n in self.names]}}
        else:
            eta = "3" if body["stopId"] == "A" else "8"
            data = {"stopArriveInfo": {"currentBusArriveTime": eta}}
        return {"errCode": 0, "data": data}

    def service(self, enabled=True, daily_limit=1000):
        return BusService(self.temp.name, enabled=enabled, clock=lambda: self.now,
                          request=self.request, daily_limit=daily_limit)

    def configure(self, s):
        line = s.search_lines("Example")[0]
        self.advance(2)
        route = s.get_route(line)
        s.save_trip(route, 0, 3)
        self.advance(2)
        return route

    def test_disabled_and_unconfigured(self):
        s = self.service(False)
        self.assertEqual(s.tick().snapshot.status, "disabled")
        with self.assertRaises(BudgetWait):
            s.search_lines("Example")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.service().tick().snapshot.status, "unconfigured")

    def test_shared_reads_and_cached_discovery(self):
        s = self.service()
        route = self.configure(s)
        self.assertEqual(s.get_route(route.line), route)
        s.tick()
        count = len(self.calls)
        for _ in range(20):
            self.assertEqual(s.read().snapshot.vehicles[0].eta_min, 3)
            s.tick()
            s.search_lines("Example")
        self.assertEqual(len(self.calls), count)

    def test_switch_clears_old_eta_and_respects_gap(self):
        s = self.service()
        route = self.configure(s)
        self.assertEqual(s.tick().snapshot.vehicles[0].eta_min, 3)
        count = len(self.calls)
        view = s.save_trip(route, 1, 3)
        self.assertEqual(view.trip.boarding.name, "B")
        self.assertEqual(view.snapshot.vehicles, ())
        self.assertEqual(view.snapshot.status, "unavailable")
        s.tick()
        self.assertEqual(len(self.calls), count)
        self.advance(60)
        view = s.tick()
        self.assertEqual(view.snapshot.vehicles[0].eta_min, 8)

    def test_restart_verifies_before_eta(self):
        s = self.service()
        self.configure(s)
        s.tick()
        self.advance(2)
        restored = self.service()
        self.assertEqual(restored.read().snapshot.status, "unverified")
        count = len(self.calls)
        restored.tick()
        self.assertEqual(len(self.calls), count + 1)
        self.assertTrue(self.calls[-1][0].endswith("querybusline"))
        self.assertEqual(restored.read().snapshot.vehicles, ())
        self.advance(30)
        self.assertEqual(restored.tick().snapshot.vehicles[0].eta_min, 3)

    def test_changed_route_needs_selection(self):
        s = self.service()
        self.configure(s)
        self.names = "XBCD"
        restored = self.service()
        self.assertEqual(restored.tick().snapshot.status, "needs_selection")
        count = len(self.calls)
        self.advance(120)
        self.assertEqual(restored.tick().snapshot.vehicles, ())
        self.assertEqual(len(self.calls), count)

    def test_search_and_eta_share_block_across_restart(self):
        s = self.service()
        self.configure(s)
        self.fail = AccessBlocked("test")
        self.assertEqual(s.tick().snapshot.status, "blocked")
        self.advance(3600)
        restored = self.service()
        count = len(self.calls)
        self.assertEqual(restored.tick().snapshot.status, "blocked")
        with self.assertRaises(AccessBlocked):
            restored.search_lines("Example")
        self.assertEqual(len(self.calls), count)

    def test_reverse_uses_returned_opposite_id(self):
        s = self.service()
        def provider(path, body, city):
            self.calls.append((path, body))
            if path.endswith("querytrafficline"):
                return {"errCode":0,"data":{"trafficStop":[
                    {"lineInfo":{"lineId":"out","lineName":"Example","upDown":0,"startStopName":"A","endStopName":"D"}},
                    {"lineInfo":{"lineId":"back","lineName":"Example","upDown":1,"startStopName":"D","endStopName":"A"}}]}}
            self.assertEqual(body["lineId"],"back")
            self.assertEqual(body["direction"],"1")
            return {"errCode":0,"data":{"busLine":{"lineId":"back","lineName":"Example","upDown":1,
                "stop":[{"stopId":n,"stopName":n,"upDown":1} for n in "DXA"]}}}
        s.gate.request=provider
        lines=s.search_lines("Example")
        self.advance(2)
        route=s.get_route(lines[0],"1")
        self.assertEqual(route.line.line_id,"back")
        self.assertEqual(route.line.direction,"1")
        self.assertEqual([stop.name for stop in route.stops],list("DXA"))
        s.save_trip(route,0,2)
        self.assertEqual(s.trip.line.direction,"1")
        self.assertEqual(len(self.calls),2)

    def test_search_result_expires(self):
        s = self.service()
        line = s.search_lines("Example")[0]
        self.advance(60)
        with self.assertRaises(ValueError):
            s.get_route(line)
        self.assertEqual(len(self.calls), 1)

    def test_expired_route_cannot_be_saved(self):
        s = self.service()
        route = self.configure(s)
        self.advance(600)
        with self.assertRaises(ValueError):
            s.save_trip(route, 1, 3)
        self.assertEqual(s.read().trip.boarding.name, "A")

    def test_daily_limit_and_restart(self):
        s = self.service(daily_limit=1)
        s.search_lines("Example")
        self.advance(2)
        restored = self.service(daily_limit=1)
        with self.assertRaises(BudgetWait):
            restored.search_lines("Other")
        self.assertEqual(len(self.calls), 1)
        self.advance(86400)
        restored.search_lines("Other")
        self.assertEqual(len(self.calls), 2)

    def test_failed_request_counts(self):
        s = self.service(daily_limit=1)
        self.fail = BusError("test")
        with self.assertRaises(BusError):
            s.search_lines("Example")
        self.advance(60)
        self.fail = None
        with self.assertRaises(BudgetWait):
            self.service(daily_limit=1).search_lines("Example")
        self.assertEqual(len(self.calls), 1)

    def test_gap_across_restart(self):
        s = self.service()
        s.search_lines("Example")
        with self.assertRaises(BudgetWait):
            self.service().search_lines("Example")
        self.assertEqual(len(self.calls), 1)

    def test_eta_gap_cannot_be_bypassed_by_new_service(self):
        s = self.service()
        self.configure(s)
        s.tick()
        self.advance(3)
        gate = self.service().gate
        count = len(self.calls)
        with self.assertRaises(BudgetWait):
            gate("/traffic/v1/getbusstoparrivedetails", {"stopId": "B"}, "310100")
        self.assertEqual(len(self.calls), count)
        self.advance(27)
        gate("/traffic/v1/getbusstoparrivedetails", {"stopId": "B"}, "310100")
        self.assertEqual(len(self.calls), count + 1)

    def test_budget_file_private(self):
        s = self.service()
        self.assertEqual(s.gate.path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
