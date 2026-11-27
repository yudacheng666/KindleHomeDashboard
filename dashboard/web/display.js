/* Display with explicitly authorized task completion. ES5/XHR; optional tab-local direct-mode resume metadata only. */
(function(){
"use strict";
var access=window.KHD_ACCESS||{}, direct=access.direct===true, openAdmin=access.openAdmin===true;
var token="", epoch=0, busy=false, data=null, pages=[], cursor=0, running=false;
var path=typeof location!=="undefined"?location.pathname:"";
var preview=path==="/preview"||path==="/preview/auto";
var adminModule=path==="/admin/weather"?"weather":path==="/admin/driving"?"driving":"";
var autoEntry=path==="/auto"||path==="/preview/auto", automatic=false;
var seconds=180, editing=false, section="tasks", settingsOpen=false;
var refreshTimer=null, rotationTimer=null, lastRender="", mode="family", savedKey="", resumePage="";
var weatherPages=[],weatherCursor=0,weatherOrder="",WEATHER_SECONDS=120;
var overviewTimers={},overviewPending={},overviewRoots={},overviewKeys={},overviewDay="";
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
  if(section==="tasks"){
    var tasks=Array.isArray(v.upcoming_tasks)?v.upcoming_tasks:v.tasks;
    return [{id:"tasks",title:"待办清单",lines:tasks.length?[]:["暂无待办"],note:"",tasks:tasks,canComplete:v.can_complete===true}];
  }
  if(section==="posters"){
    v.posters.forEach(function(t){p=p.concat(posterPages(t));});
    return p.length?p:[{id:"posters",title:"海报",lines:["暂无有效海报"],note:""}];
  }
  var settings=v.menu_display||{mode:"week",days:7},title=settings.mode==="week"?"本周菜单":"未来"+settings.days+"天菜单";
  return [{id:"week",title:title,menus:v.week_menu,lines:["暂无"+title],note:""}];
}
function eligible(p){return section==="posters";}
function tabs(){
  var active=mode==="family"?section:mode;
  ["overview","bus","tasks","posters","menus","weather","driving"].forEach(function(t){el(t+"Mode").className=t===active?"selected":"";});
  updateManagementLinks();
  show("familyControls",mode==="family"&&section==="posters");
}
function updateManagementLinks(){
  var target=automatic?"auto":mode==="family"?section:mode;
  el("manageLink").href="/bus#return-"+target;
  ["tasks","posters","menus","catalog","display"].forEach(function(t){el(t+"Manage").href="/home#"+t+"/return-"+target;});
}
function panel(open){settingsOpen=open;show("settingsPanel",open);show("displayNav",!open);show("displayContent",!open);show("weatherDisplayControls",open&&(mode==="weather"||mode==="overview")&&weatherPages.length>1);if(open)updateManagementLinks();}
function taskDateLabel(day,today){
  var d=new Date(day+"T00:00:00Z"),base=new Date(today+"T00:00:00Z");
  var label=(day.slice(0,4)===today.slice(0,4)?"":day.slice(0,4)+"/")+day.slice(5).replace("-","/");
  if(!isNaN(d.getTime()))label+=" 周"+"日一二三四五六".charAt(d.getUTCDay());
  return {label:label,tag:day===today?"今日":d.getTime()-base.getTime()===86400000?"明日":""};
}
function render(){
  var p=pages[cursor];if(!p||!data)return;
  var key=JSON.stringify([data.date,p,cursor,pages.length]);
  if(key!==lastRender){
    lastRender=key;txt("date",data.date);txt("heading",p.title);
    var root=el("body");clear(root);
    if(p.tasks&&p.tasks.length){
      var displayedDate=data.date,groups={},overdue=false;
      p.tasks.forEach(function(t){var day=t.occurrence||displayedDate;(groups[day]||(groups[day]=[])).push(t);});
      Object.keys(groups).sort().forEach(function(day){
        if(day<displayedDate&&!overdue){append(root,"h2","逾期","task-overdue");overdue=true;}
        var group=append(root,"section","","task-day"),label=taskDateLabel(day,displayedDate);
        var heading=append(group,"h3",label.label,"task-date");
        if(label.tag)append(heading,"span",label.tag,"task-date-tag");
        groups[day].forEach(function(t){
          var row=append(group,"div","","task-row");append(row,"span",t.title,"task-text");
          if(p.canComplete&&day<=displayedDate){
            var action=append(row,"span","","task-action"),button=append(action,"button","完成","task-complete");
            button.type="button";button.onclick=function(){completeTask(t,displayedDate,button);};
          }
        });
      });
    }else if(p.menus&&p.menus.length){
      var days={},names={breakfast:"早餐",lunch:"午餐",dinner:"晚餐"},order={breakfast:0,lunch:1,dinner:2};
      p.menus.forEach(function(m){(days[m.day]||(days[m.day]=[])).push(m);});
      Object.keys(days).sort().forEach(function(day){
        var group=append(root,"section","","menu-day"),heading=append(group,"h2",day,"menu-date");
        if(day===data.date)append(heading,"span","今日","menu-today");
        days[day].sort(function(a,b){return order[a.meal]-order[b.meal];}).forEach(function(m){
          var meal=append(group,"div","","menu-meal");
          append(meal,"span",names[m.meal],"menu-meal-label");
          append(meal,"span",m.dishes.join("、"),"menu-dishes");
        });
      });
    }else p.lines.forEach(function(line){append(root,"p",line,p.poster?(line.length>38?"poster compact":line.length>18?"poster medium":"poster"):"");});
    if(p.note)append(root,"p",p.note,"note");
    txt("index",section==="posters"?(cursor+1)+" / "+pages.length:"");
  }
  txt("pause",running?"暂停轮播":"开始轮播");
}
function completeTask(t,on,button){
  if(preview)return;
  if(!token||!data||data.date!==on||(t.occurrence&&t.occurrence>on)||data.can_complete!==true||!(mode==="overview"||(section==="tasks"&&mode==="family"))||settingsOpen)return;
  if(busy||(mode==="overview"&&overviewPending.home)){txt("status","正在同步，请稍后再试。");return;}
  if(!window.confirm("确认完成「"+t.title+"」？完成后保留历史记录。"))return;
  var g=epoch,x=new XMLHttpRequest(),ended=false,timer;
  busy=true;button.disabled=true;clearTimeout(refreshTimer);refreshTimer=null;
  function finish(ok){
    if(ended)return;ended=true;clearTimeout(timer);if(g!==epoch)return;
    busy=false;button.disabled=false;
    if(ok&&data&&data.date===on){
      data.tasks=data.tasks.filter(function(item){return item.id!==t.id;});
      if(Array.isArray(data.upcoming_tasks))data.upcoming_tasks=data.upcoming_tasks.filter(function(item){return item.id!==t.id;});
      data.posters=data.posters.filter(function(item){return item.task_id!==t.id;});
      if(mode==="overview"){renderOverviewHome(data);clearTimeout(overviewTimers.home);requestOverview("home");}else{accept(data);refresh();}
    }else{
      txt("status","完成未确认成功，请刷新核对后再试。");
      if(mode==="overview"){clearTimeout(overviewTimers.home);overviewTimers.home=setTimeout(function(){requestOverview("home");},30000);}else refreshTimer=setTimeout(refresh,30000);
    }
  }
  try{x.open("POST","/api/home/task/complete",true);
    if(token!=="local-direct")x.setRequestHeader("Authorization","Bearer "+token);
    x.setRequestHeader("Content-Type","application/json");
    x.onreadystatechange=function(){if(x.readyState!==4)return;var v=null;try{v=JSON.parse(x.responseText);}catch(e){}
      finish(x.status===200&&v&&v.result===null);};
    timer=setTimeout(function(){finish(false);try{x.abort();}catch(e){}},12000);
    x.send(JSON.stringify({key:t.id,on:on,completed:true}));
  }catch(e){finish(false);}
}
// Never store credentials or page contents. The direct manual display can resume
// after a mobile browser reload; token-authenticated and /auto entries cannot.
function forgetResume(){
  if(preview||adminModule||!direct||autoEntry)return;
  try{window.sessionStorage.removeItem(resumeKey);}catch(e){}
}
function rememberResume(){
  if(preview||adminModule||!direct||autoEntry||automatic||mode!=="family"||!token||!pages[cursor])return;
  try{window.sessionStorage.setItem(resumeKey,JSON.stringify({
    id:pages[cursor].id,running:running,seconds:seconds,
    section:section,saved:savedKey
  }));}catch(e){}
}
function restoreResume(){
  if(preview||adminModule||!direct||autoEntry||automatic||mode!=="family")return;
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
  stopRotation();
  if(mode==="weather"||mode==="overview"){
    if(settingsOpen||document.hidden||!token||automatic||weatherPages.length<2)return;
    rotationTimer=setTimeout(function(){
      rotationTimer=null;
      if((mode!=="weather"&&mode!=="overview")||settingsOpen||document.hidden||!token||automatic)return;
      weatherCursor=(weatherCursor+1)%weatherPages.length;if(mode==="overview")renderOverviewWeather();else renderWeather();scheduleRotation();
    },WEATHER_SECONDS*1000);
    return;
  }
  if(mode!=="family"||section!=="posters"||!running||settingsOpen||editing||!data||document.hidden||pages.filter(eligible).length<2)return;
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
function overviewDate(day){
  if(typeof day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(day))return "";
  var d=new Date(day+"T00:00:00Z");if(isNaN(d.getTime()))return "";
  return Number(day.slice(5,7))+"月"+Number(day.slice(8,10))+"日 周"+"日一二三四五六".charAt(d.getUTCDay());
}
function paintAge(){
  clearTimeout(expiryTimer);expiryTimer=null;if(document.hidden)return;
  var now=serverNow(),time=isFinite(now)?clockTime(now,now):"";
  if(mode==="overview"){
    var day=isFinite(now)?new Date(now+zoneOffset*60000).toISOString().slice(0,10):overviewDay;
    var label=overviewDate(day);
    txt("date",(label||"日期未知")+"　"+(time||"时间未知"));
  }else txt("date",time);
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

function weatherNum(v,suffix){return typeof v==="number"&&isFinite(v)?Math.round(v)+suffix:"—";}
function weatherTime(v){return typeof v==="string"?v.slice(0,16).replace("T"," ")+(v.slice(-1)==="Z"?" UTC":/[+-]\d\d:\d\d$/.test(v)?" "+v.slice(-6):""):"时间未知";}
function weatherSource(groups,s,label){
  var time=weatherTime(s.fetched_at),key=(s.source==="Open-Meteo"?"模型估算 · ":"")+time;
  var group=null;
  groups.forEach(function(g){if(g.key===key)group=g;});
  if(!group){group={key:key,labels:[]};groups.push(group);}
  group.labels.push(label);
}
function weatherPart(root,sections,key,title,groups,missing,draw){
  var s=sections[key];
  if(!s||s.status!=="available"){missing.push(title);return;}
  var block=append(root,"section","","weather-block");
  append(block,"h2",title);draw(block,s.data);
  weatherSource(groups,s,title);
}
function weatherRain(block,r){
  append(block,"p",r.summary+" · 每5分钟预报");
  if(Array.isArray(r.points)&&r.points.length>1){
    var maximum=Math.max.apply(null,r.points.map(function(p){return p.mm;}));
    if(maximum>0){
      var bars=append(block,"div","","rain-bars");
      r.points.forEach(function(p){
        var cell=append(bars,"span",""),bar=append(cell,"b","");
        if(bar.style)bar.style.height=String(Math.max(1,Math.round(30*p.mm/maximum)))+"px";
      });
    }
    append(block,"p",r.points[0].time.slice(11,16)+" — "+r.points[r.points.length-1].time.slice(11,16)+" · 峰值 "+maximum+" mm/5分钟","weather-source");
  }
  append(block,"p","预报生成 "+weatherTime(r.time),"weather-source");
}
function weatherCurve(block,rows){
  if(!document.createElementNS||rows.length<2||rows.some(function(r){return typeof r.temp!=="number"||!isFinite(r.temp);}))return;
  var ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg"),temps=rows.map(function(r){return r.temp;});
  var low=Math.min.apply(null,temps),high=Math.max.apply(null,temps),range=Math.max(2,high-low);
  svg.setAttribute("viewBox","0 0 300 62");svg.setAttribute("class","weather-curve");svg.setAttribute("aria-hidden","true");
  var points=rows.map(function(r,i){return [12+i*276/(rows.length-1),49-(r.temp-low)*36/range];});
  var line=document.createElementNS(ns,"polyline");line.setAttribute("points",points.map(function(p){return p.join(",");}).join(" "));line.setAttribute("stroke","#222");line.setAttribute("stroke-width","1.7");line.setAttribute("fill","none");svg.appendChild(line);
  points.forEach(function(p){var dot=document.createElementNS(ns,"circle");dot.setAttribute("cx",p[0]);dot.setAttribute("cy",p[1]);dot.setAttribute("r","2.4");dot.setAttribute("fill","#222");svg.appendChild(dot);});
  block.appendChild(svg);
}
function renderWeather(){
  var v=weatherPages[weatherCursor];if(!v)return;
  // Only the visible page contributes to the DOM key; invisible location
  // refreshes must not redraw an e-ink screen or reset its dwell timer.
  var otherAlerts=[];
  weatherPages.forEach(function(p,i){
    if(i===weatherCursor)return;
    var a=p.sections&&p.sections.alerts;
    if(a&&a.status==="available"&&a.data.length)otherAlerts.push(p.name+"："+a.data.map(function(x){return (x.type==="cancel"?"解除信息 · ":"")+x.headline;}).join("；"));
  });
  var key=JSON.stringify([v,weatherCursor,weatherPages.length,otherAlerts]);
  if(key===lastRender)return;
  lastRender=key;txt("date","");txt("heading",v.name||"天气");txt("index",weatherPages.length>1?(weatherCursor+1)+" / "+weatherPages.length:"");
  var root=el("body"),s=v.sections||{},groups=[],missing=[];clear(root);root.className="weather-page";
  if(v.status==="disabled"){append(root,"p","天气未启用，请前往设置。","note");return;}
  if(v.status==="storage_error"){append(root,"p","天气配置或限额记录异常，已暂停采集。","note");return;}
  var current=s.current;
  if(current&&current.status==="available"){
    var c=current.data;
    append(root,"p",weatherNum(c.temp,"°C")+"　"+c.text,"weather-main");
    var today=s.daily&&s.daily.status==="available"&&s.daily.data.length?s.daily.data[0]:null;
    if(today)append(root,"p","今日 "+weatherNum(today.min,"°")+" / "+weatherNum(today.max,"°"),"weather-summary");
    append(root,"p","体感 "+weatherNum(c.feels,"°C")+" · 湿度 "+weatherNum(c.humidity,"%")+" · 风速 "+weatherNum(c.wind," "+(c.wind_unit||"")),"weather-summary");
    weatherSource(groups,current,"实时");
  }else append(root,"p","当前天气暂不可用","note");
  var air=s.air;
  if(air&&air.status==="available"){
    append(root,"p",air.data.map(function(a){return a.name+" "+a.aqi+" · "+a.category;}).join("；"),"weather-summary");
    weatherSource(groups,air,"空气质量");
  }else missing.push("空气质量");
  var alerts=s.alerts;
  if(alerts&&alerts.status==="available"){
    if(alerts.data.length)alerts.data.forEach(function(a){
      var row=append(root,"div","","weather-alert");append(row,"p",(a.type==="cancel"?"解除信息 · ":"")+a.headline);
      append(row,"p",a.sender+" · "+weatherTime(a.issued),"weather-foot");
      if(a.description)append(row,"p",a.description,"note");
      if(a.instruction)append(row,"p",a.instruction,"note");
    });
    else append(root,"p","本次未查到预警，以气象部门发布为准。","weather-foot");
    weatherSource(groups,alerts,"预警");
  }else missing.push("预警");
  otherAlerts.forEach(function(a){append(root,"p",a,"weather-alert");});
  weatherPart(root,s,"rain","未来2小时降水",groups,missing,weatherRain);
  weatherPart(root,s,"hourly","未来12小时",groups,missing,function(block,rows){
    var samples=rows.slice(0,12).filter(function(h,i){return i%2===0;});
    weatherCurve(block,samples);
    var strip=append(block,"div","","weather-strip");
    samples.forEach(function(h){var cell=append(strip,"div","","weather-cell");
      append(cell,"p",h.time.slice(11,16));append(cell,"p",h.text);
      append(cell,"p",weatherNum(h.temp,"°"));append(cell,"p",weatherNum(h.pop,"%"));
    });
    append(block,"p","百分比为降水概率","weather-foot");
  });
  weatherPart(root,s,"daily","未来7天",groups,missing,function(block,rows){
    var strip=append(block,"div","","weather-strip");
    rows.slice(0,7).forEach(function(d){var cell=append(strip,"div","","weather-cell");
      append(cell,"p",d.time.slice(5,10));append(cell,"p",d.text);
      append(cell,"p",weatherNum(d.max,"°"));append(cell,"p",weatherNum(d.min,"°"));
    });
  });
  if(missing.length)append(root,"p",missing.join("、")+"：暂不可用","weather-foot");
  groups.forEach(function(g){append(root,"p",g.labels.join("、")+" · "+g.key,"weather-foot");});

}
function acceptWeather(v){
  data=null;pages=[];cursor=0;stopAge();
  var first={name:v.name,status:v.status,sections:v.sections},next=[first];
  if(v.status!=="disabled"&&v.status!=="storage_error")next=next.concat(v.additional||[]);
  var order=JSON.stringify(next.map(function(p){return p.name||"";}));
  if(order!==weatherOrder){weatherCursor=0;weatherOrder=order;stopRotation();}
  weatherPages=next;if(weatherCursor>=next.length)weatherCursor=0;
  renderWeather();
  show("login",false);show("display",true);txt("status","");
  show("weatherDisplayControls",settingsOpen&&weatherPages.length>1);
  if(next.length<2||settingsOpen||document.hidden)stopRotation();
  else if(rotationTimer===null)scheduleRotation();
}
var settingsDetail="",weatherSaved=null,drivingSaved=null;
var weatherSettingsEpoch=0,weatherSettingsBusy=false,weatherSearchEpoch=0,weatherSearchBusy=false;
function settingStatus(k,message){
  txt(k+"SettingStatus",message);
  txt(k+"LoadStatus",el(k+"Form").className==="hidden"?message:"");
}
function setSettingsDetail(k){
  settingsDetail=k;show("settingsMenu",!k);show("settingsDetail",!!k);
  show("weatherDetail",k==="weather");show("drivingDetail",k==="driving");
  if(settingsOpen)el("settingsPanel").className=k?"settings-detail-open":"";
}
function lockForm(k,locked){
  var root=el(k+"Form"),controls=root.querySelectorAll?root.querySelectorAll("input,select,button"):[],i;
  for(i=0;i<controls.length;i++){
    if(locked){controls[i]._khdWasDisabled=controls[i].disabled===true;controls[i].disabled=true;}
    else if(controls[i]._khdWasDisabled!==undefined){controls[i].disabled=controls[i]._khdWasDisabled;delete controls[i]._khdWasDisabled;}
  }
}
function weatherState(){
  weatherCapture();return JSON.stringify([el("weatherEnabled").checked,el("weatherConsent").checked,weatherDraft]);
}
function drivingState(){
  return JSON.stringify([el("drivingEnabled").checked,el("drivingConsent").checked,el("drivingMapPermission").checked,el("drivingInterval").value,drivingFields.map(function(f){
    return [f.name.value,f.origin.value,f.destination.value,f.enabled.checked,f.windows.map(function(w){return [w.start.value,w.end.value,w.days.map(function(x){return x.checked;})];})];
  })]);
}
function canLeaveSettings(){
  if(weatherSettingsBusy||drivingBusy){settingStatus(settingsDetail||"weather","操作正在进行，请稍后返回。");return false;}
  var dirty=settingsDetail==="weather"&&weatherSaved!==null&&weatherState()!==weatherSaved||settingsDetail==="driving"&&drivingSaved!==null&&drivingState()!==drivingSaved;
  return !dirty||window.confirm("放弃尚未保存的设置？");
}
function clearWeatherForm(){
  lockForm("weather",false);weatherSettingsEpoch++;weatherSettingsBusy=false;weatherSaved=null;weatherDraft=[];clearWeatherSearch();
  show("weatherForm",false);show("weatherRetry",false);settingStatus("weather","");
}
function leaveDetail(){
  if(!canLeaveSettings())return false;
  clearWeatherForm();clearDrivingForm();setSettingsDetail("");return true;
}
function openDetail(k){
  if(!settingsOpen)return false;
  if(settingsDetail===k)return false;
  if(!leaveDetail())return false;
  setSettingsDetail(k);return true;
}
el("settingsBack").onclick=leaveDetail;
function clearWeatherSearch(){weatherSearchEpoch++;weatherSearchBusy=false;el("weatherSearch").disabled=false;clear(el("weatherResults"));txt("weatherSearchStatus","");}
function weatherSelected(){txt("weatherSelected",el("weatherName").value?"当前选择："+el("weatherName").value:"尚未选择地点");}
var weatherDraft=[],weatherActive=0;
function weatherCapture(){
  if(!weatherDraft.length)return;
  weatherDraft[weatherActive]={name:el("weatherName").value,latitude:el("weatherLat").value,longitude:el("weatherLon").value};
}
function weatherLocationButtons(){
  var root=el("weatherLocations");clear(root);
  weatherDraft.forEach(function(p,i){
    var b=append(root,"button",p.name||"未命名",i===weatherActive?"selected":"");
    b.type="button";b.onclick=function(){if(weatherSettingsBusy)return;weatherCapture();weatherActive=i;weatherEdit();};
  });
  el("weatherAdd").disabled=weatherDraft.length>=3;
  el("weatherMoveUp").disabled=weatherActive===0;
  el("weatherRemove").disabled=weatherDraft.length<=1;
}
function weatherEdit(){
  var p=weatherDraft[weatherActive];el("weatherName").value=p.name;el("weatherLat").value=p.latitude;el("weatherLon").value=p.longitude;
  clearWeatherSearch();el("weatherKeyword").value="";weatherSelected();show("weatherCoordinates",false);weatherLocationButtons();
}
el("weatherAdd").onclick=function(){
  if(weatherSettingsBusy||weatherDraft.length>=3)return;
  weatherCapture();weatherDraft.push({name:"",latitude:"",longitude:""});weatherActive=weatherDraft.length-1;weatherEdit();
};
el("weatherMoveUp").onclick=function(){
  if(weatherSettingsBusy||weatherActive===0)return;
  weatherCapture();var p=weatherDraft.splice(weatherActive,1)[0];weatherActive--;weatherDraft.splice(weatherActive,0,p);weatherEdit();
};
el("weatherRemove").onclick=function(){
  if(weatherSettingsBusy||weatherDraft.length<=1)return;
  weatherDraft.splice(weatherActive,1);weatherActive=0;weatherEdit();settingStatus("weather","已移除草稿地点，保存后生效。");
};
function weatherForm(v){
  el("weatherEnabled").checked=v.enabled===true;el("weatherConsent").checked=v.consent===true;
  weatherDraft=[v].concat(v.additional||[]).map(function(p){return {name:p.name||"",latitude:p.name?String(p.latitude):"",longitude:p.name?String(p.longitude):""};});
  weatherActive=0;weatherEdit();
  var b=v.budget;txt("weatherBudget",(v.primary_configured?"和风凭据已配置":"和风凭据未配置，仅可使用备用源")+
    (b?" · 本月已计 "+b.used+" / "+b.limit+"，滚动32天 "+b.rolling_used+(b.blocked?" · 和风已阻断，需核查账户":"")+(b.backup_blocked?" · 备用源已阻断":""):" · 额度不可用"));
  show("weatherForm",true);weatherSaved=weatherState();show("weatherRetry",false);
}
function weatherSettingsRequest(body){
  if(!settingsOpen||settingsDetail!=="weather"||!token||weatherSettingsBusy)return;
  clearWeatherSearch();weatherSettingsBusy=true;lockForm("weather",true);show("weatherRetry",false);
  var g=++weatherSettingsEpoch,x=new XMLHttpRequest(),done=false,timer;
  settingStatus("weather",body?"正在保存…":"正在读取…");
  function finish(ok,v,code){
    if(done)return;done=true;clearTimeout(timer);
    if(g!==weatherSettingsEpoch||!settingsOpen)return;
    weatherSettingsBusy=false;lockForm("weather",false);
    if(ok&&v&&typeof v.enabled==="boolean"){weatherForm(v);settingStatus("weather",body?"已保存":"已读取");}
    else {settingStatus("weather",code===401?"需要管理权限，请使用管理令牌连接。":"操作未确认，请核对设置后再试。");show("weatherRetry",el("weatherForm").className==="hidden");}
  }
  try{
    x.open(body?"POST":"GET","/api/weather/settings",true);
    if(token!=="local-direct")x.setRequestHeader("Authorization","Bearer "+token);
    if(body)x.setRequestHeader("Content-Type","application/json");
    x.onreadystatechange=function(){if(x.readyState!==4)return;var v=null;try{v=JSON.parse(x.responseText);}catch(e){}finish(x.status===200,v,x.status);};
    timer=setTimeout(function(){finish(false,null,0);try{x.abort();}catch(e){}},12000);
    x.send(body?JSON.stringify(body):null);
  }catch(e){finish(false,null,0);}
}
el("weatherLoad").onclick=function(){if(openDetail("weather"))weatherSettingsRequest(null);};
el("weatherRetry").onclick=function(){weatherSettingsRequest(null);};
el("weatherManual").onclick=function(){show("weatherCoordinates",el("weatherCoordinates").className==="hidden");};
el("weatherName").oninput=function(){weatherCapture();weatherSelected();weatherLocationButtons();};
el("weatherKeyword").oninput=clearWeatherSearch;
el("weatherConsent").onchange=function(){if(!el("weatherConsent").checked)clearWeatherSearch();};
el("weatherSearch").onclick=function(){
  if(!settingsOpen||settingsDetail!=="weather"||!token||weatherSearchBusy||weatherSettingsBusy)return;
  var keyword=el("weatherKeyword").value.trim();
  clearWeatherSearch();
  if(!keyword){txt("weatherSearchStatus","请输入城市或区县名称。");return;}
  if(!el("weatherConsent").checked){txt("weatherSearchStatus","请先确认位置查询授权。");return;}
  weatherSearchBusy=true;el("weatherSearch").disabled=true;
  var g=++weatherSearchEpoch,x=new XMLHttpRequest(),timer,done=false;
  txt("weatherSearchStatus","搜索中…");
  function finish(ok,v){
    if(done)return;done=true;clearTimeout(timer);
    if(g!==weatherSearchEpoch||!settingsOpen)return;
    weatherSearchBusy=false;el("weatherSearch").disabled=false;
    var messages={not_configured:"请先在 NAS 配置和风凭据，或手动输入坐标。",blocked:"和风已阻断，请核查账户；可手动输入坐标。",budget:"已达到请求保护限制。",wait:"搜索过于频繁，请稍后再试。",unavailable:"搜索暂不可用，可手动输入坐标。"};
    if(!ok||!v||v.status!=="ok"||!Array.isArray(v.locations)){
      txt("weatherSearchStatus",v&&messages[v.status]||"搜索失败，请检查名称或稍后重试。");return;
    }
    txt("weatherSearchStatus",v.locations.length?"请选择地点":"未找到地点，请换个名称。");
    v.locations.forEach(function(item){
      var button=append(el("weatherResults"),"button",item.name);
      button.type="button";append(button,"small",item.region);
      button.onclick=function(){
        if(g!==weatherSearchEpoch||!settingsOpen)return;
        el("weatherName").value=item.name;el("weatherLat").value=String(item.latitude);el("weatherLon").value=String(item.longitude);
        clearWeatherSearch();txt("weatherSelected","当前选择："+item.name+(item.region?" · "+item.region:""));
        weatherCapture();weatherLocationButtons();show("weatherCoordinates",false);txt("weatherSearchStatus","已选择，可修改显示名称，请保存天气设置。");
      };
    });
  }
  try{
    x.open("POST","/api/weather/search",true);
    if(token!=="local-direct")x.setRequestHeader("Authorization","Bearer "+token);
    x.setRequestHeader("Content-Type","application/json");
    x.onreadystatechange=function(){if(x.readyState!==4)return;var v=null;try{v=JSON.parse(x.responseText);}catch(e){}finish(x.status===200,v);};
    timer=setTimeout(function(){finish(false,null);try{x.abort();}catch(e){}},12000);
    x.send(JSON.stringify({keyword:keyword,consent:true}));
  }catch(e){finish(false,null);}
};
el("weatherKeyword").onkeydown=function(e){e=e||window.event;if(e&&e.keyCode===13)el("weatherSearch").onclick();};
el("weatherSave").onclick=function(){
  if(settingsDetail!=="weather"||weatherSettingsBusy||!weatherDraft.length)return;
  weatherCapture();
  var enabled=el("weatherEnabled").checked,consent=el("weatherConsent").checked,places=[];
  for(var i=0;i<weatherDraft.length;i++){
    var p=weatherDraft[i],a=p.latitude,b=p.longitude,name=p.name.trim();
    if(i===0&&weatherDraft.length===1&&!enabled&&!name&&!a&&!b){a="0";b="0";}
    if(!/^-?\d{1,3}(\.\d{1,2})?$/.test(a)||! /^-?\d{1,3}(\.\d{1,2})?$/.test(b)||
       Math.abs(Number(a))>90||Math.abs(Number(b))>180||((enabled||weatherDraft.length>1)&&!name)){
      settingStatus("weather","第"+(i+1)+"个地点：请输入有效名称及经纬度。");weatherActive=i;weatherEdit();show("weatherCoordinates",true);return;
    }
    places.push({name:name,latitude:Number(a),longitude:Number(b)});
  }
  if(enabled&&!consent){settingStatus("weather","请确认位置传输授权。");return;}
  var main=places.shift();
  weatherSettingsRequest({enabled:enabled,consent:consent,name:main.name,latitude:main.latitude,longitude:main.longitude,additional:places});
};

function renderDrivingGroups(root,v,limit,summary){
    if(!v.enabled||!v.groups.length)append(root,"p","驾驶未启用或未配置，请前往设置。","note");
    var messages={disabled:"未启用",paused:"不在采集时段",waiting:"等待采集",not_configured:"请在NAS配置高德密钥",credential_error:"高德密钥配置有误",storage_error:"配置或额度存储异常",blocked:"已停止请求，请核查高德账号",stale:"旧数据",unavailable:"暂不可用",ok:""};
    (v.groups||[]).slice(0,limit).forEach(function(g){
      var group=append(root,"section","","driving-group");append(group,"h2",g.name);
      var pair=append(group,"div","","driving-pair"),map=append(pair,"div","","driving-map"),list=append(pair,"div","","driving-routes");
      if(typeof g.image==="string"&&/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(g.image)){
        var image=append(map,"img","");image.alt=g.name+" 路线地图";image.onerror=function(){clear(map);append(map,"p","地图图片加载失败","note");};image.src=g.image;
        if(Array.isArray(g.map_routes)&&g.map_routes.length<(g.routes||[]).length)append(map,"p","图中路线："+g.map_routes.join("、"),"driving-foot");
      }else {
        var mapMessages={map_url_too_long:"路线过长",map_geometry_unavailable:"缺少路线坐标",map_http_error:"地图接口异常",map_too_large:"地图图片过大",invalid_map:"地图响应异常",provider_rejected_request:"地图参数被拒绝",provider_blocked:"接口已阻断",request_limit:"已达请求限额"};
        append(map,"p","地图暂不可用"+(mapMessages[g.map_error]?" · "+mapMessages[g.map_error]:""),"note");
      }
      (g.routes||[]).forEach(function(r,i){
        var text=(i+1)+"  "+Math.ceil(r.seconds/60)+"分钟";
        append(list,"p",text,i===0?"driving-fast":"");
        append(list,"p",(r.meters/1000).toFixed(1)+"km");
      });
      if(!g.routes||!g.routes.length)append(list,"p","暂无可用路线");
      var note=(messages[g.status]||"")+(g.fetched_at?" · 采集 "+weatherTime(g.fetched_at):"");
      if(g.routes&&g.routes.length<3&&g.routes.length>0)note+=" · 仅返回"+g.routes.length+"条";
      if(note)append(group,"p",note,"driving-foot");
    });

}
function acceptDriving(v){
  data=null;pages=[];cursor=0;stopRotation();stopAge();
  var key=JSON.stringify(v);
  if(key!==lastRender){
    lastRender=key;txt("date","");txt("heading","驾驶");txt("index","");
    var root=el("body");clear(root);
    renderDrivingGroups(root,v,v.groups.length);
  }
  show("login",false);show("display",true);txt("status","");
}
var drivingEpoch=0,drivingBusy=false,drivingFields=[],drivingActive=0;
function clearDrivingForm(){
  lockForm("driving",false);drivingEpoch++;drivingBusy=false;drivingFields=[];drivingActive=0;drivingSaved=null;clear(el("drivingGroups"));clear(el("drivingLocations"));show("drivingForm",false);show("drivingRetry",false);settingStatus("driving","");
}
function drivingRequest(path,body,callback){
  if(!settingsOpen||settingsDetail!=="driving"||!token||drivingBusy)return;
  drivingBusy=true;lockForm("driving",true);
  var g=++drivingEpoch,x=new XMLHttpRequest(),done=false,timer;
  function finish(ok,v,code){
    if(done)return;done=true;clearTimeout(timer);
    if(g!==drivingEpoch||!settingsOpen)return;
    drivingBusy=false;lockForm("driving",false);callback(ok,v,code);
  }
  try{
    x.open(body?"POST":"GET",path,true);
    if(token!=="local-direct")x.setRequestHeader("Authorization","Bearer "+token);
    if(body)x.setRequestHeader("Content-Type","application/json");
    x.onreadystatechange=function(){if(x.readyState!==4)return;var v=null;try{v=JSON.parse(x.responseText);}catch(e){}finish(x.status===200,v,x.status);};
    timer=setTimeout(function(){finish(false,null,0);try{x.abort();}catch(e){}},15000);
    x.send(body?JSON.stringify(body):null);
  }catch(e){finish(false,null,0);}
}
function drivingInput(root,label,value,limit){
  var wrap=append(root,"label",label),input=append(wrap,"input","");
  input.type="text";input.maxLength=limit;input.value=value||"";return input;
}
function drivingButton(root,label,action){
  var b=append(root,"button",label);b.type="button";b.onclick=action;return b;
}
function drivingTime(min){return ("0"+Math.floor(min/60)).slice(-2)+":"+("0"+(min%60)).slice(-2);}
function drivingMinutes(value){
  if(!/^([01]\d|2[0-4]):[0-5]\d$/.test(value))return -1;
  var parts=value.split(":"),n=Number(parts[0])*60+Number(parts[1]);return n<=1440?n:-1;
}
function drivingLocationButtons(){
  var root=el("drivingLocations");clear(root);
  drivingFields.forEach(function(f,i){
    f.root.className="driving-fields"+(i===drivingActive?"":" hidden");
    var b=drivingButton(root,f.name.value||"目的地 "+(i+1),function(){if(!drivingBusy){drivingActive=i;drivingLocationButtons();}});
    b.className=i===drivingActive?"selected":"";
  });
  el("drivingAdd").disabled=drivingFields.length>=3;
}
function drivingGroup(group){
  var root=append(el("drivingGroups"),"section","","driving-fields"),f={root:root};
  append(root,"h3","目的地设置");
  var toggle=append(root,"label","启用此目的地"),check=append(toggle,"input","");check.type="checkbox";check.checked=group.enabled!==false;f.enabled=check;
  f.name=drivingInput(root,"显示名称",group.name,40);f.name.oninput=drivingLocationButtons;
  f.origin=drivingInput(root,"起点坐标",group.origin,40);
  f.destination=drivingInput(root,"终点坐标",group.destination,40);
  var keyword=drivingInput(root,"搜索地点名称","",80),region=drivingInput(root,"城市（可选）","",80),results=append(root,"div","","driving-result");
  var searchStatus=append(root,"p","","status");searchStatus.setAttribute&&searchStatus.setAttribute("role","status");
  function searchNote(s){slotSet(searchStatus,s);}
  function search(target){
    if(drivingBusy)return;
    if(!el("drivingConsent").checked){searchNote("请先确认位置传输及账户额度。");return;}
    clear(results);
    if(!keyword.value.trim()){searchNote("请输入地点名称。");return;}
    searchNote("搜索中…");
    drivingRequest("/api/driving/search",{keyword:keyword.value,region:region.value,consent:true},function(ok,v){
      if(!ok||!v||v.status!=="ok"){
        searchNote("搜索暂不可用，可直接输入高德坐标；请检查账户权限和额度。");return;
      }
      searchNote(v.locations.length?"请选择地点。":"未找到地点。");
      v.locations.forEach(function(p){
        drivingButton(results,p.name+" · "+p.city+p.district+" "+p.address,function(){
          if(drivingBusy||!el("drivingConsent").checked)return;
          target.value=p.location;clear(results);searchNote("已选地点，请保存设置。");
        });
      });
    });
  }
  drivingButton(root,"搜索起点",function(){search(f.origin);});
  drivingButton(root,"搜索终点",function(){search(f.destination);});
  f.windows=[];var windows=append(root,"div","");
  function addWindow(w){
    var wr=append(windows,"div","","driving-fields"),days=append(wr,"div","","driving-days"),row={root:wr,days:[]};
    ["一","二","三","四","五","六","日"].forEach(function(n,i){
      var label=append(days,"label",n),cb=append(label,"input","");cb.type="checkbox";cb.checked=w.days.indexOf(i)>=0;row.days.push(cb);
    });
    row.start=drivingInput(wr,"开始（HH:MM）",drivingTime(w.start),5);
    row.end=drivingInput(wr,"结束（HH:MM，可跨夜）",drivingTime(w.end),5);
    drivingButton(wr,"删除时段",function(){if(drivingBusy)return;windows.removeChild(wr);f.windows.splice(f.windows.indexOf(row),1);});
    f.windows.push(row);
  }
  (group.windows||[]).forEach(addWindow);
  drivingButton(root,"添加采集时段",function(){if(!drivingBusy&&f.windows.length<32)addWindow({days:[0,1,2,3,4,5,6],start:420,end:540});});
  drivingButton(root,"移除此目的地",function(){if(drivingBusy)return;el("drivingGroups").removeChild(root);drivingFields.splice(drivingFields.indexOf(f),1);drivingActive=Math.max(0,Math.min(drivingActive,drivingFields.length-1));drivingLocationButtons();});
  drivingFields.push(f);drivingActive=drivingFields.length-1;drivingLocationButtons();
}
function drivingForm(v){
  clear(el("drivingGroups"));drivingFields=[];
  el("drivingEnabled").checked=v.enabled;el("drivingConsent").checked=v.consent;el("drivingMapPermission").checked=v.map_permission;
  el("drivingInterval").value=String(v.interval);
  (v.groups||[]).forEach(drivingGroup);drivingActive=0;drivingLocationButtons();
  var b=v.budget;
  txt("drivingBudget",(v.configured?"高德密钥已配置":"高德密钥未配置")+(b?" · 32天路线/地图 "+b.lbs.used+"/"+b.lbs.limit+" · 搜索 "+b.search.used+"/"+b.search.limit+(b.blocked?" · 已阻断":""):" · 额度存储不可用"));
  show("drivingForm",true);drivingSaved=drivingState();show("drivingRetry",false);
}
function loadDriving(){
  show("drivingRetry",false);settingStatus("driving","读取中…");
  drivingRequest("/api/driving/settings",null,function(ok,v,code){
    if(ok&&v&&Array.isArray(v.groups)){drivingForm(v);settingStatus("driving","已读取");}
    else {settingStatus("driving",code===401?"需要管理权限。":"读取失败。");show("drivingRetry",true);}
  });
}
el("drivingLoad").onclick=function(){if(openDetail("driving"))loadDriving();};
el("drivingRetry").onclick=loadDriving;
el("drivingAdd").onclick=function(){if(!drivingBusy&&drivingFields.length<3)drivingGroup({enabled:true,windows:[{days:[0,1,2,3,4,5,6],start:420,end:540}]});};
el("drivingSave").onclick=function(){
  if(settingsDetail!=="driving"||drivingBusy)return;
  var groups=[],enabled=el("drivingEnabled").checked,consent=el("drivingConsent").checked,permission=el("drivingMapPermission").checked;
  if(enabled&&(!consent||!permission||!drivingFields.length)){settingStatus("driving","请确认位置和地图使用授权，并添加目的地。");return;}
  for(var i=0;i<drivingFields.length;i++){
    var f=drivingFields[i],windows=[],name=f.name.value.trim();
    if(!name||!f.origin.value.trim()||!f.destination.value.trim()){drivingActive=i;drivingLocationButtons();settingStatus("driving","请填写第"+(i+1)+"组名称与起终点。");return;}
    for(var j=0;j<f.windows.length;j++){
      var w=f.windows[j],start=drivingMinutes(w.start.value),end=drivingMinutes(w.end.value),days=[];
      w.days.forEach(function(cb,d){if(cb.checked)days.push(d);});
      if(start<0||start>=1440||end<0||start===end||!days.length){drivingActive=i;drivingLocationButtons();settingStatus("driving","请检查第"+(i+1)+"组采集时段。");return;}
      windows.push({days:days,start:start,end:end});
    }
    if(f.enabled.checked&&!windows.length){drivingActive=i;drivingLocationButtons();settingStatus("driving","启用的目的地至少需要一个采集时段。");return;}
    groups.push({name:name,origin:f.origin.value.trim(),destination:f.destination.value.trim(),enabled:f.enabled.checked,windows:windows});
  }
  settingStatus("driving","保存中…");
  drivingRequest("/api/driving/settings",{enabled:enabled,consent:consent,map_permission:permission,interval:Number(el("drivingInterval").value),groups:groups},function(ok,v){
    if(ok&&v&&Array.isArray(v.groups)){drivingForm(v);settingStatus("driving","已保存");}
    else settingStatus("driving","保存失败，请检查坐标、时段和权限。");
  });
};

/* Composite display: read the existing LAN caches independently. No provider
   request, additional server worker or data storage is introduced here. */
function overviewLink(root,label,action){
  var n=append(root,"button",label,"overview-link");n.type="button";n.onclick=action;return n;
}
function stopOverview(){
  Object.keys(overviewTimers).forEach(function(k){clearTimeout(overviewTimers[k]);});
  overviewTimers={};overviewPending={};overviewRoots={};overviewKeys={};overviewDay="";
}
function overviewLayout(){
  var root=el("body");clear(root);root.className="overview-page";
  var pair=append(root,"div","","overview-pair");
  overviewRoots.bus=append(pair,"div","","overview-half");
  overviewRoots.weather=append(pair,"div","","overview-half");
  overviewRoots.driving=append(root,"div","","overview-driving");
  overviewRoots.home=append(root,"div","","overview-home");
  ["bus","weather","driving","home"].forEach(function(k){append(overviewRoots[k],"p","正在读取","note");});
  txt("heading","");txt("index","");
}
function renderOverviewBus(v){
  var root=overviewRoots.bus,s=v.snapshot,t=v.trip,items=slotItems(s);
  var labels={live:"实时预计到站",stale:"旧数据",expired:"数据已过期",paused:"非采集时段",blocked:"接口限制访问",disabled:"公交采集未启用",config_error:"公交配置错误",unconfigured:"请先设置公交",unverified:"正在核对线路",needs_selection:"站序变化，请重新选站",unavailable:"等待首次采集",no_live_data:"暂未取得在途车辆信息",error:"接口请求失败",service_error:"本地采集服务异常"};
  var key=JSON.stringify([t,items.length,["live","stale","no_live_data"].indexOf(s.status)>=0]);
  if(key!==overviewKeys.bus){
    overviewKeys.bus=key;stopAge();clear(root);
    overviewLink(root,t?t.line.name:"公交",function(){switchMode("bus");});
    if(t)append(root,"p",t.boarding.name+" → "+t.destination.name,"note");
    busStatusNode=append(root,"p",labels[s.status]||"状态未知","note");
    for(var i=0;i<items.length;i++)etaRows.push(buildSlot(root,i));
    if(["live","stale","no_live_data"].indexOf(s.status)>=0)ageNode=append(root,"p","","note");
  }
  items.forEach(function(item,i){etaRows[i].item=item;});
  if(!items.length&&busStatusNode)slotSet(busStatusNode,labels[s.status]||"状态未知");
  etaSnapshot=s;syncClock(s);paintAge();
}
function renderOverviewWeather(){
  var root=overviewRoots.weather,v=weatherPages[weatherCursor];if(!root||!v)return;
  var s=v.sections||{},c=s.current;
  var key=JSON.stringify([v.name,v.status,c,weatherCursor,weatherPages.length,weatherPages.map(function(p){return [p.name,p.sections&&p.sections.alerts];})]);
  if(key===overviewKeys.weather)return;
  overviewKeys.weather=key;clear(root);
  overviewLink(root,(v.name||"天气")+(weatherPages.length>1?" "+(weatherCursor+1)+"/"+weatherPages.length:""),function(){switchMode("weather");});
  if(v.status==="disabled")append(root,"p","天气未启用","note");
  else if(v.status==="storage_error")append(root,"p","天气配置或限额异常","note");
  else if(c&&c.status==="available"){
    append(root,"p",weatherNum(c.data.temp,"°")+"　"+c.data.text,"weather-main");
    append(root,"p","体感 "+weatherNum(c.data.feels,"°")+" · 湿度 "+weatherNum(c.data.humidity,"%"),"weather-summary");
  }else append(root,"p","当前天气暂不可用","note");
  weatherPages.forEach(function(p){var a=p.sections&&p.sections.alerts;
    if(a&&a.status==="available"&&a.data.length)a.data.forEach(function(x){append(root,"p",(p.name||"")+"："+(x.type==="cancel"?"解除信息 · ":"")+x.headline,"weather-alert");});
  });
}
function acceptOverviewWeather(v){
  var next=[{name:v.name,status:v.status,sections:v.sections}];
  if(v.status!=="disabled"&&v.status!=="storage_error")next=next.concat(v.additional||[]);
  var order=JSON.stringify(next.map(function(p){return p.name||"";}));
  if(order!==weatherOrder){weatherCursor=0;weatherOrder=order;stopRotation();}
  weatherPages=next;if(weatherCursor>=next.length)weatherCursor=0;
  renderOverviewWeather();
  show("weatherDisplayControls",settingsOpen&&next.length>1);
  if(next.length<2||settingsOpen||document.hidden)stopRotation();else if(rotationTimer===null)scheduleRotation();
}
function renderOverviewDriving(v){
  var key=JSON.stringify([v.enabled,v.groups.length,v.groups.slice(0,2)]);if(key===overviewKeys.driving)return;
  overviewKeys.driving=key;var root=overviewRoots.driving;clear(root);
  renderDrivingGroups(root,v,2,true);
  overviewLink(root,v.groups.length>2?"另 "+(v.groups.length-2)+" 个目的地 · 全部路线":"全部路线",function(){switchMode("driving");});
}
function renderOverviewHome(v){
  overviewDay=v.date;data=v;paintAge();
  var tasks=Array.isArray(v.upcoming_tasks)?v.upcoming_tasks:v.tasks;
  var next=new Date(v.date+"T00:00:00Z");next.setUTCDate(next.getUTCDate()+1);
  var tomorrow=isNaN(next.getTime())?"":next.toISOString().slice(0,10);
  var menus=v.week_menu.filter(function(m){return m.day===v.date||m.day===tomorrow;});
  var includeTomorrow=!!tomorrow&&(menus.some(function(m){return m.day===tomorrow;})||!!(v.menu_range&&v.menu_range.first<=tomorrow&&v.menu_range.last>=tomorrow));
  var key=JSON.stringify([v.date,tasks,menus,includeTomorrow,v.can_complete]);if(key===overviewKeys.home)return;
  overviewKeys.home=key;var root=overviewRoots.home;clear(root);
  var names={breakfast:"早餐",lunch:"午餐",dinner:"晚餐"},order={breakfast:0,lunch:1,dinner:2};
  (includeTomorrow?[v.date,tomorrow]:[v.date]).forEach(function(day,i){
    var group=append(root,"section","","menu-day");
    overviewLink(group,day.slice(5).replace("-","/")+" "+(i?"明日":"今日"),function(){switchSection("menus");});
    var meals=menus.filter(function(m){return m.day===day;});
    meals.sort(function(a,b){return order[a.meal]-order[b.meal];}).forEach(function(m){
      var row=append(group,"div","","menu-meal");append(row,"span",names[m.meal],"menu-meal-label");append(row,"span",m.dishes.join("、"),"menu-dishes");
    });
    if(!meals.length)append(group,"p","暂无菜单","note");
  });
  overviewLink(root,tasks.length>3?"全部待办（"+tasks.length+"）":"待办",function(){switchSection("tasks");});
  var last="",dayGroup;
  tasks.slice(0,3).forEach(function(t){
    var day=t.occurrence||v.date;
    if(day!==last){
      last=day;dayGroup=append(root,"section","","task-day");var l=taskDateLabel(day,v.date),h=append(dayGroup,"h3",l.label,"task-date");
      if(day<v.date)append(h,"span","逾期","task-date-tag");else if(l.tag)append(h,"span",l.tag,"task-date-tag");
    }
    var row=append(dayGroup,"div","","task-row");append(row,"span",t.title,"task-text");
    if(v.can_complete===true&&day<=v.date){
      var action=append(row,"span","","task-action"),button=append(action,"button","完成","task-complete");
      button.type="button";button.onclick=function(){completeTask(t,v.date,button);};
    }
  });
  if(!tasks.length)append(root,"p","暂无待办","note");
}
function overviewFailure(k,status){
  if(k==="bus"){stopAge();serverBase=NaN;paintAge();}
  if(k==="weather"){weatherPages=[];weatherOrder="";weatherCursor=0;stopRotation();show("weatherDisplayControls",false);}
  if(k==="home"){data=null;overviewDay="";paintAge();}
  delete overviewKeys[k];var root=overviewRoots[k];clear(root);
  var names={bus:"公交",weather:"天气",driving:"驾驶",home:"菜单与待办"};
  overviewLink(root,names[k],function(){if(k==="home")switchSection("tasks");else switchMode(k);});
  append(root,"p",status===404?"模块未启用":"暂不可用，旧内容已隐藏","note");
}
function requestOverview(k){
  if(mode!=="overview"||!token||document.hidden||overviewPending[k])return;
  var interval=k==="bus"?15000:30000;
  if(k==="home"&&busy){overviewTimers[k]=setTimeout(function(){requestOverview(k);},interval);return;}
  var g=epoch,x=new XMLHttpRequest(),ended=false,timeout;
  overviewPending[k]=true;
  function finish(ok,v,status){
    if(ended)return;ended=true;clearTimeout(timeout);if(g!==epoch||mode!=="overview")return;
    overviewPending[k]=false;
    if(status===401){reset();txt("status","令牌无效，请重新连接。");return;}
    if(ok){
      if(k==="bus")renderOverviewBus(v);else if(k==="weather")acceptOverviewWeather(v);else if(k==="driving")renderOverviewDriving(v);else renderOverviewHome(v);
      show("login",false);show("display",true);txt("status","");
    }else{
      overviewFailure(k,status);
      if(status===404||status===503||el("login").className==="hidden"){show("login",false);show("display",true);}
      else txt("status","连接异常，请检查 NAS 网络");
    }
    overviewTimers[k]=setTimeout(function(){requestOverview(k);},interval);
  }
  try{x.open("GET","/api/"+k+"/view",true);if(token!=="local-direct")x.setRequestHeader("Authorization","Bearer "+token);
    x.onreadystatechange=function(){if(x.readyState!==4)return;var v=null;try{v=JSON.parse(x.responseText);}catch(e){}
      var valid=v&&(k==="bus"?v.snapshot&&Array.isArray(v.snapshot.vehicles):k==="weather"?typeof v.status==="string"&&v.sections&&typeof v.sections==="object":k==="driving"?typeof v.enabled==="boolean"&&Array.isArray(v.groups):Array.isArray(v.tasks)&&Array.isArray(v.posters)&&Array.isArray(v.week_menu));
      finish(x.status===200&&valid,v,x.status);
    };
    timeout=setTimeout(function(){finish(false,null,0);try{x.abort();}catch(e){}},12000);x.send(null);
  }catch(e){finish(false,null,0);}
}
function startOverview(){
  if(overviewRoots.bus)return;
  serverBase=NaN;overviewLayout();
  ["bus","weather","driving","home"].forEach(function(k){requestOverview(k);});
}

function modeLabel(){
  txt("modeStatus",automatic?"自动分时 · 按 NAS 采集时段":"手动显示 · 不自动切换模块");updateManagementLinks();
}
function manual(){
  if(!automatic)return;
  automatic=false;epoch++;busy=false;clearTimeout(refreshTimer);
  refreshTimer=setTimeout(refresh,mode==="bus"?15000:30000);modeLabel();
}
function switchMode(next){
  if(preview||adminModule||!token)return;
  if(settingsOpen&&!closeSettings())return;manual();
  if(next===mode)return;
  epoch++;busy=false;clearTimeout(refreshTimer);refreshTimer=null;editing=false;
  show("options",false);resumePage="";forgetResume();mode=next;
  tabs();hide("正在读取");refresh();
}
function switchSection(next){
  if(preview||adminModule||!token)return;
  if(settingsOpen&&!closeSettings())return;manual();
  if(mode!=="family"){section=next;switchMode("family");return;}
  if(section===next)return;
  section=next;editing=false;show("options",false);stopRotation();resumePage="";tabs();
  if(data)accept(data);else if(!busy)refresh();
}
function hide(reason){
  stopOverview();stopAge();
  data=null;pages=[];cursor=0;lastRender="";stopRotation();weatherPages=[];weatherCursor=0;weatherOrder="";el("body").className="";
  txt("date","");txt("heading","");clear(el("body"));txt("index","");txt("status",reason);
}
function refresh(){
  if(!token||busy||document.hidden)return;
  if(mode==="overview"&&!automatic){startOverview();return;}
  busy=true;var g=epoch,x=new XMLHttpRequest(),ended=false,timeout;
  function finish(ok,v,status){
    if(ended)return;ended=true;clearTimeout(timeout);if(g!==epoch)return;busy=false;
    if(ok){
      if(automatic){
        if(mode!==v.mode){resumePage="";forgetResume();mode=v.mode;editing=false;show("options",false);tabs();hide("");}
        v=v.view;
      }
      if(mode==="bus")acceptBus(v);else if(mode==="weather")acceptWeather(v);else if(mode==="driving")acceptDriving(v);else accept(v);
      modeLabel();
    }
    else if((status===404&&mode==="family")||status===503){show("login",false);show("display",true);hide(status===404?"家庭模块未启用，可切换至公交。":"当前模块暂不可用，可切换其他模块。");}
    else{hide(status===401?"令牌无效，请重新连接。":status===404?"家庭模块未启用。":"连接异常，旧内容已隐藏。");
      if(status===401){reset();txt("status","令牌无效，请重新连接。");return;}}
    clearTimeout(refreshTimer);refreshTimer=document.hidden?null:setTimeout(refresh,mode==="bus"?15000:30000);
  }
  try{x.open("GET",automatic?"/api/display/auto":mode==="bus"?"/api/bus/view":mode==="weather"?"/api/weather/view":mode==="driving"?"/api/driving/view":"/api/home/view",true);if(token&&token!=="local-direct")x.setRequestHeader("Authorization","Bearer "+token);
    x.onreadystatechange=function(){if(x.readyState!==4)return;var v=null;try{v=JSON.parse(x.responseText);}catch(e){}
      var next=automatic&&v?v.mode:mode, payload=automatic&&v?v.view:v;
      var valid=payload&&(next==="bus"?payload.snapshot&&Array.isArray(payload.snapshot.vehicles):next==="weather"?typeof payload.status==="string"&&payload.sections&&typeof payload.sections==="object":next==="driving"?typeof payload.enabled==="boolean"&&Array.isArray(payload.groups):next==="family"&&Array.isArray(payload.tasks)&&Array.isArray(payload.posters)&&Array.isArray(payload.week_menu));
      finish(x.status===200&&valid,v,x.status);};
    timeout=setTimeout(function(){finish(false,null,0);try{x.abort();}catch(e){}},12000);x.send(null);
  }catch(e){finish(false,null,0);}
}
function reset(keepResume){
  clearDrivingForm();clearWeatherForm();setSettingsDetail("");
  if(keepResume!==true)forgetResume();resumePage="";
  epoch++;busy=false;token="";automatic=false;modeLabel();mode="family";section="tasks";savedKey="";tabs();running=false;editing=false;seconds=180;
  clearTimeout(refreshTimer);refreshTimer=null;hide("");el("token").value="";
  panel(false);show("options",false);show("display",false);show("login",true);
}
el("connect").onclick=function(){if(busy)return;token=el("token").value;el("token").value="";if(direct&&!token)token="local-direct";if(token){if(adminModule){show("login",false);show("display",true);panel(true);el(adminModule+"Load").onclick();return;}automatic=autoEntry;restoreResume();var hash=typeof location!=="undefined"?location.hash:"";if(!automatic&&(hash==="#overview"||(!hash&&(path==="/"||preview)))){mode="overview";resumePage="";forgetResume();}else if(!automatic&&(hash==="#bus"||hash==="#weather"||hash==="#driving")){mode=hash.slice(1);resumePage="";forgetResume();}else if(!automatic&&["#tasks","#posters","#menus"].indexOf(hash)>=0){if(section!==hash.slice(1))resumePage="";section=hash.slice(1);}tabs();modeLabel();clearTimeout(refreshTimer);refreshTimer=null;refresh();}};
el("autoMode").onclick=function(){
  if(preview||adminModule||!token)return;
  if(settingsOpen&&!closeSettings())return;
  panel(false);stopRotation();automatic=true;forgetResume();epoch++;busy=false;editing=false;section="tasks";if(mode==="overview"){mode="family";hide("");}tabs();show("options",false);
  clearTimeout(refreshTimer);refreshTimer=null;modeLabel();refresh();
};
el("overviewMode").onclick=function(){switchMode("overview");};

el("tasksMode").onclick=function(){switchSection("tasks");};
el("postersMode").onclick=function(){switchSection("posters");};
el("menusMode").onclick=function(){switchSection("menus");};
el("busMode").onclick=function(){switchMode("bus");};
el("weatherMode").onclick=function(){switchMode("weather");};
el("drivingMode").onclick=function(){switchMode("driving");};
el("previous").onclick=function(){if(editing||section!=="posters"||mode!=="family")return;manual();running=false;stopRotation();advance(-1,false);};
el("next").onclick=function(){if(editing||section!=="posters"||mode!=="family")return;manual();running=false;stopRotation();advance(1,false);};
el("pause").onclick=function(){if(!data||editing||section!=="posters")return;if(running)manual();running=!running;render();scheduleRotation();};
el("settings").onclick=function(){if(preview||adminModule||!token||settingsOpen)return;panel(true);stopRotation();el("seconds").value=String(seconds);show("options",mode==="family"&&section==="posters");};
function closeSettings(){if(adminModule)return false;if(!leaveDetail())return false;editing=false;panel(false);show("options",false);scheduleRotation();return true;}
el("returnDisplay").onclick=closeSettings;
el("weatherNext").onclick=function(){if((mode!=="weather"&&mode!=="overview")||weatherPages.length<2||!settingsOpen)return;if(!closeSettings())return;weatherCursor=(weatherCursor+1)%weatherPages.length;if(mode==="overview")renderOverviewWeather();else renderWeather();};
el("apply").onclick=function(){var n=Number(el("seconds").value);if([120,180,300].indexOf(n)<0)return;if(closeSettings()){seconds=n;scheduleRotation();}};
el("cancel").onclick=closeSettings;
el("logout").onclick=function(){if(canLeaveSettings())reset();};
["manageLink","tasksManage","postersManage","menusManage","catalogManage","displayManage"].forEach(function(id){el(id).onclick=canLeaveSettings;});
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
  if(adminModule)return;
  if(document.hidden){
    rememberResume();stopOverview();stopAge();stopRotation();clearTimeout(refreshTimer);refreshTimer=null;epoch++;busy=false;
  }
  else if(token){
    if(mode==="family"&&pages[cursor])resumePage=pages[cursor].id;
    hide("正在重新读取");refresh();
  }
},false);
if(adminModule)window.KHD_ADMIN_CAN_LEAVE=canLeaveSettings;
panel(false);show("options",false);txt("version",access.version?"软件版本："+access.version:"软件版本：未知");
if(direct){el("connect").onclick();}
}());
