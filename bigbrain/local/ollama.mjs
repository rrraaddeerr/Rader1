/**
 * Tier 1 — the local model, and the reason it is worth having.
 *
 * Tiers 2 and 3 are metered against a $5 night and a 20-call vision ration.
 * That ration is the right shape for paid inference and completely the wrong
 * shape for the actual job in front of us: roughly a thousand Instagram
 * screenshots that have never been looked at. At 20 a night that is a year and
 * a half. On his Mac, overnight, on hardware already bought, it is a weekend.
 *
 * So this file exists to make the free tier as reliable as the paid one, and
 * that comes down to one thing: NEVER MAKE HIM DIAGNOSE ANYTHING. Ollama has
 * exactly two failure modes in practice — the server isn't running, or the
 * model isn't pulled — and both of them present as an opaque fetch error. Both
 * are one command to fix. So every failure that leaves this module carries the
 * command that fixes it in `fix`, and the runner prints that command instead of
 * a stack trace. A stack trace would be asking him to do our debugging.
 *
 * Nothing here throws. Every export returns a result object with an `error`
 * field, because a swallowed error that looks like an empty answer has cost
 * this project hours three separate times, and "the model returned nothing"
 * and "the model was never running" must never look alike.
 */

export const DEFAULT_HOST = "http://127.0.0.1:11434";

/** llava is the smallest vision model that reliably names materials. */
export const DEFAULT_VISION_MODEL = "llava";
export const DEFAULT_TEXT_MODEL = "llama3.1";

/**
 * Deliberately the same instruction Workers AI gets in `worker/src/enrich.js`.
 * Captions from the two tiers land in the same field and get embedded by the
 * same model, so if the prompts drifted, search results would quietly depend on
 * which tier happened to caption a ref — an inconsistency nothing downstream
 * could see or explain.
 */
export const VISION_PROMPT =
  "Describe this image for a fashion and production reference archive. " +
  "Name the garments, materials, silhouettes, colours, era, setting and overall mood. " +
  "Be concrete and specific. No preamble.";

/** Mirrors SUMMARY_SYSTEM in `worker/src/ladder.js`, for the same reason. */
export const SUMMARY_PROMPT = [
  "You summarise video transcripts for a design and production reference archive.",
  "Concrete and specific: what is shown, what is made, what is claimed, what materials and techniques come up.",
  "No preamble, no praise, no hedging. Six sentences maximum.",
].join(" ");

/** Vision on a laptop is slow. Cutting it off at 30s would fail every job. */
export const VISION_TIMEOUT_MS = 180_000;
export const TEXT_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;

/** The worker caps stored captions at this, so there is no point exceeding it. */
export const MAX_CAPTION_CHARS = 6000;
export const MAX_SUMMARY_CHARS = 900;

/**
 * Failure kinds. The runner branches on these and the distinction is the whole
 * contract: `unavailable` means the runner is broken and the job is fine, so
 * the job goes back to the pool untouched. `failed` and `timeout` mean the job
 * was genuinely attempted, so it is reported and the worker's backoff owns it.
 * Getting this backwards would either burn a ref's four retry attempts because
 * Ollama was closed, or spin forever on a ref that can never work.
 */
export const UNAVAILABLE = "unavailable";
export const TIMEOUT = "timeout";
export const FAILED = "failed";

const short = (err) => String(err?.message ?? err).slice(0, 240);

/**
 * Does the installed model list satisfy what we asked for?
 *
 * `ollama pull llava` installs `llava:latest`, so an exact-match check reports
 * a missing model to someone who just pulled it — which sends him diagnosing
 * the one thing this file promises he'll never have to. An untagged request
 * matches any tag; a tagged one must match exactly, because asking for
 * `llava:13b` and silently getting 7b is a different kind of lie.
 */
export function hasModel(installed = [], want = "") {
  const target = String(want).trim();
  if (!target) return false;
  const names = installed.map((m) => (typeof m === "string" ? m : m?.name || m?.model || ""));
  if (names.includes(target)) return true;
  if (target.includes(":")) return false;
  return names.some((n) => n.split(":")[0] === target);
}

/**
 * The one command that fixes this. Returned rather than printed so the runner
 * decides presentation and this module stays testable.
 */
export function fixFor(kind, { model = "", host = DEFAULT_HOST } = {}) {
  if (kind === "not-running") {
    return {
      fix: "ollama serve",
      // If the binary isn't there at all, `ollama serve` reports "command not
      // found" and he needs a different command. Saying so up front is one line
      // of output; making him find out is a round trip.
      alt: "brew install ollama",
      why: `nothing is listening on ${host}`,
    };
  }
  if (kind === "model-missing") {
    return { fix: `ollama pull ${model}`, alt: "", why: `the model ${model} is not pulled` };
  }
  return { fix: "", alt: "", why: "" };
}

/** fetch with a deadline that never leaks the timer or throws past the caller. */
async function call(fetchImpl, url, { method = "GET", body, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      signal: ctrl.signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Ollama answers JSON on every path we use, so unparseable output is a
      // real signal (a proxy, a wrong port). Keep the raw text as the error.
      return { ok: false, status: res.status, data: null, error: `unparseable response: ${text.slice(0, 160)}` };
    }
    return { ok: res.ok, status: res.status, data, error: res.ok ? "" : data?.error || `HTTP ${res.status}` };
  } catch (err) {
    // An abort and a refused connection arrive as the same class of error but
    // mean opposite things — one is "too slow", the other is "not there".
    const aborted = err?.name === "AbortError";
    return { ok: false, status: 0, data: null, error: aborted ? `timed out after ${timeoutMs}ms` : short(err), aborted };
  }
}

