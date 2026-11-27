/* Deterministic display tests: simulated DOM, clock and read-only XHR. */
const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict");
class Node {
  constructor(tag){this.tag=tag;this.children=[];this.textContent="";this.value="";this.checked=false;this.className="";}
  get firstChild(){return this.children[0];}
  setAttribute(k,v){this[k]=v;}
  appendChild(n){this.children.push(n);return n;}
  removeChild(n){this.children.splice(this.children.indexOf(n),1);}
}
const nodes={},events={},windowEvents={};
const doc={hidden:false,getElementById(id){return nodes[id]||(nodes[id]=new Node(id));},
  createElement(tag){return new Node(tag);},addEventListener(name,fn){events[name]=fn;}};
const el=id=>doc.getElementById(id);
const descendants=n=>n.children.flatMap(c=>[c,...descendants(c)]);
const fullText=n=>n.textContent+n.children.map(fullText).join("");
const busNodes=()=>descendants(el("body"));
const date="2026-01-05",task={id:"test-task",title:"Example task",occurrence:date};
const poster={id:"test-poster",title:"Example reminder",body:"Line one\nLine two",note:"Example note"};
const meal={day:date,meal:"dinner",dishes:["Example dish"]};
const shopping={id:"test-item",label:"Example ingredient",completed:0};
const sample={date,tasks:[task],posters:[poster],today_menu:[meal],week_menu:[meal],shopping:[shopping]};
const bus={trip:{line:{name:"Example line"},boarding:{name:"A"},destination:{name:"B"}},snapshot:{status:"live",vehicles:[{position:1,eta_min:4,distance_m:300,stops_remaining:1},{position:2,eta_min:9,distance_m:null,stops_remaining:null}],scheduled_departures:0,fetched_at:"2026-01-05T00:00:00+00:00"}};
let data=sample,fail=0,requests=0,clock=0,nextId=1,busRequests=0,busData=bus, autoMode="family", autoRequests=0;
const weatherExample={status:"ready",name:"Example",sections:{current:{status:"available",source:"QWeather",fetched_at:"2026-01-05T00:00:00Z",attributions:["Example data provider"],data:{temp:20,text:"晴",time:"2026-01-05T00:00:00Z"}}}};
let weatherData=weatherExample;
const timers=new Map();
class FakeDate extends Date {static now(){return Date.parse(bus.snapshot.fetched_at)+clock;}}
function setTimer(fn,delay){const id=nextId++;timers.set(id,{at:clock+delay,fn});return id;}
function clearTimer(id){timers.delete(id);}
function advance(ms){
  const end=clock+ms;
  while(true){
    const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
    if(!next)break;
    clock=next[1].at;timers.delete(next[0]);next[1].fn();
  }
  clock=end;
}
let reversedGroups=[false,false,false],directionWrites=0,drivingStatus="ok";
class XHR {
  open(method,path){if(path==="/api/driving/reverse"){assert.equal(method,"POST");this.path=path;return;}assert.equal(method,"GET");assert.ok(["/api/home/view","/api/bus/view","/api/display/auto","/api/weather/view","/api/driving/view"].includes(path));this.path=path;}
  setRequestHeader(k,v){if(k==="Content-Type"){assert.equal(v,"application/json");return;}assert.equal(k,"Authorization");assert.equal(v,"Bearer example-display-token");}
  send(body){if(this.path==="/api/driving/reverse"){const b=JSON.parse(body);assert.equal(b.revision,"example-"+b.group+"-"+reversedGroups[b.group]);reversedGroups[b.group]=!reversedGroups[b.group];directionWrites++;this.status=200;this.responseText=JSON.stringify({status:"ok"});this.readyState=4;this.onreadystatechange();return;}assert.equal(body,null);requests++;if(this.path==="/api/bus/view")busRequests++;if(this.path==="/api/display/auto")autoRequests++;this.status=fail||200;const timedBus={...busData,snapshot:{...busData.snapshot,server_now_ms:FakeDate.now(),fetched_at_ms:Date.parse(busData.snapshot.fetched_at),timezone_offset_min:480}};this.responseText=JSON.stringify(fail?{}:this.path==="/api/driving/view"?{enabled:true,can_reverse:true,groups:["A","B","C"].map((name,i)=>({name,status:drivingStatus,can_switch:true,reversed:reversedGroups[i],direction_revision:"example-"+i+"-"+reversedGroups[i],routes:[{seconds:600+i*60,meters:12000,congested_meters:i===0?0:1000,traffic_covered_meters:i===1?6000:12000},{seconds:4800,meters:15000,congested_meters:null,traffic_covered_meters:0}],image:"data:image/png;base64,c3ludGhldGlj",fetched_at:"2026-01-05T00:00:00+08:00"}))}:this.path==="/api/weather/view"?weatherData:this.path==="/api/bus/view"?timedBus:this.path==="/api/display/auto"?{mode:autoMode,view:autoMode==="bus"?timedBus:data}:data);this.readyState=4;this.onreadystatechange();}
  abort(){}
}
vm.runInNewContext(fs.readFileSync("dashboard/web/display.js","utf8"),{document:doc,window:{addEventListener(n,f){windowEvents[n]=f;}},XMLHttpRequest:XHR,Date:FakeDate,setTimeout:setTimer,clearTimeout:clearTimer});
function click(id){el(id).onclick();}
function heading(expected){assert.equal(el("heading").textContent,expected);}
el("token").value="example-display-token";click("connect");heading("待办清单");
data={...sample,week_menu:[meal,{...meal,day:"2026-01-06",dishes:["Tomorrow dish"]}],menu_range:{first:date,last:"2026-01-11"}};
weatherData={...weatherExample,additional:[{...weatherExample,name:"Other location",sections:{...weatherExample.sections,alerts:{status:"available",data:[{headline:"Other warning"}]}}}]};
busData={...bus,snapshot:{...bus.snapshot,status:"no_live_data",vehicles:[],departure_plans:[{time:"13:45"},{time:"14:00"}]}};
click("overviewMode");
assert.equal(el("body").className,"overview-page");
assert.equal(el("date").children.length,2);
assert.equal(el("date").children[0].className,"overview-clock");
assert.match(el("date").children[0].textContent,/^\d\d:\d\d$/);
assert.equal(el("date").children[1].className,"overview-day");
assert.equal(el("date").children[1].textContent,"1月5日 周一");
assert.ok(descendants(el("body")).some(n=>n.textContent==="Tomorrow dish"));
assert.ok(descendants(el("overviewWeather")).some(n=>n.textContent==="Other location：Other warning"));
assert.equal(el("overviewWeather").className,"");
assert.equal(el("displayHeader").className,"overview-header");
assert.equal(el("displayNav")["data-overview"],"true");
const overviewClock=el("date").children[0],overviewCalendar=el("date").children[1];
assert.ok(!descendants(el("overviewWeather")).some(n=>n.textContent==="Example"||n.textContent==="Example 1/2"));
const visibleWeather=descendants(el("overviewWeather")).find(n=>n.className==="weather-main");
assert.ok(visibleWeather);assert.equal(fullText(visibleWeather),"20°　晴");assert.equal(visibleWeather.children[0].className,"overview-number-value");
weatherData={...weatherData,sections:{...weatherData.sections,hourly:{status:"available",data:[]}}};
advance(30000);
assert.equal(descendants(el("overviewWeather")).find(n=>n.className==="weather-main"),visibleWeather);
assert.equal(el("date").children[0],overviewClock);assert.equal(el("date").children[1],overviewCalendar);
const readCount=requests;
doc.hidden=true;events.visibilitychange();advance(30000);assert.equal(requests,readCount);
doc.hidden=false;events.visibilitychange();
assert.equal(el("body").className,"overview-page");
assert.equal(el("displayNav").className,"");
assert.equal(descendants(el("body")).filter(n=>n.className.indexOf("driving-group")===0).length,2);
assert.equal(descendants(el("body")).filter(n=>n.className.indexOf("overview-driving-card")>=0).length,2);
assert.equal(descendants(el("body")).filter(n=>n.className.indexOf("driving-route-row")===0).length,4);
assert.ok(descendants(el("body")).some(n=>n.className==="driving-route-time"&&fullText(n)==="1小时20分钟"&&n.children.filter(c=>c.className==="overview-number-value").length===2));
const switches=descendants(el("body")).filter(n=>n.className==="driving-reverse");assert.equal(switches.length,2);switches[1].onclick();assert.equal(directionWrites,1);assert.deepEqual(reversedGroups,[false,true,false]);assert.ok(!descendants(el("body")).some(n=>n.textContent.indexOf("返程")===0));assert.equal(descendants(el("body")).filter(n=>n.className==="driving-reverse")[1].title,"切换为原方向");assert.deepEqual(descendants(el("body")).filter(n=>n.className==="driving-foot").map(n=>n.textContent),["仅 2 条","仅 2 条"]);
const busName=descendants(el("body")).find(n=>n.className==="overview-bus-name"),busDirection=descendants(el("body")).find(n=>n.className==="overview-bus-direction");
assert.equal(busName.textContent,"Example line");assert.equal(busDirection.textContent," · A → B");
const busHeader=descendants(el("body")).find(n=>n.children[0]===busName&&n.children[1]===busDirection);
assert.ok(busHeader);assert.equal(busHeader.className,"overview-link");assert.equal(busHeader.title,"Example line · A → B");
const vehicleRow=descendants(el("body")).find(n=>n.className==="overview-bus-slots");
assert.equal(vehicleRow.children.length,2);
assert.ok(vehicleRow.children.every(n=>n.className==="overview-bus-slot"));
assert.ok(!descendants(el("body")).some(n=>n.className==="overview-bus-label"));
assert.ok(vehicleRow.children.every(n=>n.children[0].className==="overview-bus-line"));
assert.ok(descendants(el("body")).some(n=>n.textContent==="等待发车"));
assert.ok(descendants(el("body")).some(n=>n.textContent==="首车 · 计划 13:45"));
assert.ok(descendants(el("body")).some(n=>n.textContent==="次车 · 计划 14:00"));
const noOverviewTimestamps=()=>!descendants(el("body")).some(n=>/更新\s+\d\d:\d\d|数据更新于|更新于\s/.test(n.textContent));
assert.ok(noOverviewTimestamps());
const compactBusStatus=()=>descendants(el("body")).find(n=>n.className.indexOf("overview-bus-status")>=0);
assert.equal(compactBusStatus().textContent,"");
assert.ok(!descendants(el("body")).some(n=>/最近一辆|下一辆|发车计划|本站到站时间未知|等待首站发车（计划）/.test(n.textContent)));
const overviewHome=descendants(el("body")).find(n=>n.className==="overview-home");
assert.equal(overviewHome.children.length,2);assert.equal(overviewHome.children[0].className,"overview-todos");assert.equal(overviewHome.children[1].className,"overview-menu");
assert.equal(overviewHome.children[0].children[0].textContent,"待办");assert.equal(overviewHome.children[1].children[0].textContent,"菜单");
const stableMenuTitle=overviewHome.children[1].children[1].children[0];
const beforeTasks=data;
data={...data,upcoming_tasks:[task,{...task,id:"next-day",occurrence:"2026-01-06",title:"Fictional next day"}]};
advance(30000);
const days=descendants(el("body")).filter(n=>n.className==="task-day");
assert.equal(days.length,2);assert.equal(days[0].children[0].className,"task-date");assert.equal(days[1].children[0].className,"task-date");
assert.equal(overviewHome.children[1].children[1].children[0],stableMenuTitle);
data={...data,upcoming_tasks:[task,...Array.from({length:5},(_,i)=>({...task,id:"future-"+i,occurrence:"2026-01-06",title:"Future scroll "+i}))],can_complete:true};
advance(30000);
assert.ok(descendants(el("body")).some(n=>n.textContent==="Future scroll 4"));
const circles=descendants(el("body")).filter(n=>n.className==="task-complete overview-task-circle");
assert.equal(circles.length,1);assert.equal(circles[0].textContent,"○");assert.equal(circles[0]["aria-label"],"完成待办");
assert.equal(descendants(el("body")).filter(n=>n.className==="overview-task-inactive").length,5);
data=beforeTasks;advance(30000);
assert.ok(descendants(el("body")).some(n=>n.textContent==="12.0km"));
assert.ok(descendants(el("body")).some(n=>n.textContent==="15.0km"));
assert.ok(!descendants(el("body")).some(n=>/已知拥堵|路况未知|路线及地图：高德地图/.test(n.textContent)));
assert.ok(descendants(el("body")).some(n=>n.textContent==="另 1 个目的地"));
assert.ok(!descendants(el("body")).some(n=>/全部路线/.test(n.textContent)));
assert.ok(descendants(el("body")).some(n=>n.textContent==="Example dish"));
assert.ok(descendants(el("body")).some(n=>n.textContent==="Example task"));
assert.ok(descendants(el("overviewWeather")).some(n=>n.className==="weather-main"&&fullText(n)==="20°　晴"));
assert.ok(!descendants(el("body")).some(n=>n.className==="weather-main"));
const stableTodo=descendants(el("body")).find(n=>n.className==="overview-todos").children[1].children[0];
data={...data,week_menu:data.week_menu.filter(m=>m.day!==date)};
advance(30000);
assert.equal(descendants(el("body")).find(n=>n.className==="overview-todos").children[1].children[0],stableTodo);
assert.ok(!descendants(el("body")).some(n=>n.textContent==="01/05 今日"||n.textContent==="Example dish"));
assert.ok(descendants(el("body")).some(n=>n.textContent==="01/06 明日"));assert.ok(descendants(el("body")).some(n=>n.textContent==="Tomorrow dish"));
assert.ok(!descendants(el("body")).some(n=>/^观测\s/.test(n.textContent)));
assert.ok(!descendants(el("body")).some(n=>/和风天气|Open-Meteo|Example data provider/.test(n.textContent)||/qweather\.com|open-meteo\.com/.test(n.href||"")));
assert.ok(!descendants(el("body")).some(n=>n.textContent.indexOf("天气服务由")>=0));
// Overview expiry stays active without a timestamp node, even between LAN reads.
busData={...bus,snapshot:{...bus.snapshot,fetched_at:new Date(FakeDate.now()-70000).toISOString()}};
drivingStatus="stale";
advance(15000);
assert.equal(compactBusStatus().textContent,"");
assert.ok(descendants(el("body")).some(n=>n.className==="overview-bus-eta"&&fullText(n)==="约 3 分钟"&&n.children.some(c=>c.className==="overview-number-value"&&c.textContent==="3")));
assert.ok(descendants(el("body")).some(n=>n.className==="overview-bus-time"&&/^首车 · 预计 \d\d:\d\d$/.test(n.textContent)));
assert.ok(descendants(el("body")).some(n=>n.className==="overview-bus-time"&&/^次车 · 预计 \d\d:\d\d$/.test(n.textContent)));
const requestsAtDeadline=busRequests;
advance(5000);
assert.equal(busRequests,requestsAtDeadline);
assert.equal(compactBusStatus().textContent,"数据已过期");
assert.ok(descendants(el("body")).some(n=>n.textContent==="等待更新"));
assert.ok(descendants(el("body")).some(n=>n.className==="overview-bus-time"&&n.textContent==="首车"));
assert.ok(descendants(el("body")).filter(n=>n.className==="overview-bus-time").every(n=>!/预计|计划/.test(n.textContent)));
busData={...bus,snapshot:{...bus.snapshot,status:"stale",fetched_at:new Date(FakeDate.now()).toISOString()}};
advance(10000);
assert.equal(compactBusStatus().textContent,"数据未更新");
assert.ok(descendants(el("body")).some(n=>n.textContent.indexOf("旧数据")>=0));
assert.ok(noOverviewTimestamps());
busData={...bus,snapshot:{...bus.snapshot,fetched_at:new Date(FakeDate.now()).toISOString()}};
drivingStatus="ok";
advance(30000);
assert.equal(compactBusStatus().textContent,"");
assert.ok(noOverviewTimestamps());
const fixedBusRows=()=>{const root=descendants(el("body")).find(n=>n.className==="overview-bus-slots");assert.equal(root.children.length,2);assert.ok(root.children.every(n=>n.children.length===2&&n.children[0].children.length===2));assert.ok(compactBusStatus());};
for(const state of ["paused","disabled","blocked","unverified","needs_selection","expired","no_live_data"]){
  busData={...bus,snapshot:{...bus.snapshot,status:state,vehicles:[],departure_plans:[],fetched_at:new Date(FakeDate.now()).toISOString()}};
  advance(15000);fixedBusRows();
  assert.ok(!descendants(el("body")).some(n=>n.className==="overview-bus-time"&&/预计|计划/.test(n.textContent)));
}
busData=bus;advance(15000);
click("settings");assert.equal(el("manageLink").href,"/bus#return-overview");click("returnDisplay");
data=sample;weatherData=weatherExample;busData=bus;
click("weatherMode");assert.equal(el("date").children.length,0);assert.equal(el("displayNav")["data-overview"],"false");assert.equal(el("displayHeader").className,"");assert.equal(el("overviewWeather").className,"hidden");assert.equal(el("overviewWeather").children.length,0);heading("Example");assert.ok(!descendants(el("body")).some(n=>/^观测\s/.test(n.textContent)));assert.ok(!descendants(el("body")).some(n=>/和风天气|Open-Meteo|Example data provider/.test(n.textContent)||/qweather\.com|open-meteo\.com/.test(n.href||"")));assert.ok(!descendants(el("body")).some(n=>n.textContent.indexOf("天气服务由")>=0));assert.ok(descendants(el("body")).some(n=>n.textContent==="20°C　晴"));assert.ok(descendants(el("body")).some(n=>n.textContent.includes("暂不可用")));
advance(240000);heading("Example");assert.equal(el("index").textContent,"");
weatherData={...weatherExample,additional:[{...weatherExample,name:"Example second",sections:{current:{...weatherExample.sections.current,data:{...weatherExample.sections.current.data,temp:25}}}}]};
advance(30000);heading("Example");assert.equal(el("index").textContent,"1 / 2");
const weatherFirst=el("body").children[0];advance(90000);heading("Example");assert.equal(el("body").children[0],weatherFirst);
advance(30000);heading("Example second");assert.equal(el("index").textContent,"2 / 2");assert.ok(descendants(el("body")).some(n=>n.textContent==="25°C　晴"));
assert.ok(!descendants(el("body")).some(n=>n.textContent==="20°C　晴"));
click("settings");advance(240000);heading("Example second");click("returnDisplay");advance(120000);heading("Example");
click("settings");click("weatherNext");heading("Example second");assert.equal(el("settingsPanel").className,"hidden");
doc.hidden=true;events.visibilitychange();const weatherHidden=requests;advance(240000);assert.equal(requests,weatherHidden);
doc.hidden=false;events.visibilitychange();heading("Example");
weatherData=weatherExample;advance(30000);heading("Example");assert.equal(el("index").textContent,"");advance(240000);heading("Example");
click("tasksMode");heading("待办清单");
data={...sample,upcoming_tasks:[{id:"overdue",title:"Overdue example",occurrence:"2026-01-03"},task,{id:"next",title:"Tomorrow example",occurrence:"2026-01-06"},{id:"far",title:"Future example",occurrence:"2030-01-01"},{id:"same",title:"Another future example",occurrence:"2030-01-01"}]};
advance(30000);
assert.equal(descendants(el("body")).filter(n=>n.className==="task-date").length,4);
assert.equal(descendants(el("body")).filter(n=>n.className==="task-row").length,5);
assert.ok(descendants(el("body")).some(n=>n.textContent==="逾期"));
assert.ok(descendants(el("body")).some(n=>n.textContent==="明日"));
assert.ok(descendants(el("body")).some(n=>n.textContent.indexOf("2030/01/01")===0));
assert.ok(!descendants(el("body")).some(n=>n.className==="task-complete"));
data=sample;
click("drivingMode");heading("驾驶");assert.equal(descendants(el("body")).filter(n=>n.className==="driving-group").length,3);assert.equal(descendants(el("body")).filter(n=>n.tag==="img").length,3);assert.ok(descendants(el("body")).some(n=>n.textContent==="1  10分钟"));assert.ok(descendants(el("body")).some(n=>n.textContent==="2  1小时20分钟"));assert.equal(descendants(el("body")).filter(n=>n.className==="driving-reverse").length,3);assert.ok(descendants(el("body")).some(n=>n.className==="driving-foot"&&n.textContent.indexOf("更新于")>=0));assert.ok(descendants(el("body")).some(n=>n.className==="driving-foot"&&n.textContent.indexOf("返程")===0));assert.ok(descendants(el("body")).some(n=>n.textContent==="12.0km"));assert.ok(descendants(el("body")).some(n=>n.textContent==="15.0km"));assert.ok(!descendants(el("body")).some(n=>/已知拥堵|路况未知/.test(n.textContent)));click("tasksMode");heading("待办清单");
assert.equal(el("token").value,"");assert.equal(el("familyControls").className,"hidden");
assert.equal(el("settingsPanel").className,"hidden");click("settings");assert.equal(el("displayContent").className,"hidden");assert.equal(el("settingsPanel").className,"");assert.equal(el("manageLink").href,"/bus#return-tasks");assert.equal(el("displayManage").href,"/home#display/return-tasks");click("returnDisplay");assert.equal(el("displayContent").className,"");heading("待办清单");
const first=el("body").children[0];advance(30000);assert.equal(el("body").children[0],first);
const before=requests;click("postersMode");heading("Example reminder");
assert.equal(el("body").children[0].textContent,"Line one\nLine two");
click("menusMode");heading("本周菜单");assert.ok(descendants(el("body")).some(n=>n.textContent==="Example dish"));
assert.equal(descendants(el("body")).filter(n=>n.className==="menu-today").length,1);
assert.equal(requests,before);
// Multiple meals share one date heading; today follows the NAS date, not the device clock.
data={...sample,week_menu:[{...meal,day:"2026-01-06",dishes:["Next dish"]},meal,{...meal,meal:"breakfast",dishes:["Morning dish"]}]};
advance(30000);
let dates=descendants(el("body")).filter(n=>n.className==="menu-date");
assert.deepEqual(dates.map(n=>n.textContent),[date,"2026-01-06"]);
assert.equal(dates[0].children[0].textContent,"今日");
assert.equal(dates[1].children.length,0);
assert.deepEqual(descendants(el("body")).filter(n=>n.className==="menu-meal-label").map(n=>n.textContent),["早餐","晚餐","晚餐"]);
data={...data,date:"2026-01-06"};advance(30000);
dates=descendants(el("body")).filter(n=>n.className==="menu-date");
assert.equal(dates[0].children.length,0);assert.equal(dates[1].children[0].textContent,"今日");
click("postersMode");data={...sample,posters:[poster,{...poster,id:"test-poster-2",title:"Second reminder"}]};advance(30000);
click("settings");el("seconds").value="120";click("apply");click("pause");
advance(120000);heading("Second reminder");advance(120000);heading("Example reminder");
click("next");heading("Second reminder");advance(120000);heading("Second reminder");
click("menusMode");advance(180000);heading("本周菜单");
click("postersMode");data={...sample,posters:[]};advance(30000);heading("海报");
assert.equal(el("body").children[0].textContent,"暂无有效海报");
click("tasksMode");data={date,tasks:[],posters:[],week_menu:[]};advance(30000);
heading("待办清单");assert.equal(el("body").children[0].textContent,"暂无待办");
doc.hidden=true;events.visibilitychange();const hiddenCount=requests;advance(120000);assert.equal(requests,hiddenCount);
doc.hidden=false;data=sample;events.visibilitychange();heading("待办清单");
fail=503;advance(30000);heading("");assert.equal(el("body").children.length,0);
fail=0;advance(30000);heading("待办清单");
busData={...bus,snapshot:{...bus.snapshot,fetched_at:new Date(FakeDate.now()-5000).toISOString()}};click("busMode");heading("Example line");assert.equal(el("familyControls").className,"hidden");
assert.ok(busNodes().some(n=>n.textContent==="约 4 分钟"));
assert.ok(busNodes().some(n=>n.textContent==="约 9 分钟"));
const oldBus=busRequests;const ageBefore=el("body").children.at(-1).textContent;assert.ok(ageBefore.startsWith("数据更新于"));advance(5000);assert.equal(busRequests,oldBus);assert.equal(el("body").children.at(-1).textContent,ageBefore);advance(10000);assert.equal(busRequests,oldBus+1);advance(45000);assert.ok(busNodes().some(n=>n.textContent==="约 3 分钟"));assert.equal(el("body").children.at(-1).textContent,ageBefore);
// The same cached prediction does not recreate the vehicle DOM.
const firstEta=busNodes().find(n=>n.className==="bus-left eta");
busData={...bus,snapshot:{...bus.snapshot,fetched_at:new Date(FakeDate.now()).toISOString()}};advance(15000);
assert.equal(busNodes().find(n=>n.className==="bus-left eta"),firstEta);
assert.equal(firstEta.textContent,"约 4 分钟"); // new sample can increase ETA
busData={...busData,snapshot:{...busData.snapshot,fetched_at:new Date(FakeDate.now()).toISOString(),vehicles:[{...bus.snapshot.vehicles[0],distance_m:250,eta_min:5},bus.snapshot.vehicles[1]]}};advance(15000);
assert.equal(busNodes().find(n=>n.className==="bus-left eta"),firstEta);assert.equal(firstEta.textContent,"约 5 分钟");assert.ok(busNodes().some(n=>n.textContent.includes("250 米")));
busData={...bus,snapshot:{...bus.snapshot,fetched_at:new Date(FakeDate.now()).toISOString()}};advance(15000);
assert.ok(busNodes().some(n=>n.textContent.startsWith("预计到站\n")));
busData={...busData,snapshot:{...busData.snapshot,status:"stale"}};advance(15000);
assert.ok(busNodes().some(n=>n.textContent==="约 4 分钟"));assert.ok(busNodes().some(n=>n.textContent.includes("旧数据")));
busData={...bus,snapshot:{...bus.snapshot,fetched_at:new Date(FakeDate.now()).toISOString(),vehicles:[{...bus.snapshot.vehicles[0],eta_min:1},bus.snapshot.vehicles[1]]}};advance(15000);
assert.ok(busNodes().some(n=>n.textContent==="预计即将到站"));
advance(45000);assert.ok(busNodes().some(n=>n.textContent==="等待到站确认"));assert.equal(busNodes().filter(n=>n.className.indexOf("bus-left eta")===0).length,2);
advance(30000);assert.ok(busNodes().some(n=>n.textContent==="等待数据更新"));
busData={...bus,snapshot:{...bus.snapshot,status:"no_live_data",vehicles:[],scheduled_departures:1,departure_plans:[{time:"12:00",imminent:true}],fetched_at:new Date(FakeDate.now()).toISOString()}};advance(15000);
assert.ok(busNodes().some(n=>n.textContent.includes("等待首站发车")));assert.ok(busNodes().some(n=>n.textContent.includes("计划即将发车")));
advance(75000);assert.ok(!busNodes().some(n=>n.textContent.includes("计划即将发车")));
busData={...bus,snapshot:{...bus.snapshot,status:"expired",vehicles:[]}};advance(15000);
assert.ok(!busNodes().some(n=>n.className.indexOf("bus-left eta")===0));assert.ok(!busNodes().some(n=>n.textContent.includes("数据更新于")));
click("tasksMode");heading("待办清单");assert.equal(el("familyControls").className,"hidden");
const endBus=busRequests;advance(60000);assert.equal(busRequests,endBus);
fail=401;advance(30000);assert.equal(el("display").className,"hidden");assert.equal(el("login").className,"");
assert.equal(el("body").children.length,0);assert.equal(timers.size,0);
fail=0;el("token").value="example-display-token";click("connect");windowEvents.pagehide();
assert.equal(el("display").className,"hidden");assert.equal(timers.size,0);heading("");
fail=404;el("token").value="example-display-token";click("connect");
assert.equal(el("display").className,"");fail=0;click("busMode");heading("Example line");click("logout");
assert.equal(timers.size,0);
// Saved preferences restore on a new connection, while a manual pause survives
// ordinary refreshes. Long poster chunks must preserve the original string.
const longBody="示例文字".repeat(25)+"😀\n"+"第二行\n".repeat(7)+"末尾";
data={...sample,tasks:[],posters:[{...poster,body:longBody}],today_menu:[],week_menu:[],shopping:[],
  display_settings:{seconds:120,include_week:true,include_shopping:true,autoplay:true}};
