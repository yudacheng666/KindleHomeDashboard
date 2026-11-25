"""Trusted-home mode tests. All addresses and data are fictional."""
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock
from dashboard.bus import Snapshot
from dashboard.service import BusView
from http.client import HTTPConnection
from secrets import token_urlsafe
from tempfile import TemporaryDirectory
from threading import Thread
import unittest

from dashboard.http_api import API, LocalServer
from dashboard.household import Household
from dashboard.runtime import Runtime, Window
from dashboard.service import BusService


class DirectTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Runtime(BusService(self.temp.name))
        self.home = Household(self.temp.name)

    def start(self, api, **kwargs):
        server = LocalServer(api, 0, **kwargs)
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        def stop():
            server.shutdown()
            thread.join(timeout=3)
            server.server_close()
        self.addCleanup(stop)
        return server

    def request(self, server, path, body=None, extra=None):
        conn = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        headers = {"Host": server.expected_host}
        headers.update(extra or {})
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            conn.request("GET" if body is None else "POST", path, headers=headers,
                         body=None if body is None else json.dumps(body))
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def test_direct_read_write_without_credentials(self):
        server = self.start(API(self.runtime, None, None, household=self.home, direct=True))
        status, body = self.request(server, "/api/home/view")
        self.assertEqual(status, 200)
        date = json.loads(body)["date"]
        self.assertEqual(self.request(server, "/api/home/task/add",
                         {"title":"Fictional task","start":date,"repeat":"once"})[0],200)
        self.assertEqual(len(json.loads(self.request(server,"/api/home/view")[1])["tasks"]),1)
        self.assertEqual(self.request(server,"/api/bus/view")[0],200)
        self.assertEqual(self.request(server,"/api/devices/list")[0],404)
        self.assertIn(b'"openAdmin": true',self.request(server,"/access-mode.js")[1])

    def test_auto_uses_server_clock_and_never_collects(self):
        now = datetime(2026, 1, 5, 0, 59, tzinfo=timezone.utc)
        bus = Mock()
        bus.read.return_value = BusView({"fictional":True}, Snapshot("live",now))
        runtime = Runtime(bus, windows=(Window((0,), 540, 600),),
                          clock=lambda:now)
        server = self.start(API(runtime,None,None,household=self.home,direct=True))
        def auto():
            status,body = self.request(server,"/api/display/auto")
            self.assertEqual(status,200)
            return json.loads(body)
        self.assertEqual(auto()["mode"],"family")
        bus.read.assert_not_called()
        now += timedelta(minutes=1)
        self.assertEqual(auto()["mode"],"bus")
        bus.read.return_value = BusView({"fictional":True},Snapshot("blocked",now))
        self.assertEqual(auto()["view"]["snapshot"]["status"],"blocked")
        bus.read.return_value = BusView(None,Snapshot("unconfigured",now))
        self.assertEqual(auto()["mode"],"family")
        bus.read.return_value = BusView({"fictional":True},Snapshot("disabled",now))
        self.assertEqual(auto()["mode"],"family")
        now += timedelta(hours=1)
        self.assertEqual(auto()["mode"],"family")
        bus.tick.assert_not_called()
        self.assertEqual(self.request(server,"/auto")[0],200)

    def test_auto_without_household(self):
        server = self.start(API(self.runtime,None,None,direct=True))
        status,body = self.request(server,"/api/display/auto")
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body)["mode"],"bus")

    def test_auto_requires_read_access_in_protected_mode(self):
        reader,admin=token_urlsafe(32),token_urlsafe(32)
        server=self.start(API(self.runtime,reader,admin,household=self.home))
        self.assertEqual(self.request(server,"/api/display/auto")[0],401)
        self.assertEqual(self.request(server,"/api/display/auto",
                         extra={"Authorization":"Bearer "+reader})[0],200)

    def test_optional_admin(self):
        token = token_urlsafe(32)
        server = self.start(API(self.runtime, None, token, household=self.home, direct=True))
        self.assertEqual(self.request(server,"/api/home/view")[0],200)
        self.assertEqual(self.request(server,"/api/home/manage")[0],401)
        self.assertEqual(self.request(server,"/api/access/admin")[0],401)
        self.assertEqual(self.request(server,"/api/access/admin",
                         extra={"Authorization":"Bearer "+token})[0],200)
        self.assertIn(b'"openAdmin": false',self.request(server,"/access-mode.js")[1])

    def test_wrong_host_and_origin(self):
        server = self.start(API(self.runtime, None, None, household=self.home, direct=True))
        for headers in ({"Host":"example.invalid"},{"Origin":"http://example.invalid"}):
            self.assertEqual(self.request(server,"/api/home/view",extra=headers)[0],403)
            self.assertEqual(self.request(server,"/api/home/task/add",{},headers)[0],403)

    def test_lan_boundary(self):
        api = API(self.runtime,None,None,household=self.home,direct=True)
        server = self.start(api,lan_host="192.168.99.20",lan_network="192.168.99.0/24")
        self.assertTrue(server.allowed_peer("192.168.99.21"))
        for peer in ("127.0.0.1","192.168.98.21","203.0.113.21"):
            self.assertFalse(server.allowed_peer(peer))
        self.assertEqual(self.request(server,"/api/home/view")[0],403)
        self.assertEqual(self.request(server,"/api/home/view",
                         extra={"X-Forwarded-For":"192.168.99.21"})[0],403)

    def test_invalid_network_and_plaintext_password(self):
        api = API(self.runtime,None,None,direct=True)
        for host,network in (("0.0.0.0","0.0.0.0/0"),
                             ("203.0.113.20","203.0.113.0/24"),
                             ("192.168.99.20","192.168.98.0/24"),
                             ("192.168.99.0","192.168.99.0/24")):
            with self.assertRaises(ValueError):
                LocalServer(api,0,lan_host=host,lan_network=network)
        with self.assertRaises(ValueError):
            LocalServer(API(self.runtime,None,token_urlsafe(32),direct=True),0,
                        lan_host="192.168.99.20",lan_network="192.168.99.0/24")


if __name__ == "__main__":
    unittest.main()
