/* Kindle portrait overview UI simulation. Synthetic data only. */
const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict");
class Node {
  constructor(tag){this.tag=tag;this.children=[];this.textContent="";this.value="";this.checked=false;this.className="";this.style={};this.attributes={};this.disabled=false;}
  get firstChild(){return this.children[0];}
  appendChild(n){this.children.push(n);return n;}
  removeChild(n){this.children.splice(this.children.indexOf(n),1);return n;}
  setAttribute(k,v){this.attributes[k]=String(v);}
}
const nodes={},events={},windowEvents={};
const document={hidden:false,getElementById(id){return nodes[id]||(nodes[id]=new Node(id));},
  createElement(tag){return new Node(tag);},addEventListener(name,fn){events[name]=fn;}};
const el=id=>document.getElementById(id);
const descendants=n=>n.children.flatMap(c=>[c,...descendants(c)]);
const text=n=>n.textContent+ n.children.map(text).join("");
const date="2026-01-05",tomorrow="2026-01-06",later="2026-01-07";
const task1={id:"task-one",title:"Today task one",occurrence:date};
const task2={id:"task-two",title:"Today task two",occurrence:date};
const task3={id:"task-three",title:"Tomorrow task",occurrence:tomorrow};
const task4={id:"task-four",title:"Later task",occurrence:later};
const meal=(day,meal,dishes)=>({day,meal,dishes});
const routes=[
  {seconds:1560,meters:18400,congested_meters:0,traffic_covered_meters:18400},
  {seconds:1920,meters:20100,congested_meters:500,traffic_covered_meters:20100},
  {seconds:2340,meters:22000,congested_meters:null,traffic_covered_meters:0}
];
const image="data:image/png;base64,c3ludGhldGlj";
let overview={
  bus:{trip:{line:{name:"Fictional line"},boarding:{name:"A"},destination:{name:"B"}},
    snapshot:{status:"live",vehicles:[
      {position:1,eta_min:5,distance_m:500,stops_remaining:2},
      {position:2,eta_min:14,distance_m:1800,stops_remaining:6}
    ],departure_plans:[],fetched_at:"2026-01-05T00:00:00Z",fetched_at_ms:0,server_now_ms:0,timezone_offset_min:480}},
  weather:{status:"ready",name:"地点甲",sections:{
    current:{status:"available",source:"QWeather",data:{temp:18,text:"多云",humidity:62,feels:17}},
    alerts:{status:"available",data:[]},
    hourly:{status:"available",data:[{temp:99,text:"未来预测"}]},
    daily:{status:"available",data:[{max:99,text:"未来预测"}]}
  },additional:[{status:"ready",name:"地点乙",sections:{
    current:{status:"available",source:"QWeather",data:{temp:22,text:"晴",humidity:45,feels:22}},
    alerts:{status:"available",data:[]}
  }}]},
  driving:{enabled:true,group_count:3,groups:[
    {name:"目的地甲",status:"ok",image,routes,fetched_at:"2026-01-05T00:00:00+08:00"},
    {name:"目的地乙",status:"ok",image,routes,fetched_at:"2026-01-05T00:00:00+08:00"}
  ]},
  home:{date,tasks:[task1,task2],upcoming_tasks:[task1,task2,task3,task4],posters:[{title:"海报不应显示"}],
    week_menu:[meal(date,"lunch",["番茄炒蛋","清炒时蔬"]),meal(date,"dinner",["红烧鸡腿"]),
      meal(tomorrow,"lunch",["土豆烧牛肉"]),meal(tomorrow,"dinner",["清蒸鱼"]),meal(later,"lunch",["不应显示"])],
    can_complete:true}
};
let clock=0,nextId=1,requests=0,posts=0,confirmed=false;
const timers=new Map();
class FakeDate extends Date {static now(){return Date.parse("2026-01-05T00:00:00Z")+clock;}}
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
  open(method,path){this.method=method;this.path=path;
    assert.ok((method==="GET"&&path==="/api/display/overview")||(method==="POST"&&path==="/api/home/task/complete"),method+" "+path);}
  setRequestHeader(){}
  send(body){
    requests++;
    if(this.method==="POST"){
      posts++;const sent=JSON.parse(body);assert.deepEqual(sent,{key:task1.id,on:date,completed:true});
      overview.home.tasks=overview.home.tasks.filter(t=>t.id!==task1.id);
      overview.home.upcoming_tasks=overview.home.upcoming_tasks.filter(t=>t.id!==task1.id);
      this.status=200;this.responseText=JSON.stringify({result:null});
    }else{
      const copy=JSON.parse(JSON.stringify(overview)),now=FakeDate.now();
      copy.bus.snapshot.server_now_ms=now;copy.bus.snapshot.fetched_at_ms=now;
      copy.bus.snapshot.fetched_at=new Date(now).toISOString();
      this.status=200;this.responseText=JSON.stringify(copy);
    }
    this.readyState=4;this.onreadystatechange();
  }
  abort(){}
}
vm.runInNewContext(fs.readFileSync("dashboard/web/display.js","utf8"),{
  document,window:{KHD_ACCESS:{direct:true,openAdmin:true},confirm:()=>confirmed,
    addEventListener(n,f){windowEvents[n]=f;}},location:{pathname:"/",hash:""},
  XMLHttpRequest:XHR,Date:FakeDate,setTimeout:setTimer,clearTimeout:clearTimer
});
assert.ok(requests>=1);
assert.equal(el("overview").className,"");
assert.equal(el("legacyDisplay").className,"hidden");
assert.equal(el("overviewDate").textContent,"1月5日 星期一");
assert.equal(el("overviewTime").textContent,"08:00");
assert.ok(text(el("overviewBusContent")).includes("约 5分钟"));
assert.ok(text(el("overviewBusContent")).includes("下一辆 14分钟"));
assert.ok(text(el("overviewBusContent")).includes("2站"));
assert.ok(text(el("overviewBusContent")).includes("6站"));
assert.ok(text(el("overviewWeatherContent")).includes("18° 多云"));
assert.ok(text(el("overviewWeatherContent")).includes("湿度 62%"));
assert.ok(!text(el("overviewWeatherContent")).includes("未来预测"));
assert.equal(descendants(el("overviewMap1")).filter(n=>n.tag==="img").length,1);
assert.equal(descendants(el("overviewMap2")).filter(n=>n.tag==="img").length,1);
assert.ok(text(el("overviewMap1")).includes("目的地甲"));
assert.ok(text(el("overviewMap1")).includes("26分钟"));
assert.ok(text(el("overviewMap1")).includes("32分"));
assert.ok(text(el("overviewMap2")).includes("目的地乙"));
assert.ok(text(el("overviewMap2")).includes("还有1个目的地"));
assert.ok(text(el("overviewMenuContent")).includes("番茄炒蛋"));
assert.ok(text(el("overviewMenuContent")).includes("土豆烧牛肉"));
assert.ok(!text(el("overviewMenuContent")).includes("不应显示"));
assert.ok(text(el("overviewTaskContent")).includes("Today task one"));
assert.ok(text(el("overviewTaskContent")).includes("Tomorrow task"));
assert.ok(text(el("overviewTaskContent")).includes("另有 1 项"));
assert.ok(!text(el("overviewTaskContent")).includes("海报不应显示"));
assert.equal(descendants(el("overviewTaskContent")).filter(n=>n.tag==="button").length,2);
const firstMap=descendants(el("overviewMap1")).find(n=>n.tag==="img");
const weatherNode=el("overviewWeatherContent");
advance(120000);
assert.ok(text(el("overviewWeatherContent")).includes("地点乙"));
assert.ok(text(el("overviewWeatherContent")).includes("22° 晴"));
assert.equal(descendants(el("overviewMap1")).find(n=>n.tag==="img"),firstMap);
assert.equal(el("overviewWeatherContent"),weatherNode);
el("settings").onclick();
assert.equal(el("settingsPanel").className,"");
assert.equal(el("displayContent").className,"hidden");
el("returnDisplay").onclick();
assert.equal(el("displayContent").className,"");
const buttons=descendants(el("overviewTaskContent")).filter(n=>n.tag==="button");
assert.equal(buttons.length,2);
buttons[0].onclick();
assert.equal(posts,0);
confirmed=true;buttons[0].onclick();
assert.equal(posts,1);
assert.ok(!text(el("overviewTaskContent")).includes("Today task one"));
assert.ok(text(el("overviewTaskContent")).includes("Today task two"));
assert.ok(text(el("overviewTaskContent")).includes("Tomorrow task"));
assert.equal(descendants(el("overviewTaskContent")).filter(n=>n.tag==="button").length,1);
assert.equal(el("overview").className,"");
assert.ok(requests>1);
el("settings").onclick();el("logout").onclick();
assert.equal(timers.size,0);
for(const id of ["overviewBusContent","overviewWeatherContent","overviewMap1","overviewMap2","overviewMenuContent","overviewTaskContent","body"])assert.equal(el(id).children.length,0);
console.log("Kindle single-page overview simulation passed: bus/weather split, current-only weather, two real map slots, first two of three destinations, today/tomorrow menus, task grouping and confirmation, weather rotation, settings, and local cached polling.");