/**
 * Is Ollama up, and is everything we need pulled?
 *
 * Answers all of it in one call so the runner can report every problem at once.
 * Reporting them one per restart — start, "pull llava", restart, "pull
 * llama3.1", restart — is three round trips for information we already had.
 *
 * @returns {Promise<{ok:boolean, running:boolean, host:string, installed:string[],
 *   missing:string[], fixes:Array<{fix:string, alt:string, why:string}>, error:string}>}
 */
export async function probe({
  host = DEFAULT_HOST,
  models = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const base = { ok: false, running: false, host, installed: [], missing: [], fixes: [], error: "" };
  if (typeof fetchImpl !== "function") return { ...base, error: "no fetch available — Node 20 or newer is required" };

  const res = await call(fetchImpl, `${host}/api/tags`, { timeoutMs });
  if (!res.ok) {
    return { ...base, error: res.error || "could not reach Ollama", fixes: [fixFor("not-running", { host })] };
  }

  const installed = (res.data?.models || []).map((m) => m?.name || m?.model || "").filter(Boolean);
  const missing = models.filter((m) => m && !hasModel(installed, m));
  return {
    ok: missing.length === 0,
    running: true,
    host,
    installed,
    missing,
    fixes: missing.map((m) => fixFor("model-missing", { model: m, host })),
    error: missing.length ? `not pulled: ${missing.join(", ")}` : "",
  };
}

/**
 * A client bound to one host and one pair of models.
 *
 * `fetchImpl` is injectable so the tests can drive every failure path without a
 * running Ollama — which they must, since CI has none and the failure paths are
 * the part that actually matters here.
 */
export function createOllama({
  host = DEFAULT_HOST,
  visionModel = DEFAULT_VISION_MODEL,
  textModel = DEFAULT_TEXT_MODEL,
  fetchImpl = globalThis.fetch,
  visionTimeoutMs = VISION_TIMEOUT_MS,
  textTimeoutMs = TEXT_TIMEOUT_MS,
} = {}) {
  /**
   * One generation. Returns `{text, error, kind, fix, model, ms}` and never
   * throws, so a caller can never mistake a dead server for an empty answer.
   */
  async function generate({ model, prompt, images = [], timeoutMs, maxTokens = 320 }) {
    const started = Date.now();
    const out = { text: "", error: "", kind: "", fix: null, model, ms: 0 };

    const res = await call(fetchImpl, `${host}/api/generate`, {
      method: "POST",
      timeoutMs,
      body: {
        model,
        prompt,
        images: images.length ? images : undefined,
        stream: false,
        options: { temperature: 0.2, num_predict: maxTokens },
      },
    });
    out.ms = Date.now() - started;

    if (!res.ok) {
      // A 404 here is always the model, never the route — /api/generate has
      // existed for the whole life of Ollama. So this is the pull command.
      if (res.status === 404 || /not found|try pulling/i.test(res.error || "")) {
        out.kind = UNAVAILABLE;
        out.fix = fixFor("model-missing", { model, host });
        out.error = `model ${model} is not pulled`;
        return out;
      }
      if (res.aborted) {
        out.kind = TIMEOUT;
        out.error = res.error;
        return out;
      }
      if (res.status === 0) {
        // The connection died mid-run. Ollama was there when we probed, so this
        // is the Mac sleeping or the app being quit, not a bad job.
        out.kind = UNAVAILABLE;
        out.fix = fixFor("not-running", { host });
        out.error = res.error;
        return out;
      }
      out.kind = FAILED;
      out.error = res.error;
      return out;
    }

    const text = String(res.data?.response ?? "").trim();
    if (!text) {
      // The server answered and said nothing. That is a real, attributable
      // failure of this job — not an outage — so it is reported, not released.
      out.kind = FAILED;
      out.error = "the model returned an empty response";
      return out;
    }
    out.text = text;
    return out;
  }

  return {
    host,
    visionModel,
    textModel,

    probe: (opts = {}) => probe({ host, models: [visionModel, textModel], fetchImpl, ...opts }),

    /**
     * Caption an image. `imageBase64` is raw base64, no data: prefix — that is
     * what Ollama's `images` array wants, and a prefixed string fails with a
     * decode error that reads like a model problem.
     */
    async caption(imageBase64, { title = "" } = {}) {
      // The title is context, not instruction. Instagram titles are often the
      // caption text of the post, which describes the vibe; we want the model
      // describing the pixels, so it is offered and explicitly deprioritised.
      const prompt = title
        ? `${VISION_PROMPT}\n\nThe archive's note on this image is "${String(title).slice(0, 200)}" — use it only for context, describe what you actually see.`
        : VISION_PROMPT;
      const out = await generate({ model: visionModel, prompt, images: [imageBase64], timeoutMs: visionTimeoutMs });
      return { ...out, text: out.text.slice(0, MAX_CAPTION_CHARS) };
    },

    /** Summarise transcript or page text the worker has already banked. */
    async summarize(text, { title = "" } = {}) {
      const head = title ? `Title: ${String(title).slice(0, 200)}\n\n` : "";
      const out = await generate({
        model: textModel,
        prompt: `${SUMMARY_PROMPT}\n\n${head}Transcript:\n\n${String(text)}`,
        timeoutMs: textTimeoutMs,
        maxTokens: 400,
      });
      return { ...out, text: out.text.slice(0, MAX_SUMMARY_CHARS) };
    },
  };
}
