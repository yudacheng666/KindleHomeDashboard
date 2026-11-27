"""Offline driving contract tests; no live locations, network or credentials."""
from datetime import datetime, timezone, timedelta
from dataclasses import replace
from tempfile import TemporaryDirectory
import sqlite3
import unittest
from urllib.parse import urlparse,parse_qs

from dashboard.driving import (Amap,DrivingLedger,DrivingError,DrivingBlocked,normalize_routes,map_parameters)
from dashboard.driving_service import DrivingService,config,DEFAULT


def reply(*durations):
    return {"status":"1","infocode":"10000","route":{"paths":[
        {"distance":"1000","cost":{"duration":str(d)},
         "steps":[{"polyline":"1,2;1.%d,2.5;2,3"%(i+1),
                   "tmcs":[{"tmc_status":"拥堵","tmc_distance":"200"},
                           {"tmc_status":"畅通","tmc_distance":"400"}]}]}
        for i,d in enumerate(durations)]}}


class DrivingTests(unittest.TestCase):
    def setUp(self):
        self.tmp=TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now=datetime(2026,1,15,tzinfo=timezone.utc)
        self.ledger=DrivingLedger(self.tmp.name,lambda:self.now)

    def test_rank_limit_and_unknown(self):
        routes=normalize_routes(reply(400,100,300,200))
        self.assertEqual([r.seconds for r in routes],[100,200,300])
        self.assertEqual(routes[0].view()["congested_meters"],200)
        self.assertEqual(routes[0].view()["traffic_covered_meters"],600)
        self.assertNotIn("points",routes[0].view())
        data=reply(100)
        data["route"]["paths"][0]["steps"][0]["tmcs"]=[]
        self.assertIsNone(normalize_routes(data)[0].congested_meters)

    def test_duplicate_and_missing_geometry(self):
        data=reply(100,200)
        data["route"]["paths"][1]["steps"]=data["route"]["paths"][0]["steps"]
        self.assertEqual(len(normalize_routes(data)),1)
        data["route"]["paths"][0]["steps"]=[]
        data["route"]["paths"][1]["steps"]=[]
        routes=normalize_routes(data)
        with self.assertRaises(DrivingError):
            map_parameters("1,2","2,3",routes)

    def test_map_parameters_match_rank(self):
        routes=normalize_routes(reply(200,100,300))
        params=map_parameters("1,2","2,3",routes)
        self.assertEqual(len(params["paths"].split("|")),3)
        self.assertTrue(params["paths"].split("|")[-1].startswith("7,0x000000"))
        self.assertIn("1,0,1,16,0xFFFFFF,0x000000:",params["labels"])
        self.assertNotIn("location",params)

    def test_map_partial_geometry_and_long_route(self):
        calls=[]
        api=Amap("placeholder_test_credential",self.ledger,
                 image_transport=lambda url:(calls.append(url) or ("image/png",b"synthetic")),
                 sleep=lambda _:None)
        routes=normalize_routes(reply(100,200,300))
        missing=replace(routes[1],points=())
        mime,raw,indices=api.map("1,2","2,3",(routes[0],missing,routes[2]))
        self.assertEqual(indices,(1,3))
        params=parse_qs(urlparse(calls[-1]).query)
        self.assertEqual(len(params["paths"][0].split("|")),2)
        self.assertIn("3,0,1,16",params["labels"][0])
        dense=tuple(f"{1+i/1000000:.6f},2.000000" for i in range(5000))
        long=replace(routes[0],points=dense)
        mime,raw,indices=api.map("1,2","2,3",(long,routes[1],routes[2]))
        self.assertEqual(indices,(1,2,3))
        self.assertLess(len(calls[-1]),7500)
        self.assertIn("1,2;1.004999,2",parse_qs(urlparse(calls[-1]).query)["paths"][0])
        self.assertEqual(self.ledger.usage()["lbs"]["used"],2)

    def test_map_length_rejection_retries_once(self):
        calls=[]
        def image(url):
            calls.append(url)
            if len(calls)==1:
                raise DrivingError("map_url_too_long")
            return "image/png",b"synthetic"
        api=Amap("placeholder_test_credential",self.ledger,image_transport=image,sleep=lambda _:None)
        routes=normalize_routes(reply(100,200,300))
        self.assertEqual(api.map("1,2","2,3",routes)[2],(1,))
        self.assertEqual(self.ledger.usage()["lbs"]["used"],2)

    def test_map_failure_preserves_eta_and_isolates_group(self):
        from urllib.parse import parse_qs
        def image(url):
            if "3.000000,3.000000" in parse_qs(urlparse(url).query)["markers"][0]:
                raise DrivingError("map_http_error")
            return "image/png",b"synthetic"
        service=DrivingService(self.tmp.name,{"KHD_AMAP_KEY":"placeholder_test_credential"},
            clock=lambda:self.now,transport=lambda u,h:reply(100,200,300),image_transport=image)
        groups=[{"name":"Example"+str(i),"origin":"1,2","destination":str(i+2)+",3",
                 "enabled":True,"windows":[{"days":list(range(7)),"start":0,"end":1440}]} for i in range(3)]
        service.configure({**DEFAULT,"groups":groups,"enabled":True,"consent":True,"map_permission":True})
        for _ in groups: service.step()
        rows=service.read()["groups"]
        self.assertTrue(rows[0]["image"])
        self.assertIsNone(rows[1]["image"])
        self.assertEqual(rows[1]["map_error"],"map_http_error")
        self.assertEqual(len(rows[1]["routes"]),3)
        self.assertTrue(rows[2]["image"])
        self.assertEqual(rows[2]["map_routes"],[1,2,3])

    def test_reverse_only_selected_group_and_keep_saved_endpoints(self):
        calls=[]
        mono=[10]
        def transport(url,headers):
            calls.append(parse_qs(urlparse(url).query))
            return reply(600,3900,7200)
        service=DrivingService(self.tmp.name,{"KHD_AMAP_KEY":"placeholder_test_credential"},
            clock=lambda:self.now,monotonic=lambda:mono[0],transport=transport,
            image_transport=lambda u:("image/png",b"synthetic"))
        groups=[{"name":"Example"+str(i),"origin":"1,2","destination":str(i+2)+",3",
                 "enabled":True,"windows":[{"days":list(range(7)),"start":0,"end":1440}]} for i in range(3)]
        settings={**DEFAULT,"groups":groups,"enabled":True,"consent":True,"map_permission":True}
        service.configure(settings)
        for _ in groups: service.step()
        before=service.read()["groups"]
        saved=service.settings_view()["groups"]
        body={"group":1,"revision":before[1]["direction_revision"]}
        self.assertEqual(service.reverse(body)["status"],"ok")
        rows=service.read()["groups"]
        self.assertEqual(rows[0],before[0])
        self.assertEqual(rows[2],before[2])
        self.assertTrue(rows[1]["reversed"])
        self.assertFalse(rows[1]["routes"])
        self.assertIsNone(rows[1]["image"])
        self.assertEqual(service.reverse(body)["status"],"stale")
        current={"group":1,"revision":rows[1]["direction_revision"]}
        self.assertEqual(service.reverse(current)["status"],"wait")
        service.step()
        self.assertEqual(calls[-1]["origin"],["3.000000,3.000000"])
        self.assertEqual(calls[-1]["destination"],["1.000000,2.000000"])
        self.assertEqual(service.read()["groups"][1]["routes"][1]["seconds"],3900)
        self.assertEqual(service.settings_view()["groups"],saved)
        mono[0]+=15
        self.assertEqual(service.reverse(current)["status"],"ok")
        service.step()
        self.assertEqual(calls[-1]["origin"],["1.000000,2.000000"])
        self.assertEqual(calls[-1]["destination"],["3.000000,3.000000"])
        self.assertFalse(service.read()["groups"][1]["reversed"])
        self.assertEqual(service.ledger.usage()["lbs"]["used"],10)
        service.configure({**settings,"enabled":False})
        row=service.read()["groups"][1]
        self.assertEqual(service.reverse({"group":1,"revision":row["direction_revision"]})["status"],"paused")
        self.assertFalse(row["can_switch"])

    def test_reverse_discards_inflight_forward_result(self):
        mono=[10]
        service=DrivingService(self.tmp.name,{"KHD_AMAP_KEY":"placeholder_test_credential"},
            clock=lambda:self.now,monotonic=lambda:mono[0],transport=lambda u,h:reply(600),
            image_transport=lambda u:("image/png",b"synthetic"))
        group={"name":"Example","origin":"1,2","destination":"2,3","enabled":True,
               "windows":[{"days":list(range(7)),"start":0,"end":1440}]}
        service.configure({**DEFAULT,"groups":[group],"enabled":True,"consent":True,"map_permission":True})
        original=service.provider.routes
        def swap_during_route(origin,destination):
            row=service.read()["groups"][0]
            self.assertEqual(service.reverse({"group":0,"revision":row["direction_revision"]})["status"],"ok")
            return original(origin,destination)
        service.provider.routes=swap_during_route
        service.step()
        self.assertTrue(service.read()["groups"][0]["reversed"])
        self.assertEqual(service.read()["groups"][0]["routes"],[])
        self.assertEqual(service.ledger.usage()["lbs"]["used"],1)
        service.provider.routes=original
        service.step()
        self.assertTrue(service.read()["groups"][0]["image"])

    def test_account_caps_persist(self):
        with sqlite3.connect(self.ledger.path) as db:
            db.execute("INSERT INTO request_days VALUES(?,?,?)",("2026-01-15","lbs",29999))
        self.ledger.reserve("lbs")
        self.now+=timedelta(days=18)
        restored=DrivingLedger(self.tmp.name,lambda:self.now)
        with self.assertRaises(DrivingError):
            restored.reserve("lbs")
        restored.reserve("search")
        self.assertEqual(restored.usage()["search"]["used"],1)
        self.now+=timedelta(days=15)
        restored.reserve("lbs")
        self.assertEqual(restored.usage()["lbs"]["used"],1)

    def test_provider_requests_and_block(self):
        calls=[]
        def fake(url,headers):
            calls.append(url)
            if urlparse(url).path.endswith("/text"):
                return {"status":"0","infocode":"10012"}
            return reply(100,200)
        api=Amap("placeholder_test_credential",self.ledger,fake,
                 lambda url:("image/png",b"synthetic"),sleep=lambda _:None)
        with self.assertRaisesRegex(DrivingError,"search_permission_required"):
            api.search("示例地点")
        routes=api.routes("1,2","2,3")
        api.map("1,2","2,3",routes)
        self.assertEqual(parse_qs(urlparse(calls[1]).query)["strategy"],["32"])
        self.assertEqual(self.ledger.usage()["lbs"]["used"],2)
        self.assertEqual(self.ledger.usage()["search"]["used"],1)
        api.transport=lambda u,h:{"status":"0","infocode":"10003"}
        with self.assertRaises(DrivingBlocked):
            api.routes("1,2","2,3")
        with self.assertRaises(DrivingBlocked):
            self.ledger.reserve("lbs")

    def test_three_group_service(self):
        calls=[]
        mono=[10]
        service=DrivingService(self.tmp.name,{"KHD_AMAP_KEY":"placeholder_test_credential"},
            clock=lambda:self.now,monotonic=lambda:mono[0],
            transport=lambda u,h:(calls.append(u) or reply(100,200,300)),
            image_transport=lambda u:("image/png",b"synthetic"))
        service.step()
        self.assertEqual(calls,[])
        groups=[{"name":"目的地"+str(i),"origin":"1,2","destination":str(i+2)+",3",
                 "enabled":True,"windows":[{"days":list(range(7)),"start":0,"end":1440}]}
                for i in range(3)]
        settings={**DEFAULT,"groups":groups,"enabled":True,"consent":True,"map_permission":True}
        with self.assertRaises(ValueError):
            config({**settings,"consent":False})
        service.configure(settings)
        for _ in groups:
            service.step()
        view=service.read()
        self.assertEqual(len(view["groups"]),3)
        self.assertTrue(all(len(g["routes"])==3 for g in view["groups"]))
        self.assertEqual(service.settings_view()["budget"]["lbs"]["used"],6)
        service.step()
        self.assertEqual(len(calls),3)
        mono[0]+=241
        self.assertEqual(service.read()["groups"][0]["status"],"stale")
        mono[0]+=360
        self.assertEqual(service.read()["groups"][0]["routes"],[])
        service.configure({**settings,"enabled":False})
        service.step()
        self.assertEqual(len(calls),3)
        self.assertFalse(service.read()["enabled"])
