// The phone map. Served at GET /map. Progressive zoom: regions -> clusters -> refs.
//
// Built with CSS grid and plain DOM on purpose. A force simulation is the
// desktop idea that already failed here — 1,698 nodes on a 6-inch screen is
// unreadable however fast it draws. This shows one level at a time, in thumb-
// sized cards, and the phone only ever downloads the level it's looking at.
//
// Four things it has to do to feel like an app rather than a diagram:
//   - respond on touchdown, from cache, before the network is involved
//   - never draw more than a few screenfuls at once, whatever the level holds:
//     a cluster of 1,146 refs is 1,146 <img> tags, which is the ORIGINAL
//     complaint wearing a different hat. See REF_PAGE.
//   - never jump: a skeleton is drawn at the exact count that will land, in
//     tiles of a fixed height
//   - honour the back gesture, because on iOS that IS the back button — and
//     never let "back" mean "leave the map" from anywhere but the top
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
  .back:not([disabled]):active{border-color:var(--blue)}
  .crumbs{flex:1;min-width:0;display:flex;align-items:center;gap:2px;overflow-x:auto;scrollbar-width:none;
          font-size:13px;color:var(--soft);white-space:nowrap}
  .crumbs::-webkit-scrollbar{display:none}
  /* A crumb is a real target: full thumb height, and 12px of slack either side
     so two of them are never one blurred tap. */
  .crumbs .cr{flex:none;min-height:var(--tap);padding:0 12px;display:flex;align-items:center;color:var(--soft);
              background:none;border:0;border-radius:12px;font:inherit;font-size:13px}
  .crumbs button.cr{color:var(--blue);font-weight:600;cursor:pointer}
  .crumbs button.cr:active{background:#1b2030}
  .crumbs .cr.here{color:var(--ink);font-weight:700}
  .crumbs .sep{opacity:.45}
  .act{flex:none;min-width:var(--tap);height:var(--tap);border:1px solid var(--line);background:var(--panel);color:var(--soft);
       border-radius:14px;font:inherit;font-size:13px;padding:0 12px;display:flex;align-items:center;justify-content:center;cursor:pointer}

  .wrap{padding:12px 10px calc(env(safe-area-inset-bottom) + 40px);max-width:900px;margin:0 auto}
  .title{display:flex;align-items:baseline;gap:8px;margin:2px 2px 12px}
  .title h1{font-size:21px;margin:0;letter-spacing:-.01em}
  .title .n{color:var(--soft);font-size:13px}

  /* --- the levels. One grid, three densities. --- */
  .grid{display:grid;gap:10px}
  .grid.regions{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
  .grid.clusters{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
  .grid.refs{grid-template-columns:repeat(auto-fill,minmax(104px,1fr))}

  /* Whole tile is the target — nothing here needs a precise tap. */
  .tile{position:relative;display:block;border:1px solid var(--line);background:var(--panel);border-radius:16px;
        overflow:hidden;min-height:var(--tap);color:var(--ink);cursor:pointer;text-align:left;padding:0;font:inherit;
        transition:transform .12s ease,border-color .12s ease}
  /* .flat is a tile with nowhere to go — a ref saved with no source URL. It is a
     div, it carries no handler, and it must not press in under a thumb either,
     because something that moves and does nothing reads as a broken app. */
  .tile.flat{cursor:default;transition:none;opacity:.82}
  .tile:not(.flat):active{transform:scale(.972);border-color:var(--blue)}
  .tile .pic{display:block;width:100%;background:#0b0e14;overflow:hidden}
  .grid.regions .pic{aspect-ratio:5/4}
  .grid.clusters .pic{aspect-ratio:5/4}
  .grid.refs .pic{aspect-ratio:1/1}
  .tile .pic img{width:100%;height:100%;object-fit:cover;display:block}
  .tile .ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:30px;color:var(--soft)}
  /* Fixed height, not padding plus however much text there is: the skeleton and
     the real tile are then the same box, so nothing shifts when a level lands. */
  .tile .lab{display:block;padding:9px 11px 11px;height:76px;overflow:hidden}
  .tile .lab .t{font-weight:700;font-size:14px;line-height:1.25;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .grid.refs .lab{padding:7px 8px 9px;height:52px}
  .grid.refs .lab .t{font-size:12px;font-weight:600;-webkit-line-clamp:1}
  .tile .lab .s{display:block;color:var(--soft);font-size:11.5px;margin-top:3px;text-transform:uppercase;letter-spacing:.05em;
                overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pill{position:absolute;right:8px;top:8px;background:#000c;border:1px solid var(--line);border-radius:999px;
        font-size:11px;font-weight:700;padding:3px 9px;color:var(--ink)}

  /* Skeletons carry the exact count that will land, in the same box. */
  .tile.skel{border-style:dashed;pointer-events:none}
  .tile.skel .pic{background:linear-gradient(100deg,#141924 30%,#1d2432 50%,#141924 70%);background-size:220% 100%;animation:sh 1.1s linear infinite}
  .tile.skel .bar2{display:block;height:11px;width:72%;border-radius:6px;background:#1d2432}
  @keyframes sh{to{background-position:-220% 0}}

  .note{border:1px solid var(--line);background:var(--panel);border-radius:14px;padding:14px 15px;margin-bottom:12px;font-size:14px;color:var(--soft)}
  .note b{color:var(--ink)}
  .note.bad{border-color:var(--bad)}
  .note .row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  .note button{min-height:var(--tap);border:1px solid var(--line);background:#1b2030;color:var(--ink);border-radius:12px;
               padding:0 16px;font:inherit;font-weight:600;cursor:pointer}
  .note button.go{background:var(--blue);border-color:var(--blue);color:#fff}
  .foot{margin-top:20px;text-align:center;color:var(--soft);font-size:12px}
  /* The explicit half of paging, for the times a scroll listener isn't enough. */
  .more{display:block;margin:12px auto 0;min-height:var(--tap);border:1px solid var(--line);background:#1b2030;
        color:var(--ink);border-radius:14px;padding:0 22px;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
  .more:active{border-color:var(--blue)}
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

/**
 * Refs drawn per page.
 *
 * Chosen from the screen, not from the data. At 390px the refs grid is three
 * 104px columns, and a tile is a square thumbnail over a 52px label — about
 * 166px a row. A phone shows a bit over four rows at a time, so 60 refs is
 * roughly five screenfuls: far enough ahead that a flick never hits the end,
 * short enough that one tap costs 60 images instead of 1,146. How many the
 * cluster happens to hold gets no vote.
 */
const REF_PAGE=60;

/** Skeleton tiles for the shallower levels. Both are capped upstream anyway. */
const SKEL_MAX=24;

// Levels already fetched. Tapping something we've prefetched must not wait on
// the network at all — that is the whole difference between an app and a page.
const cache=new Map();
// Where he was on each level: scroll offset, and how much of a paged level had
// been drawn, so coming back doesn't land him below the end of a shorter page.
const place=new Map();
let state={level:"regions",region:"",cluster:""};
let seq=0;
// History entries this page pushed itself. Zero means the map is still sitting
// on the entry it was opened with, so history.back() would leave the site.
let owned=0;
// The refs level currently on screen, mid-page. Null at every other level.
let feed=null;

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
/** One level up — the only direction "back" ever means inside the map. */
function up(s){
  if(s.cluster)return {level:"clusters",region:s.region,cluster:""};
  return {level:"regions",region:"",cluster:""};
}

async function api(path){
  const r=await fetch(path,{headers:{"X-Auth-Token":token}});
  if(r.status===401){localStorage.removeItem(KEY);location.href="/drop";throw new Error("401");}
  return r;
}

/** Any GET against the brain, with its failures as data rather than throws. */
async function get(path){
  try{
    const r=await api(path);
    const d=await r.json();
    return d||{ok:false,error:"empty response",nodes:[]};
  }catch(e){
    return {ok:false,error:"Couldn't reach the brain ("+(e&&e.message?e.message:"network")+")",nodes:[]};
  }
}

// One level, from cache if we have it. A level that failed to load must never
// render as "this part of the archive is empty".
async function fetchLevel(s){
  const k=keyFor(s);
  if(cache.has(k))return cache.get(k);
  const d=await get(urlFor(s));
  if(d&&d.ok)cache.set(k,d);
  return d;
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
/**
 * One card. Three shapes, and the shape follows what it can actually do:
 *   href    -> <a>, opens the ref
 *   onTap   -> <button>, drills in
 *   neither -> <div class="tile flat">: no handler, no press animation
 * Nothing here gets a listener it doesn't need, or feedback it can't honour.
 */
function tile(o){
  const kind=o.href?"a":o.onTap?"button":"div";
  const el=document.createElement(kind);
  el.className="tile"+(kind==="div"?" flat":"");
  if(o.href){el.href=o.href;el.target="_blank";el.rel="noopener";}
  const pic=o.image
    ? '<span class="pic"><img loading="lazy" decoding="async" src="'+esc(o.image)+'" alt=""></span>'
    : '<span class="pic"><span class="ph">'+(o.glyph||"◻︎")+'</span></span>';
  el.innerHTML=pic+
    (o.count!=null?'<span class="pill">'+o.count+'</span>':"")+
    '<span class="lab"><span class="t">'+esc(o.title)+'</span>'+
    (o.sub?'<span class="s">'+esc(o.sub)+'</span>':"")+'</span>';
  if(o.onTap)el.addEventListener("click",e=>{if(e&&e.preventDefault)e.preventDefault();o.onTap();});
  return el;
}

function skeleton(n,cls){
  const g=$("#stage");g.className="grid "+cls;g.innerHTML="";
  const cap=cls==="refs"?REF_PAGE:SKEL_MAX;
  const many=Math.max(1,Math.min(n||6,cap));
  for(let i=0;i<many;i++){
    const el=document.createElement("div");
    el.className="tile skel";
    el.innerHTML='<span class="pic"></span><span class="lab"><span class="bar2"></span></span>';
    g.appendChild(el);
  }
}

function crumbs(path){
  const c=$("#crumbs");c.innerHTML="";
  const list=path||[];
  list.forEach((p,i)=>{
    if(i){const s=document.createElement("span");s.className="sep";s.textContent="›";c.appendChild(s);}
    const last=i===list.length-1;
    // Where he is now is a label, not a control: a span, so it gets no press
    // feedback and VoiceOver doesn't offer it as a button that does nothing.
    const b=document.createElement(last?"span":"button");
    b.className="cr"+(last?" here":"");
    b.textContent=p.label||"Map";
    if(!last){
      b.addEventListener("click",()=>{
        go(p.level==="regions"?{level:"regions",region:"",cluster:""}
                              :{level:"clusters",region:p.id,cluster:""});
      });
    }
    c.appendChild(b);
  });
  $("#back").disabled=list.length<2;
}

function note(html,bad){
  const n=$("#note");n.className="note"+(bad?" bad":"");n.innerHTML=html;
}
function clearNote(){$("#note").className="note hide";$("#note").innerHTML="";}

/** The foot is a line of text plus, on a paged level, the control that adds to it. */
function foot(text,button){
  const f=$("#foot");
  f.innerHTML="";
  f.textContent=text||"";
  if(button)f.appendChild(button);
}

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
  foot(bits.join(" · "));
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
  // Only the first screenful — prefetching 24 clusters on cellular is rude.
  (d.nodes||[]).slice(0,6).forEach(n=>prefetch({level:"refs",region:r.id,cluster:n.id}));
  foot(d.builtAt?"built "+new Date(d.builtAt).toLocaleString():"");
}

// ---- the refs level, the only one that can be enormous ----

/** Everything in hand is drawn, and there is nothing left to ask for. */
function feedDone(){return !feed||(feed.drawn>=feed.nodes.length&&!feed.cursor);}

function stopFeed(){
  if(feed&&feed.onScroll)window.removeEventListener("scroll",feed.onScroll);
  feed=null;
}

/** Foot line, "show more" control and scroll listener, kept in step with the feed. */
function syncFeed(){
  if(!feed)return;
  const bits=[];
  if(feed.note)bits.push(feed.note);
  if(feedDone()){
    foot(bits.join(" · "));
    // Nothing more to hand him: stop listening, and take the control away
    // rather than leave a button that would do nothing.
    if(feed.onScroll){window.removeEventListener("scroll",feed.onScroll);feed.onScroll=null;}
    return;
  }
  bits.push(feed.drawn+" of "+feed.total+" shown");
  const b=document.createElement("button");
  b.className="more";
  b.textContent=feed.error?"Try again":feed.loading?"Loading…":"Show more";
  b.disabled=Boolean(feed.loading);
  b.addEventListener("click",()=>more());
  foot(bits.join(" · "),b);
  if(!feed.onScroll){
    feed.onScroll=()=>{
      if(feedDone()||feed.loading)return;
      // A flick reaches the end of the drawn page before the thumb stops.
      if(window.scrollY+window.innerHeight>=document.body.scrollHeight-900)more();
    };
    window.addEventListener("scroll",feed.onScroll,{passive:true});
  }
}

/** Draw the next n refs already in hand. */
function drawRefs(n){
  if(!feed)return;
  const g=$("#stage");
  const stop=Math.min(feed.nodes.length,feed.drawn+Math.max(1,n));
  for(let i=feed.drawn;i<stop;i++){
    const r=feed.nodes[i]||{};
    g.appendChild(tile({
      title:r.title,sub:r.host,image:r.image,glyph:icon(r.category),
      // No url is no destination — tile() makes that a flat div, not a button.
      href:r.url||""
    }));
  }
  feed.drawn=stop;
  syncFeed();
}

/** One more page: out of memory if we have it, otherwise off the cursor. */
function more(){
  if(!feed||feed.loading||feedDone())return;
  if(feed.drawn<feed.nodes.length){drawRefs(REF_PAGE);return;}
  const mine=feed;
  const s=state;
  mine.loading=true;mine.error="";
  syncFeed();
  (async()=>{
    const d=await get(urlFor(s)+"&cursor="+encodeURIComponent(mine.cursor));
    if(feed!==mine)return; // he walked off the level while it was in flight
    mine.loading=false;
    if(!d||!d.ok){mine.error=d&&d.error?d.error:"couldn't load more";syncFeed();return;}
    mine.error="";
    mine.nodes=mine.nodes.concat(d.nodes||[]);
    mine.cursor=d.nextCursor||"";
    // Keep the cache in step, so coming back doesn't re-fetch what we hold.
    const cached=cache.get(keyFor(s));
    if(cached){cached.nodes=mine.nodes.slice();cached.nextCursor=mine.cursor;}
    drawRefs(REF_PAGE);
  })();
}

function renderRefs(d,startDrawn){
  const here=(d.path||[])[2]||{};
  $("#h1").textContent=here.label||"Cluster";
  // The count is the whole cluster even though the grid is one page of it —
  // he should know how deep this is, he just shouldn't be handed all of it.
  $("#count").textContent=(d.total||0)+" refs";
  const g=$("#stage");g.className="grid refs";g.innerHTML="";
  const nodes=(d.nodes||[]).slice();
  feed={
    nodes,
    total:d.total||nodes.length,
    cursor:d.nextCursor||"",
    drawn:0,
    loading:false,
    error:"",
    onScroll:null,
    note:d.via==="rule"?"grouped by kind, not by meaning":""
  };
  // A page — or as much of one as he'd already opened before walking away.
  drawRefs(Math.max(REF_PAGE,startDrawn||0));
}

// Expected child count, so the skeleton is the right size and nothing reflows
// when the real level lands. Never more than one page: that IS what lands.
function expected(s){
  if(s.cluster){
    const parent=cache.get("r:"+s.region);
    const hit=parent&&(parent.nodes||[]).find(n=>n.id===s.cluster);
    return Math.min(hit?hit.count:12,REF_PAGE);
  }
  if(s.region){
    const parent=cache.get("regions");
    const hit=parent&&(parent.nodes||[]).find(n=>n.id===s.region);
    return hit?hit.clusterCount:8;
  }
  return 6;
}

/** Remember where he was on the level he's leaving. */
function rememberPlace(){
  place.set(keyFor(state),{y:window.scrollY||0,drawn:feed?feed.drawn:0});
}

async function render(s,{push=true}={}){
  const nextKey=keyFor(s);
  if(keyFor(state)!==nextKey)rememberPlace();
  stopFeed();
  state=s;
  const mine=++seq;
  const cls=s.cluster?"refs":s.region?"clusters":"regions";
  const h=hashFor(s);
  if(push&&location.hash!==h){history.pushState(s,"",h);owned++;}
  // Saved on every render, not just on a tap — walking BACK out of a cluster is
  // just as much "where he was" as walking into one.
  try{localStorage.setItem(PATHKEY,h);}catch(e){}
  // Coming back — the gesture, or our own back button — returns him to the
  // spot he left. Going somewhere new starts at the top.
  const spot=push?null:place.get(nextKey)||null;
  const cached=cache.get(nextKey);
  if(!cached){clearNote();skeleton(expected(s),cls);$("#h1").textContent=" ";$("#count").textContent="";foot("");}
  crumbs(cached?cached.path:placeholderPath(s));

  const d=cached||await fetchLevel(s);
  if(mine!==seq)return; // he tapped again while this was in flight

  if(!d.ok){
    $("#stage").innerHTML="";
    $("#h1").textContent="Map";$("#count").textContent="";foot("");
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
  if(d.level==="refs")renderRefs(d,spot?spot.drawn:0);
  else if(d.level==="clusters")renderClusters(d);
  else renderRegions(d);
  // An empty level is a real answer, but it must read as one rather than as a
  // page that failed to draw.
  if(!(d.nodes||[]).length){
    note(d.level==="regions"
      ? '<b>The map is empty.</b><br>No refs are in it yet. Rebuild it once there are some.'
      : '<b>Nothing in here.</b><br>This part of the map came back empty — rebuilding will re-cut it.');
  }
  window.scrollTo(0,spot?spot.y:0);
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
    cache.clear();place.clear();
    await render({level:"regions",region:"",cluster:""},{push:true});
  }catch(e){
    note('<b>Build failed.</b><br>'+esc(e&&e.message?e.message:"network"),true);
  }
  if(btn)btn.disabled=false;
}

/**
 * Wire the page up and open it where he left off. A saved path only wins when
 * the URL doesn't carry one, so a shared or bookmarked link still lands where
 * it points.
 *
 * None of this runs without a token: a doomed request and a flash of skeleton
 * on the way to /drop is worse than just going there.
 */
function start(){
  // The page restores its own scroll position per level; the browser guessing
  // as well is how a restored level lands halfway down the wrong grid.
  try{if("scrollRestoration" in history)history.scrollRestoration="manual";}catch(e){}

  $("#back").onclick=()=>{
    if($("#back").disabled)return; // top level: there is no up from here
    // Two ways up, and they must agree. If this page pushed the entry we're
    // standing on, the phone's back gesture and this button are the same move,
    // so defer to it. If it didn't — he opened /map straight onto a saved deep
    // path — history.back() would leave the site, so walk up a level ourselves
    // and push that, which also gives the gesture somewhere inside the map to
    // go back to.
    if(owned>0){history.back();return;}
    go(up(state));
  };

  // The gesture. Every entry it can reach from here is one of ours.
  window.addEventListener("popstate",()=>{
    if(owned>0)owned--;
    render(parseHash(location.hash),{push:false});
  });

  $("#rebuild").onclick=()=>{
    if(!confirm("Recompute the map from all refs?"))return;
    doRebuild($("#rebuild"));
  };

  let h=location.hash;
  if(!h||h==="#"){
    try{h=localStorage.getItem(PATHKEY)||"#/";}catch(e){h="#/";}
  }
  history.replaceState(null,"",h);
  render(parseHash(h),{push:false});
}

if(token)start();
</script>
</body>
</html>`;
