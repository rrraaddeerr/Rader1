// Shared "⏰ Remind me" bottom sheet, embedded into both the /drop and /browse
// pages. Exposes window.BB:
//   BB.openRemind(ref)        — open the sheet for {id,title,url}
//   BB.openUpcoming()         — list + cancel scheduled reminders
//   BB.longPress(node, ref)   — wire hold-down (550ms) on any element
// plus window.bbToast(msg, bad).
//
// NOTE: these strings are interpolated into the pages' template literals, so
// they must never contain backticks or dollar-brace sequences.

export const REMIND_CSS = /* css */ `
  .bbback{position:fixed;inset:0;background:#000a;opacity:0;pointer-events:none;transition:.2s;z-index:40}
  .bbback.show{opacity:1;pointer-events:auto}
  .bbsheet{position:fixed;left:50%;bottom:0;transform:translate(-50%,110%);width:min(480px,calc(100vw - 20px));background:#161a22;border:1px solid #283042;border-bottom:0;border-radius:18px 18px 0 0;padding:18px 18px calc(28px + env(safe-area-inset-bottom));z-index:41;transition:transform .25s;max-height:85vh;overflow:auto}
  .bbsheet.show{transform:translate(-50%,0)}
  .bbsheet h3{margin:0 0 12px;font-size:18px}
  .bbin{width:100%;background:#0b0e14;border:1px solid #283042;color:#e7ecf5;border-radius:10px;padding:11px 13px;font:inherit;margin-bottom:10px}
  .bbchips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
  .bbchips button{font:inherit;font-size:13px;font-weight:600;border:1px solid #283042;border-radius:999px;padding:7px 12px;background:#1b2030;color:#e7ecf5;cursor:pointer}
  .bbchips button.on{background:#3b82f6;border-color:#3b82f6;color:#fff}
  .bbwhen{color:#9aa6bd;font-size:13px;margin:4px 0 10px;min-height:1.2em}
  .bbchan{display:flex;flex-direction:column;gap:8px;margin:6px 0}
  .bbchk{display:flex;align-items:center;gap:9px;font-size:14px;background:#0b0e14;border:1px solid #283042;border-radius:10px;padding:10px 12px;cursor:pointer}
  .bbchk input{width:17px;height:17px;accent-color:#3b82f6}
  .bbmuted{color:#9aa6bd;font-size:12px;margin:8px 0 0}
  .bbrow{display:flex;gap:10px;margin-top:14px}
  .bbrow button{flex:1;font:inherit;font-weight:700;border:0;border-radius:10px;padding:12px;background:#3b82f6;color:#fff;cursor:pointer}
  .bbrow .bbghost{background:#222a39;color:#e7ecf5}
  .bbupitem{display:flex;justify-content:space-between;align-items:center;gap:10px;background:#0b0e14;border:1px solid #283042;border-radius:10px;padding:10px 12px;margin-top:8px}
  .bbupt{font-weight:600;font-size:14px}
  .bbupitem .bbdel{background:#222a39;border:1px solid #283042;color:#e7ecf5;border-radius:8px;padding:4px 9px;cursor:pointer;font:inherit}
  .bbtoast{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));transform:translateX(-50%);background:#0b0e14;border:1px solid #283042;color:#e7ecf5;border-radius:12px;padding:12px 16px;box-shadow:0 12px 40px #000a;opacity:0;pointer-events:none;transition:.2s;max-width:90vw;z-index:60}
  .bbtoast.show{opacity:1}
  .bbtoast.bad{border-color:#7a2727}
`;

export const REMIND_HTML = /* html */ `
<div id="bbback" class="bbback"></div>
<div id="bbsheet" class="bbsheet" role="dialog" aria-modal="true" aria-label="Reminder">
  <h3 id="bbhead">⏰ Remind me</h3>
  <div id="bbform">
    <input id="bbtitle" class="bbin" type="text" placeholder="What should I remind you about?" maxlength="200" autocomplete="off">
    <div id="bbchips" class="bbchips">
      <button type="button">In 1 hour</button>
      <button type="button">Tonight 6pm</button>
      <button type="button">Tomorrow 9am</button>
      <button type="button">Pick a time…</button>
    </div>
    <input id="bbdt" class="bbin hide" type="datetime-local">
    <div id="bbwhen" class="bbwhen"></div>
    <div id="bbchan" class="bbchan"></div>
    <p id="bbhint" class="bbmuted"></p>
    <div class="bbrow">
      <button type="button" id="bbcancel" class="bbghost">Cancel</button>
      <button type="button" id="bbsave">Set reminder</button>
    </div>
  </div>
  <div id="bbup" class="hide"></div>
</div>
<div id="bbtoast" class="bbtoast"></div>
`;

