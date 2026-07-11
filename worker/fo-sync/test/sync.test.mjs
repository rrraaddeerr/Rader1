// Integration test for the fo-sync Worker — Map-backed KV, plain node.
// Run: node test/sync.test.mjs
import worker from "../src/index.js";

let pass = 0, fail = 0;
const ok = (l, c) => c ? pass++ : (fail++, console.error("✗ " + l));
const eq = (l, g, w) => ok(`${l} (got ${JSON.stringify(g)})`, g === w);

function makeKV() {
  const m = new Map();
  return {
    async get(k, t) { const v = m.get(k); if (v == null) return null; return t === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    _m: m,
  };
}
const env = { FO_KV: makeKV() };
const req = (path, opts = {}) => new Request("http://x" + path, opts);
const call = (path, opts) => worker.fetch(req(path, opts), env, {});

const run = async () => {
  // health
  let r = await call("/health"); eq("health", r.status, 200);

  // create profile -> friendly code
  r = await call("/profile", { method: "POST" });
  let d = await r.json();
  eq("profile created", r.status, 200);
  ok("code looks friendly: " + d.code, /^[a-z]+-[a-z]+-\d{2}$/.test(d.code));
  const code = d.code;

  // empty state initially
  r = await call("/state/" + code);
  d = await r.json();
  eq("fresh state ok", r.status, 200);
  eq("fresh data empty", JSON.stringify(d.data), "{}");

  // save state
  const payload = { data: { saved: ["l1", "l2"], credits: 7, flair: "🔥" } };
  r = await call("/state/" + code, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  d = await r.json();
  eq("put ok", r.status, 200);
  ok("put returns updatedAt", typeof d.updatedAt === "string");

  // read it back
  r = await call("/state/" + code);
  d = await r.json();
  eq("roundtrip credits", d.data.credits, 7);
  eq("roundtrip flair", d.data.flair, "🔥");
  eq("roundtrip saved len", d.data.saved.length, 2);

  // unknown code -> 404 on GET and PUT
  r = await call("/state/no-such-00"); eq("unknown GET 404", r.status, 404);
  r = await call("/state/no-such-00", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  eq("unknown PUT 404", r.status, 404);

  // bad code format -> 400
  r = await call("/state/not!valid"); eq("bad code 400", r.status, 400);

  // bad body -> 400
  r = await call("/state/" + code, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
  eq("missing data 400", r.status, 400);

  // codes are unique-ish across calls
  const a = (await (await call("/profile", { method: "POST" })).json()).code;
  const b = (await (await call("/profile", { method: "POST" })).json()).code;
  ok("two profiles differ", a !== b);

  // ---- friends / messaging ----
  // a sends an "ask" to b's inbox
  r = await call("/msg/" + b, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: a, fromName: "Mia", kind: "ask", text: "How do I style this?", lookName: "Avant Drape" }) });
  d = await r.json();
  eq("send msg ok", r.status, 200);
  const mid = d.id; ok("msg has id", !!mid);
  // b reads inbox
  r = await call("/inbox/" + b); d = await r.json();
  eq("inbox has 1", d.messages.length, 1);
  eq("inbox from a", d.messages[0].from, a);
  eq("inbox name", d.messages[0].fromName, "Mia");
  // b acks/removes it
  r = await call("/inbox/" + b, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ remove: [mid] }) });
  d = await r.json();
  eq("inbox cleared", d.messages.length, 0);
  // send to unknown code -> 404
  r = await call("/msg/no-such-00", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: a, text: "hi" }) });
  eq("msg unknown 404", r.status, 404);
  // bad sender -> 400
  r = await call("/msg/" + b, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "nope", text: "hi" }) });
  eq("msg bad sender 400", r.status, 400);

  // ---- family group board (group-only) ----
  const fam = "mellow-otter-42";
  // empty to start
  r = await call("/board/" + fam); d = await r.json();
  eq("board empty ok", r.status, 200); eq("board empty len", d.messages.length, 0);
  // grown-up posts to the group
  r = await call("/board/" + fam, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromName: "Rader", grown: true, text: "Who's bringing the marshmallows?" }) });
  d = await r.json(); eq("board post ok", r.status, 200); ok("board post id", !!d.id);
  // kid posts to the group
  await call("/board/" + fam, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromName: "Andre", grown: false, text: "meee 🔥" }) });
  // everyone reads the same thread, oldest->newest
  r = await call("/board/" + fam); d = await r.json();
  eq("board has 2", d.messages.length, 2);
  eq("board order 1", d.messages[0].fromName, "Rader");
  eq("board order 2", d.messages[1].fromName, "Andre");
  eq("board flags grown", d.messages[0].grown, true);
  // empty text rejected
  r = await call("/board/" + fam, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fromName: "x", text: "  " }) });
  eq("board empty text 400", r.status, 400);
  // bad group code -> 400
  r = await call("/board/not!valid"); eq("board bad code 400", r.status, 400);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};
run().catch((e) => { console.error(e); process.exit(1); });
