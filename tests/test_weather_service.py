"""Offline scheduler/HTTP tests. No real credentials, places or provider calls."""
from datetime import datetime, timezone, timedelta
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import json
import unittest
from secrets import token_urlsafe
from dashboard.weather_service import WeatherService
from dashboard.weather import WeatherError, WeatherBlocked
from dashboard.http_api import API, LocalServer
from dashboard.runtime import Runtime
from dashboard.service import BusService

NOW=datetime(2026,1,5,0,tzinfo=timezone.utc)
CONFIG={"name":"Fictional district","latitude":1.23,"longitude":2.34,"enabled":True,"consent":True}
ENV={"KHD_QWEATHER_HOST":"example.qweatherapi.com","KHD_QWEATHER_KEY":"placeholder_test_key"}


def q_current(now=NOW):
    return {"validTime":now.isoformat(),"temperature":{"value":20,"unit":"°C"},
            "condition":{"text":"晴"},"feelsLike":{"value":18,"unit":"°C"},"humidity":.6,
            "wind":{"speed":{"value":2,"unit":"m/s"}},
            "metadata":{"attributions":["Fictional attribution"]}}


def meteo():
    t="2026-01-05T00:00"
    return {"timezone":"UTC",
            "current":{"time":t,"temperature_2m":19,"apparent_temperature":18,
                       "relative_humidity_2m":60,"weather_code":0,"wind_speed_10m":5},
            "current_units":{"temperature_2m":"°C","apparent_temperature":"°C","relative_humidity_2m":"%","wind_speed_10m":"km/h"},
            "hourly":{"time":[t,"2026-01-05T01:00"],"temperature_2m":[19,20],
                      "weather_code":[0,1],"precipitation_probability":[0,20]},
            "hourly_units":{"temperature_2m":"°C","precipitation_probability":"%"},
            "daily":{"time":["2026-01-05"],"weather_code":[0],"temperature_2m_max":[21],"temperature_2m_min":[16]},
            "daily_units":{"temperature_2m_max":"°C","temperature_2m_min":"°C"}}


class WeatherServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.clock=NOW
        self.mono=100
        self.calls=[]
        self.fallback=[]
        self.failure=False
        self.block=False
        def q(url,headers):
            self.calls.append(url)
            if self.block: raise WeatherBlocked("provider_blocked")
            if self.failure: raise WeatherError("test_unavailable")
            if "/weather/v1/current" in url: return q_current(self.clock)
            if "/weather/v1/hourly" in url:
                return {"hours":[{"forecastTime":(self.clock+timedelta(hours=1)).isoformat(),
                                  "condition":{"text":"晴"},"temperature":{"value":21,"unit":"°C"},
                                  "precipitation":{"probability":.3}}]}
            if "/weather/v1/daily" in url:
                return {"days":[{"daytime":{"forecastStartTime":self.clock.isoformat(),"condition":{"text":"晴"}},
                                 "temperatureMax":{"value":22,"unit":"°C"},"temperatureMin":{"value":12,"unit":"°C"}}]}
            if "minutely" in url: return {"code":"200","updateTime":self.clock.isoformat(),"summary":"无降雨",
                    "minutely":[{"fxTime":self.clock.isoformat(),"precip":"0","type":"rain"}]}
            if "airquality" in url: return {"indexes":[{"code":"cn-mee","name":"AQI (CN)","aqiDisplay":"30","category":"优"}]}
            return {"metadata":{"zeroResult":True}}
        def backup(url,headers):
            self.fallback.append(url)
            return meteo()
        self.q,self.backup=q,backup
        self.service=self.new()
    def new(self):
        return WeatherService(self.tmp.name,ENV,clock=lambda:self.clock,
              monotonic=lambda:self.mono,q_transport=self.q,backup_transport=self.backup)
    def test_disabled_and_consent(self):
        self.service.step()
        self.assertEqual(self.calls,[])
        with self.assertRaises(ValueError):
            self.service.configure({**CONFIG,"consent":False})
        self.service.step()
        self.assertEqual(self.calls,[])
    def test_six_sections_and_read_never_fetches(self):
        self.service.configure(CONFIG)
        for _ in range(6): self.service.step()
        view=self.service.read()
        self.assertEqual(view["status"],"ready")
        self.assertTrue(all(s["status"]=="available" for s in view["sections"].values()))
        self.assertEqual(view["sections"]["alerts"]["data"],[])
        self.assertEqual(view["sections"]["hourly"]["data"][0]["pop"],30)
        for _ in range(10): self.service.read(); self.service.step()
        self.assertEqual(len(self.calls),6)
        self.assertEqual(len(self.fallback),0)
        restored=self.new()
        self.assertEqual(restored.settings_view()["budget"]["used"],6)
        self.assertTrue(restored.settings_view()["enabled"])
        self.assertNotIn("placeholder_test_key",json.dumps(restored.settings_view()))
        self.assertEqual(restored.read()["status"],"waiting")
    def test_fallback_and_unknown_warnings(self):
        self.failure=True
        self.service.configure(CONFIG)
        self.service.step()
        self.assertEqual(self.service.read()["sections"]["current"]["source"],"Open-Meteo")
        self.assertEqual(self.service.read()["sections"]["alerts"]["status"],"unavailable")
        self.assertEqual(self.service.read()["sections"]["rain"]["status"],"unavailable")
        self.assertEqual(len(self.fallback),1)
        self.mono+=1900;self.clock+=timedelta(seconds=1900)
        self.assertEqual(self.service.read()["sections"]["current"]["status"],"unavailable")
    def test_block_persists(self):
        self.block=True
        self.service.configure(CONFIG)
        self.service.step()
        self.service.step()
        self.assertEqual(len(self.calls),1)
        self.assertTrue(self.new().settings_view()["budget"]["blocked"])
        self.assertEqual(self.service.read()["sections"]["current"]["source"],"Open-Meteo")
    def test_backup_access_restriction_persists(self):
        self.block=True
        def refused(url,headers):
            self.fallback.append(url)
            raise WeatherBlocked("provider_blocked")
        self.backup=refused
        self.service=self.new()
        self.service.configure(CONFIG)
        self.service.step()
        self.assertTrue(self.service.settings_view()["budget"]["backup_blocked"])
        self.mono+=4000
        self.service.step()
        self.assertEqual(len(self.fallback),1)
        self.assertTrue(self.new().settings_view()["budget"]["backup_blocked"])

    def test_location_change_clears_cache(self):
        self.service.configure(CONFIG);self.service.step()
        self.assertEqual(self.service.read()["status"],"ready")
        self.service.configure({**CONFIG,"latitude":2.34})
        self.assertEqual(self.service.read()["status"],"waiting")
        self.service.configure({**CONFIG,"enabled":False})
        self.service.step()
        self.assertEqual(self.service.read()["status"],"disabled")
        self.assertEqual(len(self.calls),1)
    def test_http_auth_and_no_external_calls(self):
        reader,admin=token_urlsafe(32),token_urlsafe(32)
        api=API(Runtime(BusService(self.tmp.name,enabled=False)),reader,admin,weather=self.service)
        with LocalServer(api,0) as server:
            thread=Thread(target=server.serve_forever,daemon=True);thread.start()
            def req(path,token,body=None):
                req=Request("http://127.0.0.1:"+str(server.server_port)+path,
                            data=json.dumps(body).encode() if body is not None else None,
                            headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"})
                with urlopen(req,timeout=3) as response:return json.load(response)
            try:
                with self.assertRaises(HTTPError) as err:
                    req("/api/weather/settings",reader)
                self.assertEqual(err.exception.code,401)
                with self.assertRaises(HTTPError) as err:
                    req("/api/weather/settings",reader,CONFIG)
                self.assertEqual(err.exception.code,401)
                self.assertEqual(req("/api/weather/view",reader)["status"],"disabled")
                self.assertTrue(req("/api/weather/settings",admin,CONFIG)["enabled"])
                self.assertEqual(req("/api/weather/view",reader)["status"],"waiting")
                self.assertEqual(self.calls,[])
            finally:
                server.shutdown();thread.join(3)
