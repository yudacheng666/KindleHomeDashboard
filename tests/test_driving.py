"""Offline driving contract tests; no live locations, network or credentials."""
from datetime import datetime, timezone, timedelta
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
        self.assertEqual(params["size"],"600*200")

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
