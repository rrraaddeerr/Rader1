#!/usr/bin/env node
/**
 * Cloudflare preflight — run this instead of reading wrangler error output.
 *
 * `wrangler vectorize create` failed with "Authentication error [code: 10000]"
 * while calling a DIFFERENT account id than the one `wrangler whoami` reports.
 * That's two independent problems wearing one error message:
 *
 *   1. a CLOUDFLARE_ACCOUNT_ID in the environment pointing somewhere else
 *   2. an OAuth token issued before Vectorize existed, so it has no
 *      `vectorize` scope no matter which account it targets
 *
 * This checks both, plus whether the indexes already exist, and prints the
 * exact commands to fix whatever it finds. It changes nothing on its own.
 *
 * Usage:  npm run doctor
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const TOML = join(HERE, "..", "wrangler.toml");

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m!\x1b[0m ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const problems = [];
const fixes = [];

console.log("\nBig Brain — Cloudflare preflight\n");

// ---------------------------------------------------------- 1. environment
const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const envToken = process.env.CLOUDFLARE_API_TOKEN || "";

if (envAccount) {
  console.log(warn(`CLOUDFLARE_ACCOUNT_ID is set: ${envAccount}`));
  console.log(dim("   This overrides everything else, including wrangler.toml."));
} else {
  console.log(ok("CLOUDFLARE_ACCOUNT_ID is not set (good — wrangler will resolve it)"));
}
if (envToken) {
  console.log(warn("CLOUDFLARE_API_TOKEN is set — it takes precedence over your login"));
  console.log(dim("   If that token is old, it may lack the vectorize scope."));
}

// -------------------------------------------------------------- 2. whoami
let loginAccount = "";
let scopes = [];
try {
  const { stdout } = await run("npx", ["wrangler", "whoami"], {
    maxBuffer: 1024 * 1024 * 8,
    timeout: 90_000,
  });
  // The account id sits in a box-drawn table; grab the first 32-hex token.
  const idMatch = stdout.match(/\b([0-9a-f]{32})\b/);
  loginAccount = idMatch ? idMatch[1] : "";
  // Scope lines look like "- vectorize (write)" or "- websearch.run".
  scopes = [...stdout.matchAll(/^\s*-\s+([a-z0-9_.\-]+)\s*(?:\(([a-z]+)\))?\s*$/gim)].map((m) =>
    m[1].toLowerCase()
  );
  // The line ends "…email you@example.com." — don't capture the sentence stop.
  const email = stdout.match(/associated with the email (\S+?)\.?(?:\s|$)/i)?.[1];

  if (loginAccount) {
    console.log(ok(`Logged in${email ? ` as ${email}` : ""} — account ${loginAccount}`));
  } else {
    // whoami ran but told us nothing useful — almost always "not logged in".
    console.log(bad("Couldn't read an account id from `wrangler whoami`"));
    problems.push("not logged in");
    fixes.push("npx wrangler login");
  }
} catch (err) {
  console.log(bad("`wrangler whoami` failed — are you logged in?"));
  console.log(dim(`   ${String(err.message).split("\n")[0]}`));
  fixes.push("npx wrangler login");
  problems.push("not logged in");
}

// ------------------------------------------------- 3. the account mismatch
if (envAccount && loginAccount && envAccount !== loginAccount) {
  console.log(bad(`Account mismatch — env says ${envAccount}, your login is ${loginAccount}`));
  console.log(dim("   This alone produces 'Authentication error [code: 10000]'."));
  problems.push("account mismatch");
  fixes.push("unset CLOUDFLARE_ACCOUNT_ID");
  fixes.push(`grep -rn CLOUDFLARE_ACCOUNT_ID ~/.zshrc ~/.zprofile ~/.bash_profile 2>/dev/null`);
}

// The scope list is a hint, not the authority. wrangler doesn't always name a
// scope "vectorize", so absence proves nothing — an actual API call does.
// Verdict is deferred until after the live check below.
const hasVectorizeScope = scopes.length ? scopes.some((s) => s.startsWith("vectorize")) : null;

// ------------------------------------------------------------ 4. the indexes
const WANT = ["bigbrain-refs"];
let existing = [];
let vectorizeWorks = false;
try {
  const { stdout } = await run("npx", ["wrangler", "vectorize", "list"], {
    maxBuffer: 1024 * 1024 * 8,
    timeout: 90_000,
  });
  existing = WANT.filter((n) => stdout.includes(n));
  vectorizeWorks = true;
  console.log(ok("`wrangler vectorize list` works — the API accepts your credentials"));
  for (const n of WANT) {
    console.log(existing.includes(n) ? ok(`  index ${n} exists`) : warn(`  index ${n} is missing`));
  }
} catch (err) {
  const msg = String(err.stderr || err.message || "");
  if (/10000|Authentication/i.test(msg)) {
    console.log(bad("`wrangler vectorize list` is rejected — same auth problem"));
    if (!problems.length) {
      problems.push("auth rejected with no obvious cause");
      fixes.push("npx wrangler logout && npx wrangler login");
    }
  } else if (/not supported|billing|plan|entitle/i.test(msg)) {
    console.log(bad("Vectorize isn't enabled on this account's plan"));
    console.log(dim(`   ${msg.split("\n").find((l) => l.trim()) || ""}`));
    problems.push("plan does not include vectorize");
  } else {
    console.log(bad("`wrangler vectorize list` failed"));
    // Wrangler is chatty; keep the lines that say something.
    const signal = msg
      .split("\n")
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
      .filter((l) => l && !/proxy environment variables|WARNING|^▲/i.test(l))
      .slice(0, 3);
    for (const l of signal) console.log(dim(`   ${l}`));
    problems.push("vectorize list failed");
  }
}

// ------------------------------------------------- 5. the scope verdict
// Only meaningful now that we know whether the API actually answers.
if (hasVectorizeScope === true) {
  console.log(ok("Your token lists the vectorize scope"));
} else if (hasVectorizeScope === false && vectorizeWorks) {
  console.log(warn("No scope literally named 'vectorize' in the token"));
  console.log(dim("   Ignore it — the API answered, so access is real. wrangler"));
  console.log(dim("   doesn't name every scope, and a working call outranks the list."));
} else if (hasVectorizeScope === false) {
  console.log(bad("No vectorize scope, and the vectorize API rejected the call"));
  problems.push("missing vectorize scope");
  fixes.push("npx wrangler logout && npx wrangler login");
}

// -------------------------------------------------------- 6. the config file
try {
  const toml = await readFile(TOML, "utf8");
  const configured = toml.match(/^\s*account_id\s*=\s*"([^"]+)"/m)?.[1];
  if (configured && loginAccount && configured !== loginAccount) {
    console.log(bad(`wrangler.toml pins account_id ${configured}, but you're ${loginAccount}`));
    problems.push("wrangler.toml account mismatch");
  } else if (configured) {
    console.log(ok(`wrangler.toml pins the right account (${configured})`));
  }

  // The placeholder KV id fails the deploy late, at the Cloudflare API, with
  // an error that doesn't mention wrangler.toml. Catch it here instead.
  if (toml.includes("REPLACE_WITH_KV_ID")) {
    console.log(bad("KV namespace id is still the placeholder"));
    console.log(dim("   Deploy will fail: \"KV namespace 'REPLACE_WITH_KV_ID' is not valid\"."));
    problems.push("KV namespace not set up");
    fixes.push("npm run setup-kv");
  } else if (/binding\s*=\s*"REFS_KV"/.test(toml)) {
    console.log(ok("KV namespace id is set"));
  }
} catch {}

// ------------------------------------------------------------------ verdict
console.log("");
if (!problems.length) {
  const missing = WANT.filter((n) => !existing.includes(n));
  if (missing.length) {
    console.log("Auth is fine. Create the missing index(es):\n");
    for (const n of missing) {
      console.log(`  npx wrangler vectorize create ${n} --dimensions=768 --metric=cosine`);
    }
    console.log("\nThen:  npm run deploy");
  } else {
    console.log("Everything checks out. The brain is ready to deploy:\n");
    console.log("  npm run deploy");
  }
} else {
  // An env override is suspect whenever anything is failing, mismatch or not.
  if (envAccount && !fixes.includes("unset CLOUDFLARE_ACCOUNT_ID")) {
    fixes.unshift("unset CLOUDFLARE_ACCOUNT_ID");
  }
  // Never report a problem without something to try.
  if (!fixes.length) fixes.push("npx wrangler logout && npx wrangler login");

  console.log(`Found ${problems.length} problem(s): ${problems.join(", ")}\n`);
  console.log("Run these in order, one at a time:\n");
  for (const f of [...new Set(fixes)]) console.log(`  ${f}`);
  console.log("\nThen run `npm run doctor` again.");
  console.log(dim("\nIf the re-login browser page asks which account, pick the one matching your email."));
}
console.log("");
process.exit(problems.length ? 1 : 0);
