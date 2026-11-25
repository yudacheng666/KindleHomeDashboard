"""Household HTTP integration with fictional content and a disabled bus."""
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection
import json
from secrets import token_urlsafe
from tempfile import TemporaryDirectory
from threading import Thread
import unittest

from dashboard.household import Household
from dashboard.http_api import API, LocalServer
from dashboard.runtime import Runtime
from dashboard.service import BusService


class HouseholdHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = datetime(2026, 1, 5, 15, 59, tzinfo=timezone.utc)
        self.home = Household(self.temp.name)
        self.bus = BusService(self.temp.name)
        self.runtime = Runtime(self.bus, clock=lambda: self.now)
        self.read_token, self.admin_token = token_urlsafe(32), token_urlsafe(32)
        self.api = API(self.runtime, self.read_token, self.admin_token, household=self.home)
        self.server = LocalServer(self.api, 0)
        self.thread = Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01})
        self.thread.start()
        self.addCleanup(self.finish)
        self.today = "2026-01-05"

    def finish(self):
        self.server.shutdown()
        self.thread.join(timeout=3)
        self.server.server_close()

    def req(self, method, path, token=None, body=None):
        headers = {}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        if body is not None:
            headers["Content-Type"] = "application/json"
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            conn.request(method, "/api/" + path, body=json.dumps(body) if body is not None else None,
                         headers=headers)
            result = conn.getresponse()
            return result.status, json.loads(result.read())
        finally:
            conn.close()

    def post(self, path, body, status=200):
        code, result = self.req("POST", "home/" + path, self.admin_token, body)
        self.assertEqual(code, status)
        return result.get("result")

    def view(self):
        code, result = self.req("GET", "home/view", self.read_token)
        self.assertEqual(code, 200)
        return result

    def manage(self):
        code, result = self.req("GET", "home/manage", self.admin_token)
        self.assertEqual(code, 200)
        return result

    def task(self, repeat="daily"):
        return self.post("task/add", {"title":"Example task","start":self.today,"repeat":repeat})

    def poster(self, key=None):
        return self.post("poster/add", {"title":"Example reminder","body":"Example body",
                         "start":self.today,"end":None,"note":"","task_id":key})

    def test_household_page_assets(self):
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            for path, expected in (("/home", '<script src="/home.js">'), ("/home.js", "XMLHttpRequest"),
                                   ("/display", '<script src="/display.js">'), ("/display.js", "XMLHttpRequest")):
                conn.request("GET", path)
                res = conn.getresponse()
                self.assertEqual(res.status, 200)
                self.assertEqual(res.getheader("Cache-Control"), "no-store")
                body = res.read().decode()
                self.assertIn(expected, body)
                self.assertNotIn(self.admin_token, body)
                self.assertNotIn(self.read_token, body)
        finally:
            conn.close()

    def test_saved_display_preferences(self):
        defaults = {"seconds":180,"include_week":False,"include_shopping":False,"autoplay":False}
        self.assertEqual(self.view()["display_settings"], defaults)
        saved = {"seconds":120,"include_week":True,"include_shopping":True,"autoplay":True}
        self.assertEqual(self.req("POST","home/display/set",self.read_token,saved)[0],401)
        self.post("display/set",saved)
        self.assertEqual(self.manage()["display_settings"],saved)
        self.assertEqual(self.view()["display_settings"],saved)
        self.assertEqual(Household(self.temp.name).view(self.today)["display_settings"],saved)
        for invalid in ({**saved,"seconds":60},{**saved,"seconds":True},{**saved,"autoplay":1}):
            self.post("display/set",invalid,400)
        self.assertEqual(self.view()["display_settings"],saved)

    def test_read_admin_and_disabled(self):
        self.assertEqual(self.req("GET","home/view")[0],401)
        self.assertEqual(self.req("GET","home/manage",self.read_token)[0],401)
        self.assertEqual(self.req("POST","home/task/add",self.read_token,{"title":"Example"})[0],401)
        self.assertEqual(self.view()["tasks"],[])
        self.assertEqual(self.req("GET","bus/view",self.read_token)[1]["snapshot"]["status"],"disabled")
        self.api.household = None
        self.assertEqual(self.req("GET","home/view",self.read_token)[0],404)
        self.assertEqual(self.req("POST","home/task/add",self.admin_token,{})[0],404)

    def test_task_edit_and_history(self):
        key = self.task()
        self.post("task/edit",{"key":key,"title":"Revised","start":self.today,"repeat":"weekly"})
        self.assertEqual(self.view()["tasks"][0]["title"],"Revised")
        self.post("task/complete",{"key":key,"on":self.today,"completed":True})
        self.assertEqual(self.view()["tasks"],[])
        self.assertTrue(self.manage()["tasks"][0]["completed"])
        self.post("task/edit",{"key":key,"title":"Revised again","start":self.today,"repeat":"daily"},400)
        self.post("task/edit",{"key":key,"title":"Revised again","start":self.today,"repeat":"weekly"})
        self.assertTrue(self.manage()["tasks"][0]["completed"])
        self.post("task/complete",{"key":key,"on":self.today,"completed":False})
        self.assertEqual(self.view()["tasks"][0]["title"],"Revised again")

    def test_midnight_rejects_stale_completion(self):
        key = self.task()
        self.now += timedelta(minutes=2)
        self.assertEqual(self.view()["date"],"2026-01-06")
        self.post("task/complete",{"key":key,"on":self.today,"completed":True},400)
        self.assertEqual(len(self.view()["tasks"]),1)
        self.post("task/complete",{"key":key,"on":"2026-01-06","completed":True})
        self.assertEqual(self.view()["tasks"],[])

    def test_linked_poster_edit_and_delete_guard(self):
        key = self.task()
        poster = self.poster(key)
        self.post("task/delete",{"key":key,"confirm":True},400)
        self.post("poster/edit",{"key":poster,"title":"Revised","body":"Standalone","start":self.today,
                                 "end":None,"note":"Example note","task_id":None})
        self.assertEqual(self.view()["posters"][0]["body"],"Standalone")
        self.post("task/delete",{"key":key},400)
        self.post("task/delete",{"key":key,"confirm":True})
        self.assertEqual(len(self.view()["posters"]),1)
        self.post("poster/enable",{"key":poster,"enabled":False})
        self.assertEqual(self.view()["posters"],[])
        self.assertEqual(len(self.manage()["posters"]),1)
        self.post("poster/delete",{"key":poster,"confirm":True})
        self.assertEqual(self.manage()["posters"],[])

    def test_menu_move_api(self):
        other = "2026-01-06"
        self.post("menu/set",{"on":self.today,"meal":"lunch","dishes":["Example dish"],"ingredients":[]})
        body={"old_on":self.today,"old_meal":"lunch","on":other,"meal":"dinner","dishes":["Edited dish"],"ingredients":[]}
        self.assertEqual(self.req("POST","home/menu/edit",self.read_token,body)[0],401)
        self.post("menu/edit",body)
        self.assertEqual(self.view()["today_menu"],[])
        rows=self.post("menu/list",{"first":other,"last":other})
        self.assertEqual(rows,[{"day":other,"meal":"dinner","dishes":["Edited dish"],"ingredients":[]}])

    def test_menu_and_shopping_edits_preserve_purchases(self):
        self.post("menu/set",{"on":self.today,"meal":"lunch","dishes":["Example dish"],"ingredients":["Example ingredient"]})
        self.assertEqual(len(self.post("menu/list",{"first":self.today,"last":self.today})),1)
        self.assertEqual(self.post("shopping/import",{"first":self.today,"last":self.today}),1)
        item = self.view()["shopping"][0]["id"]
        self.post("shopping/complete",{"key":item,"completed":True})
        self.post("shopping/edit",{"key":item,"label":"Revised ingredient"})
        self.post("menu/delete",{"on":self.today,"meal":"lunch","confirm":True})
        self.assertEqual(self.view()["today_menu"],[])
        self.assertEqual(self.view()["shopping"][0]["completed"],1)
        self.assertEqual(self.view()["shopping"][0]["label"],"Revised ingredient")
        self.post("shopping/delete",{"key":item,"confirm":True})
        self.assertEqual(self.view()["shopping"],[])

    def test_invalid_fields_and_confirmation(self):
        key = self.task()
        for body in ({"key":key,"confirm":1},{"key":key,"confirm":False},{"key":key,"confirm":True,"extra":1}):
            self.post("task/delete",body,400)
        self.post("task/edit",{"key":key,"title":"","start":self.today,"repeat":"daily"},400)
        self.assertEqual(len(self.view()["tasks"]),1)


if __name__ == "__main__":
    unittest.main()
