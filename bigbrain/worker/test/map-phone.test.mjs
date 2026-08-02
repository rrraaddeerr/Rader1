// The map, judged as a thing held in a hand.
//
// map.test.mjs checks the tree. This checks the page: it runs the inline script
// in a fake DOM and asserts what the thumb actually gets — how much lands on one
// tap, whether "back" stays inside the map, whether a target is big enough to
// hit, and whether the level he came back to is still where he left it.
//
// No deps, no network, no bindings. Run: node test/map-phone.test.mjs
import vm from "node:vm";
import { MAP_HTML } from "../src/pages/map.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

// --------------------------------------------------------------- a fake phone
/** Just enough DOM for this page. `tap()` is what his thumb does. */
class El {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.style = {};
    this.children = [];
    this.handlers = {};
    this.textContent = "";
    this.disabled = false;
    this._html = "";
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; if (!v) this.children.length = 0; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }
  removeEventListener(t, f) {
    const a = this.handlers[t] || [];
    const i = a.indexOf(f);
    if (i >= 0) a.splice(i, 1);
  }
  tap() { for (const f of (this.handlers.click || []).slice()) f({ preventDefault() {} }); }
}

/**
 * A phone with the page loaded on it.
 *
 * `levels` is the fake `/api/map`: keyed by the query string the page builds,
 * so a wrong URL shows up as a miss rather than as silently empty data.
 */
function boot(levels, { startHash = "", savedPath = "", historyLength = 3, token = true } = {}) {
  const ids = ["back", "crumbs", "rebuild", "h1", "count", "note", "stage", "foot"];
  const registry = Object.fromEntries(ids.map((id) => ["#" + id, new El("div")]));
  const scrolls = [];
  const fetched = [];

  const store = new Map(token ? [["bigbrain_token", "T"]] : []);
  if (savedPath) store.set("bigbrain_map_path", savedPath);

  const loc = { hash: startHash, href: "/map", pathname: "/map" };
  const hist = {
    length: historyLength,
    backCalls: 0,
    scrollRestoration: "auto",
    pushState(_s, _t, url) { this.length++; loc.hash = url; },
    replaceState(_s, _t, url) { if (url) loc.hash = url; },
    back() { this.backCalls++; },
  };

  const win = {
    scrollY: 0,
    innerHeight: 800,
    handlers: {},
    // Prefetch is deliberately inert here so the fetch log is only what a tap
    // actually cost.
    requestIdleCallback() {},
    scrollTo(x, y) { scrolls.push([x, y]); win.scrollY = y; },
    addEventListener(t, f) { (win.handlers[t] = win.handlers[t] || []).push(f); },
    removeEventListener(t, f) {
      const a = win.handlers[t] || [];
      const i = a.indexOf(f);
      if (i >= 0) a.splice(i, 1);
    },
    fire(t) { for (const f of (win.handlers[t] || []).slice()) f({}); },
  };

  const document = {
    body: { scrollHeight: 4000 },
    querySelector: (s) => registry[s] || null,
    getElementById: (id) => registry["#" + id] || null,
    createElement: (tag) => new El(tag),
  };

  const ctx = vm.createContext({
    document,
    window: win,
    location: loc,
    history: hist,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    confirm: () => true,
    console,
    setTimeout,
    async fetch(path) {
      fetched.push(path);
      const body = levels[path];
      if (!body) return { status: 404, async json() { return { ok: false, error: "no such level: " + path }; } };
      return { status: 200, async json() { return body; } };
    },
  });

  const src = MAP_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(src, ctx);
  return { registry, win, hist, loc, scrolls, fetched, store, $: (s) => registry[s] };
}

/** Let the page's un-awaited render()s finish. */
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// --------------------------------------------------------------- fake archive
const BIG = 1146; // measured: the tail bucket of INSPO once 24 vector clusters fill up

