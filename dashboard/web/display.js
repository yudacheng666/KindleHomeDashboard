/* Read-only display. ES5/XHR; optional tab-local direct-mode resume metadata only. */
(function(){
"use strict";
var access=window.KHD_ACCESS||{}, direct=access.direct===true, openAdmin=access.openAdmin===true;
var token="", epoch=0, busy=false, data=null, pages=[], cursor=0, running=false;
var autoEntry=typeof location!=="undefined"&&location.pathname==="/auto", automatic=false;
var seconds=180, includeWeek=false, includeShopping=false, editing=false;
var refreshTimer=null, rotationTimer=null, lastRender="", mode="family", savedKey="", resumePage="";
var resumeKey="khd-display-resume-v1";
function el(id){return document.getElementById(id);}
function txt(id,s){var n=el(id);if(n.textContent!==s)n.textContent=s;}
function show(id,yes){el(id).className=yes?"":"hidden";}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);}
function append(root,tag,text,cls){var n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;root.appendChild(n);}
// Conservative character/line budget; never truncate, including surrogate pairs.
// Scrolling remains a fallback for unusually narrow viewports or long titles.
function chunks(value){
  var chars=value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g)||[], result=[], part="", count=0, breaks=0;
  chars.forEach(function(ch){
    if(part&&(count>=54||breaks>=4)){result.push(part);part="";count=0;breaks=0;}
    part+=ch;count++;if(ch==="\n")breaks++;
  });
  if(part||!result.length)result.push(part);return result;
}
function posterPages(t){
  var parts=chunks(t.body),result=[];
  parts.forEach(function(body,i){
    var suffix=parts.length>1?" · "+(i+1)+"/"+parts.length:"";
    result.push({id:"poster:"+t.id+":"+i,title:t.title+suffix,lines:[body],note:i===parts.length-1?t.note||"":"",poster:true});
  });return result;
}
function useSaved(v){
  var s=v.display_settings;
  if(!s||[120,180,300].indexOf(s.seconds)<0||typeof s.include_week!=="boolean"||typeof s.include_shopping!=="boolean"||typeof s.autoplay!=="boolean")return;
  var key=JSON.stringify([s.seconds,s.include_week,s.include_shopping,s.autoplay]);
  if(savedKey===key)return;
  savedKey=key;seconds=s.seconds;includeWeek=s.include_week;includeShopping=s.include_shopping;running=s.autoplay;stopRotation();
}
function makePages(v){
  var p=[], summaries=[];
  if(v.tasks.length) summaries.push("待办 · "+v.tasks.length+"件");
  if(v.posters.length) summaries.push("提醒 · "+v.posters.length+"张");
  if(v.today_menu.length) summaries.push("今日菜单 · "+v.today_menu.length+"餐");
  p.push({id:"today",title:"今日生活",lines:summaries.length?summaries:["暂无家庭安排"],note:""});
  if(v.tasks.length)p.push({id:"tasks",title:"今日待办",lines:v.tasks.map(function(t){return "□ "+t.title;}),note:""});
  v.posters.forEach(function(t){p=p.concat(posterPages(t));});
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
    var root=el("body");clear(root);p.lines.forEach(function(line){append(root,"p",line,p.poster?(line.length>38?"poster compact":line.length>18?"poster medium":"poster"):"");});
    if(p.note)append(root,"p",p.note,"note");
    txt("index",(cursor+1)+" / "+pages.length);
  }
  txt("pause",running?"暂停轮播":"开始轮播");
}
// Never store credentials or page contents. The direct manual display can resume
// after a mobile browser reload; token-authenticated and /auto entries cannot.
function forgetResume(){
  if(!direct||autoEntry)return;
  try{window.sessionStorage.removeItem(resumeKey);}catch(e){}
}
function rememberResume(){
  if(!direct||autoEntry||automatic||mode!=="family"||!token||!pages[cursor])return;
  try{window.sessionStorage.setItem(resumeKey,JSON.stringify({
    id:pages[cursor].id,running:running,seconds:seconds,
    week:includeWeek,shopping:includeShopping,saved:savedKey
  }));}catch(e){}
}
function restoreResume(){
  if(!direct||autoEntry||automatic||mode!=="family")return;
  try{
    var s=JSON.parse(window.sessionStorage.getItem(resumeKey)||"null");
    forgetResume();
    if(!s||typeof s.id!=="string"||s.id.length>128||
      typeof s.running!=="boolean"||[120,180,300].indexOf(s.seconds)<0||
      typeof s.week!=="boolean"||typeof s.shopping!=="boolean"||
      typeof s.saved!=="string"||s.saved.length>128)return;
    resumePage=s.id;running=s.running;seconds=s.seconds;
    includeWeek=s.week;includeShopping=s.shopping;savedKey=s.saved;
  }catch(e){}
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
  useSaved(v);
  var old=pages[cursor], id=old?old.id:resumePage, next=makePages(v), found=-1;
  for(var i=0;id&&i<next.length;i++)if(next[i].id===id)found=i;
  resumePage="";data=v;pages=next;cursor=found<0?0:found;
  show("login",false);show("display",true);txt("status","");
  render();
  if(!running||pages.filter(eligible).length<2)stopRotation();
  else if(rotationTimer===null||found<0)scheduleRotation();
}
function acceptBus(v){
  data=null;pages=[];cursor=0;resumePage="";stopRotation();
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
function modeLabel(){
  txt("modeStatus",automatic?"自动分时 · 按 NAS 采集时段":"手动显示 · 不自动切换模块");
}
function manual(){
  if(!automatic)return;
  automatic=false;epoch++;busy=false;clearTimeout(refreshTimer);
  refreshTimer=setTimeout(refresh,mode==="bus"?15000:30000);modeLabel();
}
function switchMode(next){
  if(!token)return;
  manual();
  if(next===mode)return;
  epoch++;busy=false;clearTimeout(refreshTimer);refreshTimer=null;editing=false;
  show("options",false);resumePage="";forgetResume();mode=next;
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
    if(ok){
      if(automatic){
        if(mode!==v.mode){resumePage="";forgetResume();mode=v.mode;editing=false;show("options",false);show("familyControls",mode==="family");hide("");}
        v=v.view;
      }
      if(mode==="bus")acceptBus(v);else accept(v);
      modeLabel();
    }
    else if((status===404&&mode==="family")||status===503){show("login",false);show("display",true);hide(status===404?"家庭模块未启用，可切换至公交。":"当前模块暂不可用，可切换其他模块。");}
    else{hide(status===401?"令牌无效，请重新连接。":status===404?"家庭模块未启用。":"连接异常，旧内容已隐藏。");
      if(status===401){reset();txt("status","令牌无效，请重新连接。");return;}}
    clearTimeout(refreshTimer);refreshTimer=document.hidden?null:setTimeout(refresh,mode==="bus"?15000:30000);
  }
  try{x.open("GET",automatic?"/api/display/auto":mode==="bus"?"/api/bus/view":"/api/home/view",true);if(token&&token!=="local-direct")x.setRequestHeader("Authorization","Bearer "+token);
    x.onreadystatechange=function(){if(x.readyState!==4)return;var v=null;try{v=JSON.parse(x.responseText);}catch(e){}
      var next=automatic&&v?v.mode:mode, payload=automatic&&v?v.view:v;
      var valid=payload&&(next==="bus"?payload.snapshot&&Array.isArray(payload.snapshot.vehicles):next==="family"&&Array.isArray(payload.tasks)&&Array.isArray(payload.posters)&&Array.isArray(payload.today_menu)&&Array.isArray(payload.week_menu)&&Array.isArray(payload.shopping));
      finish(x.status===200&&valid,v,x.status);};
    timeout=setTimeout(function(){finish(false,null,0);try{x.abort();}catch(e){}},12000);x.send(null);
  }catch(e){finish(false,null,0);}
}
function reset(keepResume){
  if(keepResume!==true)forgetResume();resumePage="";
  epoch++;busy=false;token="";automatic=false;modeLabel();mode="family";savedKey="";show("familyControls",true);running=false;editing=false;seconds=180;includeWeek=false;includeShopping=false;
  clearTimeout(refreshTimer);refreshTimer=null;hide("");el("token").value="";
  show("options",false);show("display",false);show("login",true);
}
el("connect").onclick=function(){if(busy)return;token=el("token").value;el("token").value="";if(direct&&!token)token="local-direct";if(token){automatic=autoEntry;restoreResume();modeLabel();clearTimeout(refreshTimer);refreshTimer=null;refresh();}};
el("autoMode").onclick=function(){
  if(!token)return;
  automatic=true;forgetResume();epoch++;busy=false;editing=false;show("options",false);
  clearTimeout(refreshTimer);refreshTimer=null;modeLabel();refresh();
};
el("familyMode").onclick=function(){switchMode("family");};
el("busMode").onclick=function(){switchMode("bus");};
el("previous").onclick=function(){if(editing)return;manual();running=false;stopRotation();advance(-1,false);};
el("next").onclick=function(){if(editing)return;manual();running=false;stopRotation();advance(1,false);};
el("pause").onclick=function(){if(!data||editing)return;if(running)manual();running=!running;render();scheduleRotation();};
el("settings").onclick=function(){if(editing)return;manual();editing=true;stopRotation();el("seconds").value=String(seconds);el("week").checked=includeWeek;el("shopping").checked=includeShopping;show("options",true);};
function closeSettings(){editing=false;show("options",false);scheduleRotation();}
el("apply").onclick=function(){var n=Number(el("seconds").value);if([120,180,300].indexOf(n)<0)return;seconds=n;includeWeek=el("week").checked;includeShopping=el("shopping").checked;closeSettings();};
el("cancel").onclick=closeSettings;
el("logout").onclick=reset;
if(window.addEventListener){
  window.addEventListener("pagehide",function(){
    var keep=direct&&!autoEntry&&!automatic&&mode==="family"&&!!token;
    if(keep)rememberResume();
    reset(keep);
  },false);
  window.addEventListener("pageshow",function(e){
    if(direct&&e.persisted&&!token)el("connect").onclick();
  },false);
}
if(document.addEventListener)document.addEventListener("visibilitychange",function(){
  if(document.hidden){
    rememberResume();stopRotation();clearTimeout(refreshTimer);refreshTimer=null;epoch++;busy=false;
  }
  else if(token){
    if(mode==="family"&&pages[cursor])resumePage=pages[cursor].id;
    hide("正在重新读取");refresh();
  }
},false);
if(direct){el("connect").onclick();}
}());