el("token").value="example-display-token";click("connect");click("postersMode");
assert.equal(el("pause").textContent,"暂停轮播");
assert.ok(el("heading").textContent.indexOf("Example reminder · 1/")===0);
let joined="",last=false;
while(!last){
  const title=el("heading").textContent;
  const m=title.match(/(\d+)\/(\d+)$/);assert.ok(m);
  joined+=el("body").children[0].textContent;
  last=m[1]===m[2];if(!last)click("next");
}
assert.equal(joined,longBody);
assert.equal(el("body").children[1].textContent,"Example note");
assert.equal(el("pause").textContent,"开始轮播");
const pinned=el("heading").textContent;advance(120000);heading(pinned);
click("logout");el("token").value="example-display-token";click("connect");click("postersMode");
assert.equal(el("pause").textContent,"暂停轮播");click("logout");assert.equal(timers.size,0);
data=sample;busData=bus;autoMode="family";
el("token").value="example-display-token";click("connect");heading("待办清单");
const autoBefore=autoRequests;click("autoMode");heading("待办清单");assert.equal(autoRequests,autoBefore+1);
autoMode="bus";advance(30000);heading("Example line");
assert.equal(el("familyControls").className,"hidden");
autoMode="family";advance(15000);heading("待办清单");
click("postersMode");heading("Example reminder");const pinnedAuto=autoRequests;
autoMode="bus";advance(60000);heading("Example reminder");assert.equal(autoRequests,pinnedAuto);
click("autoMode");heading("Example line");
click("busMode");const manualAuto=autoRequests;autoMode="family";advance(30000);heading("Example line");assert.equal(autoRequests,manualAuto);
click("autoMode");heading("待办清单");click("postersMode");click("settings");const settingsAuto=autoRequests;autoMode="bus";advance(60000);heading("Example reminder");assert.equal(autoRequests,settingsAuto);click("cancel");
click("autoMode");heading("Example line");doc.hidden=true;events.visibilitychange();
const asleep=autoRequests;advance(60000);assert.equal(autoRequests,asleep);
autoMode="family";doc.hidden=false;events.visibilitychange();heading("待办清单");
fail=503;advance(30000);heading("");fail=0;advance(30000);heading("待办清单");
click("logout");assert.equal(timers.size,0);
// Foregrounding must re-read fresh content without jumping to another tab.
data={...sample,posters:[poster,{...poster,id:"test-poster-2",title:"Second reminder"}]};fail=0;el("token").value="example-display-token";click("connect");
click("postersMode");click("next");heading("Second reminder");
doc.hidden=true;events.visibilitychange();const pausedRequests=requests;
advance(300000);assert.equal(requests,pausedRequests);
doc.hidden=false;events.visibilitychange();heading("Second reminder");
assert.equal(el("pause").textContent,"开始轮播");
click("pause");doc.hidden=true;events.visibilitychange();advance(300000);
doc.hidden=false;events.visibilitychange();heading("Second reminder");
assert.equal(el("pause").textContent,"暂停轮播");
advance(180000);heading("Example reminder");
doc.hidden=true;events.visibilitychange();data={...sample,posters:[]};
doc.hidden=false;events.visibilitychange();heading("海报");
click("logout");assert.equal(timers.size,0);
// Direct manual display: a new script instance (mobile tab reload) restores
// only tab-local page identity and rotation metadata after a fresh response.
const storage=new Map();
const sessionStorage={getItem(k){return storage.get(k)||null;},setItem(k,v){storage.set(k,v);},removeItem(k){storage.delete(k);}};
function directDisplay(){
  vm.runInNewContext(fs.readFileSync("dashboard/web/display.js","utf8"),{
    document:doc,window:{KHD_ACCESS:{direct:true},sessionStorage,addEventListener(n,f){windowEvents[n]=f;}},
    location:{pathname:"/display"},XMLHttpRequest:XHR,setTimeout:setTimer,clearTimeout:clearTimer
  });
}
data={...sample,posters:[poster,{...poster,id:"test-poster-2",title:"Second reminder"}]};directDisplay();heading("待办清单");
click("postersMode");heading("Example reminder");
click("pause");doc.hidden=true;events.visibilitychange();
assert.equal(storage.size,1);
const serialized=[...storage.values()][0];
assert.ok(!serialized.includes("Line one")&&!serialized.includes("Example reminder")&&!serialized.includes("token"));
windowEvents.pagehide();assert.equal(timers.size,0);
doc.hidden=false;directDisplay();heading("Example reminder");
assert.equal(el("pause").textContent,"暂停轮播");
advance(180000);heading("Second reminder");
windowEvents.pagehide();windowEvents.pageshow({persisted:true});heading("Second reminder");
click("logout");assert.equal(storage.size,0);assert.equal(timers.size,0);
directDisplay();heading("待办清单");click("logout");
console.log("Household display simulation passed: automatic switching, override, saved settings, long poster preservation, unified bus/family display, rotation, pinning, settings, unchanged content, expiry/removal, hidden tab, failure, logout.");

