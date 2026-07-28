// Served at GET /queue. The swipe feed — one UI, two jobs: approving what the
// agents proposed, and tagging your own backlog. Phone-first (thumb), with
// keyboard shortcuts for when you're at the laptop.
//
// Nothing here writes to Notion. It records your decisions; pushing them
// anywhere is always a separate, explicit act.
export const QUEUE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="color-scheme" content="dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>🧠 Big Brain — Queue</title>
<style>
  :root{--bg:#0f1115;--panel:#161a22;--line:#283042;--ink:#e7ecf5;--soft:#9aa6bd;--blue:#3b82f6;--ok:#22c55e;--bad:#ef4444;--warn:#f59e0b}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);overscroll-behavior:none}
  .wrap{max-width:560px;margin:0 auto;padding:16px 14px calc(20px + env(safe-area-inset-bottom));min-height:100vh;display:flex;flex-direction:column}
  .top{display:flex;align-items:center;gap:10px;margin-bottom:12px}
  h1{font-size:17px;margin:0;font-weight:800}
  a{color:var(--blue);text-decoration:none;font-size:14px}
  .count{margin-left:auto;color:var(--soft);font-size:13px;font-variant-numeric:tabular-nums}
  .stage{position:relative;flex:1;min-height:380px;display:flex;align-items:center;justify-content:center}
  .card{position:absolute;inset:0;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:20px;display:flex;flex-direction:column;gap:12px;box-shadow:0 18px 50px #0008;transition:transform .25s ease,opacity .25s ease;will-change:transform}
  .card.go-yes{transform:translateX(120%) rotate(14deg);opacity:0}
  .card.go-no{transform:translateX(-120%) rotate(-14deg);opacity:0}
  .card.go-skip{transform:translateY(120%);opacity:0}
  .handle{font-size:13px;color:var(--soft);letter-spacing:.02em}
  .title{font-size:22px;font-weight:800;line-height:1.25;word-break:break-word}
  .was{font-size:13px;color:var(--soft);text-decoration:line-through}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .realm{display:inline-flex;align-items:center;gap:6px;background:#0b0e14;border:1px solid var(--line);border-radius:999px;padding:6px 13px;font-size:13px;font-weight:700;letter-spacing:.04em}
  .realm.INSPO{border-color:#7c4dbd;color:#c9a7ff}
  .realm.KNOWLEDGE{border-color:#2b7a5b;color:#7fe0b0}
  .realm[data-r="CULTURE+NEWS"]{border-color:#a56b1e;color:#ffc978}
  .realm.SELF{border-color:#3b82f6;color:#9dc0ff}
  .tag{background:#0b0e14;border:1px solid var(--line);border-radius:8px;padding:4px 9px;font-size:12px;color:var(--soft)}
  .why{font-size:13px;color:var(--soft);background:#0b0e14;border-left:3px solid var(--line);border-radius:0 8px 8px 0;padding:9px 12px}
  .conf{height:4px;background:#0b0e14;border-radius:99px;overflow:hidden}
  .conf i{display:block;height:100%;background:var(--ok)}
  .conf.low i{background:var(--warn)}
  .spacer{flex:1}
  .open{font-size:13px}
  .acts{display:flex;gap:10px;margin-top:14px}
  button{font:inherit;font-weight:800;border:1px solid var(--line);border-radius:14px;padding:15px 0;background:#1b2030;color:var(--ink);cursor:pointer;flex:1;font-size:15px}
  button.no:active,button.no:hover{background:var(--bad);border-color:var(--bad);color:#fff}
  button.yes:active,button.yes:hover{background:var(--ok);border-color:var(--ok);color:#04210f}
  button.skip{flex:0 0 84px}
  .hint{text-align:center;color:var(--soft);font-size:12px;margin-top:10px}
  .done{text-align:center;color:var(--soft);padding:50px 16px}
  .done h2{color:var(--ink);font-size:20px}
  .edit{display:flex;gap:6px;flex-wrap:wrap}
  .edit button{flex:0 0 auto;padding:6px 11px;font-size:12px;border-radius:999px;font-weight:700}
  .edit button.on{background:var(--blue);border-color:var(--blue);color:#fff}
  .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#0b0e14;border:1px solid var(--line);border-radius:12px;padding:10px 15px;opacity:0;transition:.2s;pointer-events:none;font-size:14px}
  .toast.show{opacity:1}
  .hide{display:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>🧠 Queue</h1>
    <a href="/browse">Gallery</a>
    <a href="#" id="undo">Undo</a>
    <span class="count" id="count"></span>
  </div>
  <div class="stage" id="stage"></div>
  <div id="controls">
    <div class="acts">
      <button class="no" id="bno">✕ No</button>
      <button class="skip" id="bskip">Skip</button>
      <button class="yes" id="byes">✓ Yes</button>
    </div>
    <p class="hint">Swipe the card, or ← → to decide · ↓ to skip</p>
  </div>
</div>
<div id="toast" class="toast"></div>

<script>
const KEY="bigbrain_token";
let token=localStorage.getItem(KEY)||"";
const $=s=>document.querySelector(s);
if(!token){location.href="/drop";}

const REALMS=["INSPO","KNOWLEDGE","CULTURE+NEWS","SELF"];
let items=[],cursor=null,i=0,busy=false,last=null,done=0,total=0;

function esc(s){return(s||"").replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));}
function toast(m){const t=$("#toast");t.textContent=m;t.className="toast show";setTimeout(()=>t.className="toast",1400);}

async function api(path,opts={}){
  const headers=Object.assign({"X-Auth-Token":token},opts.headers||{});
  const r=await fetch(path,Object.assign({},opts,{headers}));
  if(r.status===401){localStorage.removeItem(KEY);location.href="/drop";throw new Error("401");}
  return r;
}

async function loadStats(){
  try{const r=await api("/api/queue/stats");const d=await r.json();total=d.counts?.pending||0;render();}catch(e){}
}

async function fill(){
  if(busy)return;busy=true;
  try{
    const p=new URLSearchParams({limit:"25"});if(cursor)p.set("cursor",cursor);
    const r=await api("/api/queue?"+p.toString());const d=await r.json();
    items=items.concat(d.items||[]);cursor=d.cursor;
  }catch(e){}finally{busy=false;render();}
}

// The card is the whole product: it has to be decidable in one second.
function render(){
  const stage=$("#stage");
  const it=items[i];
  $("#count").textContent=total?done+" / "+total:"";
  if(!it){
    stage.innerHTML='<div class="done"><h2>'+(done?"Queue clear.":"Nothing waiting.")+'</h2><p>'+
      (done?done+" decided. Approved items are ready to push.":"Run a mining job and they will land here.")+'</p></div>';
    $("#controls").classList.add("hide");
    if(cursor&&!busy)fill();
    return;
  }
  $("#controls").classList.remove("hide");
  const p=it.proposal||{};
  const conf=Math.round((p.confidence||0)*100);
  stage.innerHTML=
    '<div class="card" id="card">'+
      (p.handle?'<div class="handle">@'+esc(p.handle)+'</div>':'<div class="handle">'+esc(it.source||"")+'</div>')+
      '<div class="title">'+esc(p.proposedTitle||p.currentTitle||"Untitled")+'</div>'+
      (p.currentTitle&&p.proposedTitle&&p.currentTitle!==p.proposedTitle?'<div class="was">'+esc(p.currentTitle)+'</div>':'')+
      '<div class="row"><span class="realm '+esc(p.realm)+'" data-r="'+esc(p.realm)+'">'+esc(p.realm||"—")+'</span>'+
        (p.tags||[]).map(t=>'<span class="tag">'+esc(t)+'</span>').join("")+'</div>'+
      (p.why?'<div class="why">'+esc(p.why)+'</div>':'')+
      '<div class="conf'+(conf<60?' low':'')+'"><i style="width:'+conf+'%"></i></div>'+
      '<div class="edit" id="edit">'+REALMS.map(r=>'<button data-realm="'+r+'"'+(r===p.realm?' class="on"':'')+'>'+r+'</button>').join("")+'</div>'+
      '<div class="spacer"></div>'+
      (p.url?'<a class="open" href="'+esc(p.url)+'" target="_blank">Open the post ↗</a>':'')+
    '</div>';

  document.querySelectorAll("#edit button").forEach(b=>{
    b.onclick=e=>{
      e.stopPropagation();
      p.realm=b.dataset.realm;
      document.querySelectorAll("#edit button").forEach(x=>x.classList.remove("on"));
      b.classList.add("on");
      const chip=document.querySelector(".realm");
      chip.textContent=p.realm;chip.className="realm "+p.realm;chip.dataset.r=p.realm;
    };
  });
  wireDrag($("#card"));
}

// Touch drag, because this is meant to be worked on a phone with one thumb.
function wireDrag(card){
  if(!card)return;
  let x0=0,y0=0,dx=0,dy=0,dragging=false;
  card.addEventListener("touchstart",e=>{
    dragging=true;x0=e.touches[0].clientX;y0=e.touches[0].clientY;card.style.transition="none";
  },{passive:true});
  card.addEventListener("touchmove",e=>{
    if(!dragging)return;
    dx=e.touches[0].clientX-x0;dy=e.touches[0].clientY-y0;
    card.style.transform="translate("+dx+"px,"+dy+"px) rotate("+(dx/18)+"deg)";
  },{passive:true});
  card.addEventListener("touchend",()=>{
    if(!dragging)return;dragging=false;card.style.transition="";
    if(dx>90)return decide("approve");
    if(dx<-90)return decide("reject");
    if(dy>110)return decide("skip");
    card.style.transform="";
  });
}

async function decide(action){
  const it=items[i];if(!it)return;
  const card=$("#card");
  if(card)card.classList.add(action==="approve"?"go-yes":action==="reject"?"go-no":"go-skip");
  last={id:it.id,index:i};
  i++;done++;
  const edits=action==="approve"?{realm:it.proposal.realm,tags:it.proposal.tags,proposedTitle:it.proposal.proposedTitle}:{};
  setTimeout(render,180);
  try{
    await api("/api/queue/"+encodeURIComponent(it.id),{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action,edits})
    });
  }catch(e){toast("Didn't save that one");}
  if(items.length-i<6&&cursor)fill();
}

$("#byes").onclick=()=>decide("approve");
$("#bno").onclick=()=>decide("reject");
$("#bskip").onclick=()=>decide("skip");
$("#undo").onclick=async e=>{
  e.preventDefault();
  if(!last){toast("Nothing to undo");return;}
  try{
    await api("/api/queue/"+encodeURIComponent(last.id),{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"reopen"})
    });
    i=last.index;done=Math.max(0,done-1);last=null;render();toast("Back one");
  }catch(err){toast("Couldn't undo");}
};
document.addEventListener("keydown",e=>{
  if(e.key==="ArrowRight"){e.preventDefault();decide("approve");}
  if(e.key==="ArrowLeft"){e.preventDefault();decide("reject");}
  if(e.key==="ArrowDown"){e.preventDefault();decide("skip");}
});

loadStats();fill();
</script>
</body>
</html>`;
