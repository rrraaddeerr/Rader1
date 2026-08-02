// The phone map. Served at GET /map. Progressive zoom: regions -> clusters -> refs.
//
// Built with CSS grid and plain DOM on purpose. A force simulation is the
// desktop idea that already failed here — 1,698 nodes on a 6-inch screen is
// unreadable however fast it draws. This shows one level at a time, in thumb-
// sized cards, and the phone only ever downloads the level it's looking at.
//
// Three things it has to do to feel like an app rather than a diagram:
//   - respond on touchdown, from cache, before the network is involved
//   - never jump: a skeleton is drawn at the exact count the parent promised
//   - honour the back gesture, because on iOS that IS the back button
export const MAP_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>🧠 Big Brain — Map</title>
<style>
  :root{--bg:#0f1115;--panel:#161a22;--line:#283042;--ink:#e7ecf5;--soft:#9aa6bd;--blue:#3b82f6;--bad:#ef4444;--tap:44px}
  *{box-sizing:border-box}
  html,body{overscroll-behavior-y:none}
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);-webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%}
  a{color:var(--blue);text-decoration:none}

  /* --- the bar. Sticky, thumb-height, clear of the notch. --- */
  .bar{position:sticky;top:0;z-index:20;background:rgba(15,17,21,.92);backdrop-filter:saturate(1.4) blur(12px);
       border-bottom:1px solid var(--line);padding:calc(env(safe-area-inset-top) + 6px) 10px 6px;
       display:flex;align-items:center;gap:8px}
  .back{flex:none;width:var(--tap);height:var(--tap);border:1px solid var(--line);background:var(--panel);color:var(--ink);
        border-radius:14px;font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer}
  .back[disabled]{opacity:.35}
  .crumbs{flex:1;min-width:0;display:flex;align-items:center;gap:6px;overflow-x:auto;scrollbar-width:none;
          font-size:13px;color:var(--soft);white-space:nowrap}
  .crumbs::-webkit-scrollbar{display:none}
  /* A crumb is the only way back up two levels at once, so it is a target and
     not a word: full thumb height, with room either side so the › between two
     of them never eats the tap. */
  .crumbs .cr{flex:none;display:flex;align-items:center;min-height:var(--tap);padding:0 8px;
              border:0;background:none;font:inherit;font-size:13px;color:var(--soft);cursor:pointer}
  .crumbs .cr.here{color:var(--ink);font-weight:700;cursor:default}
  .crumbs .sep{flex:none;opacity:.45}
  .act{flex:none;min-width:var(--tap);height:var(--tap);border:1px solid var(--line);background:var(--panel);color:var(--soft);
       border-radius:14px;font:inherit;font-size:13px;padding:0 12px;display:flex;align-items:center;justify-content:center;cursor:pointer}

  .wrap{padding:12px 10px calc(env(safe-area-inset-bottom) + 40px);max-width:900px;margin:0 auto}
  /* At 390px "Digital/3D post-internet image culture" is wider than the screen.
     Wrapping the row keeps the count on one line under it instead of letting
     both shrink and stack two words at a time beside each other. */
  .title{display:flex;align-items:baseline;gap:8px;margin:2px 2px 12px;flex-wrap:wrap}
  .title h1{font-size:21px;margin:0;letter-spacing:-.01em;min-width:0;overflow-wrap:anywhere}
  .title .n{color:var(--soft);font-size:13px;white-space:nowrap}

  /* --- the levels. One grid, three densities. --- */
  .grid{display:grid;gap:10px}
  .grid.regions{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
  .grid.clusters{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
  .grid.refs{grid-template-columns:repeat(auto-fill,minmax(104px,1fr))}

  /* Whole tile is the target — nothing here needs a precise tap. */
  .tile{position:relative;display:block;border:1px solid var(--line);background:var(--panel);border-radius:16px;
        overflow:hidden;min-height:var(--tap);color:var(--ink);cursor:pointer;text-align:left;padding:0;font:inherit;
        transition:transform .12s ease,border-color .12s ease}
  .tile:active{transform:scale(.972);border-color:var(--blue)}
  /* A tile that leads nowhere must not press like one — a scale-down that
     resolves to nothing is how a page tells him it's broken. */
  .tile.flat{cursor:default}
  .tile.flat:active{transform:none;border-color:var(--line)}
  .tile .pic{display:block;width:100%;background:#0b0e14;overflow:hidden}
  .grid.regions .pic{aspect-ratio:5/4}
  .grid.clusters .pic{aspect-ratio:5/4}
  .grid.refs .pic{aspect-ratio:1/1}
  .tile .pic img{width:100%;height:100%;object-fit:cover;display:block}
  .tile .ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:30px;color:var(--soft)}
  /* Fixed height, because the skeleton has to be the same box. The title clamps
     to two lines and the sublabel to one, so no label can outgrow it and no row
     shifts under his thumb when the real level lands. */
  .tile .lab{padding:9px 11px 11px;height:76px;overflow:hidden}
  .tile .lab .t{font-weight:700;font-size:14px;line-height:1.25;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .grid.refs .lab{padding:7px 8px 9px;height:68px}
  .grid.refs .lab .t{font-size:12px;font-weight:600}
  .tile .lab .s{color:var(--soft);font-size:11.5px;margin-top:3px;text-transform:uppercase;letter-spacing:.05em;
                overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pill{position:absolute;right:8px;top:8px;background:#000c;border:1px solid var(--line);border-radius:999px;
        font-size:11px;font-weight:700;padding:3px 9px;color:var(--ink)}

  /* Skeletons carry the exact count the parent promised, so nothing reflows. */
  .tile.skel{border-style:dashed;pointer-events:none}
  .tile.skel .pic{background:linear-gradient(100deg,#141924 30%,#1d2432 50%,#141924 70%);background-size:220% 100%;animation:sh 1.1s linear infinite}
  /* Same .lab box as a real tile, so the swap is invisible rather than a jump. */
  .tile.skel .bar2{display:block;height:13px;border-radius:6px;background:#1d2432}
  .tile.skel .bar2.b{width:62%;height:10px;margin-top:8px;background:#19202e}
  @keyframes sh{to{background-position:-220% 0}}

  .note{border:1px solid var(--line);background:var(--panel);border-radius:14px;padding:14px 15px;margin-bottom:12px;font-size:14px;color:var(--soft)}
  .note b{color:var(--ink)}
  .note.bad{border-color:var(--bad)}
  .note .row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  .note button{min-height:var(--tap);border:1px solid var(--line);background:#1b2030;color:var(--ink);border-radius:12px;
               padding:0 16px;font:inherit;font-weight:600;cursor:pointer}
  .note button.go{background:var(--blue);border-color:var(--blue);color:#fff}
  .foot{margin-top:20px;text-align:center;color:var(--soft);font-size:12px}
  /* Never stranded: the other surfaces are one thumb away at the bottom. */
  .nav{display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap}
  .nav a{min-height:var(--tap);display:flex;align-items:center;padding:0 16px;border:1px solid var(--line);
         background:var(--panel);border-radius:14px;color:var(--soft);font-size:14px;font-weight:600}
  .hide{display:none}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--blue);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px}
  @keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<div class="bar">
  <button class="back" id="back" aria-label="Back">‹</button>
  <div class="crumbs" id="crumbs"></div>
  <button class="act" id="rebuild" title="Recompute the map">↻</button>
</div>

<div class="wrap">
  <div class="title"><h1 id="h1">Map</h1><span class="n" id="count"></span></div>
  <div id="note" class="note hide"></div>
  <div id="stage" class="grid regions"></div>
  <div class="foot" id="foot"></div>
  <div class="nav"><a href="/browse">Gallery</a><a href="/queue">Queue</a><a href="/brief">Brief</a><a href="/drop">Drop</a></div>
</div>

<script>
const KEY="bigbrain_token";
const PATHKEY="bigbrain_map_path";
const token=localStorage.getItem(KEY)||"";
const $=s=>document.querySelector(s);
if(!token){location.href="/drop";}

// Levels already fetched. Tapping something we've prefetched must not wait on
// the network at all — that is the whole difference between an app and a page.
const cache=new Map();
// Where he was on each level. Backing out of a cluster must return him to the
// thumbnail he tapped, not to the top of a grid he'd already scrolled through.
const scrollAt=new Map();
let state={level:"regions",region:"",cluster:""};
let seq=0;
// History entries this page pushed itself. Reopened at a saved path it has
// pushed none, and that is the difference between "up" and "off the site".
let pushed=0;
// The refs grid draws in batches; this is the listener feeding it, held here so
// leaving the level can stop it.
let grow=null;
function stopGrowing(){if(grow){window.removeEventListener("scroll",grow);grow=null;}}

// One tap must not cost a thousand tiles. Cluster sizes are not bounded — once
// the vector pass fills its 24 slots the whole remainder of a region lands in
// one tail bucket — and building that many nodes and <img>s at once is a tap
// that visibly freezes in the hand.
const REF_PAGE=60;

function esc(s){return(s||"").replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));}
function icon(c){return({image:"🖼️",video:"🎬",audio:"🎵",post:"💬",article:"📰",code:"💻",shop:"🛍️",document:"📄",note:"📝"})[c]||"🔗";}

// ---- routing ----
// #/                       regions
// #/r/<region>             that region's clusters
// #/r/<region>/c/<cluster> that cluster's refs
function hashFor(s){
  if(s.cluster)return "#/r/"+encodeURIComponent(s.region)+"/c/"+encodeURIComponent(s.cluster);
  if(s.region)return "#/r/"+encodeURIComponent(s.region);
  return "#/";
}
function parseHash(h){
  const m=/^#\\/r\\/([^/]+)(?:\\/c\\/([^/]+))?/.exec(h||"");
  if(!m)return {level:"regions",region:"",cluster:""};
  const region=decodeURIComponent(m[1]);
  const cluster=m[2]?decodeURIComponent(m[2]):"";
  return {level:cluster?"refs":"clusters",region,cluster};
}
function keyFor(s){return s.cluster?"c:"+s.cluster:s.region?"r:"+s.region:"regions";}
function urlFor(s){
  if(s.cluster)return "/api/map?cluster="+encodeURIComponent(s.cluster);
  if(s.region)return "/api/map?region="+encodeURIComponent(s.region);
  return "/api/map";
}

async function api(path){
  const r=await fetch(path,{headers:{"X-Auth-Token":token}});
  if(r.status===401){localStorage.removeItem(KEY);location.href="/drop";throw new Error("401");}
  return r;
}

// One level, from cache if we have it. Errors come back as data — a level that
// failed to load must never render as "this part of the archive is empty".
async function fetchLevel(s){
  const k=keyFor(s);
  if(cache.has(k))return cache.get(k);
  let d;
  try{
    const r=await api(urlFor(s));
    d=await r.json();
  }catch(e){
    return {ok:false,error:"Couldn't reach the brain ("+(e&&e.message?e.message:"network")+")",nodes:[]};
  }
  if(d&&d.ok)cache.set(k,d);
  return d||{ok:false,error:"empty response",nodes:[]};
}

function prefetch(s){
  const k=keyFor(s);
  if(cache.has(k))return;
  const idle=window.requestIdleCallback||(f=>setTimeout(f,60));
  // fetchLevel returns its failures as data and only caches successes, so a
  // prefetch that fails leaves no trace and the real tap re-runs it and shows
  // the error properly. The only thing thrown here is the 401 redirect.
  idle(()=>{fetchLevel(s).catch(()=>{});});
}

// ---- rendering ----
function tile(o){
  // Refs saved without a source URL — a screenshot, a note — are real things to
  // look at and dead ends to tap. They render as plain cards, not as buttons
  // wired to nothing.
  const live=Boolean(o.href||o.onTap);
  const el=document.createElement(o.href?"a":live?"button":"div");
  el.className="tile"+(live?"":" flat");
  if(o.href){el.href=o.href;el.target="_blank";el.rel="noopener";}
  const pic=o.image
    ? '<span class="pic"><img loading="lazy" decoding="async" src="'+esc(o.image)+'" alt=""></span>'
    : '<span class="pic"><span class="ph">'+(o.glyph||"◻︎")+'</span></span>';
  el.innerHTML=pic+
    (o.count!=null?'<span class="pill">'+o.count+'</span>':"")+
    '<span class="lab"><span class="t">'+esc(o.title)+'</span>'+
    (o.sub?'<span class="s">'+esc(o.sub)+'</span>':"")+'</span>';
  if(o.onTap)el.addEventListener("click",e=>{if(!o.href)e.preventDefault();o.onTap();});
  return el;
}

function skeleton(n,cls){
  const g=$("#stage");g.className="grid "+cls;g.innerHTML="";
  // Capped at the same batch the refs grid draws first, so the skeleton and the
  // thing that replaces it are the same number of the same-sized boxes.
  const many=Math.max(1,Math.min(n||6,REF_PAGE));
  for(let i=0;i<many;i++){
    const el=document.createElement("div");
    el.className="tile skel";
    el.innerHTML='<span class="pic"></span><span class="lab"><span class="bar2"></span><span class="bar2 b"></span></span>';
    g.appendChild(el);
  }
}

function crumbs(path){
  const c=$("#crumbs");c.innerHTML="";
  (path||[]).forEach((p,i)=>{
    if(i){const s=document.createElement("span");s.className="sep";s.textContent="›";c.appendChild(s);}
    // A crumb he can go back to is a button — a span gets no press state and
    // VoiceOver never announces it as something to hit.
    const b=document.createElement(i===path.length-1?"span":"button");
    b.className="cr"+(i===path.length-1?" here":"");
    b.textContent=p.label||"Map";
    if(i<path.length-1){
      b.style.color="var(--blue)";
      b.addEventListener("click",()=>{
        go(p.level==="regions"?{level:"regions",region:"",cluster:""}
                              :{level:"clusters",region:p.id,cluster:""});
      });
    }
    c.appendChild(b);
  });
  $("#back").disabled=(path||[]).length<2;
}

function note(html,bad){
  const n=$("#note");n.className="note"+(bad?" bad":"");n.innerHTML=html;
}
function clearNote(){$("#note").className="note hide";$("#note").innerHTML="";}

function renderRegions(d){
  $("#h1").textContent="Map";
  $("#count").textContent=d.total?d.total+" refs":"";
  const g=$("#stage");g.className="grid regions";g.innerHTML="";
  (d.nodes||[]).forEach(n=>{
    g.appendChild(tile({
      title:n.label,sub:n.sublabel||n.realm,image:n.image,count:n.count,glyph:"🧠",
      onTap:()=>go({level:"clusters",region:n.id,cluster:""})
    }));
    prefetch({level:"clusters",region:n.id,cluster:""});
  });
  const c=d.clustering||{};
  const bits=[];
  if(d.builtAt)bits.push("built "+new Date(d.builtAt).toLocaleString());
  if(c.vectors===false)bits.push("grouped by kind — no vector index");
  if(d.truncated)bits.push("partial: the scan hit its limit");
  $("#foot").textContent=bits.join(" · ");
}

function renderClusters(d){
  const r=d.region||{};
  $("#h1").textContent=r.label||"Region";
  $("#count").textContent=(r.count||0)+" refs · "+(d.nodes||[]).length+" clusters";
  const g=$("#stage");g.className="grid clusters";g.innerHTML="";
  (d.nodes||[]).forEach(n=>{
    g.appendChild(tile({
      title:n.label,sub:n.via==="rule"?"by kind":"",image:n.image,count:n.count,glyph:"◍",
      onTap:()=>go({level:"refs",region:state.region||r.id,cluster:n.id})
    }));
  });
  // Only the first screenful — prefetching 24 clusters on cellular is rude —
  // and never a bucket big enough to be a download in its own right. The tail
  // cluster of a big region really does hold ~1,100 refs, which is ~450KB he
  // did not ask for.
  (d.nodes||[]).slice(0,6).forEach(n=>{
    if((n.count||0)<=REF_PAGE*2)prefetch({level:"refs",region:r.id,cluster:n.id});
  });
  $("#foot").textContent=d.builtAt?"built "+new Date(d.builtAt).toLocaleString():"";
}

function renderRefs(d){
  const here=(d.path||[])[2]||{};
  $("#h1").textContent=here.label||"Cluster";
  const all=d.nodes||[];
  // The count is the whole cluster even though the grid isn't yet, so a batched
  // screen never reads as a cluster that lost most of itself.
  $("#count").textContent=(d.total||all.length)+" refs";
  const g=$("#stage");g.className="grid refs";g.innerHTML="";
  let at=0;
  const draw=()=>{
    const end=Math.min(all.length,at+REF_PAGE);
    for(;at<end;at++){
      const n=all[at];
      g.appendChild(tile({title:n.title,sub:n.host,image:n.image,glyph:icon(n.category),href:n.url||""}));
    }
    if(at>=all.length)stopGrowing();
  };
  draw();
  if(at<all.length){
    // A screen of runway ahead of the thumb, so the next batch is already there
    // by the time he reaches it and the scroll never stalls.
    grow=()=>{if((window.scrollY||0)+window.innerHeight*2>=document.body.scrollHeight)draw();};
    window.addEventListener("scroll",grow,{passive:true});
  }
  $("#foot").textContent=d.via==="rule"?"grouped by kind, not by meaning":"";
}

// Expected child count, so the skeleton is the right size and nothing reflows
// when the real level lands.
function expected(s){
  if(s.cluster){
    const parent=cache.get("r:"+s.region);
    const hit=parent&&(parent.nodes||[]).find(n=>n.id===s.cluster);
    return hit?hit.count:12;
  }
  if(s.region){
    const parent=cache.get("regions");
    const hit=parent&&(parent.nodes||[]).find(n=>n.id===s.region);
    return hit?hit.clusterCount:8;
  }
  return 6;
}

async function render(s,{push=true,restore=0}={}){
  stopGrowing();
  const from=location.hash;
  state=s;
  const mine=++seq;
  const cls=s.cluster?"refs":s.region?"clusters":"regions";
  const h=hashFor(s);
  if(push&&location.hash!==h){
    scrollAt.set(from,window.scrollY||0);
    history.pushState(s,"",h);
    pushed++;
  }
  // Saved on every render, not just on a tap — walking BACK out of a cluster is
  // just as much "where he was" as walking into one.
  try{localStorage.setItem(PATHKEY,h);}catch(e){}
  const cached=cache.get(keyFor(s));
  if(!cached){clearNote();skeleton(expected(s),cls);$("#h1").textContent=" ";$("#count").textContent="";}
  crumbs(cached?cached.path:placeholderPath(s));

  const d=cached||await fetchLevel(s);
  if(mine!==seq)return; // he tapped again while this was in flight

  if(!d.ok){
    $("#stage").innerHTML="";
    $("#h1").textContent="Map";$("#count").textContent="";
    if(d.needsBuild){
      note('<b>The map hasn\\'t been built yet.</b><br>It groups all '+
           'your refs into regions and clusters. That takes a minute and costs nothing.'+
           '<div class="row"><button class="go" id="build">Build it now</button></div>');
      const b=document.getElementById("build");
      if(b)b.onclick=()=>doRebuild(b);
    }else{
      note('<b>Couldn\\'t load this level.</b><br>'+esc(d.error||"unknown error")+
           '<div class="row"><button class="go" id="retry">Try again</button></div>',true);
      const r=document.getElementById("retry");
      if(r)r.onclick=()=>{cache.delete(keyFor(s));render(s,{push:false});};
    }
    return;
  }
  clearNote();
  crumbs(d.path);
  if(d.level==="refs")renderRefs(d);
  else if(d.level==="clusters")renderClusters(d);
  else renderRegions(d);
  // An empty level is a real answer, but it must read as one rather than as a
  // page that failed to draw.
  if(!(d.nodes||[]).length){
    note(d.level==="regions"
      ? '<b>The map is empty.</b><br>No refs are in it yet. Rebuild it once there are some.'
      : '<b>Nothing in here.</b><br>This part of the map came back empty — rebuilding will re-cut it.');
  }
  window.scrollTo(0,restore||0);
}

// Crumbs while a level is still loading, so the bar doesn't pop in late.
function placeholderPath(s){
  const out=[{level:"regions",id:"",label:"Map"}];
  if(s.region){
    const idx=cache.get("regions");
    const hit=idx&&(idx.nodes||[]).find(n=>n.id===s.region);
    out.push({level:"clusters",id:s.region,label:hit?hit.label:"…"});
  }
  if(s.cluster)out.push({level:"refs",id:s.cluster,label:"…"});
  return out;
}

function go(s){render(s,{push:true});}

$("#back").onclick=()=>{
  // history.back() is the same move as the phone's back gesture only while
  // we're inside our own stack. Reopened at a saved path the page has pushed
  // nothing, history.length still counts wherever he came from, and back()
  // would throw him off the map entirely instead of climbing out of it.
  if(pushed>0){history.back();return;}
  go(state.cluster?{level:"clusters",region:state.region,cluster:""}
                  :{level:"regions",region:"",cluster:""});
};

window.addEventListener("popstate",()=>{
  // Forward re-entry would undercount this, and the cost of that is one
  // in-app climb instead of a gesture. Leaving the map cannot be the cost.
  pushed=Math.max(0,pushed-1);
  const h=location.hash;
  render(parseHash(h),{push:false,restore:scrollAt.get(h)||0});
});

// The rebuild is a full scan — slow enough that it needs a visible state, and
// the bar button must not resize while it runs, so the progress lives in the
// note and the button only ever gets disabled.
async function doRebuild(btn){
  if(btn)btn.disabled=true;
  note('<b>Recomputing the map.</b> <span class=spin></span><br>Scanning every ref and grouping them. This takes a moment.');
  try{
    const r=await fetch("/api/map/rebuild",{method:"POST",headers:{"X-Auth-Token":token}});
    if(r.status===401){localStorage.removeItem(KEY);location.href="/drop";return;}
    const d=await r.json();
    if(!d.ok){note('<b>Build failed.</b><br>'+esc(d.error||("HTTP "+r.status)),true);if(btn)btn.disabled=false;return;}
    cache.clear();
    await render({level:"regions",region:"",cluster:""},{push:true});
  }catch(e){
    note('<b>Build failed.</b><br>'+esc(e&&e.message?e.message:"network"),true);
  }
  if(btn)btn.disabled=false;
}
$("#rebuild").onclick=()=>{
  if(!confirm("Recompute the map from all refs?"))return;
  doRebuild($("#rebuild"));
};

// Open where he left off. A saved path only wins when the URL doesn't carry
// one, so a shared or bookmarked link still lands where it points.
(function start(){
  // Without a token every request is a guaranteed 401, so bail before firing
  // one — otherwise a skeleton flashes behind a redirect he never asked to see.
  if(!token)return;
  // The page owns scroll position now (see scrollAt); Safari also restoring it
  // on popstate puts him in two places at once.
  if("scrollRestoration" in history)history.scrollRestoration="manual";
  let h=location.hash;
  if(!h||h==="#"){
    try{h=localStorage.getItem(PATHKEY)||"#/";}catch(e){h="#/";}
    history.replaceState(null,"",h);
  }else{
    history.replaceState(null,"",h);
  }
  render(parseHash(h),{push:false});
})();
</script>
</body>
</html>`;
