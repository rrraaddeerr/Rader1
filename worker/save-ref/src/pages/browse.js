// The gallery SPA. Served at GET /browse. View / search / filter / edit /
// trash / restore refs, plus hold-down (or ⏰) to set reminders.
import { REMIND_CSS, REMIND_HTML, REMIND_JS } from "./remind.js";

export const BROWSE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0f1115">
<link rel="manifest" href="/manifest.json">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Big Brain">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<title>🧠 Big Brain — Gallery</title>
<style>
  :root{--bg:#0f1115;--panel:#161a22;--line:#283042;--ink:#e7ecf5;--soft:#9aa6bd;--blue:#3b82f6;--bad:#ef4444}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  .wrap{max-width:1200px;margin:0 auto;padding:20px 16px 80px}
  .top{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
  h1{font-size:22px;margin:0 12px 0 0}
  a{color:var(--blue);text-decoration:none}
  input[type=text]{flex:1;min-width:200px;background:#0b0e14;border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:10px 14px;font:inherit}
  button{font:inherit;font-weight:600;border:1px solid var(--line);border-radius:999px;padding:7px 14px;background:#1b2030;color:var(--ink);cursor:pointer}
  button.on{background:var(--blue);color:#fff;border-color:var(--blue)}
  button.trashchip{border-style:dashed}
  button.trashchip.on{background:#3a1520;border-color:#7a2727;color:#fff}
  .chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;position:relative;display:flex;flex-direction:column;-webkit-touch-callout:none}
  .thumb{aspect-ratio:4/3;background:#0b0e14;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .thumb img{width:100%;height:100%;object-fit:cover}
  .thumb .ph{color:var(--soft);font-size:40px}
  .meta{padding:10px 12px}
  .meta .t{font-weight:700;font-size:14px;line-height:1.3;max-height:2.6em;overflow:hidden}
  .meta .h{color:var(--soft);font-size:12px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .badge{position:absolute;left:8px;top:8px;background:#000b;border:1px solid var(--line);border-radius:999px;font-size:10px;padding:3px 8px;text-transform:uppercase;letter-spacing:.05em;z-index:1}
  .del{position:absolute;right:8px;top:8px;background:#000b;border:1px solid var(--line);color:#fff;border-radius:8px;padding:3px 8px;font-size:12px;opacity:0;transition:.15s;z-index:1}
  .edit{position:absolute;right:40px;top:8px;background:#000b;border:1px solid var(--line);color:#fff;border-radius:8px;padding:3px 8px;font-size:12px;opacity:0;transition:.15s;z-index:1}
  .rem{position:absolute;right:72px;top:8px;background:#000b;border:1px solid var(--line);color:#fff;border-radius:8px;padding:3px 8px;font-size:12px;opacity:0;transition:.15s;z-index:1}
  .card:hover .del,.card:hover .edit,.card:hover .rem{opacity:1}
  @media (hover:none){.del,.edit,.rem{opacity:1}}
  .del:hover{background:var(--bad);border-color:var(--bad)}
  .edit:hover,.rem:hover{background:var(--blue);border-color:var(--blue)}
  .editor{padding:10px 12px;border-top:1px solid var(--line);background:#0b0e14}
  .editor label{display:block;font-size:11px;color:var(--soft);margin:6px 0 3px}
  .editor select,.editor input{width:100%;background:#11151d;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 9px;font:inherit;font-size:13px}
  .editor textarea{width:100%;min-height:130px;resize:vertical;background:#11151d;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;line-height:1.5}
  .editor .erow{display:flex;gap:8px;margin-top:10px}
  .editor button{flex:1;padding:7px}
  .editor .save{background:var(--blue);color:#fff;border-color:var(--blue)}
  .trow{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line);margin-top:auto}
  .trow button{flex:1;font-size:13px;padding:8px;border-radius:8px}
  .trow .forever{background:#3a1520;border-color:#7a2727}
  .trashnote{color:var(--soft);font-size:13px;margin:0 0 14px}
  .muted{color:var(--soft)}
  .empty{text-align:center;color:var(--soft);padding:60px 0}
  .hide{display:none}
${REMIND_CSS}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>🧠 Gallery</h1>
    <a href="/drop">+ Drop</a>
    <input id="q" type="text" placeholder="Search title, host, tags, notes…">
    <button id="upcoming" title="Upcoming reminders">⏰</button>
    <button id="export">Export</button>
  </div>
  <div id="chips" class="chips"></div>
  <p id="trashnote" class="trashnote hide">🗑 Trash — deleted things live here for 30 days, then they're gone for good.</p>
  <div id="grid" class="grid"></div>
  <div id="empty" class="empty hide">Nothing here yet.</div>
  <div style="text-align:center;margin-top:24px"><button id="more" class="hide">Load more</button></div>
</div>
${REMIND_HTML}
<script>${REMIND_JS}</script>
<script>
const KEY="bigbrain_token";
let token=localStorage.getItem(KEY)||"";
const $=s=>document.querySelector(s);
let cat="", q="", cursor=null, loading=false, mode="refs"; // "refs" | "trash"

if(!token){location.href="/drop";}

async function api(path,opts={}){
  const headers=Object.assign({"X-Auth-Token":token},opts.headers||{});
  const r=await fetch(path,Object.assign({},opts,{headers}));
  if(r.status===401){localStorage.removeItem(KEY);location.href="/drop";throw new Error("401");}
  return r;
}

const CATS=["","image","video","audio","post","article","code","shop","document","note","link"];
function renderChips(){
  const c=$("#chips");c.innerHTML="";
  CATS.forEach(k=>{
    const b=document.createElement("button");b.textContent=k||"all";
    b.className=(mode==="refs"&&k===cat?"on":"");
    b.onclick=()=>{mode="refs";cat=k;reset();};
    c.appendChild(b);
  });
  const tb=document.createElement("button");
  tb.textContent="🗑 trash";
  tb.className="trashchip"+(mode==="trash"?" on":"");
  tb.onclick=()=>{mode=(mode==="trash"?"refs":"trash");cat="";reset();};
  c.appendChild(tb);
  $("#trashnote").classList.toggle("hide",mode!=="trash");
}

function refData(ref){
  return {id:ref.id,title:(ref.title||(ref.text||"").split("\\n")[0]||ref.host||"").slice(0,200),url:ref.url||""};
}

function card(ref){
  if(mode==="trash")return trashCard(ref);
  const el=document.createElement("div");el.className="card";el.id="r-"+ref.id;
  const href=ref.url||"#";
  const inner=ref.image?'<img loading="lazy" src="'+ref.image+'">':'<span class="ph">'+icon(ref.category)+'</span>';
  const opts=CATS.filter(Boolean).map(c=>'<option value="'+c+'"'+(c===ref.category?' selected':'')+'>'+c+'</option>').join("");
  const isNote=ref.kind==="note";
  el.innerHTML=
    '<span class="badge">'+ref.category+'</span>'+
    '<button class="rem" title="Remind me">⏰</button>'+
    '<button class="edit" title="Edit">✎</button>'+
    '<button class="del" title="Move to trash">✕</button>'+
    '<a class="thumb" href="'+href+'" target="_blank">'+inner+'</a>'+
    '<div class="meta"><div class="t">'+esc(ref.title||ref.text||ref.host||ref.url||"Untitled")+'</div>'+
    '<div class="h">'+esc(ref.host||"")+(ref.createdAt?' · '+new Date(ref.createdAt).toLocaleDateString():'')+'</div></div>'+
    '<div class="editor hide">'+
      '<label>Title</label><input class="etitle" value="'+esc(ref.title||"")+'">'+
      (isNote
        ?'<label>Note</label><textarea class="etext" placeholder="Write away — plenty of room.">'+esc(ref.text||"")+'</textarea>'
        :'<label>Description</label><textarea class="edesc" style="min-height:70px">'+esc(ref.desc||"")+'</textarea>')+
      '<label>Category</label><select class="ecat">'+opts+'</select>'+
      '<label>Tags (comma-separated)</label><input class="etags" value="'+esc((ref.tags||[]).join(", "))+'">'+
      '<div class="erow"><button class="cancel">Cancel</button><button class="save">Save</button></div>'+
    '</div>';
  const editor=el.querySelector(".editor");
  el.querySelector(".edit").onclick=()=>editor.classList.toggle("hide");
  el.querySelector(".cancel").onclick=()=>editor.classList.add("hide");
  el.querySelector(".rem").onclick=()=>BB.openRemind(refData(ref));
  BB.longPress(el,()=>refData(ref));
  el.querySelector(".save").onclick=async()=>{
    const payload={
      category:el.querySelector(".ecat").value,
      tags:el.querySelector(".etags").value,
      title:el.querySelector(".etitle").value,
    };
    if(isNote)payload.text=el.querySelector(".etext").value;
    else payload.desc=el.querySelector(".edesc").value;
    const r=await api("/api/ref/"+encodeURIComponent(ref.id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const d=await r.json();
    if(r.ok&&d.ok){
      Object.assign(ref,d.ref);
      el.querySelector(".badge").textContent=d.ref.category;
      el.querySelector(".t").textContent=d.ref.title||d.ref.text||d.ref.host||d.ref.url||"Untitled";
      editor.classList.add("hide");
      bbToast("Saved ✓");
    }
    else{bbToast("Save failed: "+(d.error||r.status),1);}
  };
  el.querySelector(".del").onclick=async()=>{
    const r=await api("/api/ref/"+encodeURIComponent(ref.id),{method:"DELETE"});
    if(r.ok){el.remove();bbToast("Moved to 🗑 trash — restorable for 30 days");}
    else bbToast("Delete failed",1);
  };
  return el;
}

function trashCard(ref){
  const el=document.createElement("div");el.className="card";
  const inner=ref.image?'<img loading="lazy" src="'+ref.image+'">':'<span class="ph">'+icon(ref.category)+'</span>';
  el.innerHTML=
    '<span class="badge">'+ref.category+'</span>'+
    '<div class="thumb">'+inner+'</div>'+
    '<div class="meta"><div class="t">'+esc(ref.title||ref.text||ref.host||ref.url||"Untitled")+'</div>'+
    '<div class="h">deleted'+(ref.deletedAt?' '+new Date(ref.deletedAt).toLocaleDateString():'')+'</div></div>'+
    '<div class="trow"><button class="restore">↩ Restore</button><button class="forever">Delete forever</button></div>';
  el.querySelector(".restore").onclick=async()=>{
    const r=await api("/api/ref/"+encodeURIComponent(ref.id)+"/restore",{method:"POST"});
    const d=await r.json();
    if(r.ok&&d.ok){el.remove();bbToast("Restored ✓");}
    else bbToast("Restore failed",1);
  };
  el.querySelector(".forever").onclick=async()=>{
    if(!confirm("Delete forever? This can't be undone."))return;
    await api("/api/trash/"+encodeURIComponent(ref.id),{method:"DELETE"});
    el.remove();
  };
  return el;
}

function icon(c){return({image:"🖼️",video:"🎬",audio:"🎵",post:"💬",article:"📰",code:"💻",shop:"🛍️",document:"📄",note:"📝"})[c]||"🔗";}
function esc(s){return(s||"").replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));}

async function load(append){
  if(loading)return;loading=true;
  const p=new URLSearchParams();p.set("limit","60");if(cat)p.set("cat",cat);if(q)p.set("q",q);if(append&&cursor)p.set("cursor",cursor);
  const endpoint=mode==="trash"?"/api/trash":"/api/list";
  try{
    const r=await api(endpoint+"?"+p.toString());const d=await r.json();
    const grid=$("#grid");if(!append)grid.innerHTML="";
    (d.refs||[]).forEach(ref=>grid.appendChild(card(ref)));
    cursor=d.cursor;$("#more").classList.toggle("hide",!cursor);
    $("#empty").textContent=mode==="trash"?"Trash is empty.":"Nothing here yet.";
    $("#empty").classList.toggle("hide",grid.children.length>0);
  }catch(e){}finally{loading=false;}
}
function reset(){cursor=null;renderChips();load(false);}

let t;$("#q").addEventListener("input",e=>{clearTimeout(t);t=setTimeout(()=>{q=e.target.value.trim();reset();},250);});
$("#more").onclick=()=>load(true);
$("#upcoming").onclick=()=>BB.openUpcoming();
$("#export").onclick=()=>{const a=document.createElement("a");a.href="/api/export";a.download="bigbrain-export.ndjson";
  fetch("/api/export",{headers:{"X-Auth-Token":token}}).then(r=>r.blob()).then(b=>{a.href=URL.createObjectURL(b);a.click();});};

reset();
</script>
</body>
</html>`;
