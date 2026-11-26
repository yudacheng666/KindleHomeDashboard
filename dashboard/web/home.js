/* Local household page. ES5, no remote assets, no browser persistence. */
(function(){
"use strict";
var access=window.KHD_ACCESS||{}, direct=access.direct===true, openAdmin=access.openAdmin===true;
var token="",admin=false,busy=false,epoch=0,tab=initialTab(),data=null,menus=[],menuDate="",editing=false,historyOpen=false,catalogCategory="",catalogQuery="",menusLoaded=false,stopQuick=null,resumeQuick=null,quickCanLeave=null;
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
function closeEditor(){
  if(stopQuick)stopQuick();stopQuick=null;resumeQuick=null;quickCanLeave=null;
  editing=false;clear(el("editor"));show("editor",false);el("content").className="panel";
}
function reset(){epoch++;busy=false;token="";admin=false;data=null;menus=[];menusLoaded=false;menuDate="";tab=initialTab();historyOpen=false;catalogCategory="";catalogQuery="";
  closeEditor();clear(el("content"));el("date").textContent="";el("token").value="";show("home",false);show("login",true);note("");}
function load(){
  req(admin?"manage":"view",null,function(ok,v){
    if(!ok){data=null;menus=[];menusLoaded=false;clear(el("content"));closeEditor();el("date").textContent="";return;}
    data=v;el("date").textContent=v.date;menuDate=menuDate||v.date;
    show("login",false);show("home",true);render();
  });
}
function mutate(path,body,onSaved){
  req(path,body,function(ok,v){if(ok){if(onSaved)onSaved();closeEditor();note("已保存。");load();}else{note((path==="menu/edit"||path==="menu/move"||path==="menu/plan"||path==="menu/snapshot/delete")&&v.error==="invalid_selection_or_request"?"未保存：目标餐次可能已有菜单，或原菜单/填写内容无效。请核对后重试。":"操作未确认成功；请刷新核对后再重试。");}});
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
function menuDisplayForm(){
  var s=data.menu_display||{mode:"week",days:7},p=editor("菜单展示范围");
  var mode=field(p,"展示方式",s.mode,"select",[["week","本自然周"],["rolling","今日起7天"],["custom","自定义天数"]]);
  var days=field(p,"自定义天数（1至31，含今日）",s.days,"number");
  function toggle(){days.disabled=mode.value!=="custom";}mode.onchange=toggle;toggle();
  node(p,"p","只影响看板展示，不限制排餐日期，也不删除范围外菜单。");
  actions(p,function(){mutate("menu/display",{mode:mode.value,days:mode.value==="custom"?Number(days.value):7});});
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
    if(selected&&!catalogQuery&&selected.name!=="其他"){
      btn(body,"编辑分类",function(){if(canLeave())categoryForm(selected);});
      btn(body,"删除分类",function(){if(canLeave())remove("category/delete",{key:selected.id},"分类（须先移走其中菜品）");});
    }
    var matches=c.dishes.filter(function(d){return catalogQuery?d.name.toLowerCase().indexOf(catalogQuery.toLowerCase())>=0:d.category===catalogCategory;});
    if(!matches.length)node(body,"p","暂无菜品");
    var organize=selected&&selected.name==="其他"&&!catalogQuery,checked=[];
    if(organize){
      node(body,"small","手动输入的新菜品自动归入其他；勾选后批量移动。");
      var targets=c.categories.filter(function(t){return t.id!==selected.id;}).map(function(t){return [t.id,t.name];});
      if(matches.length&&targets.length){
        var target=field(body,"移至分类",targets[0][0],"select",targets);
        btn(body,"移动所选菜品",function(){if(!canLeave())return;var keys=checked.filter(function(item){return item.control.checked;}).map(function(item){return item.key;});
          if(!keys.length){note("请先勾选菜品。");return;}
          mutate("dish/move-other",{keys:keys,category:target.value});
        });
      }
    }
    matches.forEach(function(d){var n=row(body);if(organize){var l=node(n,"label",undefined,"dish-check"),check=node(l,"input");check.type="checkbox";checked.push({control:check,key:d.id});node(l,"span",d.name);}else node(n,"p",d.name);if(catalogQuery){var cat=c.categories.filter(function(t){return t.id===d.category;})[0];if(cat)node(n,"small",cat.name);}
      btn(n,"编辑",function(){if(canLeave())dishForm(d);});
      btn(n,"删除",function(){if(canLeave())remove("dish/delete",{key:d.id},"菜品（不影响已安排菜单）");});
    });
  }
  search.oninput=function(){catalogQuery=search.value.trim();draw();};draw();
}
function uniqueLines(s){var out=[];lines(s).forEach(function(v){if(out.indexOf(v)<0)out.push(v);});return out;}
function dishPicker(p,dishes,onPick){
  var wrap=node(p,"div"),query="",selectedCategory="",search=field(wrap,"搜索菜品","","text",null,200);
  var tabs=node(wrap,"div"),choices=node(wrap,"div"),buttons=[];
  function sync(){
    var selected=uniqueLines(dishes.value);
    buttons.forEach(function(item){var active=selected.indexOf(item.name)>=0;
      item.button.className="dish-pick"+(active?" dish-selected":"");
      if(item.button.setAttribute)item.button.setAttribute("aria-pressed",active?"true":"false");
    });
  }
  function draw(){
    clear(tabs);clear(choices);buttons=[];
    var c=catalogData();
    if(!c.categories.some(function(t){return t.id===selectedCategory;}))selectedCategory=c.categories.length?c.categories[0].id:"";
    c.categories.forEach(function(t){btn(tabs,t.name,function(){selectedCategory=t.id;query="";search.value="";draw();}).className=t.id===selectedCategory?"primary":"";});
    var selected=uniqueLines(dishes.value),count=0;
    c.dishes.forEach(function(d){
      if(query?d.name.toLowerCase().indexOf(query.toLowerCase())<0:d.category!==selectedCategory)return;
      count++;
      var b=btn(choices,d.name,function(){
        var a=uniqueLines(dishes.value),i=a.indexOf(d.name);
        if(onPick){onPick(d.name,i<0);return;}
        if(i>=0)a.splice(i,1);else a.push(d.name);
        dishes.value=a.join("\n");sync();
      });buttons.push({name:d.name,button:b});
    });
    if(!count)node(choices,"small","暂无匹配菜品，可手动输入。");sync();
  }
  search.oninput=function(){query=search.value.trim();draw();};
  dishes.oninput=sync;
  node(wrap,"small","新手输菜品保存后自动归入其他分类。");
  draw();draw.sync=sync;return draw;
}
function validDate(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.slice(0,4)==="0000")return false;
  var d=new Date(value+"T00:00:00Z");return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===value;
}
function weekDates(anchor){
  if(!validDate(anchor))return [];
  var monday=new Date(anchor+"T00:00:00Z");
  monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
  var days=[];for(var i=0;i<7;i++){var d=new Date(monday.getTime()+i*86400000).toISOString().slice(0,10);if(validDate(d))days.push(d);}return days;
}
function quickMenu(){
  if(!menusLoaded){note("请先成功查询所在周的菜单，再快捷排餐。");return;}
  var days=weekDates(menuDate||data.date);if(!days.length)return;
  var p=editor("多人快捷排餐"),selectedDay=days.indexOf(menuDate)>=0?menuDate:days[0],selectedMeal="dinner";
  el("content").className="panel hidden";
  var active=true,ready=false,uncertain=false,pollTimer=null,pollXHR=null,pollTimeout=null,pollSeq=0,manualDrafts={},lastRender="",catalogRevision="";
  var period=node(p,"div",undefined,"week-nav");
  btn(period,"上一周",function(){shiftWeek(-7);});var range=node(period,"span","");btn(period,"下一周",function(){shiftWeek(7);});
  btn(p,"回到今日",function(){chooseDate(data.date);});
  var jump=field(p,"跳转日期",selectedDay,"date");jump.id="quickDate";jump.min="0001-01-01";jump.max="9999-12-31";
  btn(p,"跳转",function(){chooseDate(jump.value);});
  var dates=node(p,"div",undefined,"week-days"),meals=node(p,"div",undefined,"meal-pick");
  var status=node(p,"p","正在同步…","menu-editor-note");status.id="quickStatus";status.setAttribute&&status.setAttribute("role","status");
  var selected=node(p,"div",undefined,"shared-dishes"),manual=field(p,"手动添加菜品","","text",null,200);
  manual.id="quickManual";
  var chosen={value:""},picker=dishPicker(p,chosen,change);
  btn(p,"添加菜品",function(){var name=manual.value.trim();if(name)change(name,true,true);});
  function key(){return selectedDay+"/"+selectedMeal;}
  function current(){for(var i=0;i<menus.length;i++)if(menus[i].day===selectedDay&&menus[i].meal===selectedMeal)return menus[i];return null;}
  function say(s){if(status.textContent!==s)status.textContent=s;}
  function paint(force){
    var m=current(),dishes=m?m.dishes:[],k=JSON.stringify([key(),dishes,m?m.ingredients:[]]);
    if(!force&&k===lastRender)return;
    lastRender=k;chosen.value=dishes.join("\n");picker.sync();clear(selected);
    node(selected,"h3",selectedDay+" · "+mealNames[selectedMeal]+" · 已选 "+dishes.length+" 道");
    if(!dishes.length)node(selected,"p","尚未点菜");
    dishes.forEach(function(name){var n=node(selected,"div",undefined,"shared-dish");node(n,"span",name);btn(n,"取消",function(){change(name,false);});});
  }
  function chooseDate(value){
    if(busy||!validDate(value)){note("请选择有效日期。");return;}
    var next=weekDates(value),changed=next[0]!==days[0];
    manualDrafts[key()]=manual.value;selectedDay=value;manual.value=manualDrafts[key()]||"";
    if(changed){cancelPoll();ready=false;menus=[];days=next;say("正在同步所选周…");}
    drawNavigation();paint(true);if(changed)poll();
  }
  function shiftWeek(delta){
    var value=new Date(new Date(selectedDay+"T00:00:00Z").getTime()+delta*86400000).toISOString().slice(0,10);
    chooseDate(value);
  }
  function drawNavigation(){
    range.textContent=days[0]+" 至 "+days[days.length-1];jump.value=selectedDay;
    clear(dates);clear(meals);
    days.forEach(function(d,i){var cell=node(dates,"span"),label="周"+"一二三四五六日".charAt(i)+"\n"+d.slice(5)+(d===data.date?"\n今日":"");
      btn(cell,label,function(){chooseDate(d);}).className=d===selectedDay?"primary":"";});
    ["breakfast","lunch","dinner"].forEach(function(m){btn(meals,mealNames[m],function(){manualDrafts[key()]=manual.value;selectedMeal=m;manual.value=manualDrafts[key()]||"";drawNavigation();paint(true);}).className=m===selectedMeal?"primary":"";});
  }
  function cancelPoll(){
    pollSeq++;clearTimeout(pollTimer);pollTimer=null;clearTimeout(pollTimeout);pollTimeout=null;
    var x=pollXHR;pollXHR=null;if(x)try{x.abort();}catch(e){}
  }
  function schedule(){clearTimeout(pollTimer);pollTimer=null;if(active&&!document.hidden)pollTimer=setTimeout(poll,2000);}
  function poll(){
    if(!active||document.hidden)return;
    if(busy||pollXHR){schedule();return;}
    var x=new XMLHttpRequest(),seq=++pollSeq,g=epoch;pollXHR=x;
    function finish(ok,v){
      if(!active||seq!==pollSeq||g!==epoch)return;
      pollSeq++;clearTimeout(pollTimeout);pollTimeout=null;pollXHR=null;
      if(ok&&v&&v.result&&Array.isArray(v.result.menus)&&typeof v.result.catalog_revision==="string"){
        menus=v.result.menus;catalogRevision=v.result.catalog_revision;
        if(v.result.catalog){data.catalog=v.result.catalog;picker();}
        ready=true;paint(false);say(uncertain?"已重新同步，请核对上次未确认操作。":"已同步 · 点菜自动保存");
      }else{ready=false;say("连接异常 · 当前内容可能过时，恢复同步前不能点菜。");}
      schedule();
    }
    try{
      x.open("POST","/api/home/menu/sync",true);
      if(token&&token!=="local-direct")x.setRequestHeader("Authorization","Bearer "+token);
      x.setRequestHeader("Content-Type","application/json");
      x.onreadystatechange=function(){if(x.readyState!==4)return;var v=null;try{v=JSON.parse(x.responseText);}catch(e){}finish(x.status===200,v);};
      pollTimeout=setTimeout(function(){finish(false,null);try{x.abort();}catch(e){}},6000);
      x.send(JSON.stringify({first:days[0],last:days[days.length-1],catalog_revision:catalogRevision}));
    }catch(e){finish(false,null);}
  }
  function change(name,present,fromManual){
    if(!active||document.hidden||!ready){say("请等待重新同步后再操作。");return;}
    var m=current(),last=!present&&m&&m.dishes.filter(function(d){return d!==name;}).length===0;
    if(last&&!window.confirm("这是最后一道菜，确认取消并清除本餐及其食材记录？"))return;
    var on=selectedDay,meal=selectedMeal,b={on:on,meal:meal,name:name,present:present,confirm_empty:!!last,expected_ingredients:last?m.ingredients:null};
    cancelPoll();say("正在保存…");uncertain=false;
    req(fromManual?"menu/manual":"menu/dish",fromManual?{on:on,meal:meal,name:name}:b,function(ok,v){
      if(!active)return;
      var result=v&&v.result;
      if(ok&&(result===null||(result&&result.day===on&&result.meal===meal&&Array.isArray(result.dishes)&&Array.isArray(result.ingredients)))){
        menus=menus.filter(function(item){return item.day!==on||item.meal!==meal;});if(result)menus.push(result);
        if(fromManual&&manual.value.trim()===name)manual.value="";
        paint(false);say("已保存 · 正在同步");ready=true;
      }else{ready=false;uncertain=true;say("操作未确认，正在回读；不会自动重复提交。");}
      poll();
    });
  }
  stopQuick=function(){active=false;cancelPoll();};
  resumeQuick=function(){cancelPoll();ready=false;if(!document.hidden){say("正在同步…");poll();}};
  quickCanLeave=function(){
    manualDrafts[key()]=manual.value;
    return !Object.keys(manualDrafts).some(function(k){return manualDrafts[k].trim();})||window.confirm("还有未点击添加的菜名，确认离开？");
  };
  btn(p,"完成排餐",function(){if(!quickCanLeave())return;menuDate=selectedDay;closeEditor();load();}).className="primary";
  drawNavigation();paint(true);poll();
}
function menuForm(m){
  var p=editor(m?"编辑菜单":"新增菜单"),on=field(p,"日期",m?m.day:menuDate,"date");
  var meal=field(p,"餐次",m?m.meal:"dinner","select",[["breakfast","早餐"],["lunch","午餐"],["dinner","晚餐"]]);
  var dishes=field(p,"菜品（每行一个）",m?m.dishes.join("\n"):"","textarea");
  var ingredients=field(p,"食材（每行一个，数量写在文字中）",m?m.ingredients.join("\n"):"","textarea");
  dishPicker(p,dishes);
  if(m)node(p,"p","可以调整日期和餐次；不会覆盖其他菜单。");
  var feedback=node(p,"p","","menu-save-feedback");feedback.id="menuSaveStatus";
  if(feedback.setAttribute)feedback.setAttribute("role","status");
  var conflict=node(p,"div");
  function tell(message){feedback.textContent=message;note(message);}
  function draft(){
    return {on:on.value,meal:meal.value,dishes:uniqueLines(dishes.value),ingredients:lines(ingredients.value),expected:m?{dishes:m.dishes,ingredients:m.ingredients}:null};
  }
  function validate(b){
    if(!validDate(b.on)||!mealNames[b.meal]){tell("请选择有效日期和餐次。");return false;}
    if(!b.dishes.length){tell("请至少输入或选择一道菜。");return false;}
    if(b.dishes.length>30||b.ingredients.length>80||b.dishes.concat(b.ingredients).some(function(s){return s.length>200;})){
      tell("最多30道菜、80项食材，每项不超过200字。");return false;
    }
    return true;
  }
  function merge(a,b){var result=a.slice();b.forEach(function(s){if(result.indexOf(s)<0)result.push(s);});return result;}
  function inspect(b){
    tell("正在核对该餐次是否已有菜单…");
    req("menu/list",{first:b.on,last:b.on},function(ok,v){
      if(!ok||!Array.isArray(v.result)){tell("未确认保存结果，无法读取该餐次。输入已保留，请检查连接后重试。");return;}
      var existing=v.result.filter(function(item){return item.day===b.on&&item.meal===b.meal;})[0];
      if(!existing){tell("未保存：请核对填写内容后重试。输入已保留。");return;}
      tell("该日期及餐次已有菜单，未覆盖原内容。可追加新菜，或修改日期/餐次后保存。");
      node(conflict,"p","已有菜品："+existing.dishes.join("、"));
      btn(conflict,"追加到已有菜单",function(){
        var next=draft();
        if(next.on!==b.on||next.meal!==b.meal){clear(conflict);tell("日期或餐次已改变，请点击保存重新核对。");return;}
        if(!validate(next))return;
        next.expected={dishes:existing.dishes,ingredients:existing.ingredients};
        next.dishes=merge(existing.dishes,next.dishes);
        next.ingredients=merge(existing.ingredients,next.ingredients);
        if(validate(next))save(next);
      });
    });
  }
  function save(b){
    clear(conflict);tell("正在保存…");
    req(m?"menu/move":"menu/plan",b,function(ok,v){
      if(ok){menuDate=b.on;closeEditor();note("菜单已保存。");load();return;}
      if(v.error==="invalid_selection_or_request"){
        if(!m){inspect(b);return;}
        tell("未保存：原菜单已变化、目标餐次已有菜单或内容无效。输入已保留，请核对后重试。");
      }else if(v.error==="unauthorized"){tell("未保存：没有管理权限。输入已保留。");}
      else tell("保存结果未确认。输入已保留，请检查连接并核对菜单后重试。");
    });
  }
  actions(p,function(){
    clear(conflict);var b=draft();if(!validate(b))return;
    if(m){b.old_on=m.day;b.old_meal=m.meal;}
    save(b);
  });
}
function row(parent){return node(parent,"div",undefined,"item");}
function tasks(p,arr,manage){
  if(!arr.length)node(p,"p","暂无待办");
  if(!manage){
    var groups={};
    arr.forEach(function(t){var day=t.occurrence||data.date;(groups[day]||(groups[day]=[])).push(t);});
    var overdue=false;
    Object.keys(groups).sort().forEach(function(day){
      if(day<data.date&&!overdue){node(p,"h3","逾期");overdue=true;}
      var group=node(p,"section",undefined,"menu-day"),heading=node(group,"h3",day,"menu-date");
      if(day===data.date)node(heading,"span","今日","menu-today");
      groups[day].forEach(function(t){node(group,"p",t.title);});
    });
    return;
  }
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
      if(manage){node(n,"small","食材："+m.ingredients.join("、"));btn(n,"编辑",function(){menuForm(m);});btn(n,"删除",function(){remove("menu/snapshot/delete",{on:m.day,meal:m.meal,expected:{dishes:m.dishes,ingredients:m.ingredients}},"该餐次菜单");});}
    });
  });
}
function readMenus(p){
  menusLoaded=false;menus=[];
  var days=weekDates(menuDate);
  if(!days.length){node(p,"p","请选择有效日期");return;}
  req("menu/list",{first:days[0],last:days[days.length-1]},function(ok,v){if(ok&&Array.isArray(v.result)){menus=v.result;menusLoaded=true;menuRows(p,menus,true);}else{menus=[];node(p,"p","菜单读取失败");}});
}
function render(){
  var p=el("content");clear(p);if(!data)return;
  ["tasks","posters","menus","catalog","displaySettings"].forEach(function(t){el(t).className=t===tab?"primary":"";});
  if(tab==="displaySettings"){node(p,"h2","显示设置");var s=data.display_settings||{};node(p,"p","海报轮播："+(s.autoplay?"开启":"关闭")+" · 每页 "+(s.seconds||180)/60+" 分钟");if(admin){btn(p,"保存轮播设置",displayForm);btn(p,"菜单展示范围",menuDisplayForm);}}
  else if(tab==="tasks"){node(p,"h2","待办清单");
    if(admin){
      btn(p,"未完成",function(){if(canLeave()){closeEditor();historyOpen=false;render();}}).className=historyOpen?"":"primary";
      btn(p,"历史待办",function(){if(canLeave()){closeEditor();historyOpen=true;render();}}).className=historyOpen?"primary":"";
      if(historyOpen){history(p,data.history||[]);return;}
      btn(p,"新增待办",function(){taskForm(null);});
      node(p,"small","周期任务在本期完成后仍保留管理入口，下个周期自动出现。");
    }
    tasks(p,admin?data.tasks.filter(function(t){return t.repeat!=="once"||!t.completed;}):(Array.isArray(data.upcoming_tasks)?data.upcoming_tasks:data.tasks),admin);
  }
  else if(tab==="posters"){node(p,"h2","海报");if(admin){btn(p,"新增海报",function(){posterForm(null);});btn(p,"保存轮播设置",displayForm);}posters(p,data.posters,admin);}
  else if(tab==="catalog"){catalogPage(p);}
  else if(tab==="menus"){var s=data.menu_display||{mode:"week",days:7};node(p,"h2",admin||s.mode==="week"?"本周菜单":"未来"+s.days+"天菜单");if(admin){
      var d=field(p,"查询所在周",menuDate,"date");btn(p,"查询",function(){if(canLeave()){closeEditor();menuDate=d.value;render();}});btn(p,"快捷排餐",function(){if(canLeave())quickMenu();});btn(p,"新增菜单",function(){if(canLeave()){menuDate=d.value;menuForm(null);}});
      readMenus(node(p,"div"));
    }else menuRows(p,data.week_menu,false);}
}
function canLeave(){return !editing||(quickCanLeave?quickCanLeave():window.confirm("放弃未保存的编辑？"));}
["tasks","posters","menus","catalog","displaySettings"].forEach(function(t){el(t).onclick=function(){if(!busy&&canLeave()){closeEditor();tab=t;if(t==="catalog"&&admin)load();else render();}};});
var returnMatch=typeof location!=="undefined"&&location.hash?location.hash.match(/(?:^#|\/)return-(bus|tasks|posters|menus|weather|driving|auto)$/):null;
var returnMode=returnMatch?returnMatch[1]:"tasks";
el("returnLink").href=returnMode==="auto"?"/auto":"/display#"+returnMode;
el("busTab").href="/bus#return-"+returnMode;
el("returnLink").onclick=el("busTab").onclick=function(){return !busy&&canLeave();};
el("connect").onclick=function(){if(busy)return;token=el("token").value;el("token").value="";admin=el("mode").value==="admin";if(direct&&!token)token="local-direct";if(direct&&admin&&!openAdmin&&token==="local-direct"){note("请输入管理凭证。");return;}load();};
el("refresh").onclick=function(){if(!busy&&canLeave()){closeEditor();load();}};
el("logout").onclick=function(){if(!busy&&canLeave())reset();};
if(window.addEventListener)window.addEventListener("pagehide",reset,false);
if(document.addEventListener)document.addEventListener("visibilitychange",function(){if(resumeQuick)resumeQuick();},false);
if(direct){el("logout").textContent=openAdmin?"重新连接":"管理登录 / 退出";el("mode").value=openAdmin?"admin":"read";el("connect").onclick();}
}());
