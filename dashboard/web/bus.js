/* ES5 and XMLHttpRequest for older browsers. No storage or external assets. */
(function () {
"use strict";
var access=typeof window!=="undefined"&&window.KHD_ACCESS||{}, direct=access.direct===true, openAdmin=access.openAdmin===true;
var token="", admin=false, busy=false, generation=0, configuring=false;
var lines=[], stops=[], handle="", lastKey="", timer=null, scheduleRows=[], scheduleEditable=false, searchedKeyword="", groups=[], choices=[], ageTimer=null, collectedAt=null;
function el(id){return document.getElementById(id);}
function txt(id,value){var n=el(id);if(n.textContent!==value)n.textContent=value;}
function show(id,visible){el(id).className=visible?"":"hidden";}
function note(value){txt("message",value);}
function option(select,value,label){var n=document.createElement("option");n.value=String(value);n.textContent=label;select.appendChild(n);}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);}
function disable(value){
  busy=value;
  var ids=["connect","refresh","settings","search","detail","save","cancel","route","direction","board","destination","keyword","scheduleSettings","scheduleEnabled","scheduleAdd","scheduleSave","scheduleCancel"];
  for(var i=0;i<ids.length;i++)el(ids[i]).disabled=value;
}
function errorMessage(code){
  var messages={unauthorized:"令牌无效或没有管理权限。",provider_blocked:"公交服务已限制访问，停止请求。",local_budget_wait:"请求间隔或本地额度限制，请稍后手动重试。",bus_disabled:"公交采集未启用，请打开采集时间设置。",bus_config_error:"公交配置错误，采集已暂停，请检查采集时间设置或 Docker 日志。",local_request_gap:"请求过快，请等几秒再手动重试。",local_daily_limit:"已达到软件每日请求上限（UTC 日期），请次日再试；不是第三方额度。",provider_error:"公交接口暂不可用或未返回可识别结果。可尝试输入完整线路名称。",direction_unavailable:"接口未返回所选方向的有效站点，请核对线路方向后再试。",invalid_selection_or_request:"选择无效或已过期，请重新搜索。",service_error:"本地服务异常。"};
  return messages[code]||"连接失败，请检查本机服务。";
}
function request(method,path,body,done){
  if(busy)return;
  disable(true);note("");
  var epoch=generation,x=new XMLHttpRequest(),finished=false,deadline;
  function finish(ok,data){
    if(finished)return;finished=true;clearTimeout(deadline);
    if(epoch!==generation)return;
    disable(false);done(ok,data);
  }
  try{
    x.open(method,path,true);if(token&&token!=="local-direct")x.setRequestHeader("Authorization","Bearer "+token);
    if(body!==null)x.setRequestHeader("Content-Type","application/json");
    x.onreadystatechange=function(){
      if(x.readyState!==4)return;
      var data={};try{data=JSON.parse(x.responseText);}catch(e){}
      finish(x.status===200,data);
    };
    deadline=setTimeout(function(){finish(false,{});try{x.abort();}catch(e){}},12000);
    x.send(body===null?null:JSON.stringify(body));
  }catch(e){finish(false,{});}
}
function resetSelection(){
  lines=[];groups=[];choices=[];stops=[];handle="";
  clear(el("route"));clear(el("board"));clear(el("destination"));
  clear(el("direction"));show("directionStep",false);show("results",false);show("stations",false);txt("selection-summary","");
}
function stopAge(){clearTimeout(ageTimer);ageTimer=null;collectedAt=null;txt("updated","");}
function paintAge(){clearTimeout(ageTimer);ageTimer=null;if(collectedAt===null||document.hidden)return;var n=Math.floor((Date.now()-collectedAt)/1000);txt("updated",n<0?"更新时间未知（请检查设备时间）":n+" 秒前刷新");ageTimer=setTimeout(paintAge,5000);}
function setAge(s){stopAge();if(["live","stale","no_live_data"].indexOf(s.status)>=0){var t=Date.parse(s.fetched_at);if(isFinite(t)){collectedAt=t;paintAge();}}}
function hideData(message){
  stopAge();
  lastKey="";clear(el("vehicles"));txt("updated","");txt("schedule","");
  txt("status",message);
}
function render(data){
  var trip=data.trip,s=data.snapshot;
  if(!s){hideData("未取得有效数据");return;}
  txt("line",trip?trip.line.name:"尚未配置公交");
  txt("trip",trip?trip.boarding.name+" → "+trip.destination.name+" · "+(trip.destination_index-trip.board_index)+"站":"");
  var labels={live:"实时预计到站",stale:"数据暂未更新 · 以下为旧数据",expired:"数据已过期",paused:"非采集时段",blocked:"接口限制访问",disabled:"公交采集未启用",config_error:"公交配置错误，采集已暂停；请检查采集时间设置或 Docker 日志",unconfigured:"请先设置线路和站点",unverified:"正在核对保存的线路",needs_selection:"站序已变化，请重新选站",unavailable:"等待首次采集",no_live_data:"暂未取得在途车辆信息",error:"接口请求失败",service_error:"本地采集服务异常"};
  var vehicles=(s.status==="live"||s.status==="stale")?s.vehicles:[];
  var key=JSON.stringify([trip,s.status,vehicles,s.scheduled_departures,["live","stale","no_live_data"].indexOf(s.status)>=0?s.fetched_at:""]);
  if(key===lastKey)return;lastKey=key;
  txt("status",labels[s.status]||"状态未知");
  var root=el("vehicles");clear(root);
  for(var i=0;i<vehicles.length;i++){
    var v=vehicles[i],row=document.createElement("div"),label=document.createElement("div"),eta=document.createElement("div"),info=document.createElement("p");
    row.className="vehicle";label.textContent=v.position===1?"最近一辆":"下一辆";
    eta.className="eta";eta.textContent=v.eta_min+" 分钟";
    var parts=[];if(v.distance_m!==null)parts.push(v.distance_m+" 米");
    if(v.stops_remaining!==null)parts.push("剩余 "+v.stops_remaining+" 站");
    info.textContent=parts.join(" · ");row.appendChild(label);row.appendChild(eta);row.appendChild(info);root.appendChild(row);
  }
  txt("schedule",s.scheduled_departures&&s.status!=="stale"?"计划待发车 "+s.scheduled_departures+" 辆（非实时 ETA）":"");
  setAge(s);
}
function read(){
  if(!token||configuring||busy||document.hidden)return;
  request("GET","/api/bus/view",null,function(ok,data){
    if(ok)render(data);else{hideData("连接异常 · 实时数据已隐藏");note(errorMessage(data.error));}
  });
}
function cycle(){read();timer=setTimeout(cycle,15000);}
function exit(){
  generation++;token="";admin=false;configuring=false;disable(false);
  clearTimeout(timer);timer=null;resetSelection();hideData("尚未连接");
  txt("line","尚未配置公交");txt("trip","");el("token").value="";el("keyword").value="";
  show("config",false);show("scheduleConfig",false);clear(el("scheduleRows"));scheduleRows=[];show("dashboard",false);show("login",true);note("");
}
el("connect").onclick=function(){
  if(busy)return;token=el("token").value;el("token").value="";
  admin=el("mode").value==="admin";
  if(direct&&!token)token="local-direct";
  if(direct&&admin&&!openAdmin&&token==="local-direct"){note("请输入管理凭证。");return;}
  request("GET",admin&&direct&&!openAdmin?"/api/access/admin":"/api/bus/view",null,function(ok,data){
    if(!ok){token="";note(errorMessage(data.error));return;}
    show("login",false);show("dashboard",true);show("settings",admin);show("scheduleSettings",admin);if(direct)txt("logout",openAdmin?"重新连接":"管理登录 / 退出");
    if(admin&&direct&&!openAdmin)read();else render(data);timer=setTimeout(cycle,15000);
  });
};
el("logout").onclick=exit;el("refresh").onclick=read;
if(document.addEventListener)document.addEventListener("visibilitychange",function(){if(document.hidden){stopAge();}else if(token&&!configuring){hideData("正在重新读取");read();}},false);
function scheduleTime(n){return ("0"+Math.floor(n/60)).slice(-2)+":"+("0"+n%60).slice(-2);}
function timeMinutes(s){var m=/^([0-9]{2}):([0-9]{2})$/.exec(s);if(!m||Number(m[2])>59)return -1;return Number(m[1])*60+Number(m[2]);}
function addScheduleRow(w){
  var root=document.createElement("div");root.className="schedule-row";el("scheduleRows").appendChild(root);
  var row={root:root,days:[]}, names=["周一","周二","周三","周四","周五","周六","周日"];
  for(var i=0;i<7;i++){var label=document.createElement("label"),box=document.createElement("input"),span=document.createElement("span");
    box.type="checkbox";box.checked=w.days.indexOf(i)>=0;box.disabled=!scheduleEditable;
    span.textContent=names[i];label.appendChild(box);label.appendChild(span);root.appendChild(label);row.days.push(box);}
  function field(name,value){var l=document.createElement("label"),n=document.createElement("input"),sp=document.createElement("span");
    sp.textContent=name;n.type="text";n.maxLength=5;n.placeholder="HH:MM";n.value=value;n.disabled=!scheduleEditable;l.appendChild(sp);l.appendChild(n);root.appendChild(l);return n;}
  row.start=field("开始 ",w.start===null?"":scheduleTime(w.start));row.end=field("结束 ",w.end===null?"":scheduleTime(w.end));
  var remove=document.createElement("button");remove.type="button";remove.textContent="删除时段";remove.disabled=!scheduleEditable;
  remove.onclick=function(){if(busy)return;el("scheduleRows").removeChild(root);scheduleRows.splice(scheduleRows.indexOf(row),1);};
  root.appendChild(remove);scheduleRows.push(row);
}
function closeSchedule(){configuring=false;show("scheduleConfig",false);clear(el("scheduleRows"));scheduleRows=[];show("view",true);read();}
el("scheduleSettings").onclick=function(){
  if(busy||!admin)return;
  configuring=true;
  request("GET","/api/bus/schedule",null,function(ok,data){
    if(!ok){configuring=false;note(errorMessage(data.error));return;}
    stopAge();resetSelection();show("config",false);show("view",false);show("scheduleConfig",true);clear(el("scheduleRows"));scheduleRows=[];
    scheduleEditable=data.editable===true;el("scheduleEnabled").value=data.enabled?"1":"0";
    txt("scheduleZone","时区："+data.timezone+(scheduleEditable?"":" · 请先修正 Docker 中的请求上限设置"));
    el("scheduleEnabled").disabled=!scheduleEditable;el("scheduleAdd").disabled=!scheduleEditable;el("scheduleSave").disabled=!scheduleEditable;
    (data.windows||[]).forEach(addScheduleRow);
  });
};
el("scheduleAdd").onclick=function(){if(busy||!scheduleEditable)return;if(scheduleRows.length>=32){note("最多32个时段。");return;}addScheduleRow({days:[],start:null,end:null});};
el("scheduleCancel").onclick=closeSchedule;
el("scheduleSave").onclick=function(){
  if(busy||!scheduleEditable)return;
  var enabled=el("scheduleEnabled").value==="1",windows=[];
  for(var i=0;i<scheduleRows.length;i++){var row=scheduleRows[i],days=[];
    for(var j=0;j<7;j++)if(row.days[j].checked)days.push(j);
    var start=timeMinutes(row.start.value),end=timeMinutes(row.end.value);
    if(!days.length||start<0||start>=1440||end<0||end>1440||start===end){note("请为每个时段选择星期和有效时间。");return;}
    windows.push({days:days,start:start,end:end});
  }
  if(enabled&&!windows.length){note("开启公交前请至少添加一个采集时段。");return;}
  request("POST","/api/bus/schedule",{enabled:enabled,windows:windows},function(ok,data){
    if(!ok){note(errorMessage(data.error));return;}closeSchedule();note("采集设置已保存。");
  });
};
el("settings").onclick=function(){if(busy)return;stopAge();searchedKeyword="";show("scheduleConfig",false);clear(el("scheduleRows"));scheduleRows=[];configuring=true;resetSelection();show("view",false);show("config",true);};
el("cancel").onclick=function(){configuring=false;resetSelection();hideData("正在重新读取");show("config",false);show("view",true);read();};
function groupLines(){
  groups=[];
  lines.forEach(function(line){
    var g=null;for(var i=0;i<groups.length;i++)if(groups[i].name===line.name&&groups[i].city===line.city_code){g=groups[i];break;}
    if(!g){g={name:line.name,city:line.city_code,rows:[]};groups.push(g);}
    g.rows.push(line);
  });
}
function chooseLine(preferred){
  clearStops();clear(el("direction"));choices=[];
  var value=el("route").value,g=value===""?null:groups[Number(value)];
  show("directionStep",!!g);if(!g)return;
  option(el("direction"),"","请选择方向");
  ["0","1"].forEach(function(dir){
    var rows=g.rows.filter(function(x){return x.direction===dir;});
    var label=dir==="0"?"上行":"下行";
    if(!rows.length&&g.rows.length===1){
      choices.push({line:g.rows[0],direction:dir,key:dir});
      option(el("direction"),dir,label+"（待查询确认）");
    }else rows.forEach(function(line,i){
      var key=rows.length===1?dir:dir+":"+i;
      choices.push({line:line,direction:dir,key:key});
      option(el("direction"),key,label+" · "+line.first+" → "+line.last);
    });
  });
  el("direction").value="";
  if(preferred)choices.forEach(function(c){if(c.direction===preferred.direction&&c.line.line_id===preferred.line.line_id&&c.line.direction===preferred.line.direction)el("direction").value=c.key;});
}
function currentChoice(){var v=el("direction").value;for(var i=0;i<choices.length;i++)if(choices[i].key===v)return choices[i];return null;}
el("search").onclick=function(){
  if(busy)return;
  var keyword=el("keyword").value, old=el("route").value===""?null:groups[Number(el("route").value)], previous=currentChoice();
  var preserve=keyword===searchedKeyword&&old;
  resetSelection();
  request("POST","/api/bus/search",{keyword:keyword},function(ok,data){
    if(!ok){note(errorMessage(data.error));return;}
    searchedKeyword=keyword;lines=data.lines||[];groupLines();
    option(el("route"),"","请选择线路");
    var selected="";
    groups.forEach(function(g,i){option(el("route"),i,g.name);if(preserve&&g.name===old.name&&g.city===old.city)selected=String(i);});
    show("results",groups.length>0);el("route").value=selected;
    if(groups.length)chooseLine(preserve?previous:null);else note("没有匹配线路，请尝试输入完整名称。");
  });
};
function clearStops(){stops=[];handle="";show("stations",false);clear(el("board"));clear(el("destination"));}
el("route").onchange=function(){chooseLine(null);};
el("direction").onchange=clearStops;
function summary(){var a=Number(el("board").value),b=Number(el("destination").value);txt("selection-summary",stops[a].name+" → "+stops[b].name+" · "+(b-a)+"站");}
function destinations(){
  var a=Number(el("board").value),select=el("destination");clear(select);
  for(var i=a+1;i<stops.length;i++)option(select,i,(i+1)+". "+stops[i].name);
  summary();
}
el("board").onchange=destinations;el("destination").onchange=summary;
el("detail").onclick=function(){
  if(busy)return;clearStops();
  var choice=currentChoice();if(!choice){note("请先选择行驶方向。");return;}
  var line=choice.line,direction=choice.direction;
  request("POST","/api/bus/route",{line:line,direction:direction},function(ok,data){
    if(!ok){note(errorMessage(data.error));return;}
    stops=data.route.stops;handle=data.selection;
    txt("endpoints",(data.route.line.direction==="0"?"上行":"下行")+" · "+data.route.line.first+" → "+data.route.line.last);
    for(var i=0;i<stops.length-1;i++)option(el("board"),i,(i+1)+". "+stops[i].name);
    destinations();show("stations",true);
  });
};
el("save").onclick=function(){
  if(!handle||busy)return;
  request("POST","/api/bus/save",{selection:handle,boarding:Number(el("board").value),destination:Number(el("destination").value)},function(ok,data){
    if(!ok){note(errorMessage(data.error));return;}
    configuring=false;resetSelection();show("config",false);show("view",true);render(data);note("已保存。");
  });
};
if(direct){el("mode").value=openAdmin?"admin":"read";el("connect").onclick();}
}());
