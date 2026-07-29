// The gallery SPA. Served at GET /browse. View / search / filter / delete refs.
export const BROWSE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
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
  .chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;position:relative;display:flex;flex-direction:column}
  .thumb{aspect-ratio:4/3;background:#0b0e14;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .thumb img{width:100%;height:100%;object-fit:cover}
  .thumb .ph{color:var(--soft);font-size:40px}
  .meta{padding:10px 12px}
  .meta .t{font-weight:700;font-size:14px;line-height:1.3;max-height:2.6em;overflow:hidden}
  .meta .h{color:var(--soft);font-size:12px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .badge{position:absolute;left:8px;top:8px;background:#000b;border:1px solid var(--line);border-radius:999px;font-size:10px;padding:3px 8px;text-transform:uppercase;letter-spacing:.05em}
  .del{position:absolute;right:8px;top:8px;background:#000b;border:1px solid var(--line);color:#fff;border-radius:8px;padding:3px 8px;font-size:12px;opacity:0;transition:.15s}
  .edit{position:absolute;right:40px;top:8px;background:#000b;border:1px solid var(--line);color:#fff;border-radius:8px;padding:3px 8px;font-size:12px;opacity:0;transition:.15s}
  .card:hover .del,.card:hover .edit{opacity:1}
  .del:hover{background:var(--bad);border-color:var(--bad)}
  .edit:hover{background:var(--blue);border-color:var(--blue)}
  .editor{padding:10px 12px;border-top:1px solid var(--line);background:#0b0e14}
  .editor label{display:block;font-size:11px;color:var(--soft);margin:6px 0 3px}
  .editor select,.editor input{width:100%;background:#11151d;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 9px;font:inherit;font-size:13px}
  .editor .erow{display:flex;gap:8px;margin-top:10px}
  .editor button{flex:1;padding:7px}
  .editor .save{background:var(--blue);color:#fff;border-color:var(--blue)}
  .muted{color:var(--soft)}
  .empty{text-align:center;color:var(--soft);padding:60px 0}
  .hide{display:none}
  .sim{position:absolute;right:72px;top:8px;background:#000b;border:1px solid var(--line);color:#fff;border-radius:8px;padding:3px 8px;font-size:12px;opacity:0;transition:.15s}
  .card:hover .sim{opacity:1}
  .sim:hover{background:var(--blue);border-color:var(--blue)}
  /* --- ask --- */
  .askbar{display:flex;gap:8px;margin-bottom:14px}
  .askbar input{flex:1}
  .toggle{display:flex;border:1px solid var(--line);border-radius:999px;overflow:hidden}
  .toggle button{border:0;border-radius:0;padding:7px 12px;font-size:13px}
  .ans{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:16px}
  .ans .body{white-space:pre-wrap;line-height:1.62}
  .ans .body b{color:#fff}
  .ans .foot{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
  .src{display:inline-flex;align-items:center;gap:6px;background:#0b0e14;border:1px solid var(--line);border-radius:999px;padding:4px 11px;font-size:12px;color:var(--ink);max-width:260px}
  .src:hover{border-color:var(--blue)}
  .src .n{color:var(--blue);font-weight:800}
  .src .tt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .spin{display:inline-block;width:13px;height:13px;border:2px solid var(--line);border-top-color:var(--blue);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px}
  @keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>🧠 Gallery</h1>
    <a href="/drop">+ Drop</a>
    <a href="/brief">Brief</a>
    <a href="/queue">Queue</a>
    <a href="/shortcuts">iPhone</a>
    <input id="q" type="text" placeholder="Search title, host, tags, notes…">
    <div class="toggle" title="Keyword matches the letters. Meaning matches the idea.">
      <button id="mkw" class="on">keyword</button><button id="msem">meaning</button>
    </div>
    <button id="export">Export</button>
  </div>

  <div class="askbar">
    <input id="ask" type="text" placeholder="Ask Big Brain — “what's my thing with chrome tailoring?”">
    <button id="askgo">Ask</button>
    <button id="deep" title="Use Claude for synthesis instead of the fast model">deep</button>
  </div>
  <div id="answer" class="ans hide"></div>

  <div id="chips" class="chips"></div>
  <div id="grid" class="grid"></div>
  <div id="empty" class="empty hide">Nothing here yet.</div>
  <div style="text-align:center;margin-top:24px"><button id="more" class="hide">Load more</button></div>
</div>

<script>
const KEY="bigbrain_token";
let token=localStorage.getItem(KEY)||"";
const $=s=>document.querySelector(s);
let cat="", q="", cursor=null, loading=false, mode="kw", deep=false;

if(!token){location.href="/drop";}

async function api(path){
  const r=await fetch(path,{headers:{"X-Auth-Token":token}});
  if(r.status===401){localStorage.removeItem(KEY);location.href="/drop";throw new Error("401");}
  return r;
}
async function post(path,body){
  const r=await fetch(path,{method:"POST",headers:{"X-Auth-Token":token,"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(r.status===401){localStorage.removeItem(KEY);location.href="/drop";throw new Error("401");}
  return r;
}

const CATS=["","image","video","audio","post","article","code","shop","document","note","link"];
function renderChips(){
  const c=$("#chips");c.innerHTML="";
  CATS.forEach(k=>{const b=document.createElement("button");b.textContent=k||"all";b.className=(k===cat?"on":"");b.onclick=()=>{cat=k;reset();};c.appendChild(b);});
}

function card(ref){
  const el=document.createElement("div");el.className="card";el.id="r-"+ref.id;
  const href=ref.url||"#";
  const inner=ref.image?'<img loading="lazy" src="'+ref.image+'">':'<span class="ph">'+icon(ref.category)+'</span>';
  const opts=CATS.filter(Boolean).map(c=>'<option value="'+c+'"'+(c===ref.category?' selected':'')+'>'+c+'</option>').join("");
  el.innerHTML=
    '<span class="badge">'+ref.category+'</span>'+
    '<button class="sim" title="Find similar">≈</button>'+
    '<button class="edit" title="Edit">✎</button>'+
    '<button class="del" title="Delete">✕</button>'+
    '<a class="thumb" href="'+href+'" target="_blank">'+inner+'</a>'+
    '<div class="meta"><div class="t">'+esc(ref.title||ref.text||ref.host||ref.url||"Untitled")+'</div>'+
    '<div class="h">'+esc(ref.host||"")+(ref.createdAt?' · '+new Date(ref.createdAt).toLocaleDateString():'')+'</div></div>'+
    '<div class="editor hide">'+
      '<label>Category</label><select class="ecat">'+opts+'</select>'+
      '<label>Tags (comma-separated)</label><input class="etags" value="'+esc((ref.tags||[]).join(", "))+'">'+
      '<div class="erow"><button class="cancel">Cancel</button><button class="save">Save</button></div>'+
    '</div>';
  const editor=el.querySelector(".editor");
  el.querySelector(".edit").onclick=()=>editor.classList.toggle("hide");
  el.querySelector(".cancel").onclick=()=>editor.classList.add("hide");
  el.querySelector(".save").onclick=async()=>{
    const category=el.querySelector(".ecat").value;
    const tags=el.querySelector(".etags").value;
    const r=await fetch("/api/ref/"+encodeURIComponent(ref.id),{method:"PATCH",headers:{"X-Auth-Token":token,"Content-Type":"application/json"},body:JSON.stringify({category,tags})});
    const d=await r.json();
    if(r.ok&&d.ok){ref.category=d.ref.category;ref.tags=d.ref.tags;el.querySelector(".badge").textContent=d.ref.category;editor.classList.add("hide");}
    else{alert("Save failed: "+(d.error||r.status));}
  };
  el.querySelector(".del").onclick=async()=>{
    if(!confirm("Delete this ref?"))return;
    await fetch("/api/ref/"+encodeURIComponent(ref.id),{method:"DELETE",headers:{"X-Auth-Token":token}});
    el.remove();
  };
  el.querySelector(".sim").onclick=()=>showSimilar(ref);
  return el;
}

// Pivot the grid to "things like this one" — pure vector similarity, no model.
async function showSimilar(ref){
  note("Similar to <b>"+esc(ref.title||ref.host||"this")+"</b> <span class=spin></span>");
  try{
    const r=await api("/api/similar/"+encodeURIComponent(ref.id)+"?limit=24");
    const d=await r.json();
    if(!d.ok){note("Couldn't do that: "+esc(d.error||"error"));return;}
    const grid=$("#grid");grid.innerHTML="";
    (d.refs||[]).forEach(x=>grid.appendChild(card(x)));
    cursor=null;$("#more").classList.add("hide");
    $("#empty").classList.toggle("hide",grid.children.length>0);
    note("Similar to <b>"+esc(ref.title||ref.host||"this")+"</b> — "+(d.refs||[]).length+" refs. "+
         '<a href="#" id="clearsim">Back to everything</a>');
    const c=document.getElementById("clearsim");
    if(c)c.onclick=e=>{e.preventDefault();$("#answer").classList.add("hide");reset();};
  }catch(e){}
}

function note(htmlStr){const a=$("#answer");a.classList.remove("hide");a.innerHTML='<div class="body">'+htmlStr+'</div>';}
function icon(c){return({image:"🖼️",video:"🎬",audio:"🎵",post:"💬",article:"📰",code:"💻",shop:"🛍️",document:"📄",note:"📝"})[c]||"🔗";}
function esc(s){return(s||"").replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));}

async function load(append){
  if(loading)return;loading=true;
  // "meaning" mode goes through the vector index instead of substring matching,
  // so "warehouse lighting" finds a ref titled "sodium vapour, Gastown 1987".
  if(mode==="sem"&&q){
    try{
      const r=await post("/api/search",{q,cat,limit:60});const d=await r.json();
      const grid=$("#grid");grid.innerHTML="";
      if(!d.ok){note("Semantic search is off: "+esc(d.error||"error"));}
      else (d.refs||[]).forEach(ref=>grid.appendChild(card(ref)));
      cursor=null;$("#more").classList.add("hide");
      $("#empty").classList.toggle("hide",grid.children.length>0);
    }catch(e){}finally{loading=false;}
    return;
  }
  const p=new URLSearchParams();p.set("limit","60");if(cat)p.set("cat",cat);if(q)p.set("q",q);if(append&&cursor)p.set("cursor",cursor);
  try{
    const r=await api("/api/list?"+p.toString());const d=await r.json();
    const grid=$("#grid");if(!append)grid.innerHTML="";
    (d.refs||[]).forEach(ref=>grid.appendChild(card(ref)));
    cursor=d.cursor;$("#more").classList.toggle("hide",!cursor);
    $("#empty").classList.toggle("hide",grid.children.length>0);
  }catch(e){}finally{loading=false;}
}
function reset(){cursor=null;renderChips();load(false);}

// ---- ask ----
// Renders the model's answer with [1]/[2] citations turned into source chips.
function renderAnswer(d){
  const a=$("#answer");a.classList.remove("hide");
  const srcs=d.sources||[];
  let body=esc(d.answer||"").replace(/\\[(\\d+)\\]/g,(m,n)=>{
    const s=srcs[+n-1];
    return s?'<b>['+n+']</b>':m;
  });
  const chips=srcs.map(s=>{
    const label='<span class="n">'+s.n+'</span><span class="tt">'+esc(s.title)+'</span>';
    return s.url?'<a class="src" href="'+esc(s.url)+'" target="_blank">'+label+'</a>'
                :'<span class="src">'+label+'</span>';
  }).join("");
  a.innerHTML='<div class="body">'+body+'</div>'+
    (srcs.length?'<div class="foot"><span class="muted" style="font-size:12px">sources</span>'+chips+
      '<span class="muted" style="font-size:11px;margin-left:auto">'+esc(d.model||"")+'</span></div>':"");
}

async function doAsk(){
  const question=$("#ask").value.trim();
  if(!question)return;
  note("Thinking <span class=spin></span>");
  try{
    const r=await post("/api/ask",{q:question,deep});
    const d=await r.json();
    if(!d.ok){note(esc(d.error||"Something went wrong."));return;}
    renderAnswer(d);
  }catch(e){note("Couldn't reach the brain.");}
}
$("#askgo").onclick=doAsk;
$("#ask").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();doAsk();}});
$("#deep").onclick=()=>{deep=!deep;$("#deep").classList.toggle("on",deep);};

function setMode(m){mode=m;$("#mkw").classList.toggle("on",m==="kw");$("#msem").classList.toggle("on",m==="sem");if(q)reset();}
$("#mkw").onclick=()=>setMode("kw");
$("#msem").onclick=()=>setMode("sem");

let t;$("#q").addEventListener("input",e=>{clearTimeout(t);t=setTimeout(()=>{q=e.target.value.trim();reset();},250);});
$("#more").onclick=()=>load(true);
$("#export").onclick=()=>{const a=document.createElement("a");a.href="/api/export";a.download="bigbrain-export.ndjson";
  fetch("/api/export",{headers:{"X-Auth-Token":token}}).then(r=>r.blob()).then(b=>{a.href=URL.createObjectURL(b);a.click();});};

reset();
</script>
</body>
</html>`;
