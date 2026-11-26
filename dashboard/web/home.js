/* Local household page. ES5, no remote assets, no browser persistence. */
(function(){
"use strict";
var access=window.KHD_ACCESS||{}, direct=access.direct===true, openAdmin=access.openAdmin===true;
var token="",admin=false,busy=false,epoch=0,tab=initialTab(),data=null,menus=[],menuDate="",editing=false,historyOpen=false;
function initialTab(){var h=typeof location!=="undefined"?(location.hash||"").split("/")[0]:"";return h==="#posters"?"posters":h==="#menus"?"menus":h==="#display"?"displaySettings":"tasks";}
function el(id){return document.getElementById(id);}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);}
function show(id,yes){el(id).className=yes?"":"hidden";}
function note(s){el("message").textContent=s;}
function node(parent,tag,s,cls){var n=document.createElement(tag);if(s!==undefined)n.textContent=s;if(cls)n.className=cls;parent.appendChild(n);return n;}
function btn(parent,label,fn){var n=node(parent,"button",label);n.type="button";n.onclick=function(){if(!busy)fn();};return n;}
function field(parent,label,value,kind,options,max){
  var l=node(parent,"label",label),n=node(l,kind==="textarea"?"textarea":kind==="select"?"select":"input");
  if(kind==="select"){for(var i=0;i<options.length;i++){var o=node(n,"option",options[i][1]);o.value=options[i][0];}}
  else if(kind!=="textarea")n.type=kind||"text";
  if(max)n.maxLength=max;n.value=value==null?"":String(value);return n;
}
function req(path,body,done){
  if(busy)return;busy=true;var g=epoch,x=new XMLHttpRequest(),ended=false,timer;
  function finish(ok,v){if(ended)return;ended=true;clearTimeout(timer);if(g!==epoch)return;busy=false;
    if(!ok){note(v.error==="unauthorized"?"权限不足或令牌无效。":v.error==="not_found"?"家庭模块未启用。":v.error==="invalid_selection_or_request"?"内容无效或状态已改变，请检查日期、关联及历史记录。":"连接异常，请刷新核对后再操作。");}
    done(ok,v);}
  try{x.open(body===null?"GET":"POST","/api/home/"+path,true);if(token&&token!=="local-direct")x.setRequestHeader("Authorization","Bearer "+token);
    if(body!==null)x.setRequestHeader("Content-Type","application/json");
    x.onreadystatechange=function(){if(x.readyState!==4)return;var v={};try{v=JSON.parse(x.responseText);}catch(e){}finish(x.status===200,v);};
    timer=setTimeout(function(){finish(false,{});try{x.abort();}catch(e){}},12000);
    x.send(body===null?null:JSON.stringify(body));
  }catch(e){finish(false,{});}
}
function closeEditor(){editing=false;clear(el("editor"));show("editor",false);}
function reset(){epoch++;busy=false;token="";admin=false;data=null;menus=[];menuDate="";tab=initialTab();historyOpen=false;
  closeEditor();clear(el("content"));el("date").textContent="";el("token").value="";show("home",false);show("login",true);note("");}
