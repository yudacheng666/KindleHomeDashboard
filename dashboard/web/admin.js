/* Desktop workbench: module settings stay left, the real Kindle page stays right. */
(function(){
"use strict";
var path=location.pathname;
if(path==="/admin/display"){location.replace("/admin/family#posters");return;}
var pages=[
 ["/admin","首页","总览","home"],
 ["/admin/bus","公交设置","公交设置","bus"],
 ["/admin/weather","天气设置","天气设置","weather"],
 ["/admin/driving","驾驶设置","驾驶设置","car"],
 ["/admin/family","家庭管理","家庭管理","family"],
 ["/admin/system","系统设置","系统信息","settings"]
];
var current=pages.filter(function(p){return p[0]===path;})[0];if(!current)return;
var access=window.KHD_ACCESS||{};
function el(id){return document.getElementById(id);}
function make(root,tag,text,cls){var n=document.createElement(tag);if(text!==null&&text!==undefined)n.textContent=text;if(cls)n.className=cls;root.appendChild(n);return n;}
function icon(root,name){
 var ns="http://www.w3.org/2000/svg",s=document.createElementNS(ns,"svg"),p=document.createElementNS(ns,"path");
 var shapes={home:"M3 10 12 3l9 7v11H15v-7H9v7H3z",bus:"M5 18V6q0-3 7-3t7 3v12H5z M5 11h14 M7 18v3 M17 18v3 M8 15h1 M15 15h1",weather:"M7 19h11a4 4 0 0 0 0-8 6 6 0 0 0-11-2 5 5 0 0 0 0 10z M12 2v3 M3 4l2 2 M21 4l-2 2",car:"M3 16v-4l3-6h12l3 6v4z M3 16v3h3 M21 16v3h-3 M5 12h14 M7 15h1 M16 15h1",family:"M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M5 21v-3a7 7 0 0 1 14 0v3z",settings:"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M10 2h4l1 3 3 1 3-1 2 4-3 2v3l3 2-2 4-3-1-3 1-1 2h-4l-1-2-3-1-3 1-2-4 3-2v-3L1 9l2-4 3 1 3-1z",book:"M3 4h5q4 0 4 3 0-3 4-3h5v16h-5q-4 0-4 2 0-2-4-2H3z M12 7v15"};
 s.setAttribute("viewBox","0 0 24 24");s.setAttribute("class","admin-icon");s.setAttribute("aria-hidden","true");s.setAttribute("fill","none");s.setAttribute("stroke","currentColor");s.setAttribute("stroke-width","1.7");s.setAttribute("stroke-linecap","round");s.setAttribute("stroke-linejoin","round");p.setAttribute("d",shapes[name]||shapes.book);s.appendChild(p);root.appendChild(s);
}
function link(root,label,url,cls){var a=make(root,"a",label,cls);a.href=url;a.onclick=function(){return !window.KHD_ADMIN_CAN_LEAVE||window.KHD_ADMIN_CAN_LEAVE();};return a;}
function button(root,label,fn,cls){var b=make(root,"button",label,cls);b.type="button";b.onclick=fn;return b;}
function move(root,ids){ids.forEach(function(id){var n=el(id);if(n)root.appendChild(n);});}
var children=Array.prototype.slice.call(document.body.children).filter(function(n){return n.tagName!=="SCRIPT";});
document.body.className="desktop-admin admin-"+(path.split("/")[2]||"index");
var shell=make(document.body,"div",null,"admin-shell"),side=make(shell,"aside",null,"admin-sidebar"),brand=make(side,"div",null,"admin-brand"),logo=make(brand,"span",null,"admin-logo");icon(logo,"book");
var brandText=make(brand,"div");make(brandText,"strong","KindleHomeDashboard");make(brandText,"small","家庭信息终端");
var nav=make(side,"nav",null,"admin-nav");nav.setAttribute("aria-label","管理模块");
pages.forEach(function(p){var a=link(nav,null,p[0]);if(p===current)a.setAttribute("aria-current","page");icon(a,p[3]);make(a,"span",p[1]);});
var main=make(shell,"main",null,"admin-main"),top=make(main,"header",null,"admin-top");make(top,"strong","家庭管理后台");
var topRight=make(top,"div",null,"admin-top-right"),conn=make(topRight,"span");
if(window.KHD_ACCESS){make(conn,"i",null,"admin-dot");conn.appendChild(document.createTextNode("本地服务已响应"));}else conn.textContent="服务状态未知";
make(topRight,"span",access.version||"版本未知");
if(!access.openAdmin&&["/admin/weather","/admin/driving","/admin/family","/admin/bus"].indexOf(path)>=0)button(topRight,"管理登录 / 退出",function(){var n=el("logout");if(n)n.click();});
link(topRight,"返回展示页","/","admin-primary");
var content=make(main,"div",null,"admin-content"),workspace=make(content,"div",null,"admin-workspace"),workPane=make(workspace,"section",null,"admin-work-main");
var banner=make(workPane,"header",null,"admin-banner");make(banner,"h1",current[2]);
var work=make(workPane,"div");work.id="adminWork";children.forEach(function(n){work.appendChild(n);});document.title=current[2]+" · KindleHomeDashboard";
function statusCell(root,label,value){var c=make(root,"div",null,"admin-status-cell");make(c,"span",label,"admin-muted");make(c,"strong",value);}
if(path==="/admin"||path==="/admin/system"){
 var landing=el("adminLanding"),card=make(landing,"section",null,"admin-card");make(card,"h2","系统状态");var statuses=make(card,"div",null,"admin-status-grid");
 statusCell(statuses,"服务连接",window.KHD_ACCESS?"已响应":"未知");statusCell(statuses,"软件版本",access.version||"未知");statusCell(statuses,"访问方式",access.openAdmin?"家庭直连":access.direct?"管理需凭证":"令牌访问");
 if(path==="/admin"){make(landing,"h2","功能模块","admin-section-title");var grid=make(landing,"div",null,"admin-module-grid");
  pages.slice(1).forEach(function(p){var a=link(grid,null,p[0],"admin-card admin-module-card"),i=make(a,"span",null,"admin-module-icon");icon(i,p[3]);var c=make(a,"div");make(c,"h2",p[1]);});}
 else{var info=make(landing,"section",null,"admin-card");info.style.marginTop="16px";make(info,"h2","部署与更新");make(info,"p","在极空间 Docker 更新现有镜像，保留原数据卷。");make(info,"p","访问凭证及服务密钥在 NAS 私有配置中维护。");}
}
if(path==="/admin/family"){
 var family=el("home"),layout=make(family,"div",null,"admin-family-content");move(layout,["content","editor"]);
 var bar=make(family,"div",null,"admin-family-toolbar");family.insertBefore(bar,el("tabs"));if(el("refresh"))bar.appendChild(el("refresh"));
}
if(path==="/admin/weather"||path==="/admin/driving"){
 var isWeather=path==="/admin/weather",form=el(isWeather?"weatherForm":"drivingForm");
 if(form){var first=el(isWeather?"weatherLocations":"drivingLocations"),split=document.createElement("div");split.className="admin-split";form.insertBefore(split,first);
  var list=make(split,"aside",null,"admin-list-pane");make(list,"h3",isWeather?"地点列表 · 最多 3 个":"目的地列表 · 最多 3 个");var edit=make(split,"div",null,"admin-edit-pane");
  if(isWeather){move(list,["weatherLocations","weatherAdd","weatherMoveUp","weatherRemove"]);make(edit,"h3","编辑当前地点");move(edit,["weatherSelected"]);var keyword=el("weatherKeyword"),label=keyword.previousElementSibling;if(label&&label.tagName==="LABEL")edit.appendChild(label);move(edit,["weatherKeyword","weatherSearch","weatherSearchStatus","weatherResults"]);var n=el("weatherName");label=n.previousElementSibling;if(label&&label.tagName==="LABEL")edit.appendChild(label);move(edit,["weatherName","weatherManual","weatherCoordinates"]);}
  else{move(list,["drivingLocations","drivingAdd"]);make(edit,"h3","编辑当前目的地");move(edit,["drivingGroups"]);}
 }
}
var preview=make(workspace,"aside",null,"admin-preview-panel");make(preview,"h2","Kindle 预览");
var controls=make(preview,"div",null,"admin-preview-controls");
var modeLabel=make(controls,"label","预览内容"),mode=make(modeLabel,"select");mode.id="previewMode";
[["follow","跟随模块"],["overview","综合展示"],["bus","公交"],["weather","天气"],["driving","驾驶"],["tasks","待办"],["posters","海报"],["menus","菜单"]].forEach(function(p){var o=make(mode,"option",p[1]);o.value=p[0];});
function field(label,id,value,min,max){var l=make(controls,"label",label),n=make(l,"input");n.id=id;n.type="number";n.min=min;n.max=max;n.step="1";n.value=value;return n;}
var width=field("宽度（CSS px）","previewWidth",480,240,1600),height=field("高度（CSS px）","previewHeight",640,240,2400);
var actions=make(preview,"div",null,"admin-preview-actions"),fit=true,device=true,frame=null,w=480,h=640,follow=true;
var fitButton=button(actions,"适应区域",function(){fit=true;resize();},"primary"),oneButton=button(actions,"原始 1:1",function(){fit=false;resize();});
var appearance=button(actions,"设备外观",function(){device=!device;resize();}),defaults=button(actions,"恢复默认",function(){width.value="480";height.value="640";mode.value="follow";follow=true;fit=true;device=true;loadFrame(moduleMode());resize();});
var apply=button(actions,"应用尺寸",function(){var nw=Number(width.value),nh=Number(height.value);if(!validSize(nw,nh))return;w=nw;h=nh;resize();});
var feedback=make(preview,"p","","admin-preview-error");feedback.id="previewFeedback";feedback.setAttribute("role","status");
var stage=make(preview,"div",null,"admin-preview-stage"),wrap=make(stage,"div",null,"admin-preview-wrap"),shellDevice=make(wrap,"div",null,"admin-preview-device"),screen=make(shellDevice,"div",null,"admin-preview-screen"),brandMark=make(shellDevice,"span","kindle","admin-preview-brand");
stage.id="previewStage";shellDevice.id="previewDevice";screen.id="previewScreen";brandMark.setAttribute("aria-hidden","true");
frame=make(screen,"iframe");frame.id="previewFrame";frame.title="Kindle 实际展示交互预览";frame.setAttribute("referrerpolicy","no-referrer");
function moduleMode(){
 if(path==="/admin/bus")return "bus";if(path==="/admin/weather")return "weather";if(path==="/admin/driving")return "driving";
 if(path==="/admin/family")return window.KHD_ADMIN_PREVIEW_MODE||"tasks";return "overview";
}
function sendAuth(){if(!frame||!frame.contentWindow)return;var value=typeof window.KHD_ADMIN_GET_TOKEN==="function"?window.KHD_ADMIN_GET_TOKEN():"";frame.contentWindow.postMessage({type:"khd-admin-preview-auth",token:typeof value==="string"?value:""},location.origin);}
function loadFrame(next){var src=next==="auto"?"/preview/auto":"/preview#"+next;if(frame.getAttribute("src")===src){sendAuth();return;}frame.src=src;}
function resize(){
 if(!frame)return;
 var edge=device?Math.round(Math.min(w,h)*0.055):0,bottom=device?Math.round(Math.min(w,h)*0.105):0,outerW=w+edge*2,outerH=h+edge+bottom;
 var scale=fit?Math.min(1,Math.max(1,stage.clientWidth-26)/outerW,Math.max(1,Math.min(720,window.innerHeight-245))/outerH):1;
 shellDevice.className="admin-preview-device"+(device?" device-bezel":"");shellDevice.style.width=outerW+"px";shellDevice.style.height=outerH+"px";shellDevice.style.transform="scale("+scale+")";
 screen.style.left=edge+"px";screen.style.top=edge+"px";screen.style.width=w+"px";screen.style.height=h+"px";frame.style.width=w+"px";frame.style.height=h+"px";
 brandMark.style.bottom="0";brandMark.style.height=bottom+"px";brandMark.style.fontSize=Math.max(12,Math.round(edge*0.7))+"px";
 wrap.style.width=(outerW*scale)+"px";wrap.style.height=(outerH*scale)+"px";
 fitButton.className=fit?"primary":"";oneButton.className=fit?"":"primary";fitButton.setAttribute("aria-pressed",String(fit));oneButton.setAttribute("aria-pressed",String(!fit));
 appearance.textContent=device?"设备外观":"原始画面";appearance.setAttribute("aria-pressed",String(device));
}
mode.onchange=function(){follow=mode.value==="follow";loadFrame(follow?moduleMode():mode.value);};
window.KHD_ADMIN_PREVIEW_SET_MODE=function(next){if(follow)loadFrame(next);};
window.KHD_ADMIN_PREVIEW_REFRESH=function(){if(frame&&frame.contentWindow)frame.contentWindow.postMessage({type:"khd-admin-preview-refresh"},location.origin);};
window.KHD_ADMIN_PREVIEW_AUTH=function(){sendAuth();};
if(frame.addEventListener)frame.addEventListener("load",sendAuth);else frame.onload=sendAuth;
if(window.addEventListener)window.addEventListener("message",function(event){
 if(event.origin!==location.origin||event.source!==frame.contentWindow||!event.data)return;
 if(event.data.type==="khd-admin-preview-auth-request")sendAuth();
 else if(event.data.type==="khd-preview-mode-change"&&!follow&&["overview","bus","weather","driving","tasks","posters","menus"].indexOf(event.data.mode)>=0)mode.value=event.data.mode;
},false);
width.title=height.title="默认尺寸仅为示例，可按实际设备视口修改。";oneButton.title="网页 CSS 像素 1:1，非物理尺寸";appearance.title="通用外框与灰阶模拟，不对应特定实体型号";
loadFrame(moduleMode());resize();window.addEventListener("resize",resize);
}());