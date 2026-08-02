// Every page is a template literal with no build step, so a syntax error in an
// inline script is invisible until the phone loads it — and he loads them on a
// phone, where there is no console to look at. This walks src/pages/*.js, pulls
// every <script> body out of every exported HTML string, and compiles it.
//
// It does not run them: there is no DOM here and no point pretending. Compiling
// is the whole job — it catches the class of error that actually happens when a
// `${...}` lands inside a template literal inside a template literal.
// No deps, no network. Run: node test/pages.test.mjs
import vm from "node:vm";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = join(here, "..", "src", "pages");

/** Every <script> body in a document, ignoring src-only tags (there are none). */
function scriptsIn(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || "";
    if (/\bsrc=/i.test(attrs)) continue;
    out.push({ attrs, body: m[2] });
  }
  return out;
}

const run = async () => {
  const files = readdirSync(pagesDir).filter((f) => f.endsWith(".js")).sort();
  ok("there are pages to check", files.length > 0);

  let documents = 0;
  let scripts = 0;

  for (const file of files) {
    const mod = await import(pathToFileURL(join(pagesDir, file)).href);
    const exported = Object.entries(mod).filter(([, v]) => typeof v === "string");
    ok(`${file} exports at least one document`, exported.length > 0);

    for (const [name, markup] of exported) {
      documents++;
      ok(`${file}:${name} is a whole document`, /<!doctype html>/i.test(markup));

      // A page that reaches for a CDN cannot be served offline or from a
      // locked-down phone, and this project has no build step to inline it.
      ok(`${file}:${name} loads nothing external`, !/<(script|link)[^>]+(src|href)=["']https?:/i.test(markup));

      const found = scriptsIn(markup);
      ok(`${file}:${name} has an inline script`, found.length > 0);

      for (const [i, s] of found.entries()) {
        scripts++;
        // Classic scripts only. `type=module` parses under different rules and
        // compiling it here would need --experimental-vm-modules — a flag the
        // test script doesn't pass, so a module page would silently stop being
        // checked. No page uses one; this is the assertion that keeps it true.
        ok(`${file}:${name} script #${i} is a classic script`, !/\btype=["']module["']/i.test(s.attrs));
        try {
          new vm.Script(s.body, { filename: `${file}:${name}:${i}` });
          pass++;
        } catch (err) {
          fail++;
          console.error(`✗ ${file}:${name} script #${i} does not parse\n   ${err.message}`);
        }
      }
    }
  }

  ok(`every page compiled (${documents} documents, ${scripts} scripts)`, fail === 0);

  // The two pages he taps on a phone every day. Named so that deleting one is a
  // decision rather than an accident.
  const names = files.join(" ");
  eq("the drop page is still here", names.includes("drop.js"), true);
  eq("and the map", names.includes("map.js"), true);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