// Authorized completion: cancellation, failed write, successful write, no automatic deletion.
{
  let confirmed=false, posts=0, postFail=true, future={id:"future",title:"Future example",occurrence:"2026-01-06"},current={...sample,can_complete:true,upcoming_tasks:[task,future]};
  class TaskXHR {
    open(method,path){this.method=method;this.path=path;}
    setRequestHeader(){}
    send(body){
      this.status=200;
      if(this.method==="POST"){
        posts++;assert.deepEqual(JSON.parse(body),{key:task.id,on:date,completed:true});
        this.status=postFail?503:200;
        if(!postFail)current={...current,tasks:[],upcoming_tasks:[future]};
        this.responseText=JSON.stringify(postFail?{error:"service_error"}:{result:null});
      }else this.responseText=JSON.stringify(current);
      this.readyState=4;this.onreadystatechange();
    }
    abort(){}
  }
  vm.runInNewContext(fs.readFileSync("dashboard/web/display.js","utf8"),{document:doc,window:{KHD_ACCESS:{direct:true,openAdmin:true},confirm:()=>confirmed,addEventListener(){}},XMLHttpRequest:TaskXHR,Date:FakeDate,setTimeout:setTimer,clearTimeout:clearTimer});
  const completeButton=()=>descendants(el("body")).find(n=>n.tag==="button"&&n.textContent==="完成");
  assert.equal(descendants(el("body")).filter(n=>n.className==="task-complete").length,1);assert.ok(completeButton());completeButton().onclick();assert.equal(posts,0);
  confirmed=true;completeButton().onclick();assert.equal(posts,1);assert.ok(completeButton());assert.ok(el("status").textContent.includes("未确认"));
  postFail=false;completeButton().onclick();assert.equal(posts,2);assert.ok(!completeButton());assert.ok(descendants(el("body")).some(n=>n.textContent==="Future example"));
}


