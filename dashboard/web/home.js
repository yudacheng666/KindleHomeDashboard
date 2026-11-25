/* Local household page. ES5, no remote assets, no browser persistence. */
(function(){
"use strict";
var access=window.KHD_ACCESS||{}, direct=access.direct===true, openAdmin=access.openAdmin===true;
var token="",admin=false,busy=false,epoch=0,tab="today",data=null,menus=[],menuDate="",editing=false;
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
function reset(){epoch++;busy=false;token="";admin=false;data=null;menus=[];menuDate="";tab="today";
  closeEditor();clear(el("content"));el("date").textContent="";el("token").value="";show("home",false);show("login",true);note("");}
function load(){
  req(admin?"manage":"view",null,function(ok,v){
    if(!ok){data=null;menus=[];clear(el("content"));closeEditor();el("date").textContent="";return;}
    data=v;el("date").textContent=v.date;menuDate=menuDate||v.date;
    show("login",false);show("home",true);render();
  });
}
function mutate(path,body){
  req(path,body,function(ok,v){if(ok){closeEditor();note("已保存。");load();}else{note("操作未确认成功；请刷新核对后再重试。");}});
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
  var week=field(p,"本周菜单加入轮播",String(s.include_week),"select",yesNo);
  var shopping=field(p,"购物清单加入轮播",String(s.include_shopping),"select",yesNo);
  var auto=field(p,"连接展示页时自动开始轮播",String(s.autoplay),"select",yesNo);
  node(p,"p","保存在 NAS；展示页的临时调整不覆盖这里的默认设置。");
  actions(p,function(){mutate("display/set",{seconds:Number(interval.value),include_week:week.value==="true",include_shopping:shopping.value==="true",autoplay:auto.value==="true"});});
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
  if(m){on.disabled=true;meal.disabled=true;}
  actions(p,function(){
    if(!m&&!window.confirm("保存此日期及餐次的菜单？若已有菜单，将替换该餐次。"))return;
    menuDate=on.value;mutate("menu/set",{on:on.value,meal:meal.value,dishes:lines(dishes.value),ingredients:lines(ingredients.value)});
  });
}
function shopForm(s){
  var p=editor(s?"编辑采购项":"新增采购项"),label=field(p,"名称及数量",s?s.label:"","text",null,200);
  actions(p,function(){var b={label:label.value};if(s)b.key=s.id;mutate(s?"shopping/edit":"shopping/add",b);});
}
function importForm(){
  var p=editor("导入菜单食材"),first=field(p,"开始日期",data.date,"date"),last=field(p,"结束日期（最多七天）",data.date,"date");
  actions(p,function(){if(window.confirm("确认把所选日期的菜单食材加入购物清单？"))mutate("shopping/import",{first:first.value,last:last.value});});
}
function row(parent){return node(parent,"div",undefined,"item");}
function tasks(p,arr,manage){
  if(!arr.length)node(p,"p","暂无待办");
  arr.forEach(function(t){var n=row(p);node(n,"p",t.title);if(manage){
    node(n,"small",t.start+" · "+({once:"单次",daily:"每日",weekly:"每周"}[t.repeat])+(t.occurrence?(t.completed?" · 已完成":" · 待完成"):" · 非发生日"));
    if(t.occurrence)btn(n,t.completed?"撤销完成":"完成",function(){mutate("task/complete",{key:t.id,on:data.date,completed:!t.completed});});
    btn(n,"编辑",function(){taskForm(t);});btn(n,"删除",function(){remove("task/delete",{key:t.id},"待办及其完成记录");});
  }});
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
function shopping(p,arr,manage){
  if(!arr.length)node(p,"p","暂无采购项");
  arr.forEach(function(s){var n=row(p);node(n,"p",(s.completed?"☑ ":"□ ")+s.label);
    if(manage){node(n,"small",s.source==="manual"?"手动添加":"菜单食材");btn(n,s.completed?"撤销采购":"已采购",function(){mutate("shopping/complete",{key:s.id,completed:!Boolean(s.completed)});});btn(n,"编辑",function(){shopForm(s);});btn(n,"删除",function(){remove("shopping/delete",{key:s.id},"采购项");});}});
}
function readMenus(p){
  req("menu/list",{first:menuDate,last:menuDate},function(ok,v){if(ok){menus=v.result;menuRows(p,menus,true);}else{menus=[];node(p,"p","菜单读取失败");}});
}
function render(){
  var p=el("content");clear(p);if(!data)return;
  if(tab==="today"){
    node(p,"h2","今日生活");
    if(admin)btn(p,"保存轮播设置",displayForm);
    if(admin){var box=node(p,"div");req("view",null,function(ok,v){if(ok){node(box,"h3","待办");tasks(box,v.tasks,false);node(box,"h3","提醒");posters(box,v.posters,false);node(box,"h3","今日菜单");menuRows(box,v.today_menu,false);}else node(box,"p","今日信息读取失败");});}
    else{node(p,"h3","待办");tasks(p,data.tasks,false);node(p,"h3","提醒");posters(p,data.posters,false);node(p,"h3","今日菜单");menuRows(p,data.today_menu,false);}
  }else if(tab==="tasks"){node(p,"h2","待办");if(admin)btn(p,"新增待办",function(){taskForm(null);});tasks(p,data.tasks,admin);}
  else if(tab==="posters"){node(p,"h2","提醒海报");if(admin)btn(p,"新增海报",function(){posterForm(null);});posters(p,data.posters,admin);}
  else if(tab==="menus"){node(p,"h2",admin?"菜单管理":"本周菜单");if(admin){
      var d=field(p,"查询日期",menuDate,"date");btn(p,"查询",function(){menuDate=d.value;render();});btn(p,"新增菜单",function(){menuDate=d.value;menuForm(null);});
      readMenus(node(p,"div"));
    }else menuRows(p,data.week_menu,false);}
  else{node(p,"h2","购物清单");if(admin){btn(p,"新增采购项",function(){shopForm(null);});btn(p,"导入菜单食材",importForm);}shopping(p,data.shopping,admin);}
}
function canLeave(){return !editing||window.confirm("放弃未保存的编辑？");}
["today","tasks","posters","menus","shopping"].forEach(function(t){el(t).onclick=function(){if(!busy&&canLeave()){closeEditor();tab=t;render();}};});
el("connect").onclick=function(){if(busy)return;token=el("token").value;el("token").value="";admin=el("mode").value==="admin";if(direct&&!token)token="local-direct";if(direct&&admin&&!openAdmin&&token==="local-direct"){note("请输入管理凭证。");return;}load();};
el("refresh").onclick=function(){if(!busy&&canLeave()){closeEditor();load();}};
el("logout").onclick=function(){if(canLeave())reset();};
if(window.addEventListener)window.addEventListener("pagehide",reset,false);
if(direct){el("logout").textContent=openAdmin?"重新连接":"管理登录 / 退出";el("mode").value=openAdmin?"admin":"read";el("connect").onclick();}
}());
