/* Dependency-free UI logic test with simulated DOM, timers and HTTP. */
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
class Node {
  constructor(){this.children=[];this.textContent="";this.value="";this.className="";this.disabled=false;}
  setAttribute(name,value){this[name]=value;}
  get firstChild(){return this.children[0];}
  appendChild(n){if(!this.children.length)this.value=n.value;this.children.push(n);}
  removeChild(n){this.children.splice(this.children.indexOf(n),1);if(!this.children.length)this.value="";}
}
const nodes = {};
const doc = {getElementById(id){return nodes[id]||(nodes[id]=new Node());},
             createElement(){return new Node();}};
const line={line_id:"sample",name:"Example",direction:"0",first:"A",last:"C",city_code:"310100"};
const reverse={...line,line_id:"reverse",direction:"1",first:"C",last:"A"};
const other={...line,line_id:"other",name:"Other"};
const stops=["A","B","C"].map(n=>({name:n,stop_id:n}));
const view={trip:{line,boarding:stops[0],destination:stops[2],board_index:0,destination_index:2},
  snapshot:{status:"live",vehicles:[{position:1,eta_min:4,distance_m:300,stops_remaining:1},{position:2,eta_min:9,distance_m:null,stops_remaining:null}],scheduled_departures:1,fetched_at:"2026-01-01T00:00:00+00:00"}};
const calls=[];
let clock=Date.parse(view.snapshot.fetched_at)+5000,ageTick=null,deviceSkew=-3600000;
class FakeDate extends Date {static now(){return clock+deviceSkew;}}
let failed=false, searchError="", scheduleMismatch=false, scheduleReadFail=false, savedSchedule={editable:true,enabled:false,timezone:"UTC",windows:[]};
class XHR {
  open(method,path){this.method=method;this.path=path;}
  setRequestHeader(name,value){if(name==="Authorization")assert.equal(value,"Bearer example-ui-token");}
  send(body){
    calls.push([this.method,this.path,body&&JSON.parse(body)]);
    let data;
    if(this.path==="/api/bus/view")data=view;
    if(this.path==="/api/bus/schedule"){
      if(this.method==="POST"&&!scheduleMismatch)savedSchedule={...savedSchedule,...JSON.parse(body)};
      data=savedSchedule;
    }
    if(this.path==="/api/bus/search")data={lines:[line,reverse,other]};
    if(this.path==="/api/bus/route")data={selection:"example-handle",route:{line:JSON.parse(body).line,stops}};
    if(this.path==="/api/bus/save")data=view;
    const error=this.path==="/api/bus/search"&&searchError?searchError:(failed||scheduleReadFail&&this.path==="/api/bus/schedule"&&this.method==="GET")?"service_error":"";
    this.status=error?503:200;if(data&&data.snapshot)data={...data,snapshot:{...data.snapshot,server_now_ms:clock,fetched_at_ms:Date.parse(data.snapshot.fetched_at),timezone_offset_min:0}};this.responseText=JSON.stringify(error?{error}:data);
    this.readyState=4;this.onreadystatechange();
  }
  abort(){}
}
vm.runInNewContext(fs.readFileSync("dashboard/web/bus.js","utf8"),{document:doc,XMLHttpRequest:XHR,Date:FakeDate,setTimeout:(fn,delay)=>{if(delay===5000)ageTick=fn;return 1;},clearTimeout:()=>{}});
const el=id=>doc.getElementById(id);
// The static shell uses "panel hidden"; it must not be mistaken for an open editor.
el("scheduleConfig").className="panel hidden";assert.equal(el("returnLink").onclick(),true);
el("token").value="example-ui-token";el("mode").value="admin";el("connect").onclick();
assert.equal(el("token").value,"");
assert.equal(el("vehicles").children.length,2);
assert.equal(el("vehicles").children[0].children[1].children[0].textContent,"约 4 分钟");
assert.equal(el("updated").textContent,"5 秒前刷新");const reads=calls.length;clock+=5000;ageTick();assert.equal(el("updated").textContent,"10 秒前刷新");assert.equal(calls.length,reads);clock+=55000;ageTick();assert.equal(el("vehicles").children[0].children[1].children[0].textContent,"约 3 分钟");assert.equal(calls.length,reads);clock+=30000;ageTick();assert.equal(el("vehicles").children[0].children[1].children[0].textContent,"等待数据更新");assert.ok(el("status").textContent.includes("已过期"));clock-=90000;
const etaNode=el("vehicles").children[0].children[1].children[0];view.snapshot.vehicles[0].distance_m=250;view.snapshot.vehicles[0].eta_min=5;el("refresh").onclick();assert.equal(el("vehicles").children[0].children[1].children[0],etaNode);assert.equal(etaNode.textContent,"约 5 分钟");assert.ok(el("vehicles").children[0].children[2].children[1].textContent.includes("250 米"));view.snapshot.vehicles[0].eta_min=4;
const savedSnapshot=view.snapshot;
const slot=(i)=>el("vehicles").children[i], eta=(i)=>slot(i).children[1].children[0], time=(i)=>slot(i).children[1].children[1];
view.snapshot={...savedSnapshot,status:"no_live_data",vehicles:[],scheduled_departures:1,departure_plans:[{time:"00:01",imminent:false}]};el("refresh").onclick();
assert.ok(el("status").textContent.includes("等待首站发车"));assert.equal(eta(0).textContent,"计划即将发车");assert.ok(time(0).textContent.includes("首站计划发车"));assert.ok(el("updated").textContent.endsWith("秒前刷新"));
view.snapshot={...savedSnapshot,vehicles:[savedSnapshot.vehicles[0]],scheduled_departures:1,departure_plans:[{time:"00:15",imminent:false}]};el("refresh").onclick();assert.equal(el("vehicles").children.length,2);assert.equal(eta(1).textContent,"等待首站发车");assert.ok(time(1).textContent.includes("00:15"));assert.ok(el("status").textContent.includes("实时预计到站"));
assert.equal(slot(0).className,"bus-slot bus-first");assert.equal(slot(1).className,"bus-slot bus-next");
const firstSlot=slot(0);view.snapshot={...savedSnapshot,vehicles:[{position:1,eta_min:0,distance_m:0,stops_remaining:0},savedSnapshot.vehicles[1]]};el("refresh").onclick();assert.equal(slot(0),firstSlot);assert.equal(eta(0).textContent,"车辆已到站附近");
view.snapshot={...savedSnapshot,status:"stale"};el("refresh").onclick();assert.equal(eta(0).textContent,"约 4 分钟");assert.ok(el("status").textContent.includes("旧数据"));
view.snapshot=savedSnapshot;el("refresh").onclick();
el("settings").onclick();el("keyword").value="Example";
for(const [code,msg] of [["bus_disabled","未启用"],["local_request_gap","请求过快"],["local_daily_limit","每日请求上限"]]){searchError=code;el("search").onclick();assert.ok(el("message").textContent.includes(msg));}
searchError="";el("search").onclick();
assert.deepEqual(el("route").children.map(n=>n.textContent),["请选择线路","Example","Other"]);assert.equal(el("directionStep").className,"hidden");
el("route").value="0";el("route").onchange();assert.equal(el("directionStep").className,"");assert.equal(el("direction").value,"");
el("direction").value="1";el("direction").onchange();el("search").onclick();
assert.equal(el("direction").value,"1");
assert.deepEqual(calls[calls.length-1][2],{keyword:"Example"});
assert.ok(!nodes.broadSearch);
el("detail").onclick();
assert.equal(calls[calls.length-1][2].direction,"1");
assert.equal(calls[calls.length-1][2].line.line_id,"reverse");

