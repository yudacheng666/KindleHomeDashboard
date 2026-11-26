/* Display with explicitly authorized task completion. ES5/XHR; optional tab-local direct-mode resume metadata only. */
(function(){
"use strict";
var access=window.KHD_ACCESS||{}, direct=access.direct===true, openAdmin=access.openAdmin===true;
var token="", epoch=0, busy=false, data=null, pages=[], cursor=0, running=false;
var autoEntry=typeof location!=="undefined"&&location.pathname==="/auto", automatic=false;
var seconds=180, editing=false, section="tasks", settingsOpen=false;
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
  if(section==="tasks")return [{id:"tasks",title:"待办清单",lines:v.tasks.length?v.tasks.map(function(t){return "□ "+t.title;}):["暂无待办"],note:"",tasks:v.tasks,canComplete:v.can_complete===true}];
  if(section==="posters"){
    v.posters.forEach(function(t){p=p.concat(posterPages(t));});
    return p.length?p:[{id:"posters",title:"海报",lines:["暂无有效海报"],note:""}];
  }
  var settings=v.menu_display||{mode:"week",days:7},title=settings.mode==="week"?"本周菜单":"未来"+settings.days+"天菜单";
  return [{id:"week",title:title,menus:v.week_menu,lines:["暂无"+title],note:""}];
}
function eligible(p){return section==="posters";}
function tabs(){
  var active=mode==="bus"||mode==="weather"?mode:section;
  ["bus","tasks","posters","menus","weather"].forEach(function(t){el(t+"Mode").className=t===active?"selected":"";});
  updateManagementLinks();
  show("familyControls",mode==="family"&&section==="posters");
}
function updateManagementLinks(){
  var target=automatic?"auto":mode==="bus"||mode==="weather"?mode:section;
  el("manageLink").href="/bus#return-"+target;
  ["tasks","posters","menus","catalog","display"].forEach(function(t){el(t+"Manage").href="/home#"+t+"/return-"+target;});
}
function panel(open){settingsOpen=open;show("settingsPanel",open);show("displayNav",!open);show("displayContent",!open);if(open)updateManagementLinks();}
function render(){
  var p=pages[cursor];if(!p||!data)return;
  var key=JSON.stringify([data.date,p,cursor,pages.length]);
  if(key!==lastRender){
    lastRender=key;txt("date",data.date);txt("heading",p.title);
    var root=el("body");clear(root);
    if(p.tasks&&p.tasks.length&&p.canComplete){
      var displayedDate=data.date;
      p.tasks.forEach(function(t){
        var row=append(root,"div","","task-row");append(row,"span",t.title,"task-text");
        var action=append(row,"span","","task-action"),button=append(action,"button","完成","task-complete");
        button.type="button";button.onclick=function(){completeTask(t,displayedDate,button);};
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
  if(!token||!data||data.date!==on||data.can_complete!==true||section!=="tasks"||mode!=="family"||settingsOpen)return;
  if(busy){txt("status","正在同步，请稍后再试。");return;}
  if(!window.confirm("确认完成「"+t.title+"」？完成后保留历史记录。"))return;
  var g=epoch,x=new XMLHttpRequest(),ended=false,timer;
  busy=true;button.disabled=true;clearTimeout(refreshTimer);refreshTimer=null;
  function finish(ok){
    if(ended)return;ended=true;clearTimeout(timer);if(g!==epoch)return;
    busy=false;button.disabled=false;
    if(ok&&data&&data.date===on){
      data.tasks=data.tasks.filter(function(item){return item.id!==t.id;});
      data.posters=data.posters.filter(function(item){return item.task_id!==t.id;});
      accept(data);refresh();
    }else{
      txt("status","完成未确认成功，请刷新核对后再试。");
      refreshTimer=setTimeout(refresh,30000);
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
  stopRotation();if(mode!=="family"||section!=="posters"||!running||settingsOpen||editing||!data||document.hidden||pages.filter(eligible).length<2)return;
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

function weatherNum(v,suffix){return typeof v==="number"&&isFinite(v)?Math.round(v)+suffix:"—";}
function weatherTime(v){return typeof v==="string"?v.slice(0,16).replace("T"," ")+(v.slice(-1)==="Z"?" UTC":/[+-]\d\d:\d\d$/.test(v)?" "+v.slice(-6):""):"时间未知";}
function weatherSource(root,s,attrs){
  append(root,"p",(s.source==="QWeather"?"和风天气":"Open-Meteo · 模型估算")+" · 采集 "+weatherTime(s.fetched_at),"weather-source");
  (s.attributions||[]).forEach(function(a){if(typeof a==="string"&&attrs.indexOf(a)<0)attrs.push(a);});
}
function weatherPart(root,sections,key,title,attrs,draw){
  var block=append(root,"section","","weather-block"),s=sections[key];
  append(block,"h2",title);
  if(!s||s.status!=="available"){append(block,"p","暂不可用","note");return;}
  draw(block,s.data);
  weatherSource(block,s,attrs);
}
function acceptWeather(v){
  data=null;pages=[];cursor=0;stopRotation();stopAge();
  var key=JSON.stringify(v);
  if(key!==lastRender){
    lastRender=key;txt("date","");txt("heading",v.name?v.name+" · 天气":"天气");txt("index","");
    var root=el("body"),s=v.sections||{},attrs=[];clear(root);
    if(v.status==="disabled")append(root,"p","天气未启用，请前往设置。","note");
    else if(v.status==="storage_error")append(root,"p","天气配置或限额记录异常，已暂停采集。","note");
    else{
      var current=s.current;
      if(current&&current.status==="available"){
        var c=current.data;
        append(root,"p",weatherNum(c.temp,"°C")+"　"+c.text,"weather-main");
        append(root,"p","体感 "+weatherNum(c.feels,"°C")+" · 湿度 "+weatherNum(c.humidity,"%")+" · 风速 "+weatherNum(c.wind," "+c.wind_unit),"note");
        append(root,"p","数据时间 "+weatherTime(c.time),"note");weatherSource(root,current,attrs);
      }else append(root,"p","等待当前天气","note");
      weatherPart(root,s,"alerts","气象预警",attrs,function(block,rows){
        if(!rows.length){append(block,"p","本次未查到预警，以气象部门发布为准。","note");return;}
        rows.forEach(function(a){
          var row=append(block,"div","","weather-alert");
          append(row,"p",(a.type==="cancel"?"解除信息 · ":"")+a.headline);
          append(row,"p",a.sender+" · "+weatherTime(a.issued),"note");
          if(a.description)append(row,"p",a.description,"note");
          if(a.instruction)append(row,"p",a.instruction,"note");
        });
      });
      weatherPart(root,s,"rain","未来2小时降水",attrs,function(block,r){
        append(block,"p",r.summary+" · 每5分钟预报");
        append(block,"p","预报生成时间 "+weatherTime(r.time),"weather-source");
      });
      weatherPart(root,s,"hourly","未来12小时",attrs,function(block,rows){
        var strip=append(block,"div","","weather-strip");
        rows.slice(0,12).forEach(function(h,i){
          if(i%2)return;
          var cell=append(strip,"div","","weather-cell");
          append(cell,"p",h.time.slice(11,16));append(cell,"p",h.text);
          append(cell,"p",weatherNum(h.temp,"°"));append(cell,"p",weatherNum(h.pop,"%"));
        });
        append(block,"p","百分比为降水概率","weather-source");
      });
      weatherPart(root,s,"daily","未来7天",attrs,function(block,rows){
        var strip=append(block,"div","","weather-strip");
        rows.slice(0,7).forEach(function(d){
          var cell=append(strip,"div","","weather-cell");
          append(cell,"p",d.time.slice(5,10));append(cell,"p",d.text);
          append(cell,"p",weatherNum(d.max,"°"));append(cell,"p",weatherNum(d.min,"°"));
        });
      });
      weatherPart(root,s,"air","空气质量",attrs,function(block,rows){
        rows.forEach(function(a){append(block,"p",a.name+" "+a.aqi+" · "+a.category,"note");});
      });
      attrs.forEach(function(a){append(root,"p",a,"weather-source");});
      if(Object.keys(s).some(function(k){return s[k].status==="available"&&s[k].source==="QWeather";})){
        var attribution=append(root,"a","天气服务由和风天气驱动","weather-source");attribution.href="https://www.qweather.com";attribution.rel="noreferrer";
      }
      if(Object.keys(s).some(function(k){return s[k].status==="available"&&s[k].source==="Open-Meteo";})){
        var meteoLink=append(root,"a"," · Open-Meteo (CC BY 4.0)","weather-source");meteoLink.href="https://open-meteo.com/";meteoLink.rel="noreferrer";
      }
    }
  }
  show("login",false);show("display",true);txt("status","");
}
var weatherSettingsEpoch=0,weatherSettingsBusy=false;
function weatherForm(v){
  el("weatherEnabled").checked=v.enabled===true;el("weatherConsent").checked=v.consent===true;
  el("weatherName").value=v.name||"";el("weatherLat").value=v.name?String(v.latitude):"";el("weatherLon").value=v.name?String(v.longitude):"";
  var b=v.budget;txt("weatherBudget",(v.primary_configured?"和风凭据已配置":"和风凭据未配置，仅可使用备用源")+
    (b?" · 本月已计 "+b.used+" / "+b.limit+"，滚动32天 "+b.rolling_used+(b.blocked?" · 和风已阻断，需核查账户":"")+(b.backup_blocked?" · 备用源已阻断":""):" · 额度不可用"));
  show("weatherForm",true);
}
function weatherSettingsRequest(body){
  if(!settingsOpen||!token||weatherSettingsBusy)return;
  weatherSettingsBusy=true;
  var g=++weatherSettingsEpoch,x=new XMLHttpRequest(),done=false,timer;
  txt("weatherSettingStatus",body?"正在保存…":"正在读取…");
  function finish(ok,v,code){
    if(done)return;done=true;clearTimeout(timer);
    if(g!==weatherSettingsEpoch||!settingsOpen)return;
    weatherSettingsBusy=false;
    if(ok&&v&&typeof v.enabled==="boolean"){weatherForm(v);txt("weatherSettingStatus",body?"已保存":"已读取");}
    else txt("weatherSettingStatus",code===401?"需要管理权限，请使用管理令牌连接。":"操作未确认，请重新读取设置。");
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
el("weatherLoad").onclick=function(){weatherSettingsRequest(null);};
el("weatherSave").onclick=function(){
  var a=el("weatherLat").value,b=el("weatherLon").value,enabled=el("weatherEnabled").checked,consent=el("weatherConsent").checked,name=el("weatherName").value;
  if(!enabled&&!name&&!a&&!b){a="0";b="0";}
  if(!/^-?\d{1,3}(\.\d{1,2})?$/.test(a)||! /^-?\d{1,3}(\.\d{1,2})?$/.test(b)||
    Math.abs(Number(a))>90||Math.abs(Number(b))>180||(enabled&&(!consent||!name.trim()))){
    txt("weatherSettingStatus","请输入有效经纬度、名称并确认位置传输。");return;}
  weatherSettingsRequest({enabled:enabled,consent:consent,name:name,latitude:Number(a),longitude:Number(b)});
};

function modeLabel(){
  txt("modeStatus",automatic?"自动分时 · 按 NAS 采集时段":"手动显示 · 不自动切换模块");updateManagementLinks();
}
function manual(){
  if(!automatic)return;
  automatic=false;epoch++;busy=false;clearTimeout(refreshTimer);
  refreshTimer=setTimeout(refresh,mode==="bus"?15000:30000);modeLabel();
}
function switchMode(next){
  if(!token)return;
  if(settingsOpen)closeSettings();manual();
  if(next===mode)return;
  epoch++;busy=false;clearTimeout(refreshTimer);refreshTimer=null;editing=false;
  show("options",false);resumePage="";forgetResume();mode=next;
  tabs();hide("正在读取");refresh();
}
function switchSection(next){
  if(!token)return;
  if(settingsOpen)closeSettings();manual();
  if(mode!=="family"){section=next;switchMode("family");return;}
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
      if(mode==="bus")acceptBus(v);else if(mode==="weather")acceptWeather(v);else accept(v);
      modeLabel();
    }
    else if((status===404&&mode==="family")||status===503){show("login",false);show("display",true);hide(status===404?"家庭模块未启用，可切换至公交。":"当前模块暂不可用，可切换其他模块。");}
    else{hide(status===401?"令牌无效，请重新连接。":status===404?"家庭模块未启用。":"连接异常，旧内容已隐藏。");
      if(status===401){reset();txt("status","令牌无效，请重新连接。");return;}}
    clearTimeout(refreshTimer);refreshTimer=document.hidden?null:setTimeout(refresh,mode==="bus"?15000:30000);
  }
  try{x.open("GET",automatic?"/api/display/auto":mode==="bus"?"/api/bus/view":mode==="weather"?"/api/weather/view":"/api/home/view",true);if(token&&token!=="local-direct")x.setRequestHeader("Authorization","Bearer "+token);
    x.onreadystatechange=function(){if(x.readyState!==4)return;var v=null;try{v=JSON.parse(x.responseText);}catch(e){}
      var next=automatic&&v?v.mode:mode, payload=automatic&&v?v.view:v;
      var valid=payload&&(next==="bus"?payload.snapshot&&Array.isArray(payload.snapshot.vehicles):next==="weather"?typeof payload.status==="string"&&payload.sections&&typeof payload.sections==="object":next==="family"&&Array.isArray(payload.tasks)&&Array.isArray(payload.posters)&&Array.isArray(payload.week_menu));
      finish(x.status===200&&valid,v,x.status);};
    timeout=setTimeout(function(){finish(false,null,0);try{x.abort();}catch(e){}},12000);x.send(null);
  }catch(e){finish(false,null,0);}
}
function reset(keepResume){
  weatherSettingsEpoch++;weatherSettingsBusy=false;show("weatherForm",false);txt("weatherSettingStatus","");
  if(keepResume!==true)forgetResume();resumePage="";
  epoch++;busy=false;token="";automatic=false;modeLabel();mode="family";section="tasks";savedKey="";tabs();running=false;editing=false;seconds=180;
  clearTimeout(refreshTimer);refreshTimer=null;hide("");el("token").value="";
  panel(false);show("options",false);show("display",false);show("login",true);
}
el("connect").onclick=function(){if(busy)return;token=el("token").value;el("token").value="";if(direct&&!token)token="local-direct";if(token){automatic=autoEntry;restoreResume();var hash=typeof location!=="undefined"?location.hash:"";if(!automatic&&(hash==="#bus"||hash==="#weather")){mode=hash.slice(1);resumePage="";forgetResume();}else if(!automatic&&["#tasks","#posters","#menus"].indexOf(hash)>=0){if(section!==hash.slice(1))resumePage="";section=hash.slice(1);}tabs();modeLabel();clearTimeout(refreshTimer);refreshTimer=null;refresh();}};
el("autoMode").onclick=function(){
  if(!token)return;
  panel(false);automatic=true;forgetResume();epoch++;busy=false;editing=false;section="tasks";tabs();show("options",false);
  clearTimeout(refreshTimer);refreshTimer=null;modeLabel();refresh();
};
el("tasksMode").onclick=function(){switchSection("tasks");};
el("postersMode").onclick=function(){switchSection("posters");};
el("menusMode").onclick=function(){switchSection("menus");};
el("busMode").onclick=function(){switchMode("bus");};
el("weatherMode").onclick=function(){switchMode("weather");};
el("previous").onclick=function(){if(editing||section!=="posters"||mode!=="family")return;manual();running=false;stopRotation();advance(-1,false);};
el("next").onclick=function(){if(editing||section!=="posters"||mode!=="family")return;manual();running=false;stopRotation();advance(1,false);};
el("pause").onclick=function(){if(!data||editing||section!=="posters")return;if(running)manual();running=!running;render();scheduleRotation();};
el("settings").onclick=function(){if(!token||settingsOpen)return;panel(true);stopRotation();el("seconds").value=String(seconds);show("options",mode==="family"&&section==="posters");};
function closeSettings(){weatherSettingsEpoch++;weatherSettingsBusy=false;show("weatherForm",false);txt("weatherSettingStatus","");editing=false;panel(false);show("options",false);scheduleRotation();}
el("returnDisplay").onclick=closeSettings;
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
panel(false);show("options",false);txt("version",access.version?"软件版本："+access.version:"软件版本：未知");
if(direct){el("connect").onclick();}
}());