function load(){
  req(admin?"manage":"view",null,function(ok,v){
    if(!ok){data=null;menus=[];clear(el("content"));closeEditor();el("date").textContent="";return;}
    data=v;el("date").textContent=v.date;menuDate=menuDate||v.date;
    show("login",false);show("home",true);render();
  });
}
function mutate(path,body,onSaved){
  req(path,body,function(ok,v){if(ok){if(onSaved)onSaved();closeEditor();note("已保存。");load();}else{note(path==="menu/edit"&&v.error==="invalid_selection_or_request"?"未保存：目标餐次可能已有菜单，或原菜单/填写内容无效。请核对后重试。":"操作未确认成功；请刷新核对后再重试。");}});
}
function remove(path,body,label){
  if(window.confirm("确认删除"+label+"？此操作不可撤销。")){body.confirm=true;mutate(path,body);}
}
function editor(title){
  closeEditor();editing=true;var p=el("editor");show("editor",true);node(p,"h2",title);return p;
}
function actions(p,save){btn(p,"保存",save).className="primary";btn(p,"取消",closeEditor);}
function displayForm(){
  var p=editor("保存轮播设置"),s=data.display_settings||{seconds:180,include_week:false,include_shopping:false,autoplay:false};
  var interval=field(p,"每页停留",String(s.seconds),"select",[["120","2分钟"],["180","3分钟"],["300","5分钟"]]);
  var yesNo=[["false","否"],["true","是"]];
  var auto=field(p,"进入海报时自动开始轮播",String(s.autoplay),"select",yesNo);
  node(p,"p","保存在 NAS；展示页的临时调整不覆盖这里的默认设置。");
  actions(p,function(){mutate("display/set",{seconds:Number(interval.value),include_week:false,include_shopping:false,autoplay:auto.value==="true"});});
}
function taskForm(t){
  var p=editor(t?"编辑待办":"新增待办");
  var title=field(p,"标题",t?t.title:"","text",null,200),start=field(p,"开始日期",t?t.start:data.date,"date");
  var repeat=field(p,"重复",t?t.repeat:"once","select",[["once","单次"],["daily","每日"],["weekly","每周"]]);
  actions(p,function(){var b={title:title.value,start:start.value,repeat:repeat.value};if(t)b.key=t.id;mutate(t?"task/edit":"task/add",b);});
}
function posterForm(t){
  var p=editor(t?"编辑海报":"新增海报");
  var title=field(p,"标题",t?t.title:"","text",null,200),body=field(p,"正文（可换行）",t?t.body:"","textarea",null,1200);
  var noteField=field(p,"底部备注",t?t.note:"","text",null,200);
  var start=field(p,"开始日期",t?t.start:data.date,"date"),end=field(p,"结束日期（可留空）",t?t.end:"","date");
  var opts=[["","独立海报"]];for(var i=0;i<data.tasks.length;i++)opts.push([data.tasks[i].id,data.tasks[i].title]);
  var linked=field(p,"关联待办（关联后正文采用待办标题）",t?t.task_id:"","select",opts);
  actions(p,function(){var b={title:title.value,body:body.value,start:start.value,end:end.value||null,note:noteField.value,task_id:linked.value||null};if(t)b.key=t.id;mutate(t?"poster/edit":"poster/add",b);});
}
var mealNames={breakfast:"早餐",lunch:"午餐",dinner:"晚餐"};
function lines(s){return s.split(/\r?\n/).map(function(v){return v.trim();}).filter(function(v){return v.length>0;});}
function menuForm(m){
  var p=editor(m?"编辑菜单":"新增菜单"),on=field(p,"日期",m?m.day:menuDate,"date");
  var meal=field(p,"餐次",m?m.meal:"dinner","select",[["breakfast","早餐"],["lunch","午餐"],["dinner","晚餐"]]);
  var dishes=field(p,"菜品（每行一个）",m?m.dishes.join("\n"):"","textarea");
  var ingredients=field(p,"食材（每行一个，数量写在文字中）",m?m.ingredients.join("\n"):"","textarea");
  if(m)node(p,"p","可以调整日期和餐次；不会覆盖其他菜单。");
  actions(p,function(){
    if(!m&&!window.confirm("保存此日期及餐次的菜单？若已有菜单，将替换该餐次。"))return;
    var b={on:on.value,meal:meal.value,dishes:lines(dishes.value),ingredients:lines(ingredients.value)};
    if(m){b.old_on=m.day;b.old_meal=m.meal;}
    mutate(m?"menu/edit":"menu/set",b,function(){menuDate=b.on;});
  });
}
function row(parent){return node(parent,"div",undefined,"item");}
function tasks(p,arr,manage){
  if(!arr.length)node(p,"p","暂无待办");
  arr.forEach(function(t){var n=row(p);node(n,"p",t.title);if(manage){
    node(n,"small",t.start+" · "+({once:"单次",daily:"每日",weekly:"每周"}[t.repeat])+(t.occurrence?(t.completed?" · 已完成":" · 待完成"):" · 非发生日"));
    if(t.occurrence&&!t.completed)btn(n,"完成",function(){if(window.confirm("确认完成「"+t.title+"」？"))mutate("task/complete",{key:t.id,on:data.date,completed:true});});
    btn(n,"编辑",function(){taskForm(t);});btn(n,"删除",function(){remove("task/delete",{key:t.id},"待办及其完成记录");});
  }});
}
function history(p,arr){
  if(!arr.length)node(p,"p","暂无历史待办");
  arr.forEach(function(t){var n=row(p);node(n,"p",t.title);
    node(n,"small",t.completed_at?"完成于 "+t.completed_at.replace("T"," "):"发生日期 "+t.occurrence+" · 完成时间未知");
    if(t.restorable)btn(n,"恢复",function(){if(window.confirm("确认恢复此待办？"))mutate("task/complete",{key:t.id,on:data.date,completed:false});});
    btn(n,"彻底删除",function(){remove("history/delete",{key:t.id,occurrence:t.occurrence},t.repeat==="once"?"此待办及完成记录（关联海报须先解除）":"此期历史记录（保留周期任务及完成标记）");});
  });
}
function posters(p,arr,manage){
  if(!arr.length)node(p,"p","暂无提醒海报");
  arr.forEach(function(t){var n=row(p);node(n,"h3",t.title);var body=t.body;
    if(manage&&t.task_id){data.tasks.forEach(function(task){if(task.id===t.task_id)body=task.title;});}
    node(n,"p",body,"poster");node(n,"p",t.note||"");
    if(manage){node(n,"small",t.start+" 至 "+(t.end||"长期")+(t.enabled?" · 启用":" · 停用"));
      btn(n,"编辑",function(){posterForm(t);});btn(n,t.enabled?"停用":"启用",function(){mutate("poster/enable",{key:t.id,enabled:!t.enabled});});btn(n,"删除",function(){remove("poster/delete",{key:t.id},"海报");});}
  });
}
function menuRows(p,arr,manage){
  if(!arr.length)node(p,"p","暂无菜单");
  arr.forEach(function(m){var n=row(p);node(n,"h3",m.day+" · "+mealNames[m.meal]);node(n,"p",m.dishes.join("、"));
    if(manage){node(n,"small","食材："+m.ingredients.join("、"));btn(n,"编辑",function(){menuForm(m);});btn(n,"删除",function(){remove("menu/delete",{on:m.day,meal:m.meal},"该餐次菜单");});}});
}
function readMenus(p){
  var monday=new Date(menuDate+"T00:00:00Z");
  if(isNaN(monday.getTime())){node(p,"p","请选择有效日期");return;}
  monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
  var sunday=new Date(monday.getTime()+6*86400000);
  req("menu/list",{first:monday.toISOString().slice(0,10),last:sunday.toISOString().slice(0,10)},function(ok,v){if(ok){menus=v.result;menuRows(p,menus,true);}else{menus=[];node(p,"p","菜单读取失败");}});
}
function render(){
  var p=el("content");clear(p);if(!data)return;
  ["tasks","posters","menus","displaySettings"].forEach(function(t){el(t).className=t===tab?"primary":"";});
  if(tab==="displaySettings"){node(p,"h2","显示设置");var s=data.display_settings||{};node(p,"p","海报轮播："+(s.autoplay?"开启":"关闭")+" · 每页 "+(s.seconds||180)/60+" 分钟");if(admin)btn(p,"保存轮播设置",displayForm);}
  else if(tab==="tasks"){node(p,"h2","待办清单");
    if(admin){
      btn(p,"未完成",function(){if(canLeave()){closeEditor();historyOpen=false;render();}}).className=historyOpen?"":"primary";
      btn(p,"历史待办",function(){if(canLeave()){closeEditor();historyOpen=true;render();}}).className=historyOpen?"primary":"";
      if(historyOpen){history(p,data.history||[]);return;}
      btn(p,"新增待办",function(){taskForm(null);});
    }
    tasks(p,admin?data.tasks.filter(function(t){return t.repeat!=="once"||!t.completed;}):data.tasks,admin);
  }
  else if(tab==="posters"){node(p,"h2","海报");if(admin){btn(p,"新增海报",function(){posterForm(null);});btn(p,"保存轮播设置",displayForm);}posters(p,data.posters,admin);}
  else if(tab==="menus"){node(p,"h2","本周菜单");if(admin){
      var d=field(p,"查询所在周",menuDate,"date");btn(p,"查询",function(){menuDate=d.value;render();});btn(p,"新增菜单",function(){menuDate=d.value;menuForm(null);});
      readMenus(node(p,"div"));
    }else menuRows(p,data.week_menu,false);}
}
function canLeave(){return !editing||window.confirm("放弃未保存的编辑？");}
["tasks","posters","menus","displaySettings"].forEach(function(t){el(t).onclick=function(){if(!busy&&canLeave()){closeEditor();tab=t;render();}};});
var returnMatch=typeof location!=="undefined"&&location.hash?location.hash.match(/(?:^#|\/)return-(bus|tasks|posters|menus|auto)$/):null;
var returnMode=returnMatch?returnMatch[1]:"tasks";
el("returnLink").href=returnMode==="auto"?"/auto":"/display#"+returnMode;
el("busTab").href="/bus#return-"+returnMode;
el("returnLink").onclick=el("busTab").onclick=function(){return !busy&&canLeave();};
el("connect").onclick=function(){if(busy)return;token=el("token").value;el("token").value="";admin=el("mode").value==="admin";if(direct&&!token)token="local-direct";if(direct&&admin&&!openAdmin&&token==="local-direct"){note("请输入管理凭证。");return;}load();};
el("refresh").onclick=function(){if(!busy&&canLeave()){closeEditor();load();}};
el("logout").onclick=function(){if(canLeave())reset();};
if(window.addEventListener)window.addEventListener("pagehide",reset,false);
if(direct){el("logout").textContent=openAdmin?"重新连接":"管理登录 / 退出";el("mode").value=openAdmin?"admin":"read";el("connect").onclick();}
}());
