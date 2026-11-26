/* ES5 and XMLHttpRequest for older browsers. No storage or external assets. */
(function () {
"use strict";
var access=typeof window!=="undefined"&&window.KHD_ACCESS||{}, direct=access.direct===true, openAdmin=access.openAdmin===true;
var token="", admin=false, busy=false, generation=0, configuring=false;
var lines=[], stops=[], handle="", lastKey="", timer=null;
function el(id){return document.getElementById(id);}
function txt(id,value){var n=el(id);if(n.textContent!==value)n.textContent=value;}
function show(id,visible){el(id).className=visible?"":"hidden";}
function note(value){txt("message",value);}
function option(select,value,label){var n=document.createElement("option");n.value=String(value);n.textContent=label;select.appendChild(n);}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);}
function disable(value){
  busy=value;
  var ids=["connect","refresh","settings","search","detail","save","cancel","route","direction","board","destination","keyword"];
  for(var i=0;i<ids.length;i++)el(ids[i]).disabled=value;
}
function errorMessage(code){
  var messages={unauthorized:"令牌无效或没有管理权限。",provider_blocked:"公交服务已限制访问，停止请求。",local_budget_wait:"请求间隔或本地额度限制，请稍后手动重试。",bus_disabled:"公交采集未启用，请检查 Docker 公交开关并重新部署。",local_request_gap:"请求过快，请等几秒再手动重试。",local_daily_limit:"已达到软件每日请求上限（UTC 日期），请次日再试；不是第三方额度。",provider_error:"公交接口暂不可用。",invalid_selection_or_request:"选择无效或已过期，请重新搜索。",service_error:"本地服务异常。"};
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
  lines=[];stops=[];handle="";
  clear(el("route"));clear(el("board"));clear(el("destination"));
  show("results",false);show("stations",false);txt("selection-summary","");
}
function hideData(message){
  lastKey="";clear(el("vehicles"));txt("updated","");txt("schedule","");
  txt("status",message);
}
function render(data){
  var trip=data.trip,s=data.snapshot;
  if(!s){hideData("未取得有效数据");return;}
  txt("line",trip?trip.line.name:"尚未配置公交");
  txt("trip",trip?trip.boarding.name+" → "+trip.destination.name+" · "+(trip.destination_index-trip.board_index)+"站":"");
  var labels={live:"实时预计到站",stale:"数据暂未更新 · 以下为旧数据",expired:"数据已过期",paused:"非采集时段",blocked:"接口限制访问",disabled:"公交采集未启用",unconfigured:"请先设置线路和站点",unverified:"正在核对保存的线路",needs_selection:"站序已变化，请重新选站",unavailable:"等待首次采集",no_live_data:"暂未取得在途车辆信息",error:"接口请求失败",service_error:"本地采集服务异常"};
  var vehicles=(s.status==="live"||s.status==="stale")?s.vehicles:[];
  var key=JSON.stringify([trip,s.status,vehicles,s.scheduled_departures,vehicles.length?s.fetched_at:""]);
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
  txt("updated",vehicles.length?"最近有效采集（UTC）："+s.fetched_at.replace("T"," ").slice(0,19):"");
}
function read(){
  if(!token||configuring||busy)return;
  request("GET","/api/bus/view",null,function(ok,data){
    if(ok)render(data);else{hideData("连接异常 · 实时数据已隐藏");note(errorMessage(data.error));}
  });
}
function cycle(){read();timer=setTimeout(cycle,15000);}
function exit(){
  generation++;token="";admin=false;configuring=false;disable(false);
  clearTimeout(timer);timer=null;resetSelection();hideData("尚未连接");
  txt("line","尚未配置公交");txt("trip","");el("token").value="";el("keyword").value="";
  show("config",false);show("dashboard",false);show("login",true);note("");
}
el("connect").onclick=function(){
  if(busy)return;token=el("token").value;el("token").value="";
  admin=el("mode").value==="admin";
  if(direct&&!token)token="local-direct";
  if(direct&&admin&&!openAdmin&&token==="local-direct"){note("请输入管理凭证。");return;}
  request("GET",admin&&direct&&!openAdmin?"/api/access/admin":"/api/bus/view",null,function(ok,data){
    if(!ok){token="";note(errorMessage(data.error));return;}
    show("login",false);show("dashboard",true);show("settings",admin);if(direct)txt("logout",openAdmin?"重新连接":"管理登录 / 退出");
    if(admin&&direct&&!openAdmin)read();else render(data);timer=setTimeout(cycle,15000);
  });
};
el("logout").onclick=exit;el("refresh").onclick=read;
if(document.addEventListener)document.addEventListener("visibilitychange",function(){if(!document.hidden&&token&&!configuring){hideData("正在重新读取");read();}},false);
el("settings").onclick=function(){configuring=true;resetSelection();show("view",false);show("config",true);};
el("cancel").onclick=function(){configuring=false;resetSelection();hideData("正在重新读取");show("config",false);show("view",true);read();};
el("search").onclick=function(){
  if(busy)return;resetSelection();
  request("POST","/api/bus/search",{keyword:el("keyword").value},function(ok,data){
    if(!ok){note(errorMessage(data.error));return;}
    lines=data.lines||[];
    for(var i=0;i<lines.length;i++)option(el("route"),i,lines[i].name+" · "+lines[i].first+" → "+lines[i].last);
    show("results",lines.length>0);if(lines.length)el("direction").value=lines[0].direction;else note("没有匹配线路。");
  });
};
function clearStops(){stops=[];handle="";show("stations",false);clear(el("board"));clear(el("destination"));}
el("route").onchange=function(){clearStops();el("direction").value=lines[Number(el("route").value)].direction;};
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
  var line=lines[Number(el("route").value)],direction=el("direction").value;
  if(!line)return;
  request("POST","/api/bus/route",{line:line,direction:direction},function(ok,data){
    if(!ok){note(errorMessage(data.error));return;}
    stops=data.route.stops;handle=data.selection;
    txt("endpoints",data.route.line.first+" → "+data.route.line.last);
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
