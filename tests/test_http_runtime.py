"""Synthetic HTTP and scheduler integration tests. Loopback only."""
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection
import json
from secrets import token_urlsafe
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import Mock

from dashboard.http_api import API, LocalServer
from dashboard.runtime import Runtime, Window
from dashboard.service import BusService
from dashboard.__main__ import window_arg


class WindowTests(unittest.TestCase):
    def test_weekday_boundary_and_overnight(self):
        w = Window((0,), 23 * 60, 60)
        monday = datetime(2026, 1, 5, 23, 0)
        self.assertTrue(w.contains(monday))
        self.assertTrue(w.contains(monday + timedelta(minutes=119)))
        self.assertFalse(w.contains(monday + timedelta(minutes=120)))
        self.assertFalse(w.contains(monday - timedelta(minutes=1)))

    def test_parser_and_midnight(self):
        self.assertEqual(window_arg("0,1:08:00-24:00"), Window((0, 1), 480, 1440))
        for s in ("0:24:00-01:00", "0:08:60-10:00", "0:08:00-08:00", "7:08:00-10:00"):
            with self.assertRaises(Exception):
                window_arg(s)

    def test_no_poll_outside_window_and_failure_stops(self):
        now = datetime(2026, 1, 5, 0, tzinfo=timezone.utc)
        bus = Mock()
        runtime = Runtime(bus, windows=(Window((0,), 480, 481),), clock=lambda: now)
        runtime.step()
        bus.tick.assert_called_once()
        now += timedelta(minutes=1)
        runtime.step()
        bus.tick.assert_called_once()
        now -= timedelta(minutes=1)
        bus.tick.side_effect = OSError("synthetic failure")
        runtime.step()
        runtime.step()
        self.assertTrue(runtime.failed.is_set())
        self.assertEqual(bus.tick.call_count, 2)

    def test_background_loop_starts_and_closes(self):
        now = datetime(2026, 1, 5, 0, tzinfo=timezone.utc)
        bus = Mock()
        from threading import Event
        called = Event()
        bus.tick.side_effect = called.set
        runtime = Runtime(bus, windows=(Window((0,), 480, 481),), clock=lambda: now)
        runtime.start()
        try:
            self.assertTrue(called.wait(3))
        finally:
            runtime.close()
        self.assertFalse(runtime.thread.is_alive())


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = datetime(2026, 1, 5, 0, tzinfo=timezone.utc)
        self.calls = []
        self.bus = BusService(self.temp.name, enabled=True, clock=lambda: self.now,
                              request=self.provider)
        self.runtime = Runtime(self.bus, windows=(Window((0,), 480, 540),),
                               clock=lambda: self.now)
        self.reader, self.admin = token_urlsafe(32), token_urlsafe(32)
        self.server = LocalServer(API(self.runtime, self.reader, self.admin), port=0)
        self.thread = Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01})
        self.thread.start()
        self.addCleanup(self.finish)

    def finish(self):
        self.server.shutdown()
        self.thread.join(timeout=3)
        self.server.server_close()

    def provider(self, path, body, city):
        self.calls.append(path)
        if path.endswith("querytrafficline"):
            data = {"trafficStop": [{"lineInfo": {"lineId": "example",
                     "lineName": "Example", "startStopName": "A",
                     "endStopName": "C", "upDown": 0}}]}
        elif path.endswith("querybusline"):
            data = {"busLine": {"lineId": "example", "lineName": "Example",
                     "upDown": 0, "stop": [{"stopId": n, "stopName": n, "upDown": 0}
                                           for n in "ABC"]}}
        else:
            data = {"stopArriveInfo": {"currentBusArriveTime": "4",
                                       "nextBusArriveTime": "9"}}
        return {"errCode": 0, "data": data}

    def req(self, method, path, token=None, body=None, extra=None):
        headers = {}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        if body is not None:
            headers["Content-Type"] = "application/json"
        headers.update(extra or {})
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            conn.request(method, path, body=json.dumps(body) if body is not None else None,
                         headers=headers)
            res = conn.getresponse()
            return res.status, json.loads(res.read()), res.getheader("Cache-Control")
        finally:
            conn.close()

    def preview(self):
        status, result, _ = self.req("POST", "/api/bus/search", self.admin, {"keyword": "Example"})
        self.assertEqual(status, 200)
        self.now += timedelta(seconds=2)
        status, result, _ = self.req("POST", "/api/bus/route", self.admin,
                                     {"line": result["lines"][0], "direction": "0"})
        self.assertEqual(status, 200)
        return result["selection"]

    def test_browser_shell_and_script(self):
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            conn.request("GET", "/")
            res = conn.getresponse()
            self.assertEqual(res.status, 200)
            self.assertEqual(res.getheader("Cache-Control"), "no-store")
            self.assertIn("frame-ancestors 'none'", res.getheader("Content-Security-Policy"))
            html = res.read().decode()
            self.assertIn('<script src="/bus.js">', html)
            self.assertNotIn(self.admin, html)
            self.assertNotIn(self.reader, html)
            conn.request("GET", "/bus.js")
            res = conn.getresponse()
            self.assertEqual(res.status, 200)
            self.assertIn("XMLHttpRequest", res.read().decode())
        finally:
            conn.close()
        self.assertEqual(self.calls, [])

    def test_same_origin_browser_post(self):
        origin = "http://127.0.0.1:" + str(self.server.server_port)
        status, data, _ = self.req("POST", "/api/bus/search", self.admin,
                                  {"keyword": "Example"}, {"Origin": origin})
        self.assertEqual(status, 200)
        self.assertEqual(len(data["lines"]), 1)
        self.assertEqual(self.req("POST", "/api/bus/search", self.admin,
                                  {"keyword": "Example"}, {"Origin": "http://example.invalid"})[0], 403)
        self.assertEqual(self.req("GET", "/api/bus/view?token=example")[0], 401)

    def test_auth_and_no_cache(self):
        self.assertEqual(self.req("GET", "/api/bus/view")[0], 401)
        self.assertEqual(self.req("POST", "/api/bus/search", self.reader, {"keyword": "Example"})[0], 401)
        status, data, cache = self.req("GET", "/api/bus/view", self.reader)
        self.assertEqual((status, cache), (200, "no-store"))
        self.assertEqual(data["snapshot"]["status"], "unconfigured")
        self.assertEqual(self.calls, [])

    def test_reject_origin_and_wrong_host(self):
        for extra in ({"Origin": "https://example.invalid"}, {"Host": "example.invalid"}):
            self.assertEqual(self.req("GET", "/api/bus/view", self.reader, extra=extra)[0], 403)

    def test_complete_selection_read_only_cache_and_pause(self):
        handle = self.preview()
        body = {"selection": handle, "boarding": 0, "destination": 2}
        self.assertEqual(self.req("POST", "/api/bus/save", self.admin, body)[0], 200)
        self.assertEqual(self.req("POST", "/api/bus/save", self.admin, body)[0], 400)
        self.now += timedelta(seconds=2)
        self.runtime.step()
        count = len(self.calls)
        for _ in range(3):
            status, data, _ = self.req("GET", "/api/bus/view", self.reader)
            self.assertEqual(status, 200)
            self.assertEqual([v["eta_min"] for v in data["snapshot"]["vehicles"]], [4, 9])
        self.assertEqual(len(self.calls), count)
        self.now += timedelta(hours=1)
        self.runtime.step()
        _, data, _ = self.req("GET", "/api/bus/view", self.reader)
        self.assertEqual(data["snapshot"]["status"], "paused")
        self.assertEqual(data["snapshot"]["vehicles"], [])
        self.assertEqual(len(self.calls), count)

    def test_invalid_or_expired_selection(self):
        handle = self.preview()
        self.assertEqual(self.req("POST", "/api/bus/save", self.admin,
                                  {"selection": "wrong", "boarding": 0, "destination": 2})[0], 400)
        self.assertEqual(self.req("POST", "/api/bus/save", self.admin,
                                  {"selection": handle, "boarding": 2, "destination": 0})[0], 400)
        self.assertIsNone(self.bus.store.load())

    def test_budget_reasons(self):
        self.bus.gate.enabled = False
        self.assertEqual(self.req("POST", "/api/bus/search", self.admin, {"keyword": "A"}), (503, {"error": "bus_disabled"}))
        self.bus.gate.enabled = True
        self.assertEqual(self.req("POST", "/api/bus/search", self.admin, {"keyword": "A"})[0], 200)
        self.assertEqual(self.req("POST", "/api/bus/search", self.admin, {"keyword": "B"}), (429, {"error": "local_request_gap"}))
        self.bus.gate.daily_limit = 1
        self.assertEqual(self.req("POST", "/api/bus/search", self.admin, {"keyword": "B"}), (429, {"error": "local_daily_limit"}))
        self.assertEqual(len(self.calls), 1)

    def test_local_budget_and_malformed_body(self):
        self.assertEqual(self.req("POST", "/api/bus/search", self.admin, {"keyword": "A"})[0], 200)
        self.assertEqual(self.req("POST", "/api/bus/search", self.admin, {"keyword": "B"})[0], 429)
        self.assertEqual(self.req("POST", "/api/bus/search", self.admin, ["A"])[0], 400)
        self.assertEqual(self.req("POST", "/api/bus/search", self.admin, {"keyword": "A"*17000})[0], 413)


if __name__ == "__main__":
    unittest.main()
