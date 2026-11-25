/* Read-only display preview. ES5/XHR; no persistence or external requests. */
(function(){
"use strict";
var token="", epoch=0, busy=false, data=null, pages=[], cursor=0, running=false;
var seconds=180, includeWeek=false, includeShopping=false, editing=false;
var refreshTimer=null, rotationTimer=null, lastRender="", mode="family";
function el(id){return document.getElementById(id);}
function txt(id,s){var n=el(id);if(n.textContent!==s)n.textContent=s;}
function show(id,yes){el(id).className=yes?"":"hidden";}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);}
function append(root,tag,text,cls){var n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;root.appendChild(n);}
function makePages(v){
  var p=[], summaries=[];
  if(v.tasks.length) summaries.push("待办 · "+v.tasks.length+"件");
  if(v.posters.length) summaries.push("提醒 · "+v.posters.length+"张");
  if(v.today_menu.length) summaries.push("今日菜单 · "+v.today_menu.length+"餐");
  p.push({id:"today",title:"今日生活",lines:summaries.length?summaries:["暂无家庭安排"],note:""});
  if(v.tasks.length)p.push({id:"tasks",title:"今日待办",lines:v.tasks.map(function(t){return "□ "+t.title;}),note:""});
  v.posters.forEach(function(t){p.push({id:"poster:"+t.id,title:t.title,lines:[t.body],note:t.note||"",poster:true});});
  var meals={breakfast:"早餐",lunch:"午餐",dinner:"晚餐"};
  function menu(m,week){return (week?m.day+" · ":"")+meals[m.meal]+"\n"+m.dishes.join("、");}
  if(v.today_menu.length)p.push({id:"menu",title:"今日菜单",lines:v.today_menu.map(function(m){return menu(m,false);}),note:""});
  if(v.week_menu.length)p.push({id:"week",title:"本周菜单",lines:v.week_menu.map(function(m){return menu(m,true);}),note:""});
  var items=v.shopping.filter(function(s){return !s.completed;});
  if(items.length)p.push({id:"shopping",title:"购物清单",lines:items.map(function(s){return "□ "+s.label;}),note:""});
  return p;
}
function eligible(p){return (p.id!=="week"||includeWeek)&&(p.id!=="shopping"||includeShopping);}
function render(){
  var p=pages[cursor];if(!p||!data)return;
  var key=JSON.stringify([data.date,p,cursor,pages.length]);
  if(key!==lastRender){
    lastRender=key;txt("date",data.date);txt("heading",p.title);
    var root=el("body");clear(root);p.lines.forEach(function(line){append(root,"p",line,p.poster?"poster":"");});
    if(p.note)append(root,"p",p.note,"note");
    txt("index",(cursor+1)+" / "+pages.length);
  }
  txt("pause",running?"暂停轮播":"开始轮播");
}
function stopRotation(){clearTimeout(rotationTimer);rotationTimer=null;}
function scheduleRotation(){
  stopRotation();if(mode!=="family"||!running||editing||!data||document.hidden||pages.filter(eligible).length<2)return;
  rotationTimer=setTimeout(function(){
    rotationTimer=null;advance(1,true);scheduleRotation();
  },seconds*1000);
}
function advance(step,auto){
  if(!data||!pages.length)return;
  for(var i=1;i<=pages.length;i++){
    var n=(cursor+step*i+pages.length)%pages.length;
    if(!auto||eligible(pages[n])){cursor=n;render();return;}
  }
}
function accept(v){
  var old=pages[cursor], next=makePages(v), found=-1;
  for(var i=0;old&&i<next.length;i++)if(next[i].id===old.id)found=i;
  data=v;pages=next;cursor=found<0?0:found;
  show("login",false);show("display",true);txt("status","");
  render();
  if(!running||pages.filter(eligible).length<2)stopRotation();
  else if(rotationTimer===null||found<0)scheduleRotation();
}
function acceptBus(v){
  data=null;pages=[];cursor=0;stopRotation();
  var s=v.snapshot,t=v.trip;
  var labels={live:"实时预计到站",stale:"数据暂未更新 · 以下为旧数据",expired:"数据已过期",paused:"非采集时段",blocked:"接口限制访问",disabled:"公交采集未启用",unconfigured:"请先设置公交",unverified:"正在核对线路",needs_selection:"站序已变化，请重新选站",unavailable:"等待首次采集",no_live_data:"暂未取得在途车辆信息",error:"接口请求失败",service_error:"本地采集服务异常"};
  var vehicles=(s.status==="live"||s.status==="stale")?s.vehicles:[];
  var key=JSON.stringify([t,s.status,vehicles,s.scheduled_departures,vehicles.length?s.fetched_at:""]);
  if(key!==lastRender){
    lastRender=key;txt("date","");txt("heading",t?t.line.name:"实时公交");txt("index","");
    var root=el("body");clear(root);
    if(t)append(root,"p",t.boarding.name+" → "+t.destination.name);
    append(root,"p",labels[s.status]||"状态未知","note");
    vehicles.forEach(function(v){
      append(root,"p",v.position===1?"最近一辆":"下一辆","note");
      append(root,"p",v.eta_min+" 分钟","eta");
      var a=[];if(v.distance_m!=null)a.push(v.distance_m+" 米");
      if(v.stops_remaining!=null)a.push("剩余 "+v.stops_remaining+" 站");
      if(a.length)append(root,"p",a.join(" · "),"note");
    });
    if(s.scheduled_departures&&s.status!=="stale")append(root,"p","计划待发车 "+s.scheduled_departures+" 辆（非实时 ETA）","note");
    if(vehicles.length)append(root,"p","最近有效采集（UTC）："+s.fetched_at.replace("T"," ").slice(0,19),"note");
  }
  show("login",false);show("display",true);txt("status","");
}
function switchMode(next){
  if(!token||next===mode)return;
  epoch++;busy=false;clearTimeout(refreshTimer);refreshTimer=null;editing=false;
  show("options",false);mode=next;
  show("familyControls",mode==="family");hide("正在读取");refresh();
}
function hide(reason){
  data=null;pages=[];cursor=0;lastRender="";stopRotation();
  txt("date","");txt("heading","");clear(el("body"));txt("index","");txt("status",reason);
}
function refresh(){
  if(!token||busy||document.hidden)return;
  busy=true;var g=epoch,x=new XMLHttpRequest(),ended=false,timeout;
  function finish(ok,v,status){
    if(ended)return;ended=true;clearTimeout(timeout);if(g!==epoch)return;busy=false;
    if(ok){if(mode==="bus")acceptBus(v);else accept(v);}
    else if((status===404&&mode==="family")||status===503){show("login",false);show("display",true);hide(status===404?"家庭模块未启用，可切换至公交。":"当前模块暂不可用，可切换其他模块。");}
    else{hide(status===401?"令牌无效，请重新连接。":status===404?"家庭模块未启用。":"连接异常，旧内容已隐藏。");
      if(status===401){reset();txt("status","令牌无效，请重新连接。");return;}}
    clearTimeout(refreshTimer);refreshTimer=document.hidden?null:setTimeout(refresh,mode==="bus"?15000:30000);
  }
  try{x.open("GET",mode==="bus"?"/api/bus/view":"/api/home/view",true);x.setRequestHeader("Authorization","Bearer "+token);
    x.onreadystatechange=function(){if(x.readyState!==4)return;var v=null;try{v=JSON.parse(x.responseText);}catch(e){}
      var valid=v&&(mode==="bus"?v.snapshot&&Array.isArray(v.snapshot.vehicles):Array.isArray(v.tasks)&&Array.isArray(v.posters)&&Array.isArray(v.today_menu)&&Array.isArray(v.week_menu)&&Array.isArray(v.shopping));
      finish(x.status===200&&valid,v,x.status);};
    timeout=setTimeout(function(){finish(false,null,0);try{x.abort();}catch(e){}},12000);x.send(null);
  }catch(e){finish(false,null,0);}
}
function reset(){
  epoch++;busy=false;token="";mode="family";show("familyControls",true);running=false;editing=false;seconds=180;includeWeek=false;includeShopping=false;
  clearTimeout(refreshTimer);refreshTimer=null;hide("");el("token").value="";
  show("options",false);show("display",false);show("login",true);
}
el("connect").onclick=function(){if(busy)return;token=el("token").value;el("token").value="";if(token){clearTimeout(refreshTimer);refreshTimer=null;refresh();}};
el("familyMode").onclick=function(){switchMode("family");};
el("busMode").onclick=function(){switchMode("bus");};
el("previous").onclick=function(){if(editing)return;running=false;stopRotation();advance(-1,false);};
el("next").onclick=function(){if(editing)return;running=false;stopRotation();advance(1,false);};
el("pause").onclick=function(){if(!data||editing)return;running=!running;render();scheduleRotation();};
el("settings").onclick=function(){if(editing)return;editing=true;stopRotation();el("seconds").value=String(seconds);el("week").checked=includeWeek;el("shopping").checked=includeShopping;show("options",true);};
function closeSettings(){editing=false;show("options",false);scheduleRotation();}
el("apply").onclick=function(){var n=Number(el("seconds").value);if([120,180,300].indexOf(n)<0)return;seconds=n;includeWeek=el("week").checked;includeShopping=el("shopping").checked;closeSettings();};
el("cancel").onclick=closeSettings;
el("logout").onclick=reset;
if(window.addEventListener)window.addEventListener("pagehide",reset,false);
if(document.addEventListener)document.addEventListener("visibilitychange",function(){
  if(document.hidden){stopRotation();clearTimeout(refreshTimer);refreshTimer=null;epoch++;busy=false;}
  else if(token){hide("正在重新读取");refresh();}
},false);
}());