assert.equal(el("board").children.length,2);
el("board").value="1";el("board").onchange();
assert.equal(el("destination").children.length,1);
assert.equal(el("destination").children[0].value,"2");
el("save").onclick();
assert.deepEqual(calls[calls.length-1][2],{selection:"example-handle",boarding:1,destination:2});
assert.equal(el("config").className,"hidden");
el("scheduleSettings").onclick();
assert.equal(el("scheduleConfig").className,"");
el("scheduleEnabled").value="1";el("scheduleSave").onclick();
assert.ok(el("scheduleMessage").textContent.includes("至少"));assert.ok(el("scheduleStored").textContent.includes("关闭"));
el("scheduleAdd").onclick();
const row=el("scheduleRows").children[0];
row.children[0].children[0].checked=true;
const startHour=row.children[7].children[1],startMinute=row.children[7].children[3],endHour=row.children[8].children[1],endMinute=row.children[8].children[3];
assert.equal(startHour.children.length,25);assert.equal(startMinute.children.length,61);assert.equal(endHour.children.length,26);
assert.equal(startHour.value,"");el("scheduleSave").onclick();assert.ok(el("scheduleMessage").textContent.includes("有效时间"));
startHour.value="10";startMinute.value="07";endHour.value="24";endHour.onchange();assert.equal(endMinute.value,"00");
endMinute.value="01";el("scheduleSave").onclick();assert.ok(el("scheduleMessage").textContent.includes("有效时间"));endMinute.value="00";
el("scheduleSave").onclick();
assert.ok(calls.some(c=>c[1]==="/api/bus/schedule"&&c[0]==="POST"&&c[2].enabled===true&&c[2].windows[0].start===607&&c[2].windows[0].end===1440));
assert.equal(el("scheduleConfig").className,"");assert.equal(el("scheduleEnabled").value,"1");
assert.ok(el("scheduleStored").textContent.includes("开启"));assert.ok(el("scheduleMessage").textContent.includes("已保存并确认"));
assert.deepEqual(calls.slice(-2).map(c=>c.slice(0,2)),[["POST","/api/bus/schedule"],["GET","/api/bus/schedule"]]);
scheduleMismatch=true;el("scheduleEnabled").value="0";el("scheduleSave").onclick();
assert.ok(el("scheduleMessage").textContent.includes("不一致"));assert.ok(el("scheduleStored").textContent.includes("开启"));
scheduleMismatch=false;scheduleReadFail=true;el("scheduleSave").onclick();
assert.ok(el("scheduleMessage").textContent.includes("未能读取确认"));assert.ok(el("scheduleStored").textContent.includes("未确认"));
scheduleReadFail=false;el("scheduleCancel").onclick();el("scheduleSettings").onclick();
assert.equal(el("scheduleEnabled").value,"0");assert.ok(el("scheduleStored").textContent.includes("关闭"));
const restoredRow=el("scheduleRows").children[0];
assert.equal(restoredRow.children[7].children[1].value,"10");assert.equal(restoredRow.children[7].children[3].value,"07");
assert.equal(restoredRow.children[8].children[1].value,"24");assert.equal(restoredRow.children[8].children[3].value,"00");
el("scheduleEnabled").value="1";el("scheduleSave").onclick();assert.ok(el("scheduleMessage").textContent.includes("已保存并确认"));
el("scheduleCancel").onclick();el("scheduleSettings").onclick();assert.equal(el("scheduleEnabled").value,"1");el("scheduleCancel").onclick();
failed=true;el("refresh").onclick();assert.equal(el("vehicles").children.length,0);assert.equal(el("updated").textContent,"");
el("logout").onclick();assert.equal(el("dashboard").className,"hidden");
assert.equal(el("trip").textContent,"");
console.log("Browser logic simulation passed: selection, ETA, disconnect and logout.");
