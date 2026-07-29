#!/usr/bin/env node
/**
 * Create (or find) the KV namespace and write its id into wrangler.toml.
 *
 * wrangler.toml ships with `id = "REPLACE_WITH_KV_ID"`, which fails the deploy
 * with "KV namespace 'REPLACE_WITH_KV_ID' is not valid [code: 10042]". The
 * documented fix is three manual steps: run a create command, copy a 32-char
 * hex id out of the output, and hand-edit a TOML file. This does all three.
 *
 * Safe to re-run: if a matching namespace already exists it reuses it rather
 * than creating a second one, and it never overwrites an id you've already set
 * unless you pass --force.
 *
 * Usage:  npm run setup-kv
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const TOML = join(HERE, "..", "wrangler.toml");

const PLACEHOLDER = "REPLACE_WITH_KV_ID";
const NAMESPACE = "save-ref-kv";
const force = process.argv.includes("--force");

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/**
 * wrangler renamed `kv:namespace` to `kv namespace` between v3 and v4, and
 * this repo can end up running either. Try the modern form, fall back.
 */
async function wrangler(args) {
  // ["kv","namespace","list"] (v4)  ->  ["kv:namespace","list"] (v3)
  const legacy =
    args[0] === "kv" && args[1] === "namespace" ? ["kv:namespace", ...args.slice(2)] : null;
  const attempts = legacy ? [args, legacy] : [args];
  let lastErr;
  for (const attempt of attempts) {
    try {
      return await run("npx", ["wrangler", ...attempt], { maxBuffer: 1024 * 1024 * 8, timeout: 120_000 });
    } catch (err) {
      lastErr = err;
      const msg = String(err.stderr || err.message || "");
      // Only fall through on a command-shape error; real failures should stop.
      if (!/unknown argument|not a valid|Unknown command|did you mean/i.test(msg)) throw err;
    }
  }
  throw lastErr;
}

console.log("\nBig Brain — KV setup\n");

let toml = await readFile(TOML, "utf8").catch(() => null);
if (!toml) {
  console.log(bad(`Couldn't read ${TOML}`));
  process.exit(1);
}

const current = toml.match(/^\s*id\s*=\s*"([^"]+)"/m)?.[1] || "";
if (current && current !== PLACEHOLDER && !force) {
  console.log(ok(`wrangler.toml already has a KV id (${current})`));
  console.log(dim("   Nothing to do. Re-run with --force to replace it.\n"));
  process.exit(0);
}

// ---- reuse an existing namespace if there is one ------------------------
let id = "";
try {
  const { stdout } = await wrangler(["kv", "namespace", "list"]);
  const json = stdout.slice(stdout.indexOf("["));
  const list = JSON.parse(json);
  const match = list.find((n) => typeof n?.title === "string" && n.title.includes(NAMESPACE));
  if (match?.id) {
    id = match.id;
    console.log(ok(`Found an existing namespace "${match.title}"`));
    console.log(dim("   Reusing it rather than creating a duplicate."));
  }
} catch {
  // Listing is a convenience; if it fails we just create one.
}

// ---- otherwise create it ------------------------------------------------
if (!id) {
  console.log(`Creating KV namespace "${NAMESPACE}" …`);
  try {
    const { stdout } = await wrangler(["kv", "namespace", "create", NAMESPACE]);
    // wrangler prints: { binding = "...", id = "0f2ac74b498b4802..." }
    id = stdout.match(/id\s*=\s*"([0-9a-f]{32})"/i)?.[1] || stdout.match(/\b([0-9a-f]{32})\b/)?.[1] || "";
    if (!id) {
      console.log(bad("Created it, but couldn't find the id in wrangler's output."));
      console.log(dim(stdout.split("\n").slice(0, 12).join("\n")));
      process.exit(1);
    }
    console.log(ok("Namespace created"));
  } catch (err) {
    const msg = String(err.stderr || err.message || "");
    console.log(bad("Couldn't create the namespace"));
    for (const l of msg.split("\n").map((s) => s.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter((l) => l && !/WARNING|proxy environment/i.test(l)).slice(0, 4)) {
      console.log(dim(`   ${l}`));
    }
    process.exit(1);
  }
}

// ---- write it into wrangler.toml ---------------------------------------
const before = toml;
toml = current
  ? toml.replace(/^(\s*id\s*=\s*)"[^"]+"/m, `$1"${id}"`)
  : toml.replace(new RegExp(`"${PLACEHOLDER}"`), `"${id}"`);

if (toml === before) {
  console.log(bad("Couldn't find the id line to update in wrangler.toml"));
  console.log(dim(`   Set it by hand: id = "${id}"`));
  process.exit(1);
}

await writeFile(TOML, toml);
console.log(ok(`wrangler.toml updated — REFS_KV id = ${id}`));
console.log(dim("   This id is not a secret; it's safe to commit."));
console.log("\nNext:\n");
console.log("  npx wrangler secret put AUTH_TOKEN");
console.log(dim("   (paste a long random string — generate one with: openssl rand -hex 32)"));
console.log("\n  npm run deploy\n");
