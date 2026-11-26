/* Read-only display. ES5/XHR; optional tab-local direct-mode resume metadata only. */
(function(){
"use strict";
var access=window.KHD_ACCESS||{}, direct=access.direct===true, openAdmin=access.openAdmin===true;
var token="", epoch=0, busy=false, data=null, pages=[], cursor=0, running=false;
var autoEntry=typeof location!=="undefined"&&location.pathname==="/auto", automatic=false;
var seconds=180, editing=false, section="tasks";
var refreshTimer=null, rotationTimer=null, lastRender="", mode="family", savedKey="", resumePage="";
var resumeKey="khd-display-resume-v1",ageNode=null,etaRows=[],etaSnapshot=null,busStatusNode=null,expiryTimer=null;
function el(id){return document.getElementById(id);}
function txt(id,s){var n=el(id);if(n.textContent!==s)n.textContent=s;}
function show(id,yes){var n=el(id),c=yes?"":"hidden";if(n.className!==c)n.className=c;}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);}
function append(root,tag,text,cls){var n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;root.appendChild(n);return n;}
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
  if(!s||[120,180,300].indexOf(s.seconds)<0||typeof s.autoplay!=="boolean")return;
  var key=JSON.stringify([s.seconds,s.autoplay]);
  if(savedKey===key)return;
  savedKey=key;seconds=s.seconds;running=s.autoplay;stopRotation();
}
function makePages(v){
  var p=[];
  if(section==="tasks")return [{id:"tasks",title:"待办清单",lines:v.tasks.length?v.tasks.map(function(t){return "□ "+t.title;}):["暂无待办"],note:""}];
  if(section==="posters"){
    v.posters.forEach(function(t){p=p.concat(posterPages(t));});
    return p.length?p:[{id:"posters",title:"海报",lines:["暂无有效海报"],note:""}];
  }
  var meals={breakfast:"早餐",lunch:"午餐",dinner:"晚餐"};
  return [{id:"week",title:"本周菜单",lines:v.week_menu.length?v.week_menu.map(function(m){return m.day+" · "+meals[m.meal]+"\n"+m.dishes.join("、");}):["暂无本周菜单"],note:""}];
}
function eligible(p){return section==="posters";}
function tabs(){
  var active=mode==="bus"?"bus":section;
  ["bus","tasks","posters","menus"].forEach(function(t){el(t+"Mode").className=t===active?"selected":"";});
  el("manageLink").href=mode==="bus"?"/":"/home#"+section;
  show("familyControls",mode==="family"&&section==="posters");
}
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
    section:section,saved:savedKey
  }));}catch(e){}
}
function restoreResume(){
  if(!direct||autoEntry||automatic||mode!=="family")return;
  try{
    var s=JSON.parse(window.sessionStorage.getItem(resumeKey)||"null");
    forgetResume();
    if(!s||typeof s.id!=="string"||s.id.length>128||
      typeof s.running!=="boolean"||[120,180,300].indexOf(s.seconds)<0||
      typeof s.saved!=="string"||s.saved.length>128)return;
    resumePage=s.id;running=s.running;seconds=s.seconds;
    section=["tasks","posters","menus"].indexOf(s.section)>=0?s.section:s.id.indexOf("poster:")===0?"posters":s.id==="week"?"menus":"tasks";savedKey=s.saved;
  }catch(e){}
}
function stopRotation(){clearTimeout(rotationTimer);rotationTimer=null;}
function scheduleRotation(){
  stopRotation();if(mode!=="family"||section!=="posters"||!running||editing||!data||document.hidden||pages.filter(eligible).length<2)return;
  rotationTimer=setTimeout(function(){
    rotationTimer=null;advance(1,true);scheduleRotation();
  },seconds*1000);
}
function advance(step,auto){
  if(section!=="posters"||!data||!pages.length)return;
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
  tabs();render();
  if(!running||pages.filter(eligible).length<2)stopRotation();
  else if(rotationTimer===null||found<0)scheduleRotation();
}
// ETA is a minute-resolution prediction at receipt, not a countdown or arrival event.
// Use the server epoch and configured timezone, not the device wall clock.
var serverBase=NaN,clientBase=0,zoneOffset=0;
function elapsedClock(){return typeof performance!=="undefined"&&typeof performance.now==="function"?performance.now():Date.now();}
function syncClock(s){serverBase=typeof s.server_now_ms==="number"?s.server_now_ms:NaN;clientBase=elapsedClock();zoneOffset=typeof s.timezone_offset_min==="number"?s.timezone_offset_min:0;}
function serverNow(){var elapsed=elapsedClock()-clientBase;return elapsed>=0?serverBase+elapsed:NaN;}
function clockTime(ms,now){
  var d=new Date(ms+zoneOffset*60000),n=new Date(now+zoneOffset*60000);
  function pad(v){return ("0"+v).slice(-2);}
  return (d.toUTCString().slice(0,16)!==n.toUTCString().slice(0,16)?pad(d.getUTCMonth()+1)+"-"+pad(d.getUTCDate())+" ":"")+pad(d.getUTCHours())+":"+pad(d.getUTCMinutes());
}
// Live arrivals take priority. Plans fill only vacant slots, never supply a stop ETA.
function slotItems(s){
  var items=(s.status==="live"||s.status==="stale")?s.vehicles.slice(0,2).map(function(v){return {vehicle:v};}):[];
  if(s.status==="live"||s.status==="no_live_data"){
    var plans=Array.isArray(s.departure_plans)?s.departure_plans:[];
    for(var i=0;i<plans.length&&items.length<2;i++)items.push({plan:plans[i]});
  }
  return items;
}
function slotNode(root,tag,cls){
  var n=document.createElement(tag);n.className=cls;root.appendChild(n);return n;
}
function buildSlot(root,i){
  var row=slotNode(root,"div","bus-slot "+(i===0?"bus-first":"bus-next"));
  var heading=slotNode(row,"div","bus-slot-label");heading.textContent=i===0?"最近一辆":"下一辆";
  var pair=slotNode(row,"div","bus-pair"),eta=slotNode(pair,"div","bus-left eta"),time=slotNode(pair,"div","bus-right bus-time");
  var detail=slotNode(row,"div","bus-pair bus-details"),stops=slotNode(detail,"div","bus-left"),distance=slotNode(detail,"div","bus-right");
  return {heading:heading,eta:eta,time:time,stops:stops,distance:distance,item:null};
}
function slotSet(node,value){if(node.textContent!==value)node.textContent=value;}
function updateEta(rows,s,now){
  var stamp=s.fetched_at_ms,age=now-stamp,valid=typeof stamp==="number"&&isFinite(stamp)&&age>=0&&age<90000;
  rows.forEach(function(row,i){
    var item=row.item,v=item.vehicle,p=item.plan,label="",time="",stops="",distance="",compact=false;
    slotSet(row.heading,(i===0?"最近一辆":"下一辆")+(p?" · 发车计划":""));
    if(!valid){label="等待数据更新";compact=true;}
    else if(p){
      var current=new Date(now+zoneOffset*60000),minute=current.getUTCHours()*60+current.getUTCMinutes(),delta=null;
      if(p.time){var a=p.time.split(":");delta=Number(a[0])*60+Number(a[1])-minute;}
      // Date is not provided; do not infer departure across midnight or from a passed plan.
      label=p.imminent===true||delta===0||delta===1?"计划即将发车":delta!==null&&delta<0&&delta>=-720?"等待发车确认":"等待首站发车";
      time=p.time?"首站计划发车\n"+p.time:"首站计划发车\n时间未知";
      stops="本站到站时间未知";compact=true;
    }else if(v){
      var target=stamp+v.eta_min*60000,remaining=Math.ceil((target-now)/60000);
      if(s.status==="stale"){label="约 "+v.eta_min+" 分钟";time="原预计到站\n"+clockTime(target,now);}
      else{
        label=v.eta_min===0&&v.distance_m===0&&v.stops_remaining===0?"车辆已到站附近":remaining<=0?"等待到站确认":remaining===1?"预计即将到站":"约 "+remaining+" 分钟";
        time="预计到站\n"+clockTime(target,now);
      }
      compact=label.indexOf("分钟")<0||label.length>9;
      if(v.stops_remaining!=null)stops="剩余 "+v.stops_remaining+" 站";
      if(v.distance_m!=null)distance="距离 "+v.distance_m+" 米";
    }
    var cls="bus-left eta"+(compact?" bus-state":"");
    if(row.eta.className!==cls)row.eta.className=cls;
    slotSet(row.eta,label);slotSet(row.time,time);slotSet(row.stops,stops);slotSet(row.distance,distance);
  });
  return valid;
}
function slotStatus(s,valid){
  return !valid?"数据时间异常或已过期":s.status==="stale"?"数据暂未更新 · 以下为旧数据":s.vehicles.length?"实时预计到站":slotItems(s).length?"等待首站发车（计划）":"暂未取得在途车辆信息";
}
function stopAge(){clearTimeout(expiryTimer);expiryTimer=null;ageNode=null;etaRows=[];etaSnapshot=null;busStatusNode=null;}
function paintAge(){
  clearTimeout(expiryTimer);expiryTimer=null;if(document.hidden)return;
  var now=serverNow();txt("date",isFinite(now)?clockTime(now,now):"");
  if(!ageNode||!etaSnapshot)return;
  var stamp=etaSnapshot.fetched_at_ms,valid=updateEta(etaRows,etaSnapshot,now);
  if(busStatusNode)slotSet(busStatusNode,slotStatus(etaSnapshot,valid));
  var label=!isFinite(stamp)||!isFinite(now)||stamp>now?"更新时间未知（请检查 NAS 时间）":"数据更新于 "+clockTime(stamp,now)+(valid?"":" · 数据已失去时效");
  if(ageNode.textContent!==label)ageNode.textContent=label;
  // The local deadline does not wait for a slow or outstanding LAN read.
  if(valid)expiryTimer=setTimeout(paintAge,90000-(now-stamp));
}
function acceptBus(v){
  data=null;pages=[];cursor=0;resumePage="";stopRotation();
  var s=v.snapshot,t=v.trip;
  var labels={live:"实时预计到站",stale:"数据暂未更新 · 以下为旧数据",expired:"数据已过期",paused:"非采集时段",blocked:"接口限制访问",disabled:"公交采集未启用",config_error:"公交配置错误，采集已暂停；请检查 Docker 日志",unconfigured:"请先设置公交",unverified:"正在核对线路",needs_selection:"站序已变化，请重新选站",unavailable:"等待首次采集",no_live_data:"暂未取得在途车辆信息",error:"接口请求失败",service_error:"本地采集服务异常"};
  var items=slotItems(s),key=JSON.stringify([t,items.length,["live","stale","no_live_data"].indexOf(s.status)>=0]);
  if(key!==lastRender){
    stopAge();lastRender=key;txt("date","");txt("heading",t?t.line.name:"实时公交");txt("index","");
    var root=el("body");clear(root);
    if(t)append(root,"p",t.boarding.name+" → "+t.destination.name);
    busStatusNode=append(root,"p",labels[s.status]||"状态未知","note");
    for(var i=0;i<items.length;i++)etaRows.push(buildSlot(root,i));
    if(["live","stale","no_live_data"].indexOf(s.status)>=0)ageNode=append(root,"p","","note");
  }
  items.forEach(function(item,i){etaRows[i].item=item;});
  if(!items.length&&busStatusNode)slotSet(busStatusNode,labels[s.status]||"状态未知");
  etaSnapshot=s;syncClock(s);paintAge();
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
  tabs();hide("正在读取");refresh();
}
function switchSection(next){
  if(!token)return;
  manual();
  if(mode==="bus"){section=next;switchMode("family");return;}
  if(section===next)return;
  section=next;editing=false;show("options",false);stopRotation();resumePage="";tabs();
  if(data)accept(data);else if(!busy)refresh();
}
function hide(reason){
  stopAge();
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
        if(mode!==v.mode){resumePage="";forgetResume();mode=v.mode;editing=false;show("options",false);tabs();hide("");}
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
      var valid=payload&&(next==="bus"?payload.snapshot&&Array.isArray(payload.snapshot.vehicles):next==="family"&&Array.isArray(payload.tasks)&&Array.isArray(payload.posters)&&Array.isArray(payload.week_menu));
      finish(x.status===200&&valid,v,x.status);};
    timeout=setTimeout(function(){finish(false,null,0);try{x.abort();}catch(e){}},12000);x.send(null);
  }catch(e){finish(false,null,0);}
}
function reset(keepResume){
  if(keepResume!==true)forgetResume();resumePage="";
  epoch++;busy=false;token="";automatic=false;modeLabel();mode="family";section="tasks";savedKey="";tabs();running=false;editing=false;seconds=180;
  clearTimeout(refreshTimer);refreshTimer=null;hide("");el("token").value="";
  show("options",false);show("display",false);show("login",true);
}
el("connect").onclick=function(){if(busy)return;token=el("token").value;el("token").value="";if(direct&&!token)token="local-direct";if(token){automatic=autoEntry;restoreResume();tabs();modeLabel();clearTimeout(refreshTimer);refreshTimer=null;refresh();}};
el("autoMode").onclick=function(){
  if(!token)return;
  automatic=true;forgetResume();epoch++;busy=false;editing=false;section="tasks";tabs();show("options",false);
  clearTimeout(refreshTimer);refreshTimer=null;modeLabel();refresh();
};
el("tasksMode").onclick=function(){switchSection("tasks");};
el("postersMode").onclick=function(){switchSection("posters");};
el("menusMode").onclick=function(){switchSection("menus");};
el("busMode").onclick=function(){switchMode("bus");};
el("previous").onclick=function(){if(editing||section!=="posters"||mode!=="family")return;manual();running=false;stopRotation();advance(-1,false);};
el("next").onclick=function(){if(editing||section!=="posters"||mode!=="family")return;manual();running=false;stopRotation();advance(1,false);};
el("pause").onclick=function(){if(!data||editing||section!=="posters")return;if(running)manual();running=!running;render();scheduleRotation();};
el("settings").onclick=function(){if(editing||mode!=="family"||section!=="posters")return;manual();editing=true;stopRotation();el("seconds").value=String(seconds);show("options",true);};
function closeSettings(){editing=false;show("options",false);scheduleRotation();}
el("apply").onclick=function(){var n=Number(el("seconds").value);if([120,180,300].indexOf(n)<0)return;seconds=n;closeSettings();};
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
    rememberResume();stopAge();stopRotation();clearTimeout(refreshTimer);refreshTimer=null;epoch++;busy=false;
  }
  else if(token){
    if(mode==="family"&&pages[cursor])resumePage=pages[cursor].id;
    hide("正在重新读取");refresh();
  }
},false);
if(direct){el("connect").onclick();}
}());
