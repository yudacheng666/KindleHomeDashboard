"""Targeted real Chromium integration, using local fictional content only.

Run on a standard Linux runner with Chrome and ChromeDriver preinstalled.
No third-party Python packages or external provider calls.
"""
import json
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone
from secrets import token_urlsafe
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.request import Request, urlopen

from dashboard.household import Household
from dashboard.http_api import API, LocalServer
from dashboard.runtime import Runtime
from dashboard.service import BusService


def main():
    chrome = shutil.which("google-chrome") or shutil.which("chromium")
    driver = shutil.which("chromedriver") or os.path.join(
        os.environ.get("CHROMEWEBDRIVER", ""), "chromedriver")
    assert chrome and os.path.isfile(driver), "Chrome/driver missing"
    def wd(path, body=None, method=None):
        raw = None if body is None else json.dumps(body).encode()
        req = Request("http://127.0.0.1:9515"+path, data=raw, method=method,
                      headers={"Content-Type":"application/json"})
        with urlopen(req, timeout=15) as response:
            return json.load(response)["value"]

    def wait(fn):
        for _ in range(80):
            if fn():
                return
            time.sleep(.15)
        raise AssertionError("Expected browser state not reached")

    def ready():
        try:
            return wd("/status").get("ready")
        except Exception:
            return False

    with TemporaryDirectory() as directory:
        now = datetime(2026, 1, 5, 0, tzinfo=timezone.utc)
        home = Household(directory)
        bus = BusService(directory, enabled=False)
        runtime = Runtime(bus, clock=lambda:now)
        reader, admin = token_urlsafe(32), token_urlsafe(32)
        with LocalServer(API(runtime, reader, admin, household=home), 0) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            proc = subprocess.Popen(
                [driver, "--port=9515", "--allowed-ips=127.0.0.1"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            sid = None
            try:
                wait(ready)
                session = wd("/session", {"capabilities":{"alwaysMatch":{
                    "browserName":"chrome","goog:chromeOptions":{
                        "binary":chrome,"args":["--headless=new","--no-sandbox",
                        "--disable-dev-shm-usage","--window-size=600,800"]}}}})
                sid = session["sessionId"]
                def js(script, args=()):
                    return wd("/session/"+sid+"/execute/sync", {"script":script,"args":list(args)})
                def go(path):
                    wd("/session/"+sid+"/url", {"url":"http://127.0.0.1:"+str(server.server_port)+path})
                    wait(lambda:js("return !!document.getElementById('connect').onclick"))
                def click(id):
                    js("document.getElementById(arguments[0]).click()", [id])
                def button(root, label):
                    js("""var b=Array.from(document.getElementById(arguments[0]).querySelectorAll('button')).find(
                       (function(label){return function(x){return x.textContent===label;};})(arguments[1]));
                       if(!b)throw Error('Button missing');b.click();""", [root,label])
                def text_in(id, value):
                    return js("var n=document.getElementById(arguments[0]);return !!n&&n.textContent.indexOf(arguments[1])>=0",[id,value])
                go("/home")
                js("document.getElementById('token').value=arguments[0];document.getElementById('mode').value='admin';",[admin])
                click("connect")
                wait(lambda:js("return document.getElementById('home').className!=='hidden'"))
                click("tasks")
                # Admin's today view can still be loading; repeat harmless tab click.
                wait(lambda:js("document.getElementById('tasks').click();return document.getElementById('content').textContent.indexOf('新增待办')>=0"))
                button("content","新增待办")
                js("document.querySelector('#editor input').value='Fictional browser task'")
                button("editor","保存")
                wait(lambda:len(home.view("2026-01-05")["tasks"])==1)
                wait(lambda:text_in("content","Fictional browser task"))
                # Add linked content through the local model to exercise display
                # without duplicating all management interactions in the browser.
                task=home.view("2026-01-05")["tasks"][0]
                home.add_poster("Fictional reminder",None,"2026-01-05",task_id=task["id"])
                home.set_menu("2026-01-05","dinner",["Fictional dish"],["Fictional ingredient"])
                home.import_ingredients("2026-01-05","2026-01-05")
                click("posters")
                wait(lambda:text_in("content","保存轮播设置"))
                button("content","保存轮播设置")
                js("var a=document.querySelectorAll('#editor select');a[0].value='120';a[1].value='true'")
                button("editor","保存")
                wait(lambda:home.view("2026-01-05")["display_settings"]["autoplay"])
                wait(lambda:js("return document.getElementById('editor').className==='hidden'"))
                # Move a separate fictional meal in the actual editor without
                # disturbing the dinner used by the display regression.
                home.set_menu("2026-01-05","breakfast",["Fictional breakfast"])
                click("menus")
                wait(lambda:text_in("content","Fictional breakfast"))
                js("var rows=document.querySelectorAll('#content .item');for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf('Fictional breakfast')>=0){rows[i].querySelector('button').click();break;}}")
                assert js("return !document.querySelector('#editor input').disabled && !document.querySelector('#editor select').disabled")
                js("document.querySelector('#editor input').value='2026-01-06';document.querySelector('#editor select').value='lunch'")
                button("editor","保存")
                wait(lambda:len(home.menus_between("2026-01-06","2026-01-06"))==1)
                wait(lambda:text_in("content","Fictional breakfast"))
                assert home.menus_between("2026-01-06","2026-01-06")[0]["meal"]=="lunch"
                assert all(m["meal"]!="breakfast" for m in home.menus_between("2026-01-05","2026-01-05"))
                click("logout")
                wait(lambda:js("return document.getElementById('home').className==='hidden'"))
                go("/")
                js("document.getElementById('token').value=arguments[0]",[reader])
                click("connect")
                wait(lambda:text_in("heading","待办清单"))
                assert text_in("body","Fictional browser task")
                assert js("return getComputedStyle(document.getElementById(\'settingsPanel\')).display===\'none\'")
                click("settings")
                assert js("return getComputedStyle(document.getElementById(\'displayContent\')).display===\'none\' && getComputedStyle(document.getElementById(\'settingsPanel\')).display!==\'none\'")
                assert js("return document.getElementById(\'manageLink\').getAttribute(\'href\')===\'/bus#return-tasks\'")
                click("returnDisplay")
                assert text_in("heading","待办清单")
                click("postersMode");assert text_in("heading","Fictional reminder")
                assert text_in("pause","暂停轮播")
                click("menusMode");assert text_in("body","Fictional dish")
                assert not text_in("body","Fictional ingredient")
                click("busMode")
                wait(lambda:text_in("body","公交采集未启用"))
                assert not text_in("body","Fictional")
                click("tasksMode")
                wait(lambda:text_in("heading","待办清单"))
                assert js("return document.getElementById('login').className==='hidden'")
                click("logout")
                assert js("return document.getElementById('body').textContent==='' && document.getElementById('display').className==='hidden'")
                # Direct mode preview, isolated loopback only. The same static
                # pages must open without typing credentials.
                server.api.direct = True
                server.api.admin_token = None
                go("/display")
                wait(lambda:text_in("heading","待办清单"))
                click("postersMode")
                wait(lambda:text_in("heading","Fictional reminder"))
                click("settings")
                click("tasksManage")
                wait(lambda:text_in("content","新增待办"))
                wait(lambda:js("return document.getElementById(\'returnLink\').getAttribute(\'href\')===\'/display#posters\'"))
                click("returnLink")
                wait(lambda:text_in("heading","Fictional reminder"))
                click("settings")
                click("displayManage")
                wait(lambda:text_in("content","保存轮播设置"))
                assert text_in("content","显示设置")
                click("returnLink")
                wait(lambda:text_in("heading","Fictional reminder"))
                click("settings")
                click("pause")
                click("returnDisplay")
                assert text_in("pause","开始轮播")
                js("Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))")
                js("Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))")
                wait(lambda:text_in("heading","Fictional reminder"))
                assert text_in("pause","开始轮播")
                go("/display")
                wait(lambda:text_in("heading","Fictional reminder"))
                assert text_in("pause","开始轮播")
                click("busMode")
                wait(lambda:text_in("body","公交采集未启用"))
                go("/home")
                wait(lambda:text_in("content","新增待办"))
                wait(lambda:js("document.getElementById('tasks').click();return document.getElementById('content').textContent.indexOf('新增待办')>=0"))
                button("content","新增待办")
                js("document.querySelector('#editor input').value='Fictional direct task'")
                button("editor","保存")
                wait(lambda:len(home.view("2026-01-05")["tasks"])==2)
                go("/bus")
                wait(lambda:js("return document.getElementById('dashboard').className!=='hidden'"))
                assert js("return document.getElementById('settings').className!=='hidden'")
                go("/auto")
                wait(lambda:text_in("modeStatus","自动分时"))
                wait(lambda:text_in("heading","待办清单"))
                click("busMode")
                wait(lambda:text_in("body","公交采集未启用"))
                assert text_in("modeStatus","手动显示")
                click("settings")
                click("autoMode")
                wait(lambda:text_in("heading","待办清单"))
                assert text_in("modeStatus","自动分时")
                click("settings")
                click("manageLink")
                wait(lambda:js("var n=document.getElementById(\'dashboard\');return !!n&&n.className!==\'hidden\'"))
                assert js("return document.getElementById(\'returnLink\').getAttribute(\'href\')===\'/auto\'")
                click("returnLink")
                wait(lambda:js("return location.pathname===\'/auto\'"))
                wait(lambda:text_in("heading","待办清单"))
                assert text_in("modeStatus","自动分时")
                # Exercise actual HTML select elements with a fictional upstream.
                from dashboard.runtime import Window
                from datetime import timedelta
                bus.set_enabled(True)
                runtime.windows=(Window(tuple(range(7)),0,1440),)
                stamp=datetime.now(timezone.utc)-timedelta(seconds=10)
                bus.clock=bus.gate.clock=lambda:stamp
                forward={"lineId":"fiction-a","lineName":"Example bus","upDown":0,
                         "startStopName":"A","endStopName":"C"}
                reverse={"lineId":"fiction-b","lineName":"Example bus","upDown":1,
                         "startStopName":"C","endStopName":"A"}
                calls=[]
                def provider(path,body,city):
                    calls.append((path,body))
                    if path.endswith("querytrafficline"):
                        return {"errCode":0,"data":{"trafficStop":[{"stopLineInfo":[forward,reverse]}]}}
                    if path.endswith("querybusline"):
                        assert body["lineId"]=="fiction-b" and body["direction"]=="1"
                        return {"errCode":0,"data":{"busLine":{**reverse,"stop":[
                            {"stopId":n,"stopName":n,"upDown":1} for n in "CBA"]}}}
                    return {"errCode":0,"data":{"stopArriveInfo":{"currentBusArriveTime":"4","nextBusArriveTime":"9"}}}
                bus.gate.request=provider
                go("/bus")
                wait(lambda:js("return document.getElementById('dashboard').className!=='hidden'"))
                click("settings")
                js("document.getElementById('keyword').value='Example bus'")
                click("search")
                wait(lambda:js("return document.getElementById('route').options.length===2"))
                assert js("return document.getElementById('route').options[1].textContent==='Example bus' && document.getElementById('directionStep').className==='hidden'")
                js("var e=document.getElementById('route');e.value='0';e.dispatchEvent(new Event('change'))")
                assert js("return document.getElementById('directionStep').className!== 'hidden'")
                js("var e=document.getElementById('direction');e.value='1';e.dispatchEvent(new Event('change'))")
                stamp+=timedelta(seconds=3)
                click("detail")
                wait(lambda:js("return document.getElementById('stations').className!=='hidden'"))
                assert js("return document.getElementById('board').options[0].textContent.indexOf('C')>=0")
                click("save")
                wait(lambda:bus.trip is not None)
                assert bus.trip.line.direction=="1" and bus.trip.line.line_id=="fiction-b"
                # Use a current timestamp for realistic relative-age rendering.
                stamp+=timedelta(seconds=3)
                bus.tick()
                wait(lambda:js("return document.getElementById('config').className==='hidden'"))
                click("refresh")
                wait(lambda:text_in("vehicles","4 分钟"))
                wait(lambda:text_in("updated","秒前刷新"))
                assert len(calls)==3
                # Real geometry: both slots share the same columns and the first is larger.
                layout = """return (function(){
                  var slots=document.querySelectorAll('.bus-slot');
                  if(slots.length!==2)return false;
                  var a=slots[0].querySelector('.eta'),b=slots[1].querySelector('.eta');
                  var x=slots[0].querySelector('.bus-time'),y=slots[1].querySelector('.bus-time');
                  return Math.abs(a.getBoundingClientRect().left-b.getBoundingClientRect().left)<2
                    && Math.abs(x.getBoundingClientRect().left-y.getBoundingClientRect().left)<2
                    && x.getBoundingClientRect().left>a.getBoundingClientRect().left+50
                    && parseFloat(getComputedStyle(a).fontSize)>parseFloat(getComputedStyle(b).fontSize)
                    && document.documentElement.scrollWidth<=window.innerWidth;
                })()"""
                assert js(layout)
                go("/display")
                wait(lambda:text_in("heading","待办清单"))
                click("busMode")
                wait(lambda:text_in("body","4 分钟"))
                wait(lambda:text_in("body","数据更新于"))
                assert len(calls)==3
                assert js(layout)
                # Use the existing cache, not a new upstream request.
                from dataclasses import replace
                bus.poller.last=replace(bus.poller.last, vehicles=bus.poller.last.vehicles[:1],
                                        scheduled_departures=1, departure_plans=({"time":"23:59","imminent":False},))
                go("/bus")
                wait(lambda:text_in("vehicles","首站计划发车"))
                assert js(layout)
                assert len(calls)==3
                print("Real Chromium bus selection PASS: one route, explicit direction, verified stations, relative age, local reads.")
                print("Real Chromium automatic entry PASS: direct startup, manual override, resume automatic")
                print("Real Chromium direct access PASS: display, management without login, bus settings")
                print("Real Chromium PASS: create task, persisted content, linked poster, menu, saved rotation, single-session module switch and logout")
            finally:
                if sid:
                    try:
                        wd("/session/"+sid, method="DELETE")
                    except Exception:
                        pass
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                server.shutdown()
                thread.join(timeout=3)


if __name__=="__main__":
    main()
