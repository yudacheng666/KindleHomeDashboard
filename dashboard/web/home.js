/* Local household page. ES5, no remote assets, no browser persistence. */
(function(){
"use strict";
var access=window.KHD_ACCESS||{}, direct=access.direct===true, openAdmin=access.openAdmin===true;
var token="",admin=false,busy=false,epoch=0,tab=initialTab(),data=null,menus=[],menuDate="",editing=false,historyOpen=false,catalogCategory="",catalogQuery="";
function initialTab(){var h=typeof location!=="undefined"?(location.hash||"").split("/")[0]:"";return h==="#posters"?"posters":h==="#menus"?"menus":h==="#catalog"?"catalog":h==="#display"?"displaySettings":"tasks";}
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
function reset(){epoch++;busy=false;token="";admin=false;data=null;menus=[];menuDate="";tab=initialTab();historyOpen=false;catalogCategory="";catalogQuery="";
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
function catalogData(){return data.catalog||{categories:[],dishes:[]};}
function categoryOptions(){return catalogData().categories.map(function(c){return [c.id,c.name];});}
function categoryForm(c){
  var p=editor(c?"编辑分类":"新增分类"),name=field(p,"分类名称",c?c.name:"","text",null,60);
  actions(p,function(){var b={name:name.value};if(c)b.key=c.id;mutate(c?"category/edit":"category/add",b);});
}
function dishForm(d){
  var p=editor(d?"编辑菜品":"新增菜品"),name=field(p,"菜名",d?d.name:"","text",null,200);
  var category=field(p,"分类",d?d.category:catalogCategory||((categoryOptions()[0]||[])[0]),"select",categoryOptions());
  actions(p,function(){var b={name:name.value,category:category.value};if(d)b.key=d.id;mutate(d?"dish/edit":"dish/add",b);});
}
function catalogPage(p){
  node(p,"h2","家庭菜单维护");
  if(!admin){node(p,"p","请使用管理权限维护家庭菜单。");return;}
  var c=catalogData(),tools=node(p,"div",undefined,"catalog-tools");
  btn(tools,"新增分类",function(){if(canLeave())categoryForm(null);});
  if(c.categories.length)btn(tools,"新增菜品",function(){if(canLeave())dishForm(null);});
  var search=field(p,"搜索菜品",catalogQuery,"text",null,200);
  var layout=node(p,"div",undefined,"catalog-layout"),nav=node(layout,"div",undefined,"catalog-nav"),body=node(layout,"div",undefined,"catalog-body");
  if(!c.categories.some(function(t){return t.id===catalogCategory;}))catalogCategory=c.categories.length?c.categories[0].id:"";
  function draw(){
    clear(nav);clear(body);
    c.categories.forEach(function(t){
      btn(nav,t.name,function(){if(!canLeave())return;closeEditor();catalogCategory=t.id;catalogQuery="";search.value="";draw();}).className=t.id===catalogCategory?"primary":"";
    });
    var selected=c.categories.filter(function(t){return t.id===catalogCategory;})[0];
    if(selected&&!catalogQuery){
      btn(body,"编辑分类",function(){if(canLeave())categoryForm(selected);});
      btn(body,"删除分类",function(){if(canLeave())remove("category/delete",{key:selected.id},"分类（须先移走其中菜品）");});
    }
    var matches=c.dishes.filter(function(d){return catalogQuery?d.name.toLowerCase().indexOf(catalogQuery.toLowerCase())>=0:d.category===catalogCategory;});
    if(!matches.length)node(body,"p","暂无菜品");
    matches.forEach(function(d){var n=row(body);node(n,"p",d.name);if(catalogQuery){var cat=c.categories.filter(function(t){return t.id===d.category;})[0];if(cat)node(n,"small",cat.name);}
      btn(n,"编辑",function(){if(canLeave())dishForm(d);});
      btn(n,"删除",function(){if(canLeave())remove("dish/delete",{key:d.id},"菜品（不影响已安排菜单）");});
    });
  }
  search.oninput=function(){catalogQuery=search.value.trim();draw();};draw();
}
function uniqueLines(s){var out=[];lines(s).forEach(function(v){if(out.indexOf(v)<0)out.push(v);});return out;}
function dishPicker(p,dishes){
  var wrap=node(p,"div"),query="",selectedCategory="",search=field(wrap,"搜索菜品","","text",null,200);
  var tabs=node(wrap,"div"),choices=node(wrap,"div");
  function draw(){
    clear(tabs);clear(choices);
    var c=catalogData();
    if(!c.categories.some(function(t){return t.id===selectedCategory;}))selectedCategory=c.categories.length?c.categories[0].id:"";
    c.categories.forEach(function(t){btn(tabs,t.name,function(){selectedCategory=t.id;query="";search.value="";draw();}).className=t.id===selectedCategory?"primary":"";});
    var selected=uniqueLines(dishes.value),count=0;
    c.dishes.forEach(function(d){
      if(query?d.name.toLowerCase().indexOf(query.toLowerCase())<0:d.category!==selectedCategory)return;
      count++;var active=selected.indexOf(d.name)>=0;
      var b=btn(choices,d.name,function(){
        var a=uniqueLines(dishes.value),i=a.indexOf(d.name);
        if(i>=0)a.splice(i,1);else a.push(d.name);
        dishes.value=a.join("\n");draw();
      });b.className="dish-pick"+(active?" dish-selected":"");b.setAttribute&&b.setAttribute("aria-pressed",active?"true":"false");
    });
    if(!count)node(choices,"small","暂无匹配菜品，可手动输入。");
  }
  search.oninput=function(){query=search.value.trim();draw();};
  dishes.oninput=draw;
  btn(wrap,"将手输菜品加入菜品库",function(){
    var c=catalogData(),names=uniqueLines(dishes.value).filter(function(n){return !c.dishes.some(function(d){return d.name===n;});});
    if(!names.length){note("没有未入库的菜品。");return;}
    if(!selectedCategory){note("请先在家庭菜单维护中新增分类。");return;}
    var category=c.categories.filter(function(t){return t.id===selectedCategory;})[0];
    if(!window.confirm("将 "+names.length+" 道未入库菜品加入「"+category.name+"」？"))return;
    req("dish/import",{names:names,category:selectedCategory},function(ok,v){if(ok&&v.result){data.catalog=v.result;note("菜品已入库，本餐菜单仍需保存。");draw();}});
  });
  draw();return draw;
}
function weekDates(anchor){
  var monday=new Date(anchor+"T00:00:00Z");if(isNaN(monday.getTime()))return [];
  monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
  var days=[];for(var i=0;i<7;i++)days.push(new Date(monday.getTime()+i*86400000).toISOString().slice(0,10));return days;
}
function quickMenu(){
  var p=editor("快捷排餐"),days=weekDates(menuDate||data.date),selectedDay=days.indexOf(menuDate)>=0?menuDate:days[0],selectedMeal="dinner",drafts={},original={};
  menus.forEach(function(m){original[m.day+"/"+m.meal]={dishes:m.dishes.join("\n"),ingredients:m.ingredients.join("\n")};});
  var dates=node(p,"div",undefined,"week-days"),meals=node(p,"div",undefined,"meal-pick");
  var dishes=field(p,"菜品（可点选或每行手动输入一个）","","textarea"),ingredients=field(p,"食材（可选，保留旧数据）","","textarea");
  var picker=dishPicker(p,dishes),message=node(p,"p","","menu-editor-note");
  function key(){return selectedDay+"/"+selectedMeal;}
  function stored(k){return original[k]||{dishes:"",ingredients:""};}
  function capture(){var k=key(),base=stored(k),value={dishes:dishes.value,ingredients:ingredients.value};
    if(value.dishes===base.dishes&&value.ingredients===base.ingredients)delete drafts[k];else drafts[k]=value;}
  function draw(){
    clear(dates);clear(meals);
    days.forEach(function(d,i){var cell=node(dates,"span"),label="周"+"一二三四五六日".charAt(i)+"\n"+d.slice(5)+(d===data.date?"\n今日":"");
      btn(cell,label,function(){capture();selectedDay=d;draw();}).className=d===selectedDay?"primary":"";});
    ["breakfast","lunch","dinner"].forEach(function(m){btn(meals,mealNames[m],function(){capture();selectedMeal=m;draw();}).className=m===selectedMeal?"primary":"";});
    var v=drafts[key()]||stored(key());dishes.value=v.dishes;ingredients.value=v.ingredients;
    message.textContent=selectedDay+" · "+mealNames[selectedMeal]+(original[key()]?" · 已有菜单":"")+"；切换日期和餐次会保留本页草稿。";picker();
  }
  btn(p,"保存本餐菜单",function(){
    capture();var k=key(),b={on:selectedDay,meal:selectedMeal,dishes:uniqueLines(dishes.value),ingredients:lines(ingredients.value)};
    if(!b.dishes.length){note("请至少选择或输入一道菜；删除整餐请使用菜单列表。");return;}
    if(original[k]){b.old_on=selectedDay;b.old_meal=selectedMeal;}
    req(original[k]?"menu/edit":"menu/set",b,function(ok){
      if(!ok){note("本餐保存未确认，请核对后重试；草稿仍保留。");return;}
      original[k]={dishes:b.dishes.join("\n"),ingredients:b.ingredients.join("\n")};delete drafts[k];
      menus=menus.filter(function(m){return m.day!==b.on||m.meal!==b.meal;});menus.push({day:b.on,meal:b.meal,dishes:b.dishes,ingredients:b.ingredients});
      note("本餐已保存。");draw();
    });
  }).className="primary";
  btn(p,"完成排餐",function(){capture();if(Object.keys(drafts).length&&!window.confirm("还有 "+Object.keys(drafts).length+" 餐未保存，确认放弃这些草稿？"))return;closeEditor();render();});
  draw();
}
function menuForm(m){
  var p=editor(m?"编辑菜单":"新增菜单"),on=field(p,"日期",m?m.day:menuDate,"date");
  var meal=field(p,"餐次",m?m.meal:"dinner","select",[["breakfast","早餐"],["lunch","午餐"],["dinner","晚餐"]]);
  var dishes=field(p,"菜品（每行一个）",m?m.dishes.join("\n"):"","textarea");
  var ingredients=field(p,"食材（每行一个，数量写在文字中）",m?m.ingredients.join("\n"):"","textarea");
  dishPicker(p,dishes);
  if(m)node(p,"p","可以调整日期和餐次；不会覆盖其他菜单。");
  actions(p,function(){
    if(!m&&!window.confirm("保存此日期及餐次的菜单？若已有菜单，将替换该餐次。"))return;
    var b={on:on.value,meal:meal.value,dishes:uniqueLines(dishes.value),ingredients:lines(ingredients.value)};
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
  var days={},order={breakfast:0,lunch:1,dinner:2};
  arr.forEach(function(m){(days[m.day]||(days[m.day]=[])).push(m);});
  Object.keys(days).sort().forEach(function(day){
    var group=node(p,"section",undefined,"menu-day"),heading=node(group,"h3",day,"menu-date");
    if(day===data.date)node(heading,"span","今日","menu-today");
    days[day].sort(function(a,b){return order[a.meal]-order[b.meal];}).forEach(function(m){
      var n=row(group);node(n,"strong",mealNames[m.meal]);node(n,"p",m.dishes.join("、"));
      if(manage){node(n,"small","食材："+m.ingredients.join("、"));btn(n,"编辑",function(){menuForm(m);});btn(n,"删除",function(){remove("menu/delete",{on:m.day,meal:m.meal},"该餐次菜单");});}
    });
  });
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
  ["tasks","posters","menus","catalog","displaySettings"].forEach(function(t){el(t).className=t===tab?"primary":"";});
  if(tab==="displaySettings"){node(p,"h2","显示设置");var s=data.display_settings||{};node(p,"p","海报轮播："+(s.autoplay?"开启":"关闭")+" · 每页 "+(s.seconds||180)/60+" 分钟");if(admin)btn(p,"保存轮播设置",displayForm);}
  else if(tab==="tasks"){node(p,"h2","待办清单");
    if(admin){
      btn(p,"未完成",function(){if(canLeave()){closeEditor();historyOpen=false;render();}}).className=historyOpen?"":"primary";
      btn(p,"历史待办",function(){if(canLeave()){closeEditor();historyOpen=true;render();}}).className=historyOpen?"primary":"";
      if(historyOpen){history(p,data.history||[]);return;}
      btn(p,"新增待办",function(){taskForm(null);});
      node(p,"small","周期任务在本期完成后仍保留管理入口，下个周期自动出现。");
    }
    tasks(p,admin?data.tasks.filter(function(t){return t.repeat!=="once"||!t.completed;}):data.tasks,admin);
  }
  else if(tab==="posters"){node(p,"h2","海报");if(admin){btn(p,"新增海报",function(){posterForm(null);});btn(p,"保存轮播设置",displayForm);}posters(p,data.posters,admin);}
  else if(tab==="catalog"){catalogPage(p);}
  else if(tab==="menus"){node(p,"h2","本周菜单");if(admin){
      var d=field(p,"查询所在周",menuDate,"date");btn(p,"查询",function(){if(canLeave()){closeEditor();menuDate=d.value;render();}});btn(p,"快捷排餐",function(){if(canLeave())quickMenu();});btn(p,"新增菜单",function(){if(canLeave()){menuDate=d.value;menuForm(null);}});
      readMenus(node(p,"div"));
    }else menuRows(p,data.week_menu,false);}
}
function canLeave(){return !editing||window.confirm("放弃未保存的编辑？");}
["tasks","posters","menus","catalog","displaySettings"].forEach(function(t){el(t).onclick=function(){if(!busy&&canLeave()){closeEditor();tab=t;render();}};});
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
