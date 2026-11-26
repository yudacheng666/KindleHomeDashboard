/* Deterministic display tests: simulated DOM, clock and read-only XHR. */
const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict");
class Node {
  constructor(tag){this.tag=tag;this.children=[];this.textContent="";this.value="";this.checked=false;this.className="";}
  get firstChild(){return this.children[0];}
  appendChild(n){this.children.push(n);return n;}
  removeChild(n){this.children.splice(this.children.indexOf(n),1);}
}
const nodes={},events={},windowEvents={};
const doc={hidden:false,getElementById(id){return nodes[id]||(nodes[id]=new Node(id));},
  createElement(tag){return new Node(tag);},addEventListener(name,fn){events[name]=fn;}};
const el=id=>doc.getElementById(id);
const date="2026-01-05",task={id:"test-task",title:"Example task"};
const poster={id:"test-poster",title:"Example reminder",body:"Line one\nLine two",note:"Example note"};
const meal={day:date,meal:"dinner",dishes:["Example dish"]};
const shopping={id:"test-item",label:"Example ingredient",completed:0};
const sample={date,tasks:[task],posters:[poster],today_menu:[meal],week_menu:[meal],shopping:[shopping]};
const bus={trip:{line:{name:"Example line"},boarding:{name:"A"},destination:{name:"B"}},snapshot:{status:"live",vehicles:[{position:1,eta_min:4,distance_m:300,stops_remaining:1},{position:2,eta_min:9,distance_m:null,stops_remaining:null}],scheduled_departures:0,fetched_at:"2026-01-05T00:00:00+00:00"}};
let data=sample,fail=0,requests=0,clock=0,nextId=1,busRequests=0,busData=bus, autoMode="family", autoRequests=0;
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
class XHR {
  open(method,path){assert.equal(method,"GET");assert.ok(["/api/home/view","/api/bus/view","/api/display/auto"].includes(path));this.path=path;}
  setRequestHeader(k,v){assert.equal(k,"Authorization");assert.equal(v,"Bearer example-display-token");}
  send(body){assert.equal(body,null);requests++;if(this.path==="/api/bus/view")busRequests++;if(this.path==="/api/display/auto")autoRequests++;this.status=fail||200;this.responseText=JSON.stringify(fail?{}:this.path==="/api/bus/view"?busData:this.path==="/api/display/auto"?{mode:autoMode,view:autoMode==="bus"?busData:data}:data);this.readyState=4;this.onreadystatechange();}
  abort(){}
}
vm.runInNewContext(fs.readFileSync("dashboard/web/display.js","utf8"),{document:doc,window:{addEventListener(n,f){windowEvents[n]=f;}},XMLHttpRequest:XHR,Date:FakeDate,setTimeout:setTimer,clearTimeout:clearTimer});
function click(id){el(id).onclick();}
function heading(expected){assert.equal(el("heading").textContent,expected);}
el("token").value="example-display-token";click("connect");heading("今日生活");
assert.equal(el("token").value,"");assert.equal(el("pause").textContent,"开始轮播");
const first=el("body").children[0];advance(30000);assert.equal(el("body").children[0],first);
advance(180000);heading("今日生活"); // No rotation until opted in.
const before=requests;click("next");heading("今日待办");click("next");heading("Example reminder");
assert.equal(el("body").children[0].textContent,"Line one\nLine two");
assert.equal(requests,before); // manual changes are local only.
click("pause");advance(180000);heading("今日菜单");advance(180000);heading("今日生活");
click("settings");el("seconds").value="120";el("week").checked=true;el("shopping").checked=true;click("apply");
advance(120000);heading("今日待办");advance(120000);heading("Example reminder");
advance(120000);heading("今日菜单");advance(120000);heading("本周菜单");advance(120000);heading("购物清单");
click("previous");heading("本周菜单");advance(120000);heading("本周菜单"); // manual pin
click("previous");click("previous");heading("Example reminder");
data={...sample,posters:[]};advance(30000);heading("今日生活"); // removed page falls back
data={date,tasks:[],posters:[],today_menu:[],week_menu:[],shopping:[]};advance(30000);
heading("今日生活");assert.equal(el("body").children[0].textContent,"暂无家庭安排");
click("pause");advance(300000);heading("今日生活"); // single page stays put
doc.hidden=true;events.visibilitychange();const hiddenCount=requests;advance(120000);assert.equal(requests,hiddenCount);
doc.hidden=false;data=sample;events.visibilitychange();heading("今日生活");
fail=503;advance(30000);heading("");assert.equal(el("body").children.length,0);
fail=0;advance(30000);heading("今日生活");
busData={...bus,snapshot:{...bus.snapshot,fetched_at:new Date(FakeDate.now()-5000).toISOString()}};click("busMode");heading("Example line");assert.equal(el("familyControls").className,"hidden");
assert.ok(el("body").children.some(n=>n.textContent==="约 4 分钟"));
assert.ok(el("body").children.some(n=>n.textContent==="约 9 分钟"));
const oldBus=busRequests;const ageBefore=el("body").children.at(-1).textContent;assert.ok(ageBefore.startsWith("数据更新于"));advance(5000);assert.equal(busRequests,oldBus);assert.equal(el("body").children.at(-1).textContent,ageBefore);advance(10000);assert.equal(busRequests,oldBus+1);advance(45000);assert.ok(el("body").children.some(n=>n.textContent==="约 3 分钟"));assert.equal(el("body").children.at(-1).textContent,ageBefore);
// The same cached prediction does not recreate the vehicle DOM.
const firstEta=el("body").children.find(n=>n.className==="eta");
busData={...bus,snapshot:{...bus.snapshot,fetched_at:new Date(FakeDate.now()).toISOString()}};advance(15000);
assert.equal(el("body").children.find(n=>n.className==="eta"),firstEta);
assert.equal(firstEta.textContent,"约 4 分钟"); // new sample can increase ETA
assert.ok(el("body").children.some(n=>n.textContent.startsWith("预计到站 ")));
busData={...busData,snapshot:{...busData.snapshot,status:"stale"}};advance(15000);
assert.ok(el("body").children.some(n=>n.textContent==="旧预测 · 约 4 分钟"));
busData={...bus,snapshot:{...bus.snapshot,fetched_at:new Date(FakeDate.now()).toISOString(),vehicles:[{...bus.snapshot.vehicles[0],eta_min:1},bus.snapshot.vehicles[1]]}};advance(15000);
assert.ok(el("body").children.some(n=>n.textContent==="预计即将到站"));
advance(45000);assert.ok(el("body").children.some(n=>n.textContent==="等待到站确认"));assert.equal(el("body").children.filter(n=>n.className==="eta").length,2);
advance(30000);assert.ok(el("body").children.some(n=>n.textContent==="等待数据更新"));
busData={...bus,snapshot:{...bus.snapshot,status:"expired",vehicles:[]}};advance(15000);
assert.ok(!el("body").children.some(n=>n.className==="eta"));assert.ok(!el("body").children.some(n=>n.textContent.includes("数据更新于")));
click("familyMode");heading("今日生活");assert.equal(el("familyControls").className,"");
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
el("token").value="example-display-token";click("connect");heading("今日生活");
assert.equal(el("pause").textContent,"暂停轮播");
advance(120000);assert.ok(el("heading").textContent.indexOf("Example reminder · 1/")===0);
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
click("logout");el("token").value="example-display-token";click("connect");
assert.equal(el("pause").textContent,"暂停轮播");click("logout");assert.equal(timers.size,0);
data=sample;busData=bus;autoMode="family";
el("token").value="example-display-token";click("connect");heading("今日生活");
const autoBefore=autoRequests;click("autoMode");heading("今日生活");assert.equal(autoRequests,autoBefore+1);
autoMode="bus";advance(30000);heading("Example line");
assert.equal(el("familyControls").className,"hidden");
autoMode="family";advance(15000);heading("今日生活");
assert.equal(el("familyControls").className,"");
click("next");heading("今日待办");const pinnedAuto=autoRequests;
autoMode="bus";advance(60000);heading("今日待办");assert.equal(autoRequests,pinnedAuto);
click("autoMode");heading("Example line");
click("busMode");const manualAuto=autoRequests;autoMode="family";advance(30000);heading("Example line");assert.equal(autoRequests,manualAuto);
click("autoMode");heading("今日生活");click("settings");const settingsAuto=autoRequests;autoMode="bus";advance(60000);heading("今日生活");assert.equal(autoRequests,settingsAuto);click("cancel");
click("autoMode");heading("Example line");doc.hidden=true;events.visibilitychange();
const asleep=autoRequests;advance(60000);assert.equal(autoRequests,asleep);
autoMode="family";doc.hidden=false;events.visibilitychange();heading("今日生活");
fail=503;advance(30000);heading("");fail=0;advance(30000);heading("今日生活");
click("logout");assert.equal(timers.size,0);
// Foregrounding must re-read fresh content without jumping to page one.
data=sample;fail=0;el("token").value="example-display-token";click("connect");
click("next");click("next");heading("Example reminder");
doc.hidden=true;events.visibilitychange();const pausedRequests=requests;
advance(300000);assert.equal(requests,pausedRequests);
doc.hidden=false;events.visibilitychange();heading("Example reminder");
assert.equal(el("pause").textContent,"开始轮播");
click("pause");doc.hidden=true;events.visibilitychange();advance(300000);
doc.hidden=false;events.visibilitychange();heading("Example reminder");
assert.equal(el("pause").textContent,"暂停轮播");
advance(180000);heading("今日菜单");
click("previous");heading("Example reminder");
doc.hidden=true;events.visibilitychange();data={...sample,posters:[]};
doc.hidden=false;events.visibilitychange();heading("今日生活");
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
data=sample;directDisplay();heading("今日生活");
click("next");click("next");heading("Example reminder");
click("pause");doc.hidden=true;events.visibilitychange();
assert.equal(storage.size,1);
const serialized=[...storage.values()][0];
assert.ok(!serialized.includes("Line one")&&!serialized.includes("Example reminder")&&!serialized.includes("token"));
windowEvents.pagehide();assert.equal(timers.size,0);
doc.hidden=false;directDisplay();heading("Example reminder");
assert.equal(el("pause").textContent,"暂停轮播");
advance(180000);heading("今日菜单");
windowEvents.pagehide();windowEvents.pageshow({persisted:true});heading("今日菜单");
click("logout");assert.equal(storage.size,0);assert.equal(timers.size,0);
directDisplay();heading("今日生活");click("logout");
console.log("Household display simulation passed: automatic switching, override, saved settings, long poster preservation, unified bus/family display, rotation, pinning, settings, unchanged content, expiry/removal, hidden tab, failure, logout.");