export const REMIND_JS = /* js */ `
(function(){
"use strict";
var TKEY="bigbrain_token";
function tok(){return localStorage.getItem(TKEY)||"";}
function el(id){return document.getElementById(id);}
var cfg=null,cur=null,dueMs=0;

function bbToast(msg,bad){
  var t=el("bbtoast");t.textContent=msg;t.className="bbtoast show"+(bad?" bad":"");
  clearTimeout(bbToast._t);bbToast._t=setTimeout(function(){t.className="bbtoast";},3200);
}
window.bbToast=bbToast;

function escq(s){return String(s||"").replace(/[&<>"]/g,function(m){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m];});}
function fmtDue(ms){return new Date(ms).toLocaleString([],{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});}
function openSheet(){el("bbback").classList.add("show");el("bbsheet").classList.add("show");}
function closeSheet(){el("bbback").classList.remove("show");el("bbsheet").classList.remove("show");}

async function loadCfg(){
  if(cfg)return cfg;
  try{
    var r=await fetch("/api/reminders/config",{headers:{"X-Auth-Token":tok()}});
    var d=await r.json();
    if(d&&d.ok)cfg=d;
  }catch(e){}
  if(!cfg)cfg={push:{vapidKey:""},sms:false,whatsapp:false};
  return cfg;
}

function setDue(ms,btn){
  dueMs=ms;
  el("bbwhen").textContent="⏰ "+fmtDue(ms);
  var bs=el("bbchips").querySelectorAll("button");
  for(var i=0;i<bs.length;i++)bs[i].classList.remove("on");
  if(btn)btn.classList.add("on");
}

function chanRow(id,label,checked){
  return '<label class="bbchk"><input type="checkbox" id="'+id+'"'+(checked?" checked":"")+'> '+label+'</label>';
}

function renderChannels(){
  var saved=[];
  try{saved=JSON.parse(localStorage.getItem("bigbrain_channels")||"[]");}catch(e){}
  function pick(k,dflt){return saved.length?saved.indexOf(k)>=0:dflt;}
  var h="";
  h+=chanRow("bbch-push","🔔 Notification from Big Brain",pick("push",true));
  if(cfg.whatsapp)h+=chanRow("bbch-whatsapp","💬 WhatsApp me",pick("whatsapp",false));
  if(cfg.sms)h+=chanRow("bbch-sms","📱 Text me (SMS)",pick("sms",false));
  h+=chanRow("bbch-ics","🍎 Apple Reminders / Calendar (.ics)",pick("ics",false));
  el("bbchan").innerHTML=h;
  var hint="";
  if(!cfg.whatsapp&&!cfg.sms)hint="Want WhatsApp/SMS too? Add the Twilio secrets to the Worker — see the README.";
  var isIOS=/iPhone|iPad|iPod/.test(navigator.userAgent);
  var standalone=(window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches)||window.navigator.standalone;
  if(isIOS&&!standalone)hint+=(hint?" ":"")+"iPhone notifications need: Share → Add to Home Screen, then use Big Brain from that icon.";
  el("bbhint").textContent=hint;
}

function localDT(d){
  function p(n){return (n<10?"0":"")+n;}
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+"T"+p(d.getHours())+":"+p(d.getMinutes());
}

function b64ToU8(s){
  var pad="====".slice(0,(4-s.length%4)%4);
  var b=atob((s+pad).replace(/-/g,"+").replace(/_/g,"/"));
  var u=new Uint8Array(b.length);
  for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);
  return u;
}

async function ensurePush(){
  var isIOS=/iPhone|iPad|iPod/.test(navigator.userAgent);
  var standalone=(window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches)||window.navigator.standalone;
  if(!("serviceWorker" in navigator)||!("PushManager" in window)){
    if(isIOS&&!standalone)throw new Error("On iPhone: Share → Add to Home Screen, then set reminders from the installed Big Brain icon.");
    throw new Error("This browser can't do push notifications");
  }
  var perm=await Notification.requestPermission();
  if(perm!=="granted")throw new Error("Notifications are blocked for this site");
  var subKey=localStorage.getItem("bigbrain_subkey");
  if(!subKey){subKey=crypto.randomUUID().replace(/-/g,"");localStorage.setItem("bigbrain_subkey",subKey);}
  var reg=await navigator.serviceWorker.register("/sw.js?k="+subKey);
  await navigator.serviceWorker.ready;
  var sub=await reg.pushManager.getSubscription();
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToU8(cfg.push.vapidKey)});
  var r=await fetch("/api/push/subscribe",{method:"POST",headers:{"X-Auth-Token":tok(),"Content-Type":"application/json"},body:JSON.stringify({subKey:subKey,subscription:sub.toJSON()})});
  var d=await r.json();
  if(!r.ok||!d.ok)throw new Error("Could not register this device for notifications");
}

async function downloadIcs(title){
  var r=await fetch("/api/reminders/ics",{method:"POST",headers:{"X-Auth-Token":tok(),"Content-Type":"application/json"},
    body:JSON.stringify({title:title,due:dueMs,url:(cur&&cur.url)||""})});
  if(!r.ok)throw new Error("ICS download failed");
  var b=await r.blob();
  var a=document.createElement("a");
  a.href=URL.createObjectURL(b);
  a.download="bigbrain-reminder.ics";
  document.body.appendChild(a);a.click();a.remove();
}

async function save(){
  var chans=[];
  if(el("bbch-push")&&el("bbch-push").checked)chans.push("push");
  if(el("bbch-whatsapp")&&el("bbch-whatsapp").checked)chans.push("whatsapp");
  if(el("bbch-sms")&&el("bbch-sms").checked)chans.push("sms");
  if(el("bbch-ics")&&el("bbch-ics").checked)chans.push("ics");
  if(!dueMs)return bbToast("Pick a time first",1);
  if(dueMs<Date.now()-60000)return bbToast("That time is in the past",1);
  if(!chans.length)return bbToast("Pick at least one way to be reminded",1);
  var title=el("bbtitle").value.trim()||"Reminder";
  localStorage.setItem("bigbrain_channels",JSON.stringify(chans));
  var server=chans.filter(function(c){return c!=="ics";});
  var btn=el("bbsave");btn.disabled=true;btn.textContent="Setting…";
  try{
    if(server.indexOf("push")>=0)await ensurePush();
    if(server.length){
      var r=await fetch("/api/reminders",{method:"POST",headers:{"X-Auth-Token":tok(),"Content-Type":"application/json"},
        body:JSON.stringify({title:title,due:dueMs,url:(cur&&cur.url)||"",refId:(cur&&cur.id)||"",channels:server})});
      var d=await r.json();
      if(!r.ok||!d.ok)throw new Error((d&&d.error)||"Could not save reminder");
    }
    if(chans.indexOf("ics")>=0)await downloadIcs(title);
    closeSheet();
    bbToast("⏰ Reminder set — "+fmtDue(dueMs));
  }catch(e){bbToast(String((e&&e.message)||e),1);}
  btn.disabled=false;btn.textContent="Set reminder";
}

window.BB={
  openRemind:async function(ref){
    cur=ref||{};
    el("bbform").classList.remove("hide");el("bbup").classList.add("hide");
    el("bbhead").textContent="⏰ Remind me";
    el("bbtitle").value=(cur.title||"").slice(0,200);
    el("bbdt").classList.add("hide");
    await loadCfg();
    renderChannels();
    var bs=el("bbchips").querySelectorAll("button");
    setDue(Date.now()+3600000,bs[0]);
    openSheet();
  },
  openUpcoming:async function(){
    el("bbform").classList.add("hide");el("bbup").classList.remove("hide");
    el("bbhead").textContent="⏰ Upcoming reminders";
    el("bbup").innerHTML='<p class="bbmuted">Loading…</p>';
    openSheet();
    try{
      var r=await fetch("/api/reminders",{headers:{"X-Auth-Token":tok()}});
      var d=await r.json();
      var rems=(d&&d.reminders)||[];
      if(!rems.length){el("bbup").innerHTML='<p class="bbmuted">No upcoming reminders. Hold down any card (or tap its ⏰) to set one.</p>';return;}
      var h="";
      for(var i=0;i<rems.length;i++){
        var m=rems[i];
        h+='<div class="bbupitem"><div><div class="bbupt">'+escq(m.title||"Reminder")+'</div>'+
           '<div class="bbmuted">'+fmtDue(m.dueMs)+' · '+escq((m.channels||[]).join(" + "))+'</div></div>'+
           '<button class="bbdel" data-id="'+escq(m.id)+'" title="Cancel reminder">✕</button></div>';
      }
      el("bbup").innerHTML=h;
      var dels=el("bbup").querySelectorAll(".bbdel");
      for(var j=0;j<dels.length;j++){
        dels[j].onclick=function(ev){
          var id=ev.currentTarget.getAttribute("data-id");
          fetch("/api/reminders/"+encodeURIComponent(id),{method:"DELETE",headers:{"X-Auth-Token":tok()}})
            .then(function(){window.BB.openUpcoming();});
        };
      }
    }catch(e){el("bbup").innerHTML='<p class="bbmuted">Could not load reminders.</p>';}
  },
  longPress:function(node,refOrFn){
    var timer=null,fired=false,sx=0,sy=0;
    node.style.webkitTouchCallout="none";
    node.addEventListener("pointerdown",function(e){
      if(e.target&&e.target.closest&&e.target.closest("button,input,select,textarea"))return;
      fired=false;sx=e.clientX;sy=e.clientY;
      clearTimeout(timer);
      timer=setTimeout(function(){
        timer=null;fired=true;
        if(navigator.vibrate)navigator.vibrate(15);
        window.BB.openRemind(typeof refOrFn==="function"?refOrFn():refOrFn);
      },550);
    });
    node.addEventListener("pointermove",function(e){
      if(timer&&(Math.abs(e.clientX-sx)>12||Math.abs(e.clientY-sy)>12)){clearTimeout(timer);timer=null;}
    });
    ["pointerup","pointercancel","pointerleave"].forEach(function(ev){
      node.addEventListener(ev,function(){if(timer){clearTimeout(timer);timer=null;}});
    });
    node.addEventListener("click",function(e){if(fired){e.preventDefault();e.stopPropagation();fired=false;}},true);
    node.addEventListener("contextmenu",function(e){if(fired)e.preventDefault();});
  }
};

(function wire(){
  var chips=el("bbchips").querySelectorAll("button");
  chips[0].onclick=function(){el("bbdt").classList.add("hide");setDue(Date.now()+3600000,chips[0]);};
  chips[1].onclick=function(){
    el("bbdt").classList.add("hide");
    var d=new Date();d.setHours(18,0,0,0);
    if(d.getTime()<Date.now()+60000)d.setDate(d.getDate()+1);
    setDue(d.getTime(),chips[1]);
  };
  chips[2].onclick=function(){
    el("bbdt").classList.add("hide");
    var d=new Date();d.setDate(d.getDate()+1);d.setHours(9,0,0,0);
    setDue(d.getTime(),chips[2]);
  };
  chips[3].onclick=function(){
    var dt=el("bbdt");dt.classList.remove("hide");
    if(!dt.value){var d=new Date(Date.now()+3600000);d.setMinutes(0,0,0);dt.value=localDT(d);}
    var ms=Date.parse(dt.value);
    if(ms)setDue(ms,chips[3]);
    dt.focus();
  };
  el("bbdt").addEventListener("change",function(e){
    var ms=Date.parse(e.target.value);
    if(ms)setDue(ms,el("bbchips").querySelectorAll("button")[3]);
  });
  el("bbcancel").onclick=closeSheet;
  el("bbback").onclick=closeSheet;
  el("bbsave").onclick=save;
})();
})();
`;
