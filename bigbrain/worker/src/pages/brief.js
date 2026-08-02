// Served at GET /brief. The morning page: what landed overnight, what the
// brain noticed, what's waiting on him. Read top to bottom in twenty seconds
// on a phone — synthesis, then the counts as numerals big enough to take in at
// arm's length, then the new refs as a thumbable strip, then the one thing that
// needs a decision, with the door to /queue on it.
//
// It reacts, it doesn't initiate: nothing on this page starts a job, spends
// anything or changes a ref. The only button that costs money is `refresh`,
// and it says so.
//
// Self-contained: no external assets, no chart library — the realm split is a
// flex row of divs with percentage widths.
export const BRIEF_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>🧠 Big Brain — Brief</title>
<style>
  :root{--bg:#0f1115;--panel:#161a22;--line:#283042;--ink:#e7ecf5;--soft:#9aa6bd;--blue:#3b82f6;--ok:#22c55e;--bad:#ef4444;--warn:#f59e0b}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  .wrap{max-width:620px;margin:0 auto;padding:16px 14px calc(40px + env(safe-area-inset-bottom))}
  .top{display:flex;align-items:baseline;gap:12px;margin-bottom:16px}
  h1{font-size:17px;margin:0;font-weight:800}
  h2{font-size:11px;margin:0 0 8px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--soft)}
  a{color:var(--blue);text-decoration:none;font-size:14px}
  .day{margin-left:auto;color:var(--soft);font-size:13px;font-variant-numeric:tabular-nums}

  /* --- the paragraph on top --- */
  .lede{font-size:19px;line-height:1.45;margin:0;white-space:pre-wrap}
  .lede.plain{font-size:17px;color:var(--soft)}
  .by{color:var(--soft);font-size:11px;margin-top:10px;letter-spacing:.02em}
  .block{margin:0 0 22px}

  /* --- counts, big enough to read at arm's length --- */
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));gap:8px}
  .tile{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 10px;display:flex;flex-direction:column;gap:2px;min-width:0}
  .tile b{font-size:clamp(26px,8.5vw,34px);line-height:1;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  .tile sup{font-size:14px;color:var(--warn);vertical-align:super;margin-left:1px}
  .tile span{font-size:11px;color:var(--soft);line-height:1.3}
  .tile.warn b{color:var(--warn)}
  .tile.dim b{color:var(--soft)}

  /* --- what landed --- */
  .strip{display:flex;gap:10px;overflow-x:auto;padding-bottom:8px;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch}
  .strip::-webkit-scrollbar{height:0}
  .ref{flex:0 0 112px;scroll-snap-align:start;display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--ink)}
  .th{display:flex;align-items:center;justify-content:center;aspect-ratio:1;background:#0b0e14;border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .th img{width:100%;height:100%;object-fit:cover}
  .th i{font-style:normal;font-size:26px;opacity:.6}
  .rt{line-height:1.28;max-height:2.56em;overflow:hidden}
  .rm{color:var(--soft);font-size:10px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  /* --- the one decision --- */
  .cta{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 18px;font-size:15px;color:var(--ink)}
  .cta b{font-size:28px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1}
  .cta.go{border-color:#2c61b0;background:#16233c}
  .cta.go span{margin-left:auto;font-size:20px;color:var(--blue)}
  .cta.done{color:var(--soft)}
  .cta.bad{border-color:#7a2727}

  /* --- the archive's shape, CSS only --- */
  .bar{display:flex;height:12px;border-radius:99px;overflow:hidden;background:#0b0e14;border:1px solid var(--line)}
  .bar i{display:block;height:100%}
  .legend{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:10px}
  .lg{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--soft);font-variant-numeric:tabular-nums}
  .lg i{width:9px;height:9px;border-radius:3px;display:inline-block}
  .facts{font-size:13px;color:var(--soft);margin:0 0 10px;font-variant-numeric:tabular-nums}

  .foot{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;color:var(--soft);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
  .foot a{font-size:12px}
  details{margin-top:12px;color:var(--soft);font-size:12px}
  summary{cursor:pointer;color:var(--warn)}
  pre{white-space:pre-wrap;word-break:break-word;background:#0b0e14;border:1px solid var(--line);border-radius:10px;padding:10px;margin:8px 0 0;font-size:11px}
  .warnline{color:var(--warn);font-size:12px;margin:0 0 12px}
  .skel{background:var(--panel);border:1px solid var(--line);border-radius:14px;height:76px;animation:pulse 1.1s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.45}50%{opacity:.9}}
  .hide{display:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>🧠 Brief</h1>
    <a href="/queue">Queue</a>
    <a href="/browse">Gallery</a>
    <span class="day" id="day"></span>
  </div>

  <div class="block" id="synth"><div class="skel"></div></div>
  <div class="block"><div class="tiles" id="tiles"></div></div>
  <div class="block hide" id="landed"><h2 id="landedhead">What landed</h2><div class="strip" id="strip"></div></div>
  <div class="block" id="decide"></div>
  <div class="block hide" id="shape"></div>
  <div class="foot" id="foot"></div>
</div>

<script>
const KEY="bigbrain_token";
let token=localStorage.getItem(KEY)||"";
const $=s=>document.querySelector(s);
if(!token){location.href="/drop";}

let busy=false;

function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));}
function num(n){return n==null?"—":Number(n).toLocaleString();}
function icon(c){return({image:"🖼️",video:"🎬",audio:"🎵",post:"💬",article:"📰",code:"💻",shop:"🛍️",document:"📄",note:"📝"})[c]||"🔗";}
function ago(iso){
  const ms=Date.now()-Date.parse(iso);
  if(!isFinite(ms)||ms<0)return"";
  if(ms<3600000)return Math.max(1,Math.round(ms/60000))+"m ago";
  if(ms<172800000)return Math.round(ms/3600000)+"h ago";
  return Math.round(ms/86400000)+"d ago";
}

const RC={INSPO:"#c9a7ff",KNOWLEDGE:"#7fe0b0","CULTURE+NEWS":"#ffc978",SELF:"#9dc0ff",unassigned:"#47536e"};
function color(k){return RC[k]||"#5b6b8c";}
function pairs(o){return Object.keys(o||{}).map(k=>[k,o[k]]).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));}

// The deterministic version of the paragraph, for when the model is refused,
// unbound or broke. The page never goes wordless just because a tier did.
function headline(d){
  const l=d.landed||{},w=d.waiting||{};
  const day=(l.day&&l.day.count)||0,week=(l.week&&l.week.count)||0;
  const bits=[];
  if(day)bits.push(day+(day===1?" ref":" refs")+" landed in the last 24 hours");
  else if(week)bits.push("Nothing new overnight");
  else bits.push("Nothing landed this week");
  if(week&&week!==day)bits.push(week+" over the last "+(l.windowDays||7)+" days");
  if(l.quietHours!=null&&!day)bits.push("last save "+l.quietHours+"h ago");
  let s=bits.join(", ")+".";
  if(w.pending==null)s+=" The queue count didn't come back.";
  else if(w.pending)s+=" "+w.pending+" waiting on your thumb.";
  else s+=" Queue clear.";
  return s;
}

function renderSynth(d){
  const s=d.synthesis||{};
  if(s.text){
    $("#synth").innerHTML='<p class="lede">'+esc(s.text)+'</p>'+
      '<div class="by">'+esc(s.model||"")+(s.cost?" · $"+Number(s.cost).toFixed(3):"")+" · tier "+esc(s.tier)+'</div>';
    return;
  }
  $("#synth").innerHTML='<p class="lede plain">'+esc(headline(d))+'</p>'+
    '<div class="by">written from the numbers'+(s.reason?" — "+esc(s.reason):"")+'</div>';
}

function renderTiles(d){
  const l=d.landed||{},w=d.waiting||{},c=d.cost||{};
  const floor=l.complete===false;
  const rows=[
    {n:num(l.day&&l.day.count),k:"landed in 24h",cap:floor},
    {n:num(l.week&&l.week.count),k:"in "+((l.windowDays||7))+" days",cap:floor},
    {n:num(w.pending),k:w.pending==null?"queue unread":"waiting on you",tone:w.pending?"warn":(w.pending==null?"dim":"")},
    {n:(c.usd!=null?"$"+Number(c.usd).toFixed(2):"—"),k:"of $"+(c.ceiling!=null?c.ceiling:"?")+" today",tone:"dim"}
  ];
  $("#tiles").innerHTML=rows.map(r=>
    '<div class="tile'+(r.tone?" "+r.tone:"")+'"><b>'+esc(r.n)+
    (r.cap?'<sup title="the scan hit its read cap, so this is a floor">+</sup>':'')+
    '</b><span>'+esc(r.k)+'</span></div>').join("");
}

function renderLanded(d){
  const l=d.landed||{};
  const today=(l.day&&l.day.refs)||[];
  const week=(l.week&&l.week.refs)||[];
  const refs=today.length?today:week;
  if(!refs.length){$("#landed").classList.add("hide");return;}
  $("#landed").classList.remove("hide");
  $("#landedhead").textContent=today.length?"What landed overnight":"Nothing overnight — the last "+((l.windowDays||7))+" days";
  $("#strip").innerHTML=refs.map(r=>
    '<a class="ref" href="'+esc(r.url||"#")+'"'+(r.url?' target="_blank" rel="noreferrer"':'')+'>'+
      '<span class="th">'+(r.image?'<img loading="lazy" src="'+esc(r.image)+'" alt="">':'<i>'+icon(r.category)+'</i>')+'</span>'+
      '<span class="rt">'+esc(r.title)+'</span>'+
      '<span class="rm">'+esc(r.realm||r.category||"")+'</span>'+
    '</a>').join("");
}

function renderDecide(d){
  const w=d.waiting||{};
  if(w.pending==null){
    $("#decide").innerHTML='<div class="cta bad">The queue scan failed, so this page can\\'t tell you what\\'s waiting. '+
      '<a href="/queue">Open the queue</a> and look.</div>';
    return;
  }
  if(!w.pending){
    $("#decide").innerHTML='<div class="cta done">Queue clear.'+
      (w.approved?" "+num(w.approved)+" approved and not pushed anywhere yet.":"")+'</div>';
    return;
  }
  $("#decide").innerHTML='<a class="cta go" href="/queue"><b>'+num(w.pending)+'</b> waiting on your thumb<span>→</span></a>';
}

function renderShape(d){
  const s=d.shape||{};
  if(s.total==null){$("#shape").classList.add("hide");return;}
  $("#shape").classList.remove("hide");
  const split=pairs(s.byRealm);
  const seen=split.reduce((a,p)=>a+p[1],0);
  const bar=split.map(p=>'<i style="width:'+(seen?(p[1]*100/seen).toFixed(2):0)+'%;background:'+color(p[0])+'" title="'+esc(p[0]+" "+p[1])+'"></i>').join("");
  const legend=split.map(p=>'<span class="lg"><i style="background:'+color(p[0])+'"></i>'+esc(p[0])+" "+num(p[1])+'</span>').join("");
  const facts=num(s.total)+(s.exact===false?"+":"")+" refs · "+
    (s.embedded==null?"embedded count unavailable":num(s.embedded)+" embedded")+
    (s.unindexed?" · "+num(s.unindexed)+" not indexed":"");
  $("#shape").innerHTML='<h2>The archive</h2><p class="facts">'+esc(facts)+'</p>'+
    (seen?'<div class="bar">'+bar+'</div><div class="legend">'+legend+'</div>'+
      '<p class="facts" style="margin:10px 0 0">split across the newest '+num(s.basedOn)+' refs read, not all '+num(s.total)+'</p>':"");
}

function renderFoot(d){
  const bits=[];
  bits.push(d.cached?"cached · built "+ago(d.builtAt):"built just now");
  if(d.landed&&d.landed.undated)bits.push(num(d.landed.undated)+" refs read carried no date");
  const errs=(d.errors||[]);
  let html=bits.map(esc).join(" · ")+
    ' · <a href="#" id="refresh">refresh</a> · <a href="#" id="deep" title="rewrite the paragraph with Claude — costs about $0.02">deep</a>';
  if(errs.length){
    html+='<details><summary>'+errs.length+" thing"+(errs.length>1?"s":"")+' went wrong while building this</summary><pre>'+
      esc(errs.map(e=>(e.stage?e.stage+": ":"")+(e.error||JSON.stringify(e))).join("\\n"))+'</pre></details>';
  }
  $("#foot").innerHTML=html;
  $("#refresh").onclick=e=>{e.preventDefault();load({refresh:true});};
  $("#deep").onclick=e=>{e.preventDefault();load({refresh:true,deep:true});};
}

function render(d){
  $("#day").textContent=d.day||"";
  renderSynth(d);renderTiles(d);renderLanded(d);renderDecide(d);renderShape(d);renderFoot(d);
}

function fail(msg){
  $("#synth").innerHTML='<p class="lede plain">'+esc(msg)+'</p>'+
    '<div class="by"><a href="#" id="retry">try again</a></div>';
  $("#tiles").innerHTML="";
  const r=document.getElementById("retry");
  if(r)r.onclick=e=>{e.preventDefault();load({});};
}

async function load(opts){
  opts=opts||{};
  if(busy)return;
  busy=true;
  $("#synth").innerHTML='<div class="skel"></div>';
  const p=new URLSearchParams();
  if(opts.refresh)p.set("refresh","1");
  if(opts.deep)p.set("deep","1");
  const qs=p.toString();
  try{
    const r=await fetch("/api/brief"+(qs?"?"+qs:""),{headers:{"X-Auth-Token":token}});
    if(r.status===401){localStorage.removeItem(KEY);location.href="/drop";return;}
    const d=await r.json();
    if(!d||!d.ok){fail((d&&d.error)||("The worker answered "+r.status+"."));return;}
    render(d);
  }catch(err){
    fail("Couldn't reach the worker: "+(err&&err.message?err.message:err));
  }finally{busy=false;}
}

load({});
</script>
</body>
</html>`;
