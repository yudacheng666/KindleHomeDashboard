/* Offline UI logic exercise. No real data or network. */
const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict");
class Node {
  constructor(tag){this.tag=tag;this.children=[];this.textContent="";this.value="";this.className="";}
  get firstChild(){return this.children[0];}
  appendChild(n){this.children.push(n);return n;}
  removeChild(n){this.children.splice(this.children.indexOf(n),1);}
}
const nodes={},doc={getElementById(id){return nodes[id]||(nodes[id]=new Node(id));},createElement(tag){return new Node(tag);}};
const el=id=>doc.getElementById(id);
const date="2026-01-05",task={id:"synthetic-task",title:"Example task",start:date,repeat:"daily",occurrence:date,completed:false};
const manage={date,tasks:[task],posters:[],shopping:[]};
const view={date,tasks:[task],posters:[],shopping:[],today_menu:[],week_menu:[]};
const calls=[];let fail=false,confirmed=true;
class XHR {
  open(method,path){this.method=method;this.path=path;}
  setRequestHeader(k,v){}
  send(body){
    calls.push([this.path,body&&JSON.parse(body)]);
    let response=this.path.endsWith("/manage")?manage:this.path.endsWith("/view")?view:{result:[]};
    this.status=fail?503:200;this.responseText=JSON.stringify(response);this.readyState=4;this.onreadystatechange();
  }
  abort(){}
}
function all(n,p){return (p(n)?[n]:[]).concat(...n.children.map(c=>all(c,p)));}
function click(root,label){const n=all(root,n=>n.tag==="button"&&n.textContent===label)[0];assert.ok(n,label);n.onclick();}
vm.runInNewContext(fs.readFileSync("dashboard/web/home.js","utf8"),{document:doc,window:{confirm:()=>confirmed,addEventListener(){}},XMLHttpRequest:XHR,setTimeout:()=>1,clearTimeout(){}});
el("token").value="example-test-only";el("mode").value="admin";el("connect").onclick();
assert.equal(el("token").value,"");
el("tasks").onclick();click(el("content"),"完成");
assert.ok(calls.some(c=>c[0].endsWith("/task/complete")&&c[1].on===date&&c[1].completed===true));
click(el("content"),"新增待办");
const inputs=all(el("editor"),n=>n.tag==="input");inputs[0].value="Fictional new task";
click(el("editor"),"保存");assert.ok(calls.some(c=>c[0].endsWith("/task/add")&&c[1].title==="Fictional new task"));
click(el("content"),"编辑");click(el("editor"),"取消");assert.equal(el("editor").className,"hidden");
confirmed=false;const count=calls.length;click(el("content"),"删除");assert.equal(calls.length,count);
confirmed=true;click(el("content"),"删除");assert.ok(calls.some(c=>c[0].endsWith("/task/delete")&&c[1].confirm===true));
el("posters").onclick();click(el("content"),"新增海报");
const pi=all(el("editor"),n=>n.tag==="input");pi[0].value="Fictional poster";all(el("editor"),n=>n.tag==="textarea")[0].value="Line one\nLine two";
click(el("editor"),"保存");assert.ok(calls.some(c=>c[0].endsWith("/poster/add")&&c[1].body==="Line one\nLine two"));
el("menus").onclick();click(el("content"),"新增菜单");const ta=all(el("editor"),n=>n.tag==="textarea");ta[0].value="Dish A\nDish B";ta[1].value="Ingredient A";
click(el("editor"),"保存");assert.ok(calls.some(c=>c[0].endsWith("/menu/set")&&c[1].dishes.length===2));
el("shopping").onclick();click(el("content"),"导入菜单食材");click(el("editor"),"保存");assert.ok(calls.some(c=>c[0].endsWith("/shopping/import")));
fail=true;el("refresh").onclick();assert.equal(el("content").children.length,0);
el("logout").onclick();assert.equal(el("home").className,"hidden");assert.equal(el("date").textContent,"");
fail=false;el("mode").value="read";el("token").value="example-reader";el("connect").onclick();el("tasks").onclick();
assert.equal(all(el("content"),n=>n.tag==="button").length,0);
console.log("Household browser logic simulation passed: read/admin, task, poster, menu, shopping, cancellation, logout.");