const clusterNodes = [];
for (let i = 1; i <= 25; i++) {
  clusterNodes.push({ id: "inspo--all-c" + i, label: "Group " + i, via: i === 25 ? "rule" : "vector", count: i === 25 ? BIG : 18, image: "" });
}
const refNodes = [];
for (let i = 0; i < BIG; i++) {
  refNodes.push({ id: "r" + i, title: "Instagram", host: "instagram.com", url: "https://instagram.com/p/" + i, image: "https://img.test/" + i + ".jpg", category: "image" });
}
// One ref with nothing to open — a screenshot saved with no source URL.
refNodes[0] = { id: "r0", title: "Screenshot", host: "", url: "", image: "https://img.test/0.jpg", category: "image" };

const LEVELS = {
  "/api/map": {
    ok: true, level: "regions", total: 1578, builtAt: "2026-08-01T00:00:00.000Z",
    path: [{ level: "regions", id: "", label: "Map" }],
    nodes: [{ id: "inspo--all", label: "INSPO", sublabel: "everything else", count: 1578, image: "", clusterCount: 25 }],
  },
  "/api/map?region=inspo--all": {
    ok: true, level: "clusters", total: 1578, builtAt: "2026-08-01T00:00:00.000Z",
    path: [{ level: "regions", id: "", label: "Map" }, { level: "clusters", id: "inspo--all", label: "INSPO" }],
    region: { id: "inspo--all", label: "INSPO", count: 1578 },
    nodes: clusterNodes,
  },
  "/api/map?cluster=inspo--all-c25": {
    ok: true, level: "refs", total: BIG, via: "rule", builtAt: "2026-08-01T00:00:00.000Z",
    path: [
      { level: "regions", id: "", label: "Map" },
      { level: "clusters", id: "inspo--all", label: "INSPO" },
      { level: "refs", id: "inspo--all-c25", label: "instagram.com" },
    ],
    nodes: refNodes,
  },
};

// ------------------------------------------------- one tap must not cost 1,146 tiles
{
  const p = boot(LEVELS, { startHash: "#/r/inspo--all/c/inspo--all-c25" });
  await settle();
  const stage = p.$("#stage");
  eq("the refs level is the refs grid", stage.className, "grid refs");
  ok(
    `one tap draws a screenful, not the whole cluster (drew ${stage.children.length} of ${BIG})`,
    stage.children.length > 0 && stage.children.length <= 90
  );
  eq("but the count still admits how many there are", p.$("#count").textContent, BIG + " refs");

  // Scrolling keeps handing him more, and eventually all of it.
  let guard = 0;
  while (stage.children.length < BIG && guard++ < 200) {
    p.win.scrollY += 2000;
    p.win.fire("scroll");
    await settle(2);
  }
  eq("scrolling reaches every ref in the cluster", stage.children.length, BIG);
  ok("and stops listening once there is nothing left", (p.win.handlers.scroll || []).length === 0);
}

// ------------------------------------------------------- a ref with no URL is not a button
{
  const p = boot(LEVELS, { startHash: "#/r/inspo--all/c/inspo--all-c25" });
  await settle();
  const first = p.$("#stage").children[0];
  ok("a ref with a URL opens it", p.$("#stage").children[1].tagName === "a");
  ok("a ref with nothing to open is not pressable", first.tagName !== "a" && first.tagName !== "button");
  ok("and it does not animate under a thumb that gets nothing", /\bflat\b/.test(first.className));
  eq("nor does it carry a dead tap handler", (first.handlers.click || []).length, 0);
}

// ------------------------------------------- "back" out of a restored path stays in the map
{
  // How he actually opens it: tap the bookmark, land where he left off. The page
  // restores that with replaceState, so it has pushed nothing of its own — and
  // history.back() would leave the site.
  const p = boot(LEVELS, { savedPath: "#/r/inspo--all/c/inspo--all-c25", historyLength: 4 });
  await settle();
  eq("it reopens where he left off", p.$("#h1").textContent, "instagram.com");
  ok("and back is offered", p.$("#back").disabled === false);

  p.$("#back").onclick();
  await settle();
  eq("back does not throw him out of the map", p.hist.backCalls, 0);
  eq("it goes up one level instead", p.$("#h1").textContent, "INSPO");
}

