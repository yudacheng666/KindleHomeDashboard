/* Dependency-free UI logic test with simulated DOM, timers and HTTP. */
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
class Node {
  constructor(){this.children=[];this.textContent="";this.value="";this.className="";this.disabled=false;}
  get firstChild(){return this.children[0];}
  appendChild(n){if(!this.children.length)this.value=n.value;this.children.push(n);}
  removeChild(n){this.children.splice(this.children.indexOf(n),1);if(!this.children.length)this.value="";}
}
const nodes = {};
const doc = {getElementById(id){return nodes[id]||(nodes[id]=new Node());},
             createElement(){return new Node();}};
const line={line_id:"sample",name:"Example",direction:"0",first:"A",last:"C",city_code:"310100"};
const stops=["A","B","C"].map(n=>({name:n,stop_id:n}));
const view={trip:{line,boarding:stops[0],destination:stops[2],board_index:0,destination_index:2},
  snapshot:{status:"live",vehicles:[{position:1,eta_min:4,distance_m:300,stops_remaining:1},{position:2,eta_min:9,distance_m:null,stops_remaining:null}],scheduled_departures:1,fetched_at:"2026-01-01T00:00:00+00:00"}};
const calls=[];
let failed=false;
class XHR {
  open(method,path){this.method=method;this.path=path;}
  setRequestHeader(name,value){if(name==="Authorization")assert.equal(value,"Bearer example-ui-token");}
  send(body){
    calls.push([this.method,this.path,body&&JSON.parse(body)]);
    let data;
    if(this.path==="/api/bus/view")data=view;
    if(this.path==="/api/bus/search")data={lines:[line]};
    if(this.path==="/api/bus/route")data={selection:"example-handle",route:{line,stops}};
    if(this.path==="/api/bus/save")data=view;
    this.status=failed?503:200;this.responseText=JSON.stringify(failed?{error:"service_error"}:data);
    this.readyState=4;this.onreadystatechange();
  }
  abort(){}
}
vm.runInNewContext(fs.readFileSync("dashboard/web/bus.js","utf8"),{document:doc,XMLHttpRequest:XHR,setTimeout:()=>1,clearTimeout:()=>{}});
const el=id=>doc.getElementById(id);
el("token").value="example-ui-token";el("mode").value="admin";el("connect").onclick();
assert.equal(el("token").value,"");
assert.equal(el("vehicles").children.length,2);
assert.equal(el("vehicles").children[0].children[1].textContent,"4 分钟");
el("settings").onclick();el("keyword").value="Example";el("search").onclick();el("detail").onclick();
assert.equal(el("board").children.length,2);
el("board").value="1";el("board").onchange();
assert.equal(el("destination").children.length,1);
assert.equal(el("destination").children[0].value,"2");
el("save").onclick();
assert.deepEqual(calls[calls.length-1][2],{selection:"example-handle",boarding:1,destination:2});
assert.equal(el("config").className,"hidden");
failed=true;el("refresh").onclick();assert.equal(el("vehicles").children.length,0);
el("logout").onclick();assert.equal(el("dashboard").className,"hidden");
assert.equal(el("trip").textContent,"");
console.log("Browser logic simulation passed: selection, ETA, disconnect and logout.");
