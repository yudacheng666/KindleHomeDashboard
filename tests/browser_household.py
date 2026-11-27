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
from dashboard.weather_service import WeatherService
from test_weather_service import ENV, q_current, meteo


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
        weather_calls=[]
        def fake_weather(url, headers):
            weather_calls.append(url)
            if "/geo/v2/city/lookup" in url:
                return {"code":"200","location":[{"name":"Fictional district","adm1":"Fictional province","lat":"1.23","lon":"2.34"},{"name":"Fictional district","adm1":"Other province","lat":"3.45","lon":"4.56"}]}
            return q_current(now)
        weather=WeatherService(directory,ENV,clock=lambda:now,q_transport=fake_weather,backup_transport=lambda u,h:meteo())
        from dashboard.driving_service import DrivingService
        from test_driving import reply
        import struct, zlib
        def png_chunk(kind, data):
            return struct.pack(">I",len(data))+kind+data+struct.pack(">I",zlib.crc32(kind+data))
        map_png=b"\x89PNG\r\n\x1a\n"+png_chunk(b"IHDR",struct.pack(">IIBBBBB",600,360,8,0,0,0,0))+png_chunk(b"IDAT",zlib.compress((b"\x00"+b"\xff"*600)*360))+png_chunk(b"IEND",b"")
        driving=DrivingService(directory,{"KHD_AMAP_KEY":"placeholder_test_credential"},
            clock=lambda:now,transport=lambda u,h:reply(600,1200,4800),
            image_transport=lambda u:("image/png",map_png))
        with LocalServer(API(runtime, reader, admin, household=home, weather=weather, driving=driving), 0) as server:
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
                assert js("return document.querySelectorAll('#content .menu-date').length===1 && document.querySelectorAll('#content .menu-today').length===1")
                js("var rows=document.querySelectorAll('#content .item');for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf('Fictional breakfast')>=0){rows[i].querySelector('button').click();break;}}")
                assert js("return !document.querySelector('#editor input').disabled && !document.querySelector('#editor select').disabled")
                js("document.querySelector('#editor input').value='2026-01-06';document.querySelector('#editor select').value='lunch'")
                button("editor","保存")
                wait(lambda:len(home.menus_between("2026-01-06","2026-01-06"))==1)
                wait(lambda:text_in("content","Fictional breakfast"))
                assert home.menus_between("2026-01-06","2026-01-06")[0]["meal"]=="lunch"
                assert all(m["meal"]!="breakfast" for m in home.menus_between("2026-01-05","2026-01-05"))
                # Catalog management and mixed point-select/manual weekly entry.
                click("catalog")
                wait(lambda:text_in("content","家庭菜单维护"))
                button("content","新增菜品")
                js("document.querySelector('#editor input').value='Fictional catalog dish'")
                button("editor","保存")
                wait(lambda:len(home.manage("2026-01-05")["catalog"]["dishes"])==1)
                wait(lambda:text_in("content","Fictional catalog dish"))
                click("menus")
                wait(lambda:text_in("content","Fictional dish"))
                button("content","快捷排餐")
                wait(lambda:text_in("quickStatus","已同步"))
                button("editor","Fictional catalog dish")
                wait(lambda:"Fictional catalog dish" in home.menus_between("2026-01-06","2026-01-06")[-1]["dishes"])
                wait(lambda:text_in("quickStatus","已同步"))
                # A second top-level browser window (not an iframe: CSP forbids embedding).
                first_window=wd("/session/"+sid+"/window")
                second_window=wd("/session/"+sid+"/window/new",{"type":"window"})["handle"]
                wd("/session/"+sid+"/window",{"handle":second_window})
                go("/home#menus")
                js("document.getElementById('token').value=arguments[0];document.getElementById('mode').value='admin';",[admin])
                click("connect")
                wait(lambda:text_in("content","Fictional dish"))
                button("content","快捷排餐")
                wait(lambda:text_in("quickStatus","已同步"))
                js("Array.from(document.querySelectorAll('#editor .week-days button')).find(b=>b.textContent.indexOf('01-06')>=0).click()")
                wait(lambda:text_in("editor","Fictional catalog dish"))
                js("document.getElementById('quickManual').value='Fictional manual dish'")
                button("editor","添加菜品")
                wait(lambda:text_in("editor","Fictional manual dish") and text_in("quickStatus","已同步"))
                assert "Fictional manual dish" in home.menus_between("2026-01-06","2026-01-06")[-1]["dishes"]
                catalog=home.manage("2026-01-05")["catalog"]
                other=next(c["id"] for c in catalog["categories"] if c["name"]=="其他")
                assert any(d["name"]=="Fictional manual dish" and d["category"]==other for d in catalog["dishes"])
                # Resume the first window; its immediate foreground read must see the new dish.
                wd("/session/"+sid+"/window",{"handle":first_window})
                wait(lambda:text_in("editor","Fictional manual dish"))
                wait(lambda:text_in("quickStatus","已同步"))
                js("var r=Array.from(document.querySelectorAll('.shared-dish')).find(n=>n.textContent.indexOf('Fictional catalog dish')>=0);r.querySelector('button').click()")
                wait(lambda:not text_in("editor","Fictional catalog dish") or not js("return Array.from(document.querySelectorAll('.shared-dish')).some(n=>n.textContent.indexOf('Fictional catalog dish')>=0)"))
                wait(lambda:text_in("quickStatus","已同步"))
                wd("/session/"+sid+"/window",{"handle":second_window})
                wait(lambda:js("return !Array.from(document.querySelectorAll('.shared-dish')).some(n=>n.textContent.indexOf('Fictional catalog dish')>=0)"))
                assert text_in("editor","Fictional manual dish")
                wd("/session/"+sid+"/window",method="DELETE")
                wd("/session/"+sid+"/window",{"handle":first_window})
                button("editor","完成排餐")
                wait(lambda:text_in("content","Fictional manual dish"))
                button("content","快捷排餐")
                wait(lambda:text_in("quickStatus","已同步"))
                button("editor","下一周")
                wait(lambda:text_in("quickStatus","已同步"))
                js("document.getElementById('quickDate').value='2030-01-01'")
                button("editor","跳转")
                wait(lambda:text_in("quickStatus","已同步"))
                js("document.getElementById('quickManual').value='Fictional future dish'")
                button("editor","添加菜品")
                wait(lambda:len(home.menus_between("2030-01-01","2030-01-01"))==1)
                wait(lambda:text_in("quickStatus","已同步"))
                button("editor","回到今日")
                wait(lambda:text_in("quickStatus","已同步"))
                button("editor","完成排餐")
                wait(lambda:text_in("content","Fictional dish"))
                click("catalog")
                wait(lambda:text_in("content","家庭菜单维护"))
                button("content","其他")
                js("var a=document.querySelectorAll('#content input[type=checkbox]');for(var i=0;i<a.length;i++)a[i].checked=true")
                button("content","移动所选菜品")
                wait(lambda:all(d["category"]!=other for d in home.manage("2026-01-05")["catalog"]["dishes"]))
                wait(lambda:text_in("content","暂无菜品"))
                click("displaySettings")
                button("content","菜单展示范围")
                js("var m=document.querySelector('#editor select');m.value='custom';m.onchange();document.querySelector('#editor input').value='14'")
                button("editor","保存")
                wait(lambda:home.view("2026-01-05")["menu_display"]["days"]==14)
                wait(lambda:js("return document.getElementById('editor').className==='hidden'"))
                # Restore the default to keep subsequent existing weekly view assertions.
                button("content","菜单展示范围")
                js("var m=document.querySelector('#editor select');m.value='week';m.onchange()")
                button("editor","保存")
                wait(lambda:home.view("2026-01-05")["menu_display"]["mode"]=="week")
                wait(lambda:js("return document.getElementById('editor').className==='hidden'"))
                # Existing dinner: save must explain conflict beside the button and preserve the draft.
                click("menus")
                wait(lambda:text_in("content","Fictional dish"))
                button("content","新增菜单")
                js("document.querySelector('#editor input').value='2026-01-05';document.querySelector('#editor textarea').value='Fictional added dish'")
                button("editor","保存")
                wait(lambda:text_in("menuSaveStatus","已有菜单"))
                assert js("return document.querySelector('#editor textarea').value==='Fictional added dish'")
                assert home.menus_between("2026-01-05","2026-01-05")[0]["dishes"]==["Fictional dish"]
                button("editor","追加到已有菜单")
                wait(lambda:js("return document.getElementById('editor').className==='hidden'"))
                wait(lambda:text_in("content","Fictional added dish"))
                meal=home.menus_between("2026-01-05","2026-01-05")[0]
                assert meal["dishes"]==["Fictional dish","Fictional added dish"] and meal["ingredients"]==["Fictional ingredient"]
                # An unused date saves directly, without a redundant confirmation dialog.
                button("content","新增菜单")
                js("document.querySelector('#editor input').value='2026-01-07';document.querySelector('#editor textarea').value='Fictional new meal'")
                button("editor","保存")
                wait(lambda:text_in("content","Fictional new meal"))
                assert home.menus_between("2026-01-07","2026-01-07")[0]["dishes"]==["Fictional new meal"]
                click("logout")
                wait(lambda:js("return document.getElementById('home').className==='hidden'"))
                go("/")
                js("document.getElementById('token').value=arguments[0]",[reader])
                click("connect")
                wait(lambda:text_in("body","Fictional browser task"))
                assert js("return document.getElementById('body').className==='overview-page' && !document.querySelector('.task-complete')")
                assert js("return !!document.querySelector('#body .overview-bus') && document.getElementById('overviewWeather').className!=='hidden' && !document.querySelector('#body .weather-main')")
                assert js("return document.documentElement.scrollWidth<=window.innerWidth")
                click("settings");click("returnDisplay")
                js("document.getElementById('tasksMode').click()")
                wait(lambda:text_in("heading","待办清单"))
                assert text_in("body","Fictional browser task")
                assert js("return !document.querySelector('.task-complete')")
                assert js("return getComputedStyle(document.getElementById(\'settingsPanel\')).display===\'none\'")
                click("settings")
                assert js("return getComputedStyle(document.getElementById(\'displayContent\')).display===\'none\' && getComputedStyle(document.getElementById(\'settingsPanel\')).display!==\'none\'")
                assert js("return document.getElementById(\'manageLink\').getAttribute(\'href\')===\'/bus#return-tasks\'")
                click("weatherLoad")
                wait(lambda:text_in("weatherSettingStatus","需要管理权限"))
                click("returnDisplay")
                assert text_in("heading","待办清单")
                click("postersMode");assert text_in("heading","Fictional reminder")
                assert text_in("pause","暂停轮播")
                click("menusMode");assert text_in("body","Fictional dish")
                assert js("return document.querySelectorAll('#body .menu-date').length===3 && document.querySelectorAll('#body .menu-today').length===1")
                assert js("return document.querySelector('#body .menu-date').textContent==='2026-01-05今日'")
                assert not text_in("body","Fictional ingredient")
                click("busMode")
                wait(lambda:text_in("body","公交自动更新已关闭"))
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
                click("weatherMode")
                wait(lambda:text_in("body","天气未启用"))
                click("settings");click("weatherLoad")
                wait(lambda:text_in("weatherSettingStatus","已读取"))
                assert js("return getComputedStyle(document.getElementById('settingsDetail')).display!=='none' && getComputedStyle(document.getElementById('drivingDetail')).display==='none'")
                js("document.getElementById('weatherKeyword').value='Fictional';document.getElementById('weatherEnabled').checked=true;document.getElementById('weatherConsent').checked=true")
                click("weatherSearch")
                wait(lambda:text_in("weatherResults","Fictional province"))
                assert text_in("weatherResults","Other province")
                js("document.querySelector('#weatherResults button').click()")
                assert text_in("weatherSelected","Fictional district")
                assert js("return document.getElementById('weatherLat').value==='1.23'")
                assert len(weather_calls)==1
                click("weatherSave")
                wait(lambda:text_in("weatherSettingStatus","已保存"))
                assert weather.settings_view()["enabled"] and len(weather_calls)==1
                weather.step()
                click("returnDisplay");click("tasksMode");click("weatherMode")
                wait(lambda:text_in("body","20°C"))
                assert not text_in("body","和风天气") and len(weather_calls)==2
                assert not text_in("body","观测 ")
                click("settings");click("weatherLoad")
                wait(lambda:text_in("weatherSettingStatus","已读取"))
                assert js("return document.getElementById('weatherEnabled').checked")
                click("weatherAdd");click("weatherManual")
                js("document.getElementById('weatherName').value='Fictional custom';document.getElementById('weatherLat').value='3.45';document.getElementById('weatherLon').value='4.56'")
                click("weatherSave")
                wait(lambda:text_in("weatherSettingStatus","已保存"))
                assert weather.settings_view()["additional"]==[{"name":"Fictional custom","latitude":3.45,"longitude":4.56}]
                for _ in range(12): weather.step()
                click("returnDisplay");click("tasksMode");click("weatherMode")
                wait(lambda:text_in("heading","Fictional district"))
                assert text_in("index","1 / 2")
                assert not text_in("body","Fictional custom")
                assert weather.read()["additional"][0]["sections"]["current"]["status"]=="available"
                click("settings");click("weatherNext")
                wait(lambda:text_in("heading","Fictional custom"))
                assert text_in("index","2 / 2")
                assert not text_in("body","主地点")
                assert not text_in("body","Fictional district")
                click("settings");click("weatherLoad")
                wait(lambda:text_in("weatherSettingStatus","已读取"))
                js("document.querySelectorAll('#weatherLocations button')[1].click()")
                click("weatherMoveUp");click("weatherSave")
                wait(lambda:text_in("weatherSettingStatus","已保存"))
                assert weather.settings_view()["name"]=="Fictional custom"
                assert weather.settings_view()["additional"][0]["name"]=="Fictional district"
                js("document.querySelectorAll('#weatherLocations button')[1].click()")
                click("weatherRemove");click("weatherSave")
                wait(lambda:text_in("weatherSettingStatus","已保存"))
                assert weather.settings_view()["additional"]==[]
                js("document.getElementById('weatherName').value='Unsaved example';window.confirm=function(){return false;}")
                click("settingsBack")
                assert js("return getComputedStyle(document.getElementById('weatherDetail')).display!=='none'")
                js("window.confirm=function(){return true;}")
                click("settingsBack")
                assert js("return getComputedStyle(document.getElementById('settingsDetail')).display==='none'")
                click("weatherLoad")
                wait(lambda:text_in("weatherSettingStatus","已读取"))
                assert js("return document.getElementById('weatherName').value==='Fictional custom'")
                click("settingsBack")
                click("drivingLoad")
                wait(lambda:text_in("drivingSettingStatus","已读取"))
                js("document.getElementById('drivingEnabled').checked=true;document.getElementById('drivingConsent').checked=true;document.getElementById('drivingMapPermission').checked=true")
                for i in range(3):
                    click("drivingAdd")
                    js("""var g=document.querySelectorAll('#drivingGroups > section')[arguments[0]], fields=g.querySelectorAll('input[type=text]');
                        fields[0].value='Example '+arguments[0];fields[1].value='1,2';fields[2].value=(arguments[0]+2)+',3';
                        fields[5].value='00:00';fields[6].value='24:00';""",[i])
                click("drivingSave")
                wait(lambda:text_in("drivingSettingStatus","已保存"))
                assert len(driving.settings_view()["groups"])==3
                assert js("return document.querySelectorAll('#drivingGroups > section:not(.hidden)').length===1")
                js("document.querySelectorAll('#drivingLocations button')[2].click()")
                assert js("return !document.querySelectorAll('#drivingGroups > section')[2].classList.contains('hidden')")
                for _ in range(3): driving.step()
                click("returnDisplay");click("drivingMode")
                wait(lambda:js("return document.querySelectorAll('#body .driving-group').length===3"))
                wait(lambda:js("return Array.from(document.querySelectorAll('#body .driving-map img')).length===3 && Array.from(document.querySelectorAll('#body .driving-map img')).every(function(x){return x.complete&&x.naturalWidth>0;})"))
                assert text_in("body","10分钟") and text_in("body","20分钟") and text_in("body","1小时20分钟")
                click("settings");click("drivingLoad")
                wait(lambda:text_in("drivingSettingStatus","已读取"))
                assert js("return document.querySelectorAll('#drivingGroups > section').length===3")
                assert js("return document.getElementById('drivingSave').parentNode.nextElementSibling.id==='drivingSettingStatus'")
                click("returnDisplay")
                click("overviewMode")
                wait(lambda:js("return document.querySelectorAll('#body .overview-driving-card').length===2 && document.querySelectorAll('#body .overview-driving-map img').length===2 && document.querySelector('#body .overview-bus')!==null"))
                assert text_in("body","另 1 个目的地") and not text_in("body","全部路线")
                assert text_in("body","1小时20分钟")
                assert js("""return Array.from(document.querySelectorAll('#body .overview-driving-card .driving-foot,#body .overview-bus .note')).every(function(n){return !/更新\s+\d\d:\d\d|数据更新于|更新于\s/.test(n.textContent);})""")
                assert js("""return Array.from(document.querySelectorAll('#body .driving-reverse')).length===2 &&
                  Array.from(document.querySelectorAll('#body .driving-reverse')).every(function(b){
                    var a=b.getBoundingClientRect(),i=b.parentNode.querySelector('img').getBoundingClientRect();
                    return a.left>=i.left&&a.right<=i.right&&a.top>=i.top&&a.bottom<=i.bottom;
                  })""")
                assert not text_in("body","已知拥堵") and not text_in("body","路况未知")
                assert js("return Array.from(document.querySelectorAll('#body .overview-driving-routes')).every(function(n){return /km/.test(n.textContent)&&/分钟/.test(n.textContent);})")
                assert js("""return (function(){
                  var cards=document.querySelectorAll('#body .overview-driving-card'),maps=document.querySelectorAll('#body .overview-driving-map'),rows=document.querySelectorAll('#body .driving-route-row');
                  if(cards.length!==2||maps.length!==2||rows.length!==6)return false;
                  var a=cards[0].getBoundingClientRect(),c=cards[1].getBoundingClientRect();
                  return a.left<c.left&&Math.abs(a.top-c.top)<2&&a.right<=c.left+2
                    &&Array.prototype.every.call(maps,function(n){var h=n.parentNode.parentNode.querySelector('h2').getBoundingClientRect();return Math.abs(n.getBoundingClientRect().height-140)<2&&n.getBoundingClientRect().top-h.bottom<=4;})
                    &&Array.prototype.every.call(rows,function(n){return n.scrollHeight<=n.clientHeight+2&&parseFloat(getComputedStyle(n).fontSize)>=18;});
                })()""")
                assert js("return document.documentElement.scrollWidth<=window.innerWidth")
                # Real rendered sizes, visible header geometry and reachable navigation.
                readable = """return (function(){
                  var nav=document.getElementById('displayNav'), menu=document.getElementById('settingsMenu');
                  var visible=function(n){return n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0;};
                  var rules=[['.overview-link',19],['.driving-route-row',18],['.driving-routes',18],['.driving-foot',16],['.menu-dishes',19],['.task-row',19]];
                  var ok=rules.every(function(r){var nodes=document.querySelectorAll('#body '+r[0]);return (r[0]==='.driving-foot'||nodes.length>0)&&Array.from(nodes).every(function(n){return parseFloat(getComputedStyle(n).fontSize)>=r[1];});});
                  return nav.querySelectorAll('button').length===1&&visible(document.getElementById('settings'))
                    &&menu.contains(document.getElementById('busMode'))&&!visible(document.getElementById('busMode'))
                    &&ok&&document.documentElement.scrollWidth<=window.innerWidth;
                })()"""
                assert js(readable)
                original_rect=wd("/session/"+sid+"/window/rect")
                wd("/session/"+sid+"/window/rect", {"width":480,"height":640})
                assert js(readable)
                # One boundary per group; no empty timestamp row or duplicate borders.
                assert js("""return (function(){
                  var root=document.getElementById('body'),grid=root.querySelector('.overview-driving-grid'),cards=root.querySelectorAll('.overview-driving-card'),home=root.querySelector('.overview-home'),menu=root.querySelector('.overview-menu'),todo=root.querySelector('.overview-todos');
                  var border=function(n,side){return parseFloat(getComputedStyle(n)['border'+side+'Width']);};
                  return border(grid,'Top')===0&&border(grid,'Bottom')===0&&border(root.querySelector('.overview-driving'),'Top')===1&&border(home,'Top')===1
                    &&Array.from(cards).every(function(n){return border(n,'Bottom')===0;})
                    &&(!menu.lastElementChild||border(menu.lastElementChild,'Bottom')===0)
                    &&border(todo,'Top')===(menu.children.length?1:0)
                    &&Array.from(root.querySelectorAll('.overview-bus .note:empty')).every(function(n){return n.getBoundingClientRect().height===0;});
                })()""")
                assert js("""return (function(){
                  var w=document.getElementById('overviewWeather').getBoundingClientRect(),d=document.getElementById('date').getBoundingClientRect(),s=document.getElementById('settings').getBoundingClientRect(),b=document.querySelector('#body .overview-bus').getBoundingClientRect(),c=document.querySelectorAll('#body .overview-driving-card');
                  return w.width>0&&d.width>0&&Math.abs(w.top-d.top)<=2&&d.right<=w.left+1&&w.right<=s.left+1&&Math.max(d.bottom,w.bottom,s.bottom)<=b.top+1
                    &&b.width>=document.getElementById('body').getBoundingClientRect().width-2&&c.length===2&&c[0].getBoundingClientRect().right<=c[1].getBoundingClientRect().left+2;
                })()""")
                wd("/session/"+sid+"/window/rect", {"width":320,"height":640})
                assert js(readable)
                assert js("""var d=document.getElementById('date').getBoundingClientRect(),w=document.getElementById('overviewWeather').getBoundingClientRect(),s=document.getElementById('settings').getBoundingClientRect();return w.width>0&&Math.abs(d.top-w.top)<=2&&d.right<=w.left+1&&w.right<=s.left+1""")
                assert js("""var c=document.querySelectorAll('#body .overview-driving-card');return c.length===2&&c[1].getBoundingClientRect().top>=c[0].getBoundingClientRect().bottom-1""")
                wd("/session/"+sid+"/window/rect", {"width":original_rect["width"],"height":original_rect["height"]})
                assert js("""var c=document.querySelectorAll('#body .overview-driving-card');return c.length===2&&c[0].getBoundingClientRect().right<=c[1].getBoundingClientRect().left+2""")
                click("settings")
                assert js("return document.getElementById('busMode').getBoundingClientRect().height>=44 && document.getElementById('weatherMode').getBoundingClientRect().height>=44")
                click("returnDisplay")
                button("body","另 1 个目的地")
                wait(lambda:js("return document.querySelectorAll('#body .driving-map img').length===3"))
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
                wait(lambda:text_in("content","轮播设置"))
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
                wait(lambda:text_in("body","公交自动更新已关闭"))
                go("/home")
                wait(lambda:text_in("content","新增待办"))
                wait(lambda:js("document.getElementById('tasks').click();return document.getElementById('content').textContent.indexOf('新增待办')>=0"))
                button("content","新增待办")
                js("document.querySelector('#editor input').value='Fictional direct task'")
                button("editor","保存")
                wait(lambda:len(home.view("2026-01-05")["tasks"])==2)
                # Complete a one-off item from the display, cancel first,
                # restore through history, then permanently remove it.
                go("/display#tasks")
                wait(lambda:text_in("body","Fictional direct task"))
                js("window.confirm=function(){return false;}")
                js("var rows=document.querySelectorAll('.task-row');for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf('Fictional direct task')>=0)rows[i].querySelector('button').click();}")
                assert len(home.view("2026-01-05")["tasks"])==2
                js("window.confirm=function(){return true;}")
                js("var rows=document.querySelectorAll('.task-row');for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf('Fictional direct task')>=0)rows[i].querySelector('button').click();}")
                wait(lambda:len(home.view("2026-01-05")["tasks"])==1)
                wait(lambda:not text_in("body","Fictional direct task"))
                click("settings");click("tasksManage")
                wait(lambda:text_in("content","历史待办"))
                button("content","历史待办")
                wait(lambda:text_in("content","Fictional direct task"))
                js("window.confirm=function(){return true;}")
                button("content","恢复")
                wait(lambda:len(home.view("2026-01-05")["tasks"])==2)
                wait(lambda:text_in("content","暂无历史待办"))
                click("returnLink")
                wait(lambda:text_in("body","Fictional direct task"))
                js("window.confirm=function(){return true;}")
                js("var rows=document.querySelectorAll('.task-row');for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf('Fictional direct task')>=0)rows[i].querySelector('button').click();}")
                wait(lambda:len(home.view("2026-01-05")["tasks"])==1)
                click("settings");click("tasksManage")
                wait(lambda:text_in("content","历史待办"))
                button("content","历史待办")
                wait(lambda:text_in("content","Fictional direct task"))
                js("window.confirm=function(){return false;}")
                button("content","彻底删除")
                assert len(home.manage("2026-01-05")["history"])==1
                js("window.confirm=function(){return true;}")
                button("content","彻底删除")
                wait(lambda:home.manage("2026-01-05")["history"]==[])
                wait(lambda:text_in("content","暂无历史待办"))
                assert len(home.manage("2026-01-05")["tasks"])==1
                # Upcoming tasks are grouped in the real narrow display; only
                # due items can be completed, and linked posters remain due-only.
                old=home.add_task("Fictional overdue","2026-01-03")
                upcoming=home.add_task("Fictional future","2026-01-06")
                same=home.add_task("Fictional same day","2026-01-06")
                repeated=home.add_task("Fictional recurring","2026-01-05","daily")
                home.complete(repeated,"2026-01-05")
                far=home.add_task("Fictional far "+("long title "*12),"2030-01-01")
                go("/display#tasks")
                wait(lambda:text_in("body","Fictional future"))
                assert js("return document.querySelectorAll('.task-date').length===4 && document.querySelectorAll('.task-complete').length===2")
                assert js("return document.querySelectorAll('.task-date-tag').length===2 && document.querySelector('.task-overdue').textContent==='逾期'")
                assert js("return Array.from(document.querySelectorAll('.task-row')).filter(n=>n.textContent.indexOf('Fictional future')>=0||n.textContent.indexOf('Fictional recurring')>=0).every(n=>!n.querySelector('button'))")
                assert js("return document.documentElement.scrollWidth<=window.innerWidth")
                for key in (old,upcoming,same,repeated,far):
                    home.delete_task(key)
                go("/bus")
                wait(lambda:js("return document.getElementById('dashboard').className!=='hidden'"))
                assert js("return document.getElementById('settings').className!=='hidden'")
                # Exercise the actual schedule select, POST, readback, re-entry
                # and durable restore, with no scheduler or upstream traffic.
                runtime.web_settings = True
                click("scheduleSettings")
                wait(lambda:text_in("scheduleStored","关闭"))
                js("document.getElementById('scheduleEnabled').value='1'")
                click("scheduleSave")
                wait(lambda:text_in("scheduleMessage","至少"))
                assert not bus.gate.enabled
                click("scheduleAdd")
                js("var r=document.querySelector('#scheduleRows .schedule-row');r.querySelector('input[type=checkbox]').checked=true;var t=r.querySelectorAll('select');t[0].value='23';t[1].value='07';t[2].value='24';t[2].dispatchEvent(new Event('change'))")
                click("scheduleSave")
                wait(lambda:text_in("scheduleMessage","已保存并确认"))
                assert bus.gate.enabled and not runtime.active()
                assert runtime.schedule_view()["windows"] == [{"days":[0],"start":1387,"end":1440}]
                assert js("return document.getElementById('scheduleEnabled').value==='1' && document.getElementById('scheduleConfig').className!=='hidden'")
                assert text_in("scheduleStored","开启")
                restored=Runtime(BusService(directory,enabled=False),web_settings=True,clock=lambda:now)
                assert restored.schedule_view()["enabled"] is True
                go("/bus")
                wait(lambda:js("return document.getElementById('dashboard').className!=='hidden'"))
                click("scheduleSettings")
                wait(lambda:text_in("scheduleStored","开启"))
                assert js("return document.getElementById('scheduleEnabled').value==='1'")
                assert js("var r=document.querySelector('#scheduleRows .schedule-row');return r.querySelectorAll('input[type=text]').length===0 && Array.from(r.querySelectorAll('select')).map(x=>x.value).join(':')==='23:07:24:00'")
                js("document.getElementById('scheduleEnabled').value='0'")
                click("scheduleSave")
                wait(lambda:text_in("scheduleMessage","已保存并确认"))
                assert not bus.gate.enabled
                assert text_in("scheduleStored","关闭")
                click("scheduleCancel")
                print("Real Chromium schedule enable/save/readback/reopen/disable and durable restore PASS")
                go("/auto")
                wait(lambda:text_in("modeStatus","自动分时"))
                wait(lambda:text_in("heading","待办清单"))
                click("busMode")
                wait(lambda:text_in("body","公交自动更新已关闭"))
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
                    && slots[1].getBoundingClientRect().height<slots[0].getBoundingClientRect().height
                    && parseFloat(getComputedStyle(slots[1].querySelector(".bus-time")).fontSize)<parseFloat(getComputedStyle(slots[0].querySelector(".bus-time")).fontSize)
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
                # Desktop workbench: all modules retain the same live, interactive preview.
                wd("/session/"+sid+"/window/rect", {"width":1440,"height":1000})
                go_admin = lambda path: wd("/session/"+sid+"/url", {"url":"http://127.0.0.1:"+str(server.server_port)+path})
                go_admin("/admin")
                wait(lambda:js("return !!document.querySelector('.admin-module-grid') && !!document.getElementById('previewFrame')"))
                assert js("return document.querySelectorAll('.admin-module-card').length===5")
                assert js("""return (function(){
                  var b=document.querySelector('.admin-brand strong'),r=document.createRange();r.selectNodeContents(b);
                  return r.getClientRects().length===1
                    && b.getBoundingClientRect().right<=document.querySelector('.admin-sidebar').getBoundingClientRect().right
                    && document.querySelectorAll('.admin-status-cell .admin-muted').length===3
                    && !document.querySelector('.admin-info')
                    && !Array.from(document.querySelectorAll('.admin-nav a')).some(a=>a.textContent.includes('显示设置'))
                    && Array.prototype.every.call(document.querySelectorAll('.admin-module-card'),function(a){return a.tagName==='A'&&a.getBoundingClientRect().height<125&&!!a.getAttribute('href');})
                    && !!document.querySelector('.admin-preview-panel');
                })()""")
                assert js("return document.querySelectorAll('.admin-nav a[aria-current=page]').length===1 && document.documentElement.scrollWidth<=window.innerWidth")
                # Old route is retained only as a redirect into poster management.
                go_admin("/admin/display")
                wait(lambda:js("return location.pathname==='/admin/family' && location.hash==='#posters'"))
                go_admin("/admin/family")
                wait(lambda:js("return !!document.querySelector('.admin-preview-panel') && document.getElementById('previewFrame').contentWindow.document.getElementById('heading').textContent==='待办清单'"))
                assert js("""return (function(){
                  var f=document.getElementById('previewFrame');
                  return document.getElementById('previewMode').value==='follow'
                    && f.contentWindow.innerWidth===480 && f.contentWindow.innerHeight===640
                    && !!f.contentDocument.querySelector('.task-complete')
                    && getComputedStyle(document.querySelector('.admin-preview-panel')).position==='sticky'
                    && getComputedStyle(document.getElementById('displaySettings')).display==='none';
                })()""")
                # Module-owned settings: poster rotation and menu display range are in their own tabs.
                click("posters")
                wait(lambda:js("return document.getElementById('previewFrame').getAttribute('src')==='/preview#posters'"))
                for _ in range(80):
                    state=js("var f=document.getElementById('previewFrame');return {src:f.getAttribute('src'),mode:document.getElementById('previewMode').value,hash:f.contentWindow.location.hash,heading:f.contentDocument.getElementById('heading')&&f.contentDocument.getElementById('heading').textContent,body:f.contentDocument.getElementById('body').textContent.slice(0,240)}")
                    if state.get("heading")=="Fictional reminder":break
                    time.sleep(.15)
                else:
                    raise AssertionError("Poster preview did not follow module: "+str(state))
                button("content","轮播设置")
                assert text_in("editor","每页停留")
                button("editor","保存")
                wait(lambda:text_in("content","轮播：开启"))
                click("menus")
                wait(lambda:js("return document.getElementById('previewFrame').contentWindow.document.getElementById('heading').textContent==='本周菜单'"))
                button("content","菜单展示范围")
                assert text_in("editor","展示方式")
                button("editor","取消")
                # The Kindle settings button really opens the in-frame settings UI.
                js("document.getElementById('previewFrame').contentWindow.document.getElementById('settings').click()")
                assert js("return document.getElementById('previewFrame').contentWindow.document.getElementById('settingsPanel').className!=='hidden'")
                js("document.getElementById('previewFrame').contentWindow.document.getElementById('returnDisplay').click()")
                assert js("return document.getElementById('previewFrame').contentWindow.document.getElementById('settingsPanel').className==='hidden'")
                # Manual preview lock survives left-side module changes; follow restores linkage.
                js("var m=document.getElementById('previewMode');m.value='bus';m.onchange()")
                for _ in range(80):
                    state=js("var f=document.getElementById('previewFrame');return {src:f.getAttribute('src'),mode:document.getElementById('previewMode').value,hash:f.contentWindow.location.hash,busMode:f.contentDocument.getElementById('busMode').className,heading:f.contentDocument.getElementById('heading')&&f.contentDocument.getElementById('heading').textContent,body:f.contentDocument.getElementById('body').textContent.slice(0,240)}")
                    if state.get("hash")=="#bus" and state.get("busMode")=="selected":break
                    time.sleep(.15)
                else:
                    raise AssertionError("Manual preview lock did not switch to bus: "+str(state))
                click("tasks")
                assert js("return document.getElementById('previewMode').value==='bus' && document.getElementById('previewFrame').contentWindow.location.hash==='#bus' && document.getElementById('previewFrame').contentWindow.document.getElementById('busMode').className==='selected'")
                js("var m=document.getElementById('previewMode');m.value='follow';m.onchange()")
                wait(lambda:js("return document.getElementById('previewFrame').contentWindow.document.getElementById('heading').textContent==='待办清单'"))
                # Viewport geometry remains the real CSS viewport, independent of the device bezel.
                js("document.getElementById('previewWidth').value='1'")
                click("previewApply")
                assert text_in("previewFeedback","请输入有效")
                js("document.getElementById('previewWidth').value='420';document.getElementById('previewHeight').value='560'")
                click("previewApply");click("previewOne")
                wait(lambda:js("var f=document.getElementById('previewFrame');return f.contentWindow.innerWidth===420&&f.contentWindow.innerHeight===560"))
                assert js("var f=document.getElementById('previewFrame');return f.style.width==='420px'&&f.style.height==='560px'&&f.getBoundingClientRect().width===420&&f.getBoundingClientRect().height===560")
                js("var f=document.getElementById('previewFrame');window.testPreview=f;window.testPreviewFont=f.contentWindow.getComputedStyle(f.contentDocument.body).font")
                click("previewAppearance")
                assert js("var f=document.getElementById('previewFrame');return f===window.testPreview&&f.contentWindow.innerWidth===420&&f.contentWindow.innerHeight===560&&getComputedStyle(f).filter==='none'&&f.contentWindow.getComputedStyle(f.contentDocument.body).font===window.testPreviewFont")
                click("previewAppearance");click("previewFit")
                js("document.getElementById('previewWidth').value='600';document.getElementById('previewHeight').value='800'")
                click("previewApply")
                wait(lambda:js("var f=document.getElementById('previewFrame');return f.contentWindow.innerWidth===600&&f.contentWindow.innerHeight===800"))
                assert js("var f=document.getElementById('previewFrame'),a=f.getBoundingClientRect();return Math.abs(a.width/a.height-.75)<.001&&a.width<600")
                click("previewOne")
                assert js("var f=document.getElementById('previewFrame');return f.getBoundingClientRect().width===600&&f.getBoundingClientRect().height===800")
                click("previewDefaults")
                wait(lambda:js("var f=document.getElementById('previewFrame');return f.contentWindow.innerWidth===480&&f.contentWindow.innerHeight===640"))
                assert js("return document.getElementById('previewMode').value==='follow'&&document.getElementById('previewWidth').value==='480'&&document.getElementById('previewHeight').value==='640'&&document.getElementById('previewFit').getAttribute('aria-pressed')==='true'&&document.getElementById('previewDevice').classList.contains('device-bezel')")
                # Module routes all keep the same persistent preview and select their matching display.
                go_admin("/admin/weather")
                wait(lambda:text_in("weatherSettingStatus","已读取"))
                assert js("return !!document.querySelector('.admin-list-pane #weatherLocations') && document.querySelector('.admin-nav a[aria-current=page]').textContent==='天气设置'")
                go_admin("/admin/driving")
                wait(lambda:text_in("drivingSettingStatus","已读取"))
                assert js("return !!document.querySelector('.admin-list-pane #drivingLocations') && document.querySelectorAll('#drivingGroups > section:not(.hidden)').length===1")
                go_admin("/admin/family")
                wait(lambda:text_in("content","新增待办"))
                assert js("return !!document.querySelector('.admin-family-content #content') && getComputedStyle(document.getElementById('displaySettings')).display==='none'")
                js("document.getElementById('displaySettings').click()")
                assert text_in("content","新增待办")
                go_admin("/admin/bus")
                wait(lambda:js("return document.getElementById('dashboard').className!=='hidden'"))
                assert js("return document.getElementById('scheduleSettings').textContent==='更新时间设置'")
                click("settings")
                assert js("return document.getElementById('config').className!=='hidden'")
                click("cancel")
                assert len(calls)==3
                print("Desktop admin shell, exact CSS viewport preview, same renderer, read-only navigation and module editors PASS")
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