// ------------------------------------------------- back inside our own stack is still the gesture
{
  const p = boot(LEVELS, { startHash: "#/" });
  await settle();
  p.$("#stage").children[0].tap(); // into the region
  await settle();
  eq("tapping a region drills in", p.$("#h1").textContent, "INSPO");
  p.$("#back").onclick();
  eq("once the page owns the entry, back IS the phone's back gesture", p.hist.backCalls, 1);
}

// ----------------------------------------------------------- coming back keeps his place
{
  const p = boot(LEVELS, { startHash: "#/r/inspo--all" });
  await settle();
  p.win.scrollY = 1400; // he scrolled a long way down 25 clusters
  p.$("#stage").children[24].tap(); // into the last one
  await settle();
  eq("drilling in starts at the top", p.scrolls[p.scrolls.length - 1][1], 0);

  p.loc.hash = "#/r/inspo--all";
  p.win.fire("popstate");
  await settle();
  eq("coming back lands where he was", p.scrolls[p.scrolls.length - 1][1], 1400);
  ok("and the phone is told not to also guess", p.hist.scrollRestoration === "manual");
}

// ------------------------------------------------------------------ tap targets
{
  const css = MAP_HTML.slice(MAP_HTML.indexOf("<style>"), MAP_HTML.indexOf("</style>"));
  const rule = (sel) => {
    const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}").exec(css);
    return m ? m[1] : "";
  };
  ok("a breadcrumb is a thumb-sized target", /min-height:var\(--tap\)/.test(rule(".crumbs .cr")));
  ok("and has room either side of it", /padding:0 (?:[1-9]|1[0-9])px/.test(rule(".crumbs .cr")));
  ok("the back button is 44px", /height:var\(--tap\)/.test(rule(".back")));
  ok("so is the rebuild button", /height:var\(--tap\)/.test(rule(".act")));
  ok("nothing on this page waits for a hover", !/:hover/.test(css));

  // A tappable crumb has to BE a button — a span gets no press feedback and no
  // VoiceOver affordance.
  const p = boot(LEVELS, { startHash: "#/r/inspo--all/c/inspo--all-c25" });
  await settle();
  const crumbs = p.$("#crumbs").children;
  eq("three crumbs at the deepest level", crumbs.filter((c) => /\bcr\b/.test(c.className)).length, 3);
  eq("the two he can go back to are buttons", crumbs.filter((c) => c.tagName === "button").length, 2);
  eq("where he is now is not", crumbs.filter((c) => /\bhere\b/.test(c.className))[0].tagName, "span");
}

// --------------------------------------------------- the skeleton is the size of the thing
{
  // The page's own promise: "a skeleton is drawn at the exact count the parent
  // promised" so nothing reflows. A picture-sized box over a half-height label
  // bar is not the same box, and every row shifts when the level lands.
  const css = MAP_HTML.slice(MAP_HTML.indexOf("<style>"), MAP_HTML.indexOf("</style>"));
  ok("the label block is a fixed height", /\.tile \.lab\{[^}]*height:\d+px/.test(css));
  ok("and a denser one on the refs grid", /\.grid\.refs \.lab\{[^}]*height:\d+px/.test(css));
  ok("the skeleton uses that same block", /skel[\s\S]{0,400}class="lab"/.test(MAP_HTML) || /class="lab"[\s\S]{0,200}bar2/.test(MAP_HTML));
}

// ------------------------------------------------------- no token, no requests
{
  // A page with no token must go to /drop and stop — not fire a doomed request
  // and flash a skeleton at him on the way out.
  const p = boot(LEVELS, { token: false });
  await settle();
  eq("no token sends him to /drop", p.loc.href, "/drop");
  eq("and nothing is asked of the brain first", p.fetched.length, 0);
  eq("and no skeleton flashes behind the redirect", p.$("#stage").children.length, 0);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
