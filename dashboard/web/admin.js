/* Desktop shell. Existing management code owns all editing and access rules. */
(function(){
"use strict";
var path=location.pathname,pages=[
["/admin","首页","总览","查看配置入口与本地连接状态。","home"],
["/admin/display","显示设置","显示设置","管理看板显示设置，预览各展示页面。","screen"],
["/admin/bus","公交设置","公交设置","选择线路、方向、乘车站点和采集时段。","bus"],
["/admin/weather","天气设置","天气设置","管理最多三个天气地点及采集配置。","weather"],
["/admin/driving","驾驶设置","驾驶设置","分别编辑最多三个目的地、起终点及采集时段。","car"],
["/admin/family","家庭管理","家庭管理","维护待办、每周菜单、菜品库及提醒海报。","family"],
["/admin/system","系统设置","系统信息","查看软件版本、访问方式及部署说明。","settings"]];
var current=pages.filter(function(p){return p[0]===path;})[0];if(!current)return;
var access=window.KHD_ACCESS||{};
function el(id){return document.getElementById(id);}
function make(root,tag,text,cls){var n=document.createElement(tag);if(text!==null&&text!==undefined)n.textContent=text;if(cls)n.className=cls;root.appendChild(n);return n;}
function icon(root,name){
 var ns="http://www.w3.org/2000/svg",s=document.createElementNS(ns,"svg"),p=document.createElementNS(ns,"path");
 var shapes={home:"M3 10 12 3l9 7v11H15v-7H9v7H3z",screen:"M3 4h18v13H3z M8 21h8 M12 17v4",bus:"M5 18V6q0-3 7-3t7 3v12H5z M5 11h14 M7 18v3 M17 18v3 M8 15h1 M15 15h1",weather:"M7 19h11a4 4 0 0 0 0-8 6 6 0 0 0-11-2 5 5 0 0 0 0 10z M12 2v3 M3 4l2 2 M21 4l-2 2",car:"M3 16v-4l3-6h12l3 6v4z M3 16v3h3 M21 16v3h-3 M5 12h14 M7 15h1 M16 15h1",family:"M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M5 21v-3a7 7 0 0 1 14 0v3z",settings:"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M10 2h4l1 3 3 1 3-1 2 4-3 2v3l3 2-2 4-3-1-3 1-1 2h-4l-1-2-3-1-3 1-2-4 3-2v-3L1 9l2-4 3 1 3-1z",book:"M3 4h5q4 0 4 3 0-3 4-3h5v16h-5q-4 0-4 2 0-2-4-2H3z M12 7v15"};
 s.setAttribute("viewBox","0 0 24 24");s.setAttribute("class","admin-icon");s.setAttribute("aria-hidden","true");s.setAttribute("fill","none");s.setAttribute("stroke","currentColor");s.setAttribute("stroke-width","1.7");s.setAttribute("stroke-linecap","round");s.setAttribute("stroke-linejoin","round");p.setAttribute("d",shapes[name]||shapes.screen);s.appendChild(p);root.appendChild(s);
}
function link(root,label,url,cls){var a=make(root,"a",label,cls);a.href=url;a.onclick=function(){return !window.KHD_ADMIN_CAN_LEAVE||window.KHD_ADMIN_CAN_LEAVE();};return a;}
function button(root,label,fn,cls){var b=make(root,"button",label,cls);b.type="button";b.onclick=fn;return b;}
function move(root,ids){ids.forEach(function(id){var n=el(id);if(n)root.appendChild(n);});}
var children=Array.prototype.slice.call(document.body.children).filter(function(n){return n.tagName!=="SCRIPT";});
document.body.className="desktop-admin admin-"+(path.split("/")[2]||"index");
var shell=make(document.body,"div",null,"admin-shell"),side=make(shell,"aside",null,"admin-sidebar"),brand=make(side,"div",null,"admin-brand"),logo=make(brand,"span",null,"admin-logo");icon(logo,"book");
var brandText=make(brand,"div");make(brandText,"strong","KindleHomeDashboard");make(brandText,"small","家庭信息终端");
var nav=make(side,"nav",null,"admin-nav");nav.setAttribute("aria-label","管理模块");
pages.forEach(function(p){var a=link(nav,null,p[0]);if(p===current)a.setAttribute("aria-current","page");icon(a,p[4]);make(a,"span",p[1]);});

var main=make(shell,"main",null,"admin-main"),top=make(main,"header",null,"admin-top");make(top,"strong","家庭管理后台");
var topRight=make(top,"div",null,"admin-top-right"),conn=make(topRight,"span");if(window.KHD_ACCESS){make(conn,"i",null,"admin-dot");conn.appendChild(document.createTextNode("本地服务已响应"));}else conn.textContent="服务状态未知";
make(topRight,"span",access.version||"版本未知");if(!access.openAdmin&&["/admin/weather","/admin/driving","/admin/display","/admin/family","/admin/bus"].indexOf(path)>=0)button(topRight,"管理登录 / 退出",function(){el("logout").click();});
link(topRight,"返回展示页","/","admin-primary");
var content=make(main,"div",null,"admin-content"),banner=make(content,"header",null,"admin-banner");make(banner,"h1",current[2]);
var work=make(content,"div");work.id="adminWork";children.forEach(function(n){work.appendChild(n);});document.title=current[2]+" · KindleHomeDashboard";
function statusCell(root,label,value,description){var c=make(root,"div",null,"admin-status-cell");make(c,"span",label,"admin-muted");make(c,"strong",value);if(description)make(c,"span",description,"admin-muted");}
if(path==="/admin"||path==="/admin/system"){
 var landing=el("adminLanding"),card=make(landing,"section",null,"admin-card");make(card,"h2","系统状态");var statuses=make(card,"div",null,"admin-status-grid");
 statusCell(statuses,"服务连接",window.KHD_ACCESS?"已响应":"未知");statusCell(statuses,"软件版本",access.version||"未知");statusCell(statuses,"访问方式",access.openAdmin?"家庭直连":access.direct?"管理需凭证":"令牌访问");
 if(path==="/admin"){make(landing,"h2","功能模块","admin-section-title");var grid=make(landing,"div",null,"admin-module-grid");
 pages.slice(1).forEach(function(p){var a=link(grid,null,p[0],"admin-card admin-module-card"),i=make(a,"span",null,"admin-module-icon");icon(i,p[4]);var c=make(a,"div");make(c,"h2",p[1]);make(c,"p",p[3]);});}
 else{var info=make(landing,"section",null,"admin-card");info.style.marginTop="16px";make(info,"h2","部署与更新");make(info,"p","更新：在极空间 Docker 更新现有镜像，保留原数据卷。");make(info,"p","访问凭证及服务密钥：在 NAS 私有配置中维护。");}
}
if(path==="/admin/display"||path==="/admin/family"){
 var family=el("home"),layout=make(family,"div",null,"admin-family-content");move(layout,["content","editor"]);
 if(path==="/admin/family"){var bar=make(content,"div",null,"admin-family-toolbar");content.insertBefore(bar,work);bar.appendChild(el("refresh"));}
 if(path==="/admin/display"){
  var columns=make(content,"div",null,"admin-display-grid");columns.appendChild(work);
  var preview=make(columns,"section",null,"admin-card");make(preview,"h2","Kindle 显示预览");
  var controls=make(preview,"div",null,"admin-preview-controls");
  function field(label,id,value,min,max){var l=make(controls,"label",label),n=make(l,"input");n.id=id;n.type="number";n.min=min;n.max=max;n.step="1";n.value=value;return n;}
  var width=field("视口宽度（CSS px）","previewWidth",480,240,1600),height=field("视口高度（CSS px）","previewHeight",640,240,2400),ml=make(controls,"label","预览模式"),mode=make(ml,"select");mode.id="previewMode";
  [["overview","综合展示"],["bus","公交"],["weather","天气"],["driving","驾驶"],["tasks","待办"],["menus","菜单"],["posters","海报"],["auto","自动分时"]].forEach(function(p){var o=make(mode,"option",p[1]);o.value=p[0];});
  var actions=make(preview,"div",null,"admin-preview-actions"),fit=true,device=true,frame=null,w=480,h=640;
  var fitButton=button(actions,"适应区域",function(){fit=true;resize();},"primary"),oneButton=button(actions,"原始 1:1",function(){fit=false;resize();});
  var appearance=button(actions,"原始画面",function(){device=!device;resize();});appearance.id="previewAppearance";
  var apply=button(actions,"应用视口 / 刷新",load);apply.id="previewApply";fitButton.id="previewFit";oneButton.id="previewOne";
  var feedback=make(preview,"p","","admin-preview-error");feedback.id="previewFeedback";feedback.setAttribute("role","status");
  var stage=make(preview,"div",null,"admin-preview-stage"),wrap=make(stage,"div",null,"admin-preview-wrap"),shell=make(wrap,"div",null,"admin-preview-device"),screen=make(shell,"div",null,"admin-preview-screen"),brand=make(shell,"span","kindle","admin-preview-brand");stage.id="previewStage";shell.id="previewDevice";screen.id="previewScreen";brand.setAttribute("aria-hidden","true");
  function resize(){
   if(!frame)return;
   // The viewport is never derived from the decorative bezel. Scale the
   // entire device once, and reserve its scaled footprint in normal flow.
   var edge=device?Math.round(Math.min(w,h)*0.055):0,
       bottom=device?Math.round(Math.min(w,h)*0.105):0,
       outerW=w+edge*2,outerH=h+edge+bottom;
   var scale=fit?Math.min(1,Math.max(1,stage.clientWidth-26)/outerW,Math.max(1,Math.min(720,window.innerHeight-260))/outerH):1;
   shell.className="admin-preview-device"+(device?" device-bezel":"");
   shell.style.width=outerW+"px";shell.style.height=outerH+"px";shell.style.transform="scale("+scale+")";
   screen.style.left=edge+"px";screen.style.top=edge+"px";screen.style.width=w+"px";screen.style.height=h+"px";
   frame.style.width=w+"px";frame.style.height=h+"px";
   brand.style.bottom="0";brand.style.height=bottom+"px";brand.style.fontSize=Math.max(12,Math.round(edge*0.7))+"px";
   wrap.style.width=(outerW*scale)+"px";wrap.style.height=(outerH*scale)+"px";
   fitButton.className=fit?"primary":"";oneButton.className=fit?"":"primary";
   fitButton.setAttribute("aria-pressed",String(fit));oneButton.setAttribute("aria-pressed",String(!fit));
   appearance.textContent=device?"原始画面":"设备外观";appearance.setAttribute("aria-pressed",String(!device));
   
  }
  function load(){var nw=Number(width.value),nh=Number(height.value);if(!Number.isInteger(nw)||!Number.isInteger(nh)||nw<240||nw>1600||nh<240||nh>2400){feedback.textContent="请输入有效的整数视口尺寸（宽 240–1600，高 240–2400）。";return;}
   feedback.textContent="";w=nw;h=nh;if(frame)screen.removeChild(frame);frame=make(screen,"iframe");frame.id="previewFrame";frame.title="真实 Kindle 页面只读预览";frame.src=mode.value==="auto"?"/preview/auto":"/preview#"+mode.value;frame.setAttribute("referrerpolicy","no-referrer");resize();}
  mode.onchange=load;window.addEventListener("resize",resize);appearance.title="通用外框与灰阶模拟，非实体型号测绘";oneButton.title="网页 CSS 像素 1:1，非物理尺寸";width.title=height.title="默认尺寸仅为示例，请按实际设备视口填写";load();
 }
}
if(path==="/admin/weather"||path==="/admin/driving"){
 var isWeather=path==="/admin/weather",form=el(isWeather?"weatherForm":"drivingForm"),first=el(isWeather?"weatherLocations":"drivingLocations"),split=document.createElement("div");split.className="admin-split";form.insertBefore(split,first);
 var list=make(split,"aside",null,"admin-list-pane");make(list,"h3",isWeather?"地点列表 · 最多 3 个":"目的地列表 · 最多 3 个");var edit=make(split,"div",null,"admin-edit-pane");
 if(isWeather){move(list,["weatherLocations","weatherAdd","weatherMoveUp","weatherRemove"]);make(edit,"h3","编辑当前地点");move(edit,["weatherSelected"]);var keyword=el("weatherKeyword"),label=keyword.previousElementSibling;if(label&&label.tagName==="LABEL")edit.appendChild(label);move(edit,["weatherKeyword","weatherSearch","weatherSearchStatus","weatherResults"]);var n=el("weatherName");label=n.previousElementSibling;if(label&&label.tagName==="LABEL")edit.appendChild(label);move(edit,["weatherName","weatherManual","weatherCoordinates"]);}
 else{move(list,["drivingLocations","drivingAdd"]);make(edit,"h3","编辑当前目的地");move(edit,["drivingGroups"]);}
}
}());
