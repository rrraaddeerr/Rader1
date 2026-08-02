/**
 * The cost governor.
 *
 * Standing rule: no heavy background burns without a same-moment OK. He got
 * billed badly once, and the comfort ceiling is about $5 a night. So spend is
 * metered here rather than trusted to whoever wrote the calling code — a job
 * that wants to run 1,200 vision calls gets refused, not invoiced.
 *
 * The tier ladder, cheapest first. Always climb from the bottom:
 *   0  deterministic code on the Worker (rules, joins, scraping, diffing)
 *   1  local models on the Mac via Ollama — free, overnight bulk
 *   2  Workers AI / Haiku — cheap per-item classify, summarize, embed
 *   3  frontier Claude — judgment, ranking, digest voice, taste-adjacent only
 *
 * Ledger lives in KV, one key per UTC day. Refusals are loud and cheap;
 * silent overspend is the only real failure mode.
 */

export const TIERS = {
  0: { name: "deterministic", usdPerUnit: 0 },
  1: { name: "local", usdPerUnit: 0 },
  2: { name: "cheap-model", usdPerUnit: 0.0002 },
  3: { name: "frontier", usdPerUnit: 0.02 },
};

/** Vision is the expensive one, so it's rationed by count as well as cost. */
export const DEFAULT_CEILING_USD = 5;
export const DEFAULT_VISION_RATION = 20;

const key = (day) => `budget:${day}`;

/** UTC day stamp. Pass a date to make this testable. */
export function dayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

const ceiling = (env) => Number(env?.NIGHTLY_CEILING_USD ?? DEFAULT_CEILING_USD) || DEFAULT_CEILING_USD;
const visionRation = (env) => Number(env?.VISION_RATION ?? DEFAULT_VISION_RATION) || DEFAULT_VISION_RATION;

/** Current ledger for a day. Never throws — a missing ledger is a zero one. */
export async function ledger(env, day = dayStamp()) {
  const empty = { day, usd: 0, calls: {}, vision: 0 };
  try {
    const stored = await env.REFS_KV.get(key(day), "json");
    return stored ? { ...empty, ...stored } : empty;
  } catch {
    return empty;
  }
}

/**
 * Estimate what a job would cost before running it.
 * @returns {number} USD
 */
export function estimate(tier, units = 1) {
  const t = TIERS[tier] ?? TIERS[3];
  return t.usdPerUnit * Math.max(0, units);
}

/**
 * Ask permission to spend. Returns `{ok:false}` rather than throwing so the
 * caller can degrade — usually by dropping to a cheaper tier or stopping.
 *
 * @param {object} opts
 * @param {number} opts.tier   0-3
 * @param {number} opts.units  how many calls/items
 * @param {boolean} opts.vision counts against the separate vision ration
 */
export async function charge(env, { tier = 3, units = 1, vision = false, label = "" } = {}) {
  const day = dayStamp();
  const current = await ledger(env, day);
  const cost = estimate(tier, units);
  const cap = ceiling(env);

  if (vision && current.vision + units > visionRation(env)) {
    return {
      ok: false,
      reason: `vision ration spent (${current.vision}/${visionRation(env)} today)`,
      ...current,
      remaining: Math.max(0, cap - current.usd),
    };
  }

  if (current.usd + cost > cap) {
    return {
      ok: false,
      reason: `would exceed the $${cap}/night ceiling ($${current.usd.toFixed(3)} spent)`,
      ...current,
      remaining: Math.max(0, cap - current.usd),
    };
  }

  const next = {
    day,
    usd: Number((current.usd + cost).toFixed(6)),
    calls: { ...current.calls, [tier]: (current.calls[tier] || 0) + units },
    vision: current.vision + (vision ? units : 0),
    lastLabel: label || current.lastLabel || "",
  };
  try {
    await env.REFS_KV.put(key(day), JSON.stringify(next));
  } catch {
    // A ledger we can't write is a ledger we can't trust — refuse the spend.
    return { ok: false, reason: "couldn't write the ledger", ...current };
  }

  return { ok: true, cost, ...next, remaining: Math.max(0, cap - next.usd) };
}

/**
 * Would this job fit? Read-only — use before kicking off a batch so you can
 * tell the operator "this would cost $2.40, want it?" instead of finding out.
 */
export async function quote(env, { tier = 3, units = 1, vision = false } = {}) {
  const current = await ledger(env);
  const cap = ceiling(env);
  const cost = estimate(tier, units);
  const remaining = Math.max(0, cap - current.usd);
  const visionLeft = Math.max(0, visionRation(env) - current.vision);
  return {
    cost: Number(cost.toFixed(4)),
    spentToday: current.usd,
    ceiling: cap,
    remaining: Number(remaining.toFixed(4)),
    visionLeft,
    fits: cost <= remaining && (!vision || units <= visionLeft),
    // How many you could do with what's left, at this tier.
    affordable: TIERS[tier]?.usdPerUnit
      ? Math.floor(remaining / TIERS[tier].usdPerUnit)
      : Infinity,
  };
}