// The embedded admin preview is interactive only after its same-origin parent
// supplies the already-verified session token; credentials never enter the URL.
{
  const previewNodes={},previewEvents={},parent={messages:[],postMessage(message,origin){this.messages.push([message,origin]);}};
  const previewDoc={
    getElementById(id){return previewNodes[id]||(previewNodes[id]=new Node(id));},
    createElement(tag){return new Node(tag);},
    addEventListener(n,f){previewEvents["doc:"+n]=f;}
  };
  const pEl=id=>previewDoc.getElementById(id);
  const pDesc=n=>n.children.flatMap(c=>[c,...pDesc(c)]);
  let posted=0;
  const current={...sample,can_complete:true,upcoming_tasks:[task]};
  class PreviewXHR {
    open(method,path){this.method=method;this.path=path;}
    setRequestHeader(k,v){
      if(k==="Authorization")assert.equal(v,"Bearer parent-admin-token");
      else if(k==="Content-Type")assert.equal(v,"application/json");
      else assert.fail("Unexpected request header "+k);
    }
    send(body){
      if(this.method==="GET"){assert.equal(this.path,"/api/home/view");this.status=200;this.responseText=JSON.stringify(current);}
      else{
        assert.equal(this.path,"/api/home/task/complete");
        assert.deepEqual(JSON.parse(body),{key:task.id,on:date,completed:true});
        posted++;current.tasks=[];current.upcoming_tasks=[];this.status=200;this.responseText=JSON.stringify({result:null});
      }
      this.readyState=4;this.onreadystatechange();
    }
    abort(){}
  }
  const previewWindow={parent,addEventListener(n,f){previewEvents[n]=f;},confirm:()=>true};
  vm.runInNewContext(fs.readFileSync("dashboard/web/display.js","utf8"),{
    document:previewDoc,window:previewWindow,location:{pathname:"/preview",hash:"#tasks",origin:"http://127.0.0.1"},
    XMLHttpRequest:PreviewXHR,Date:FakeDate,setTimeout:setTimer,clearTimeout:clearTimer
  });
  assert.ok(parent.messages.some(x=>x[0].type==="khd-admin-preview-auth-request"));
  assert.equal(pDesc(pEl("body")).filter(n=>n.className==="task-complete").length,0);
  previewEvents.message({origin:"http://127.0.0.1",source:parent,data:{type:"khd-admin-preview-auth",token:"parent-admin-token"}});
  assert.equal(pDesc(pEl("body")).filter(n=>n.className==="task-complete").length,1);
  const complete=pDesc(pEl("body")).find(n=>n.className==="task-complete");
  complete.onclick();assert.equal(posted,1);
  assert.equal(pDesc(pEl("body")).filter(n=>n.className==="task-complete").length,0);
}
