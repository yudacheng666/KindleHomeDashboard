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
let data=sample,fail=0,requests=0,clock=0,nextId=1,busRequests=0,busData=bus;
const timers=new Map();
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
  open(method,path){assert.equal(method,"GET");assert.ok(["/api/home/view","/api/bus/view"].includes(path));this.path=path;}
  setRequestHeader(k,v){assert.equal(k,"Authorization");assert.equal(v,"Bearer example-display-token");}
  send(body){assert.equal(body,null);requests++;if(this.path==="/api/bus/view")busRequests++;this.status=fail||200;this.responseText=JSON.stringify(fail?{}:this.path==="/api/bus/view"?busData:data);this.readyState=4;this.onreadystatechange();}
  abort(){}
}
vm.runInNewContext(fs.readFileSync("dashboard/web/display.js","utf8"),{document:doc,window:{addEventListener(n,f){windowEvents[n]=f;}},XMLHttpRequest:XHR,setTimeout:setTimer,clearTimeout:clearTimer});
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
click("busMode");heading("Example line");assert.equal(el("familyControls").className,"hidden");
assert.ok(el("body").children.some(n=>n.textContent==="4 分钟"));
assert.ok(el("body").children.some(n=>n.textContent==="9 分钟"));
const oldBus=busRequests;advance(15000);assert.equal(busRequests,oldBus+1);
busData={...bus,snapshot:{...bus.snapshot,status:"expired",vehicles:[]}};advance(15000);
assert.ok(!el("body").children.some(n=>n.className==="eta"));
click("familyMode");heading("今日生活");assert.equal(el("familyControls").className,"");
const endBus=busRequests;advance(60000);assert.equal(busRequests,endBus);
fail=401;advance(30000);assert.equal(el("display").className,"hidden");assert.equal(el("login").className,"");
assert.equal(el("body").children.length,0);assert.equal(timers.size,0);
fail=0;el("token").value="example-display-token";click("connect");windowEvents.pagehide();
assert.equal(el("display").className,"hidden");assert.equal(timers.size,0);heading("");
fail=404;el("token").value="example-display-token";click("connect");
assert.equal(el("display").className,"");fail=0;click("busMode");heading("Example line");click("logout");
assert.equal(timers.size,0);
console.log("Household display simulation passed: unified bus/family display, rotation, pinning, settings, unchanged content, expiry/removal, hidden tab, failure, logout.");
