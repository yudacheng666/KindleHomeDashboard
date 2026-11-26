/* Offline UI logic exercise. No real data or network. */
const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict");
class Node {
  constructor(tag){this.tag=tag;this.children=[];this.textContent="";this.value="";this.className="";}
  get firstChild(){return this.children[0];}
  appendChild(n){this.children.push(n);return n;}
  removeChild(n){this.children.splice(this.children.indexOf(n),1);}
}
const nodes={},events={},doc={hidden:false,getElementById(id){return nodes[id]||(nodes[id]=new Node(id));},createElement(tag){return new Node(tag);},addEventListener(n,f){events[n]=f;}};
const el=id=>doc.getElementById(id);
const date="2026-01-05",task={id:"synthetic-task",title:"Example task",start:date,repeat:"daily",occurrence:date,completed:false};
const manage={date,tasks:[task],posters:[],shopping:[],history:[{...task,completed_at:null,restorable:true}],catalog:{categories:[{id:"cat",name:"Example category"},{id:"other",name:"其他"}],dishes:[{id:"dish",name:"Catalog dish",category:"cat"}]}};
const view={date,tasks:[task],posters:[],shopping:[],today_menu:[],week_menu:[]};
const calls=[];let fail=false,confirmed=true;
const sampleMenu={day:date,meal:"lunch",dishes:["Example dish"],ingredients:["Example ingredient"]};
let shared=[sampleMenu,{...sampleMenu,meal:"dinner",dishes:["Example dinner"]},{...sampleMenu,day:"2026-01-06"}],timers=new Map(),nextTimer=1;
function setTimer(fn,ms){let id=nextTimer++;timers.set(id,{fn,ms});return id;}
function clearTimer(id){timers.delete(id);}
function tick(){for(const [id,t] of [...timers])if(t.ms===2000){timers.delete(id);t.fn();}}
class XHR {
  open(method,path){this.method=method;this.path=path;}
  setRequestHeader(k,v){}
  send(body){
    calls.push([this.path,body&&JSON.parse(body)]);
    let response=this.path.endsWith("/manage")?manage:this.path.endsWith("/view")?view:this.path.endsWith("/menu/list")?{result:shared}:{result:[]};
    if(this.path.endsWith("/menu/sync")){const b=JSON.parse(body);response={result:{menus:shared.filter(m=>m.day>=b.first&&m.day<=b.last),catalog_revision:"test",catalog:manage.catalog}};}
    if(!fail&&(this.path.endsWith("/menu/dish")||this.path.endsWith("/menu/manual"))){
      const b=JSON.parse(body);if(this.path.endsWith("/menu/manual")){b.present=true;if(!manage.catalog.dishes.some(d=>d.name===b.name))manage.catalog.dishes.push({id:"manual-"+b.name,name:b.name,category:"other"});}const m=shared.find(x=>x.day===b.on&&x.meal===b.meal),d=m?m.dishes.slice():[];
      let dishes=b.present?[...new Set([...d,b.name])]:d.filter(x=>x!==b.name);
      const result=dishes.length?{day:b.on,meal:b.meal,dishes,ingredients:m?m.ingredients:[]}:null;
      shared=shared.filter(x=>x.day!==b.on||x.meal!==b.meal);if(result)shared.push(result);response={result};
    }
    if(!fail&&this.path.endsWith("/dish/move-other")){const b=JSON.parse(body);manage.catalog.dishes.forEach(d=>{if(b.keys.includes(d.id))d.category=b.category;});}
    this.status=fail?503:200;this.responseText=JSON.stringify(response);this.readyState=4;this.onreadystatechange();
  }
  abort(){}
}
function all(n,p){return (p(n)?[n]:[]).concat(...n.children.map(c=>all(c,p)));}
function click(root,label){const n=all(root,n=>n.tag==="button"&&n.textContent===label)[0];assert.ok(n,label);n.onclick();}
vm.runInNewContext(fs.readFileSync("dashboard/web/home.js","utf8"),{document:doc,window:{confirm:()=>confirmed,addEventListener(){}},XMLHttpRequest:XHR,setTimeout:setTimer,clearTimeout:clearTimer});
el("token").value="example-test-only";el("mode").value="admin";el("connect").onclick();
assert.equal(el("token").value,"");
el("tasks").onclick();click(el("content"),"完成");
assert.ok(calls.some(c=>c[0].endsWith("/task/complete")&&c[1].on===date&&c[1].completed===true));
click(el("content"),"历史待办");
assert.ok(all(el("content"),n=>n.textContent.includes("完成时间未知")).length);
confirmed=false;const historyCount=calls.length;click(el("content"),"彻底删除");assert.equal(calls.length,historyCount);
confirmed=true;click(el("content"),"彻底删除");assert.ok(calls.some(c=>c[0].endsWith("/history/delete")&&c[1].confirm===true));
click(el("content"),"未完成");click(el("content"),"新增待办");
const inputs=all(el("editor"),n=>n.tag==="input");inputs[0].value="Fictional new task";
click(el("editor"),"保存");assert.ok(calls.some(c=>c[0].endsWith("/task/add")&&c[1].title==="Fictional new task"));
click(el("content"),"编辑");click(el("editor"),"取消");assert.equal(el("editor").className,"hidden");
confirmed=false;const count=calls.length;click(el("content"),"删除");assert.equal(calls.length,count);
confirmed=true;click(el("content"),"删除");assert.ok(calls.some(c=>c[0].endsWith("/task/delete")&&c[1].confirm===true));
el("posters").onclick();click(el("content"),"新增海报");
const pi=all(el("editor"),n=>n.tag==="input");pi[0].value="Fictional poster";all(el("editor"),n=>n.tag==="textarea")[0].value="Line one\nLine two";
click(el("editor"),"保存");assert.ok(calls.some(c=>c[0].endsWith("/poster/add")&&c[1].body==="Line one\nLine two"));
el("menus").onclick();
assert.deepEqual(all(el("content"),n=>n.className==="menu-date").map(n=>n.textContent),[date,"2026-01-06"]);
assert.equal(all(el("content"),n=>n.className==="menu-today").length,1);
assert.equal(all(el("content"),n=>n.className==="menu-date")[0].children[0].textContent,"今日");
el("catalog").onclick();click(el("content"),"新增菜品");all(el("editor"),n=>n.tag==="input")[0].value="New fictional dish";click(el("editor"),"保存");
assert.ok(calls.some(c=>c[0].endsWith("/dish/add")&&c[1].name==="New fictional dish"));
el("menus").onclick();click(el("content"),"快捷排餐");
click(el("editor"),"Catalog dish");
assert.ok(calls.some(c=>c[0].endsWith("/menu/dish")&&c[1].name==="Catalog dish"&&c[1].present===true));
const quickStatus=all(el("editor"),n=>n.id==="quickStatus")[0],manual=all(el("editor"),n=>n.id==="quickManual")[0];
assert.ok(quickStatus.textContent.includes("已同步"));
assert.ok(all(el("editor"),n=>n.className==="dish-pick dish-selected"&&n.textContent==="Catalog dish").length);
const dinner=shared.find(m=>m.day===date&&m.meal==="dinner");dinner.dishes.push("Remote dish");tick();
assert.ok(all(el("editor"),n=>n.textContent==="Remote dish").length);
manual.value="Handwritten dish";click(el("editor"),"午餐");assert.equal(manual.value,"");click(el("editor"),"晚餐");assert.equal(manual.value,"Handwritten dish");
click(el("editor"),"添加菜品");assert.equal(manual.value,"");
assert.ok(shared.find(m=>m.day===date&&m.meal==="dinner").dishes.includes("Handwritten dish"));
assert.ok(manage.catalog.dishes.some(d=>d.name==="Handwritten dish"&&d.category==="other"));
click(el("editor"),"下一周");assert.ok(calls.some(c=>c[0].endsWith("/menu/sync")&&c[1].first==="2026-01-12"));
const jump=all(el("editor"),n=>n.id==="quickDate")[0];jump.value="2030-01-01";click(el("editor"),"跳转");
manual.value="Future dish";click(el("editor"),"添加菜品");assert.ok(shared.some(m=>m.day==="2030-01-01"&&m.dishes.includes("Future dish")));
click(el("editor"),"回到今日");assert.ok(calls.some(c=>c[0].endsWith("/menu/sync")&&c[1].first==="2026-01-05"));
fail=true;tick();let writes=calls.filter(c=>c[0].endsWith("/menu/dish")).length;
click(el("editor"),"Catalog dish");assert.equal(calls.filter(c=>c[0].endsWith("/menu/dish")).length,writes);
fail=false;tick();assert.ok(quickStatus.textContent.includes("已同步"));
fail=true;click(el("editor"),"Catalog dish");assert.equal(calls.filter(c=>c[0].endsWith("/menu/dish")).length,writes+1);
fail=false;tick();assert.ok(quickStatus.textContent.includes("核对"));assert.equal(calls.filter(c=>c[0].endsWith("/menu/dish")).length,writes+1);
doc.hidden=true;events.visibilitychange();let countPoll=calls.length;tick();assert.equal(calls.length,countPoll);
doc.hidden=false;events.visibilitychange();assert.ok(calls.length>countPoll);
click(el("editor"),"完成排餐");countPoll=calls.length;tick();assert.equal(calls.length,countPoll);
el("catalog").onclick();click(el("content"),"其他");
const check=all(el("content"),n=>n.type==="checkbox")[0];check.checked=true;click(el("content"),"移动所选菜品");
assert.ok(calls.some(c=>c[0].endsWith("/dish/move-other")&&c[1].keys.length===1&&c[1].category==="cat"));
el("displaySettings").onclick();click(el("content"),"菜单展示范围");all(el("editor"),n=>n.tag==="select")[0].value="custom";all(el("editor"),n=>n.tag==="input")[0].value="14";click(el("editor"),"保存");
assert.ok(calls.some(c=>c[0].endsWith("/menu/display")&&c[1].mode==="custom"&&c[1].days===14));
el("menus").onclick();
click(el("content"),"新增菜单");const ta=all(el("editor"),n=>n.tag==="textarea");ta[0].value="Dish A\nDish B";ta[1].value="Ingredient A";
click(el("editor"),"保存");assert.ok(calls.some(c=>c[0].endsWith("/menu/plan")&&c[1].expected===null&&c[1].dishes.length===2));
click(el("content"),"编辑");
const menuOn=all(el("editor"),n=>n.tag==="input")[0],menuMeal=all(el("editor"),n=>n.tag==="select")[0];
assert.ok(!menuOn.disabled&&!menuMeal.disabled);
menuOn.value="2026-01-06";menuMeal.value="dinner";click(el("editor"),"保存");
assert.ok(calls.some(c=>c[0].endsWith("/menu/move")&&c[1].old_on===date&&c[1].old_meal==="lunch"&&c[1].on==="2026-01-06"&&c[1].meal==="dinner"));
assert.ok(calls.some(c=>c[0].endsWith("/menu/list")&&c[1].first==="2026-01-05"&&c[1].last==="2026-01-11"));
assert.ok(!calls.some(c=>c[0].includes("/shopping/")));
el("posters").onclick();click(el("content"),"保存轮播设置");all(el("editor"),n=>n.tag==="select")[1].value="true";click(el("editor"),"保存");assert.ok(calls.some(c=>c[0].endsWith("/display/set")&&c[1].autoplay===true&&!c[1].include_shopping));
fail=true;el("refresh").onclick();assert.equal(el("content").children.length,0);
el("logout").onclick();assert.equal(el("home").className,"hidden");assert.equal(el("date").textContent,"");
fail=false;el("mode").value="read";el("token").value="example-reader";el("connect").onclick();el("tasks").onclick();
assert.equal(all(el("content"),n=>n.tag==="button").length,0);
console.log("Household browser logic simulation passed: read/admin, task, poster, weekly menu, poster rotation settings, cancellation, logout.");
