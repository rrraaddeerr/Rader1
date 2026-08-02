// The drop SPA. Served at GET /drop. Self-contained: no external assets.
export const DROP_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>🧠 Big Brain</title>
<style>
  :root{--bg:#0f1115;--panel:#161a22;--panel2:#1b2030;--line:#283042;--ink:#e7ecf5;--soft:#9aa6bd;--blue:#3b82f6;--blue2:#2563eb;--ok:#22c55e;--bad:#ef4444}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  .wrap{max-width:760px;margin:0 auto;padding:28px 18px 80px}
  header{text-align:center;margin:14px 0 8px}
  h1{font-size:30px;margin:0}
  .sub{color:var(--soft);margin:6px 0 22px;text-align:center}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;margin:14px 0}
  .setup{background:var(--panel2);border:1px solid #2c61b0}
  label{font-weight:600;display:block;margin-bottom:8px}
  input[type=text],input[type=password],textarea{width:100%;background:#0b0e14;border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:12px 14px;font:inherit}
  textarea{min-height:70px;resize:vertical}
  button{font:inherit;font-weight:700;border:0;border-radius:10px;padding:11px 18px;background:var(--blue);color:#fff;cursor:pointer}
  button:hover{background:var(--blue2)}
  button.ghost{background:#222a39;color:var(--ink)}
  .row{display:flex;gap:10px;align-items:center}
  .drop{border:2px dashed #2f3b55;border-radius:18px;padding:46px 18px;text-align:center;background:var(--panel2);transition:.15s;cursor:pointer}
  .drop.hot{border-color:var(--blue);background:#16233c;transform:scale(1.01)}
  .drop .big{font-size:20px;font-weight:800;color:var(--blue);margin-bottom:6px}
  .drop .hint{color:var(--soft);font-size:14px}
  .barwrap{display:flex;gap:10px;margin-top:14px}
  .barwrap input{flex:1}
  .muted{color:var(--soft);font-size:13px}
  .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#0b0e14;border:1px solid var(--line);border-radius:12px;padding:12px 16px;box-shadow:0 12px 40px #000a;opacity:0;pointer-events:none;transition:.2s;max-width:90vw}
  .toast.show{opacity:1}
  .toast.ok{border-color:#1f6b3a}.toast.bad{border-color:#7a2727}
  .recent{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px;margin-top:8px}
  .tile{background:#0b0e14;border:1px solid var(--line);border-radius:10px;overflow:hidden;aspect-ratio:1;position:relative;display:flex;align-items:center;justify-content:center;text-align:center}
  .tile img{width:100%;height:100%;object-fit:cover}
  .tile .ph{font-size:12px;color:var(--soft);padding:6px;word-break:break-word}
  .badge{position:absolute;left:5px;top:5px;background:#000a;border:1px solid var(--line);border-radius:999px;font-size:10px;padding:2px 7px;text-transform:uppercase;letter-spacing:.04em}
  .links{display:flex;gap:16px;justify-content:center;margin-top:18px}
  a{color:var(--blue)}
  .hide{display:none}
</style>
</head>
<body>
<div class="wrap">
  <header><h1>🧠 Big Brain</h1></header>
  <p class="sub">Drop a link, image, or note — it gets auto-categorized into your brain.</p>

  <div id="setup" class="card setup hide">
    <label for="tok">First-time setup: paste your Big Brain token</label>
    <p class="muted" style="margin-top:-2px">Stored only in this browser (localStorage) — sent only to your Worker as <code>X-Auth-Token</code>.</p>
    <div class="barwrap">
      <input id="tok" type="password" placeholder="X-Auth-Token (the long hex string)" autocomplete="off">
      <button id="savetok">Save</button>
    </div>
    <p id="tokmsg" class="muted"></p>
  </div>

  <div id="app" class="hide">
    <div id="zone" class="drop" tabindex="0" role="button" aria-label="Drop files here or click to pick">
      <div class="big">⬇ Drop here</div>
      <div class="hint">Files, screenshots, or images — drag in, paste (⌘V), or click to pick. Multiple at once is fine.</div>
    </div>

    <div class="barwrap">
      <input id="urlin" type="text" placeholder="…or paste a URL / note and hit Enter" autocomplete="off">
      <button id="pick" class="ghost">Pick file</button>
      <button id="add">Save</button>
    </div>
    <input id="note" type="text" placeholder="why are you saving this? (optional — but it's the part that sounds like you)" autocomplete="off" style="margin-top:10px">
    <input id="file" type="file" multiple class="hide" accept="image/*,video/*,application/pdf">

    <div id="echo" class="card hide">
      <div class="row" style="justify-content:space-between">
        <strong id="echotitle">You've saved things like this</strong>
        <button id="echoclose" class="ghost" style="padding:4px 10px">✕</button>
      </div>
      <div id="echoitems" class="recent"></div>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <strong>Recent</strong>
        <a href="/browse">Browse all →</a>
      </div>
      <div id="recent" class="recent"></div>
      <p id="emptyrecent" class="muted hide">Nothing yet. Drop something above.</p>
    </div>
  </div>

  <div class="links">
    <a href="/browse">Gallery</a>
    <a href="/queue">Queue</a>
    <a href="/shortcuts">iPhone setup</a>
    <a href="#" id="logout">Reset token</a>
  </div>
</div>
<div id="toast" class="toast"></div>

<script>
const KEY="bigbrain_token";
let token=localStorage.getItem(KEY)||"";
const $=s=>document.querySelector(s);
const setup=$("#setup"),app=$("#app");

function show(){ if(token){setup.classList.add("hide");app.classList.remove("hide");loadRecent();} else {setup.classList.remove("hide");app.classList.add("hide");} }
function toast(msg,kind){const t=$("#toast");t.textContent=msg;t.className="toast show "+(kind||"");setTimeout(()=>t.className="toast",2200);}

async function api(path,opts={}){
  const headers=Object.assign({"X-Auth-Token":token},opts.headers||{});
  const res=await fetch(path,Object.assign({},opts,{headers}));
  if(res.status===401){toast("Bad token — reset it","bad");localStorage.removeItem(KEY);token="";show();throw new Error("401");}
  return res;
}

$("#savetok").onclick=async()=>{
  const v=$("#tok").value.trim(); if(!v){return;}
  token=v;
  try{const r=await fetch("/api/list?limit=1",{headers:{"X-Auth-Token":v}});
    if(r.ok){localStorage.setItem(KEY,v);$("#tokmsg").textContent="✓ Saved";show();}
    else{$("#tokmsg").textContent="That token was rejected.";token="";}
  }catch(e){$("#tokmsg").textContent="Couldn't reach the Worker.";}
};
$("#logout").onclick=e=>{e.preventDefault();localStorage.removeItem(KEY);token="";show();};

// ---- saving ----
// ?similar=1 asks the worker to hand back the nearest refs it already holds,
// so a save immediately tells you where it sits in the archive.
async function saveJSON(payload){
  const r=await api("/save?similar=1",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  const d=await r.json(); if(!r.ok||!d.ok)throw new Error(d.error||"save failed");
  return d;
}
async function saveBlob(file,note){
  const headers={"Content-Type":file.type||"application/octet-stream","X-Filename":encodeURIComponent(file.name||"")};
  if(note)headers["X-Note"]=encodeURIComponent(note);
  const r=await api("/save?similar=1",{method:"POST",headers,body:file});
  const d=await r.json(); if(!r.ok||!d.ok)throw new Error(d.error||"save failed");
  return d;
}
function takeNote(){const el=$("#note");const v=el.value.trim();el.value="";return v;}

async function handleText(text){
  text=text.trim(); if(!text)return;
  const note=takeNote();
  const isUrl=/^https?:\\/\\//i.test(text)||/^[\\w-]+\\.[a-z]{2,}/i.test(text);
  try{
    const d=await saveJSON(isUrl?{url:text,note}:{text,note});
    toast("Saved → "+d.ref.category,"ok");prepend(d.ref);echo(d.similar);
  }catch(e){toast("Failed: "+e.message,"bad");}
}
async function handleFiles(files){
  const note=takeNote();
  for(const f of files){
    try{const d=await saveBlob(f,note);toast("Saved → "+d.ref.category,"ok");prepend(d.ref);echo(d.similar);}
    catch(e){toast("Failed: "+e.message,"bad");}
  }
}

// ---- "you've saved things like this before" ----
function echo(similar){
  const box=$("#echo");
  if(!similar||!similar.length){box.classList.add("hide");return;}
  $("#echotitle").textContent="You've saved "+similar.length+" thing"+(similar.length>1?"s":"")+" like this";
  const items=$("#echoitems");items.innerHTML="";
  similar.forEach(s=>{
    const a=document.createElement("a");a.className="tile";
    a.href=s.url||("/browse#"+s.id);a.target=s.url?"_blank":"_self";
    a.innerHTML='<span class="badge">'+s.category+'</span>'+
      (s.image?'<img loading="lazy" src="'+s.image+'">':'<span class="ph">'+(s.title||s.category)+'</span>');
    items.appendChild(a);
  });
  box.classList.remove("hide");
}
$("#echoclose").onclick=()=>$("#echo").classList.add("hide");

// ---- recent strip ----
function tile(ref){
  const d=document.createElement("a");d.className="tile";d.href=ref.url||("/browse#"+ref.id);d.target=ref.url?"_blank":"_self";
  d.innerHTML='<span class="badge">'+ref.category+'</span>'+(ref.image?'<img loading="lazy" src="'+ref.image+'">':'<span class="ph">'+(ref.title||ref.host||ref.category)+'</span>');
  return d;
}
function prepend(ref){const r=$("#recent");$("#emptyrecent").classList.add("hide");r.prepend(tile(ref));while(r.children.length>12)r.removeChild(r.lastChild);}
async function loadRecent(){
  try{const r=await api("/api/list?limit=12");const d=await r.json();const box=$("#recent");box.innerHTML="";
    if(!d.refs||!d.refs.length){$("#emptyrecent").classList.remove("hide");return;}
    $("#emptyrecent").classList.add("hide");d.refs.forEach(ref=>box.appendChild(tile(ref)));
  }catch(e){}
}

// ---- wiring ----
const zone=$("#zone");
["dragenter","dragover"].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.add("hot");}));
["dragleave","drop"].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.remove("hot");}));
zone.addEventListener("drop",e=>{
  const files=[...(e.dataTransfer.files||[])];
  if(files.length)return handleFiles(files);
  const u=e.dataTransfer.getData("text/uri-list")||e.dataTransfer.getData("text/plain");
  if(u)handleText(u);
});
zone.onclick=()=>$("#file").click();
zone.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$("#file").click();}};
$("#pick").onclick=()=>$("#file").click();
$("#file").onchange=e=>{handleFiles([...e.target.files]);e.target.value="";};
$("#add").onclick=()=>{const v=$("#urlin").value;$("#urlin").value="";handleText(v);};
$("#urlin").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();const v=e.target.value;e.target.value="";handleText(v);}});
window.addEventListener("paste",e=>{
  if(document.activeElement===$("#urlin")||document.activeElement===$("#tok")||document.activeElement===$("#note"))return;
  const items=[...(e.clipboardData?.items||[])];
  const imgs=items.filter(i=>i.type.startsWith("image/")).map(i=>i.getAsFile()).filter(Boolean);
  if(imgs.length){e.preventDefault();return handleFiles(imgs);}
  const text=e.clipboardData?.getData("text");if(text){e.preventDefault();handleText(text);}
});

show();
</script>
</body>
</html>`;
