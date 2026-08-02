// Served at GET /shortcuts. The iPhone setup guide — four ways to reach Big
// Brain without opening a browser. Fills in your real worker URL and token so
// every field is copy-paste ready.
export const SHORTCUTS_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>🧠 Big Brain — iPhone setup</title>
<style>
  :root{--bg:#0f1115;--panel:#161a22;--panel2:#1b2030;--line:#283042;--ink:#e7ecf5;--soft:#9aa6bd;--blue:#3b82f6;--ok:#22c55e}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  .wrap{max-width:760px;margin:0 auto;padding:26px 18px 90px}
  h1{font-size:26px;margin:0 0 4px}
  h2{font-size:18px;margin:0}
  .sub{color:var(--soft);margin:0 0 22px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;margin:16px 0}
  .head{display:flex;gap:10px;align-items:baseline;margin-bottom:4px}
  .num{width:26px;height:26px;flex:0 0 26px;border-radius:50%;background:var(--blue);color:#fff;font-size:13px;font-weight:800;display:flex;align-items:center;justify-content:center}
  .why{color:var(--soft);font-size:14px;margin:2px 0 12px 36px}
  ol{margin:0 0 0 36px;padding-left:18px}
  li{margin-bottom:7px}
  code{background:#0b0e14;border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px;word-break:break-all}
  .field{display:flex;gap:8px;align-items:center;margin:8px 0 8px 36px}
  .field code{flex:1;padding:9px 11px}
  button{font:inherit;font-weight:700;border:0;border-radius:9px;padding:9px 13px;background:#222a39;color:var(--ink);cursor:pointer;white-space:nowrap}
  button:hover{background:#2c3448}
  button.copy:hover{background:var(--blue);color:#fff}
  .lbl{font-size:12px;color:var(--soft);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 2px 36px}
  .note{background:var(--panel2);border-left:3px solid var(--blue);border-radius:0 10px 10px 0;padding:10px 14px;margin:14px 0 0 36px;font-size:14px;color:var(--soft)}
  .links{display:flex;gap:16px;justify-content:center;margin-top:26px}
  a{color:var(--blue);text-decoration:none}
  .warn{background:#2a1d17;border:1px solid #7a4a27;border-radius:12px;padding:14px 16px;margin:0 0 18px}
</style>
</head>
<body>
<div class="wrap">
  <h1>🧠 Big Brain on your phone</h1>
  <p class="sub">Four ways in, from zero taps to a conversation. Set up the ones you'll use.</p>

  <div id="notok" class="warn">Open this page after saving your token on <a href="/drop">/drop</a> — the fields below fill in with your real URL and token once you have.</div>

  <div class="card">
    <div class="head"><span class="num">1</span><h2>Share sheet — from any app</h2></div>
    <p class="why">The workhorse. Anything with a Share button — Safari, Instagram, Photos, Notes — can send straight to the brain.</p>
    <ol>
      <li>Open <strong>Shortcuts</strong> → <strong>+</strong> → rename it <strong>Big Brain</strong>.</li>
      <li>Tap the ⓘ info button → turn on <strong>Show in Share Sheet</strong>.</li>
      <li>Under <em>Accepted types</em>, keep <strong>URLs, Text, Images</strong> (turn the rest off).</li>
      <li>Add action <strong>Get Contents of URL</strong> and set:</li>
    </ol>
    <div class="lbl">URL</div>
    <div class="field"><code id="u1"></code><button class="copy" data-c="u1">Copy</button></div>
    <div class="lbl">Method</div>
    <div class="field"><code>POST</code></div>
    <div class="lbl">Headers</div>
    <div class="field"><code>X-Auth-Token</code> = <code id="t1"></code><button class="copy" data-c="t1">Copy</button></div>
    <div class="lbl">Request Body → JSON</div>
    <div class="field"><code>url</code> (Text) = <strong>Shortcut Input</strong></div>
    <p class="note">Sharing a <em>photo</em> instead of a link? Add an <strong>If</strong> on the input type: for images set the body to <strong>File</strong> (Shortcut Input) and add header <code>Content-Type</code> = <code>image/jpeg</code>. The worker takes raw bytes on the same endpoint.</p>
  </div>

  <div class="card">
    <div class="head"><span class="num">2</span><h2>Back Tap — zero taps, zero UI</h2></div>
    <p class="why">Double- or triple-tap the back of the phone and whatever's on your clipboard lands in the brain. Nothing opens. Fastest possible save.</p>
    <ol>
      <li>Duplicate the shortcut above, rename it <strong>Brain Grab</strong>.</li>
      <li>Replace the body value with <strong>Clipboard</strong> instead of Shortcut Input.</li>
      <li>End with a <strong>Vibrate Device</strong> action so you feel the confirm.</li>
      <li><strong>Settings → Accessibility → Touch → Back Tap → Triple Tap</strong> → pick <strong>Brain Grab</strong>.</li>
    </ol>
    <p class="note">Prefer the side button? <strong>Settings → Accessibility → Accessibility Shortcut</strong> is the triple-click; it only lists accessibility features, so Back Tap is the one that runs a Shortcut directly.</p>
  </div>

  <div class="card">
    <div class="head"><span class="num">3</span><h2>Capture + one line — why you saved it</h2></div>
    <p class="why">One extra second, and it's the most valuable second. Your own words are the only part of a ref that isn't scraped — they're what makes taste synthesis sound like you.</p>
    <ol>
      <li>Duplicate <strong>Brain Grab</strong>, rename it <strong>Brain + Note</strong>.</li>
      <li>Before the URL action, add <strong>Ask for Input</strong> → Text → prompt <em>"why?"</em>.</li>
      <li>In the JSON body add a second field <code>note</code> (Text) = <strong>Provided Input</strong>.</li>
      <li>Put this one on Double Tap, and the silent one on Triple Tap.</li>
    </ol>
  </div>

  <div class="card">
    <div class="head"><span class="num">4</span><h2>Voice — ask the archive out loud</h2></div>
    <p class="why">Hands full, in a warehouse, walking. "Hey Siri, ask Big Brain" — spoken answer back, grounded in your refs.</p>
    <ol>
      <li>New shortcut named <strong>Ask Big Brain</strong> (the name becomes the Siri phrase).</li>
      <li>Add <strong>Dictate Text</strong>.</li>
      <li>Add <strong>Get Contents of URL</strong>, method <strong>POST</strong>, URL:</li>
    </ol>
    <div class="field"><code id="u2"></code><button class="copy" data-c="u2">Copy</button></div>
    <div class="lbl">Headers</div>
    <div class="field"><code>X-Auth-Token</code> = <code id="t2"></code><button class="copy" data-c="t2">Copy</button></div>
    <div class="lbl">Request Body → JSON</div>
    <div class="field"><code>q</code> (Text) = <strong>Dictated Text</strong></div>
    <ol start="4">
      <li>Finish with <strong>Speak Text</strong> on the result.</li>
    </ol>
    <p class="note"><code>?format=text</code> is already on that URL so the reply comes back as plain prose, not JSON — <strong>Speak Text</strong> can read it straight out. Add <code>&amp;deep=1</code> when you want Claude to do the thinking instead of the fast model.</p>
  </div>

  <div class="links">
    <a href="/drop">Drop</a>
    <a href="/browse">Gallery</a>
  </div>
</div>

<script>
const token=localStorage.getItem("bigbrain_token")||"";
const O=location.origin;
document.getElementById("u1").textContent=O+"/save";
document.getElementById("u2").textContent=O+"/api/ask?format=text";
document.getElementById("t1").textContent=token||"(save your token on /drop first)";
document.getElementById("t2").textContent=token||"(save your token on /drop first)";
if(token)document.getElementById("notok").style.display="none";
document.querySelectorAll(".copy").forEach(b=>{
  b.onclick=async()=>{
    const text=document.getElementById(b.dataset.c).textContent;
    try{await navigator.clipboard.writeText(text);const o=b.textContent;b.textContent="✓";setTimeout(()=>b.textContent=o,1200);}catch(e){}
  };
});
</script>
</body>
</html>`;
