/* Read-only display preview. ES5/XHR; no persistence or external requests. */
(function(){
"use strict";
var token="", epoch=0, busy=false, data=null, pages=[], cursor=0, running=false;
var seconds=180, includeWeek=false, includeShopping=false, editing=false;
var refreshTimer=null, rotationTimer=null, lastRender="";
function el(id){return document.getElementById(id);}
function txt(id,s){var n=el(id);if(n.textContent!==s)n.textContent=s;}
function show(id,yes){el(id).className=yes?"":"hidden";}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);}
function append(root,tag,text,cls){var n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;root.appendChild(n);}
function makePages(v){
  var p=[], summaries=[];
  if(v.tasks.length) summaries.push("待办 · "+v.tasks.length+"件");
  if(v.posters.length) summaries.push("提醒 · "+v.posters.length+"张");
  if(v.today_menu.length) summaries.push("今日菜单 · "+v.today_menu.length+"餐");
  p.push({id:"today",title:"今日生活",lines:summaries.length?summaries:["暂无家庭安排"],note:""});
  if(v.tasks.length)p.push({id:"tasks",title:"今日待办",lines:v.tasks.map(function(t){return "□ "+t.title;}),note:""});
  v.posters.forEach(function(t){p.push({id:"poster:"+t.id,title:t.title,lines:[t.body],note:t.note||"",poster:true});});
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
    var root=el("body");clear(root);p.lines.forEach(function(line){append(root,"p",line,p.poster?"poster":"");});
    if(p.note)append(root,"p",p.note,"note");
    txt("index",(cursor+1)+" / "+pages.length);
  }
  txt("pause",running?"暂停轮播":"开始轮播");
}
function stopRotation(){clearTimeout(rotationTimer);rotationTimer=null;}
function scheduleRotation(){
  stopRotation();if(!running||editing||!data||pages.filter(eligible).length<2)return;
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
  var old=pages[cursor], next=makePages(v), found=-1;
  for(var i=0;old&&i<next.length;i++)if(next[i].id===old.id)found=i;
  data=v;pages=next;cursor=found<0?0:found;
  show("login",false);show("display",true);txt("status","");
  render();
  if(rotationTimer===null)scheduleRotation();
}
function hide(reason){
  data=null;pages=[];cursor=0;lastRender="";stopRotation();
  txt("date","");txt("heading","");clear(el("body"));txt("index","");txt("status",reason);
}
function refresh(){
  if(!token||busy)return;
  busy=true;var g=epoch,x=new XMLHttpRequest(),ended=false,timeout;
  function finish(ok,v,status){
    if(ended)return;ended=true;clearTimeout(timeout);if(g!==epoch)return;busy=false;
    if(ok){accept(v);}
    else{hide(status===401?"令牌无效，请重新连接。":status===404?"家庭模块未启用。":"连接异常，家庭内容已隐藏。");
      if(status===401){reset();txt("status","令牌无效，请重新连接。");return;}}
    clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,30000);
  }
  try{x.open("GET","/api/home/view",true);x.setRequestHeader("Authorization","Bearer "+token);
    x.onreadystatechange=function(){if(x.readyState!==4)return;var v=null;try{v=JSON.parse(x.responseText);}catch(e){}
      finish(x.status===200&&v&&Array.isArray(v.tasks)&&Array.isArray(v.posters)&&Array.isArray(v.today_menu)&&Array.isArray(v.week_menu)&&Array.isArray(v.shopping),v,x.status);};
    timeout=setTimeout(function(){finish(false,null,0);try{x.abort();}catch(e){}},12000);x.send(null);
  }catch(e){finish(false,null,0);}
}
function reset(){
  epoch++;busy=false;token="";running=false;editing=false;seconds=180;includeWeek=false;includeShopping=false;
  clearTimeout(refreshTimer);refreshTimer=null;hide("");el("token").value="";
  show("options",false);show("display",false);show("login",true);
}
el("connect").onclick=function(){if(busy)return;token=el("token").value;el("token").value="";if(token)refresh();};
el("previous").onclick=function(){if(editing)return;running=false;stopRotation();advance(-1,false);};
el("next").onclick=function(){if(editing)return;running=false;stopRotation();advance(1,false);};
el("pause").onclick=function(){if(!data||editing)return;running=!running;render();scheduleRotation();};
el("settings").onclick=function(){if(editing)return;editing=true;stopRotation();el("seconds").value=String(seconds);el("week").checked=includeWeek;el("shopping").checked=includeShopping;show("options",true);};
function closeSettings(){editing=false;show("options",false);scheduleRotation();}
el("apply").onclick=function(){var n=Number(el("seconds").value);if([120,180,300].indexOf(n)<0)return;seconds=n;includeWeek=el("week").checked;includeShopping=el("shopping").checked;closeSettings();};
el("cancel").onclick=closeSettings;
el("logout").onclick=reset;
if(window.addEventListener)window.addEventListener("pagehide",reset,false);
if(document.addEventListener)document.addEventListener("visibilitychange",function(){
  if(document.hidden){stopRotation();clearTimeout(refreshTimer);refreshTimer=null;}
  else if(token){hide("正在重新读取");refresh();}
},false);
}());
