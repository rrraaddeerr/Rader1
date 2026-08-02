/**
 * The enrichment ladder — a ref is never finished, it climbs.
 *
 * Enrichment used to be one-shot: a ref either got enriched or it didn't, and
 * `enrichedAt` was the whole of its memory. That's a switch, not a process. The
 * archive is supposed to get richer every night on compute already paid for,
 * which means each ref needs to know *how deep it currently is* and *what the
 * single cheapest next thing to learn about it would be*.
 *
 * Six rungs, each strictly deeper than the last:
 *
 *   0  raw          title, url, whatever the import carried
 *   1  classified   realm + coarse classification — free, deterministic
 *   2  surface      thumbnail, readable page text, dead-link status
 *   3  seen         vision caption for images: what is literally in the picture
 *   4  watched      video transcript pulled and summarised
 *   5  detailed     detail tags proposed from the deepened content
 *
 * Three properties this file exists to hold:
 *
 * 1. THE LEVEL IS INFERRED, NOT MIGRATED. `levelOf()` reads what a ref already
 *    carries. The 1,578 refs already in KV get correct levels the first time
 *    the nightly looks at them, with no backfill job and no window where the
 *    stored level and the stored content disagree. Stored ladder state is
 *    bookkeeping *about attempts*; the content is always the truth about depth.
 *
 * 2. A PERMANENT FAILURE IS NOT RETRIED; A TRANSIENT ONE IS. This is the whole
 *    design. A host that 403s a bot will 403 it again tomorrow, and paying a
 *    tier-2 unit every night for the rest of the archive's life to rediscover
 *    that is exactly the slow leak the cost governor exists to stop. A timeout
 *    is the opposite: the world was briefly wrong and will probably be right
 *    later. So failures are classified, permanent ones close the rung, and
 *    transient ones come back on an exponential backoff — with an attempt cap,
 *    because a failure we can't classify must not become an infinite retry.
 *
 * 3. TASTE IS STAGED, FACTS ARE APPLIED. Rungs 2/3/4 produce facts about the
 *    content — a thumbnail, a body, a caption, a transcript — and those are
 *    written onto the ref. Rungs 1 and 5 produce claims about what a ref MEANS,
 *    and those only ever become proposals in the swipe queue. Nothing in this
 *    file writes `ref.realm` or `ref.tags`.
 *
 * And the standing rule above all of them: nothing here can create a ref. Every
 * write is a re-read-then-put of a `ref:` key that already existed, and a key
 * that vanished mid-climb is dropped rather than resurrected.
 */

import { classify } from "./realm.js";
import { tagProposals, lowConfidenceRealm, classifyInput, DEAD_STATUSES } from "./propose.js";
import { propose as stageProposals } from "./stage.js";
import { charge, quote, estimate } from "./budget.js";
import {
  recoverImage,
  fetchPageText,
  fetchTranscript,
  captionImage,
  youtubeId,
  MAX_BODY_CHARS,
} from "./enrich.js";
import { brainReady, indexRef } from "./embed.js";
import { generate } from "./ask.js";

/** The top rung. A ref at MAX_LEVEL has nothing left to learn cheaply. */
export const MAX_LEVEL = 5;

/**
 * How many times an unclassifiable failure may repeat before we call it
 * permanent. Four nights is enough for a genuine outage to end and short
 * enough that a quietly broken host stops costing us anything within a week.
 */
export const MAX_TRANSIENT_ATTEMPTS = 4;

/** Days to wait after the Nth transient failure. Doubling, then it converts. */
export const BACKOFF_DAYS = [1, 2, 4, 8];

/** Failure kinds. Exported because the distinction is the design. */
export const PERMANENT = "permanent";
export const TRANSIENT = "transient";

const UA = "Mozilla/5.0 (compatible; BigBrainBot/1.0; +https://bigbrain.ref)";
const LINK_TIMEOUT_MS = 5000;
const DAY_MS = 86_400_000;

/** Below this a transcript is already its own summary — don't pay to shorten it. */
const SUMMARY_FLOOR_CHARS = 400;
const SUMMARY_MAX_CHARS = 900;

/** Enough text that tagProposals has something to match. Mirrors its own guard. */
const MIN_TAGGABLE_CHARS = 3;

/** KV keys a ladder walk may read before giving up on finding candidates. */
const MAX_SCAN = 400;
const PAGE = 100;

/**
 * How many candidates we look at to fill a cohort of `limit`. Sorting for
 * breadth is only as good as the pool it sorts, and reading all 1,578 refs to
 * get a globally perfect order would blow the CPU budget for a job whose entire
 * point is to be cheap. Four times the cohort is a good local order, and the
 * cursor means the rest of the archive is seen within the same lap anyway.
 */
const POOL_FACTOR = 4;
const MAX_POOL = 200;

const short = (err) => String(err?.message ?? err).slice(0, 240);
const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();

/**
 * Loop 2 reaches the ladder through here.
 *
 * `suppressed` is a Set of queue kinds the learner has decided he has answered
 * enough times — it arrives from cron.js, which computes it once a night. A
 * plain duck-type check rather than `instanceof Set` so a caller can pass any
 * lookup it likes, and a missing one means "nothing is suppressed", which is
 * the correct behaviour on night one and for every ad-hoc call.
 */
const isSuppressed = (set, kind) => Boolean(kind && set && typeof set.has === "function" && set.has(kind));

// --------------------------------------------------------------- the failure axis

/**
 * Is this failure worth asking about again?
 *
 * The default matters more than the table: anything we don't recognise is
 * TRANSIENT. We never permanently give up on a failure we don't understand —
 * but `MAX_TRANSIENT_ATTEMPTS` means "don't understand" can only cost four
 * nights before it converts to permanent anyway. So the cost of guessing wrong
 * in this direction is bounded, and the cost of guessing wrong the other way
 * (marking a blip permanent) is a ref that never climbs again.
 *
 * @param {object|Error|string} signal  an Error, `{status}`, or a reason string
 * @returns {{permanent:boolean, kind:string, reason:string}}
 */
export function classifyFailure(signal = {}) {
  const status = Number(signal?.status ?? 0) || 0;
  const raw = String(signal?.message ?? signal?.reason ?? (typeof signal === "string" ? signal : "")).trim();
  const msg = raw.slice(0, 200);
  const hay = msg.toLowerCase();

  const verdict = (permanent, reason) => ({
    permanent,
    kind: permanent ? PERMANENT : TRANSIENT,
    reason: reason || msg || (status ? `http ${status}` : "unknown failure"),
  });

  // Gone, or refusing us on purpose. Both are stable facts about the host:
  // a 403 from a login wall is tomorrow's 403 too. Instagram is the whole
  // reason this branch exists — 1,241 refs live there.
  if (status === 404 || status === 410) return verdict(true, `gone (${status})`);
  if (status === 401 || status === 403 || status === 451) return verdict(true, `blocked (${status})`);

  // Overloaded, rate-limited, or briefly broken. Ask again later.
  if (status === 408 || status === 425 || status === 429) return verdict(false, `busy (${status})`);
  if (status >= 500 && status < 600) return verdict(false, `server error (${status})`);

  // Callers raise these deliberately when the content itself forecloses the
  // rung — a video with no caption track will not grow one.
  if (/^no-(captions|bytes|text|content)\b/.test(hay)) return verdict(true, msg);
  if (/unsupported|not applicable/.test(hay)) return verdict(true, msg);

  // Network weather.
  if (/abort|timeout|timed out|network|socket|econn|enotfound|fetch failed|temporar/.test(hay)) {
    return verdict(false, msg || "network");
  }

  // A binding that isn't wired is config, and config changes. Never permanent.
  if (/not bound|no api key|unbound/.test(hay)) return verdict(false, msg);

  return verdict(false, msg || "unknown failure");
}

// ------------------------------------------------------------------ ladder state

/** Per-rung attempt history, or null if we've never tried this rung. */
export function stepState(ref, level) {
  const steps = ref?.ladder?.steps;
  return (steps && steps[String(level)]) || null;
}

/**
 * Is this rung closed to us right now?
 *
 * Two ways: permanently (we asked and the answer will not change), or
 * temporarily (a transient failure whose backoff hasn't elapsed). `retry`
 * re-opens both — that's the manual override for "the host was down last week,
 * try the whole archive again".
 */
export function isBlocked(ref, level, { now = new Date(), retry = false } = {}) {
  if (retry) return false;
  const st = stepState(ref, level);
  if (!st || st.ok) return false;
  if (st.permanent) return true;
  return Boolean(st.nextAt) && Date.parse(st.nextAt) > now.getTime();
}

/**
 * Fold one attempt into a ref's ladder state. Pure — returns the new `ladder`
 * object, never mutates.
 *
 * A success wipes the failure bookkeeping for that rung: whatever was wrong is
 * over, and leaving a stale `permanent` behind would block a `retry` that had
 * just succeeded.
 */
export function recordAttempt(ref, level, { ok, reason = "", permanent = false, now = new Date() } = {}) {
  const prev = ref?.ladder && typeof ref.ladder === "object" ? ref.ladder : {};
  const steps = { ...(prev.steps || {}) };
  const key = String(level);
  const attempts = ((steps[key]?.attempts) || 0) + 1;
  const next = { attempts, lastAt: iso(now), ok: Boolean(ok) };

  if (ok) {
    next.reason = reason || "";
  } else {
    // Exhausting the transient budget converts to permanent. Without this an
    // unclassifiable failure is an infinite nightly retry, which is the exact
    // leak the permanent/transient split exists to close.
    const exhausted = !permanent && attempts >= MAX_TRANSIENT_ATTEMPTS;
    next.permanent = permanent || exhausted;
    next.reason = exhausted
      ? `${reason || "unknown failure"} · failed ${attempts}x, treating as permanent`
      : reason || "unknown failure";
    if (!next.permanent) {
      const days = BACKOFF_DAYS[Math.min(attempts, BACKOFF_DAYS.length) - 1];
      next.nextAt = iso(new Date(now.getTime() + days * DAY_MS));
    }
  }

  steps[key] = next;
  return { ...prev, steps, updatedAt: iso(now) };
}

// ------------------------------------------------------------------- the rungs

/** A ref whose url points at a page with prose we could read. */
function readsPage(ref) {
  if (!ref?.url) return false;
  if (ref.category === "image" || ref.category === "audio") return false;
  return ref.kind !== "note";
}

/** Text worth handing to a tagger. Title/caption/note, never the whole body. */
function taggableText(ref) {
  return [ref?.title, ref?.caption, ref?.desc, ref?.note, ref?.text, ref?.name, ref?.Name, ref?.notes, ref?.Notes]
    .filter((s) => typeof s === "string" && s.trim())
    .join(" ")
    .trim();
}

/** Did we already learn this url is gone? Then level 2 is a finished answer. */
function knownDead(ref) {
  return DEAD_STATUSES.has(Number(ref?.linkStatus));
}

const SUMMARY_SYSTEM = [
  "You summarise video transcripts for a design and production reference archive.",
  "Concrete and specific: what is shown, what is made, what is claimed, what materials and techniques come up.",
  "No preamble, no praise, no hedging. Six sentences maximum.",
].join(" ");

/**
 * The rungs, in order.
 *
 * `applies`    is this rung meaningful for this ref at all? A note has no page
 *              to read; an article has no picture to caption. levelOf steps
 *              over a rung that doesn't apply without crediting it — an
 *              enriched article is level 2, not level 4 for having failed to be
 *              a video — but it doesn't block on it either.
 * `satisfied`  do we already hold what this rung produces?
 * `possible`   could we actually attempt it? Distinct from `applies` on
 *              purpose: an image ref with no bytes anywhere DOES have a rung 3
 *              (so it honestly reports level 2, not level 3) but there is no
 *              call we could make to satisfy it.
 * `proposes`   the queue kind this rung would ASK him about, so loop 2's
 *              suppression can reach the ladder. Without this the learner can
 *              silence the triage generators and the ladder keeps queueing the
 *              same cards from 25 refs a night, which is the exact opposite of
 *              "he swipes less each week".
 * `asks`       WOULD this rung put a card in his queue for THIS ref? Only the
 *              rungs that would are silenced, and only for the refs they would
 *              actually ask about: a ref the classifier settles on its own is
 *              not a question, so rung 1 still banks the record for it while
 *              realm cards are suppressed. See nextStep() for why a suppressed
 *              rung is skipped entirely rather than run with the asking off.
 * `run`        one attempt. Returns {ok, patch, staged, reason, permanent}.
 */
export const RUNGS = [
  {
    level: 1,
    name: "classified",
    tier: 0,
    vision: false,
    // Every ref can be classified: Type is populated on every Notion row, so
    // this rung is free for the entire archive.
    applies: () => true,
    // `ref.realm` set by his own hand also counts — he has already answered the
    // question this rung asks, and re-asking it would be noise in his queue.
    satisfied: (ref) => Boolean(ref?.classified?.realm) || Boolean(ref?.realm),
    possible: () => true,
    proposes: "realm",
    // Only the refs the classifier cannot settle become cards, so only those
    // are the ones loop 2 can silence. The rest of the archive keeps climbing
    // this rung while realm is suppressed, which is the whole point of asking
    // per ref rather than per rung.
    asks: (ref) => lowConfidenceRealm(ref).length > 0,
    async run(env, ref) {
      const c = classify(classifyInput(ref));
      const patch = {
        // The RECORD of what the free classifier said, which is a fact. The
        // realm itself is a taste call and is never written here — see the
        // proposal below and the file header.
        classified: {
          realm: c.realm,
          axis: c.axis,
          tags: c.tags,
          confidence: c.confidence,
          why: c.why,
          tier: c.tier,
          at: new Date().toISOString(),
        },
      };

      // Too weak to settle on its own goes to his thumb. propose() dedupes by
      // target, so this is safe to run alongside cron's triage job. Suppression
      // never reaches here: nextStep() has already declined to offer this rung
      // for a ref it would ask about, so a rung that runs is a rung allowed to
      // ask, and there is no muted half-attempt to record.
      let staged = 0;
      const proposals = lowConfidenceRealm(ref);
      if (proposals.length) {
        const out = await stageProposals(env, { kind: "realm", source: "ladder", proposals });
        staged = out.queued;
      }
      return { ok: true, patch, staged, note: `realm ${c.realm} @${c.confidence}` };
    },
  },

  {
    level: 2,
    name: "surface",
    tier: 0,
    vision: false,
    // No url means no page, no og:image and no link to check. A pasted
    // screenshot skips straight to rung 3.
    applies: (ref) => Boolean(ref?.url),
    satisfied: (ref) => {
      if (knownDead(ref)) return true; // dead IS the level-2 answer
      const imageKnown = Boolean(ref?.image || ref?.blobKey || ref?.imageTried);
      // A body or a caption we already hold was fetched over a live link, so it
      // proves the url resolves. Demanding a separate HEAD before calling a ref
      // level 2 would send us back across the whole archive to learn what the
      // body in front of us already says.
      const textKnown = !readsPage(ref) || Boolean(ref?.body || ref?.caption || ref?.enrichTried);
      return imageKnown && textKnown;
    },
    possible: (ref) => Boolean(ref?.url),
    async run(env, ref) {
      const patch = {};
      const problems = [];
      let got = false;

      try {
        Object.assign(patch, await recoverImage(ref));
        if (patch.image) got = true;
      } catch (err) {
        // Marking it tried without saying why is worse than useless: a blank
        // thumbnail on /browse has to stay explainable.
        patch.imageTried = true;
        patch.imageWhy = `error: ${short(err)}`;
        problems.push(`image: ${short(err)}`);
      }

      if (readsPage(ref)) {
        try {
          const body = await fetchPageText(ref.url);
          // A body that's basically the title we already have is not content.
          if (body && body.length > 200) {
            patch.body = body;
            patch.enrichKind = "page";
            got = true;
          }
        } catch (err) {
          problems.push(`page: ${short(err)}`);
        }
        patch.enrichTried = new Date().toISOString();
      }

      // Probe only when we came away empty-handed. A body or a thumbnail is
      // already proof the link is alive; spending a subrequest to confirm what
      // we're holding is the kind of waste that adds up over 1,578 refs.
      if (!got) {
        const probe = await probeLink(ref.url, linkTimeout(env));
        patch.linkStatus = probe.status;
        patch.linkCheckedAt = new Date().toISOString();
        if (probe.error) patch.linkError = probe.error;
        else delete patch.linkError;
      }

      // Both halves threw: we learned nothing and recorded nothing, so this is
      // a real failure and gets classified. Everything else counts as done —
      // recoverImage and fetchPageText each leave a durable "we tried" marker,
      // so there is genuinely nothing left for a second attempt to discover.
      if (problems.length === (readsPage(ref) ? 2 : 1)) {
        return { ok: false, patch, ...classifyFailure({ message: problems.join(" · ") }) };
      }

      const note = knownDead(patch) ? `dead: ${patch.linkStatus}` : summarizeSurface(patch);
      return { ok: true, patch, note };
    },
  },

  {
    level: 3,
    name: "seen",
    tier: 2,
    vision: true,
    applies: (ref) => ref?.category === "image",
    satisfied: (ref) => Boolean(ref?.caption),
    // The impossibility the brief names: no bytes anywhere means captionImage
    // would return "" without ever reaching the model, and we'd have spent one
    // of twenty nightly vision units on nothing.
    possible: (ref) => Boolean(ref?.blobKey || ref?.image),
    async run(env, ref) {
      if (!env?.AI) return { ok: false, patch: {}, ...classifyFailure({ message: "AI not bound" }) };

      const { bytes, error, status } = await imageBytes(env, ref);
      if (!bytes) {
        return { ok: false, patch: {}, ...classifyFailure({ status, message: error || "no-bytes: nothing to caption" }) };
      }

      const caption = await captionImage(env, bytes);
      if (!caption) {
        // captionImage swallows its own error and returns "", so we cannot tell
        // a model outage from a refusal here. Unclassified means transient,
        // which means four tries and then it closes itself. That is the right
        // shape for "we don't know".
        return { ok: false, patch: {}, ...classifyFailure({ message: "vision returned nothing" }) };
      }
      return { ok: true, patch: { caption, enrichKind: "vision" }, note: `caption ${caption.length} chars` };
    },
  },

  {
    level: 4,
    name: "watched",
    tier: 2,
    vision: false,
    applies: (ref) => ref?.category === "video" && Boolean(ref?.url),
    satisfied: (ref) => Boolean(ref?.transcript) || (ref?.enrichKind === "transcript" && Boolean(ref?.body)),
    // fetchTranscript only knows YouTube. A Vimeo or TikTok link cannot reach
    // this rung with the tools we have — an honest impossibility, not a failure
    // to record and retry.
    possible: (ref) => Boolean(youtubeId(ref?.url)),
    async run(env, ref) {
      let transcript = "";
      try {
        transcript = await fetchTranscript(ref.url);
      } catch (err) {
        return { ok: false, patch: {}, ...classifyFailure(err) };
      }
      if (!transcript) {
        // Auto-captions exist for very nearly everything on YouTube, so a video
        // with no track today has none tomorrow. `retry` re-opens it.
        return { ok: false, patch: {}, ...classifyFailure({ message: "no-captions: no track on this video" }) };
      }

      const patch = { transcript, body: transcript, enrichKind: "transcript" };

      // The summary is a bonus, not the rung. The transcript is the substance,
      // and refusing to bank it because the summariser blinked would mean
      // re-fetching the whole track tomorrow to end up in the same place.
      if (transcript.length > SUMMARY_FLOOR_CHARS) {
        const out = await generate(env, {
          system: SUMMARY_SYSTEM,
          user: `Transcript:\n\n${transcript.slice(0, MAX_BODY_CHARS)}`,
          deep: false,
          maxTokens: 400,
        });
        if (out.text) patch.summary = String(out.text).trim().slice(0, SUMMARY_MAX_CHARS);
        else if (out.errors?.length) patch.summaryError = out.errors.join(" · ").slice(0, 200);
      }

      return { ok: true, patch, note: `transcript ${transcript.length} chars${patch.summary ? " + summary" : ""}` };
    },
  },

  {
    level: 5,
    name: "detailed",
    tier: 0,
    vision: false,
    applies: () => true,
    // Satisfaction lives in the ladder, NOT in ref.tags — the tags only land on
    // the ref if he approves them, and a ladder that waited on his thumb would
    // re-propose every unswiped ref every single night. Asking is the work;
    // the answer is his.
    satisfied: (ref) => stepState(ref, 5)?.ok === true,
    possible: (ref) => taggableText(ref).length >= MIN_TAGGABLE_CHARS,
    proposes: "tag",
    // Nothing but the question comes out of this rung, so every ref it reaches
    // is a ref it would ask about. Triage deliberately never runs tags either,
    // which makes the ladder the only source of a tag card — one more reason
    // not to let a suppressed night close the rung.
    asks: () => true,
    async run(env, ref) {
      const proposals = tagProposals(ref);
      if (!proposals.length) {
        // Silence is a real answer. Most refs say nothing that maps onto his
        // fixed vocabulary, and re-asking a free question forever is still a
        // waste of the walk that finds it.
        return { ok: true, patch: {}, staged: 0, note: "nothing worth tagging" };
      }
      const out = await stageProposals(env, { kind: "tag", source: "ladder", proposals });
      return { ok: true, patch: {}, staged: out.queued, note: `staged ${out.queued} tag proposals` };
    },
  },
];

const RUNG_BY_LEVEL = new Map(RUNGS.map((r) => [r.level, r]));

/** Human names for the levels, for briefs and debug output. */
export const LEVEL_NAMES = ["raw", ...RUNGS.map((r) => r.name)];

/** What rung 2 actually came away with, for the run record. */
function summarizeSurface(patch) {
  const got = [];
  if (patch.image) got.push("thumb");
  if (patch.body) got.push(`${patch.body.length} chars`);
  if (!got.length) got.push(patch.imageWhy || `link ${patch.linkStatus ?? "?"}`);
  return got.join(" + ");
}

// ----------------------------------------------------------------- the public API

/**
 * What level is this ref at, judged only by what it carries?
 *
 * The level is the highest rung that APPLIES to this ref and is satisfied, with
 * every applicable rung below it satisfied too. Nothing needs to have written a
 * level for the level to be right, which is what makes the 1,578 refs already
 * in KV correct the first time the nightly looks at them.
 *
 * Two deliberate choices in that sentence:
 *
 * A rung that doesn't apply is stepped over without crediting it. An article
 * has no picture to caption and no video to watch, so an enriched article
 * reports level 2 — "surface done" — not level 4 for having failed to be a
 * video. Otherwise the histogram lies about how deep the archive really is, and
 * "get everything to level 2 before anything reaches level 4" stops meaning
 * anything. It does mean the number can jump (an article goes 2 -> 5 when its
 * tags are staged), which is honest: there was nothing in between for it.
 *
 * A rung that applies but is permanently blocked still holds the level down,
 * because it genuinely never happened. `nextStep()` is the one that steps over
 * a block, so a ref stuck at rung 2 can still reach the queue at rung 5 while
 * continuing to report level 1.
 *
 * @param {object} ref
 * @returns {number} 0..MAX_LEVEL
 */
export function levelOf(ref) {
  if (!ref || typeof ref !== "object") return 0;
  let level = 0;
  for (const rung of RUNGS) {
    if (!rung.applies(ref)) continue;
    if (!rung.satisfied(ref)) break;
    level = rung.level;
  }
  return level;
}

/**
 * The single next advance available for this ref, and what it costs.
 *
 * Walks up from the current level and returns the first rung that applies, is
 * unsatisfied, is possible, is not blocked, and is not muted by loop 2.
 * Skipping over a blocked or impossible rung is deliberate: an image we can't
 * fetch bytes for still has a title worth tagging, and stalling it forever at
 * rung 3 would take free work off the table for no gain.
 *
 * A muted rung is stepped over for the same reason. Suppression is a decision
 * about what to ASK him, not about what the archive is allowed to learn: a ref
 * whose realm card is silenced tonight still deserves its thumbnail, and
 * freezing every ref the classifier can't settle — which is most of the
 * Instagram half of the archive — would stop loop 1 dead every time loop 2
 * disliked a generator. The ref reports the lower level until the question is
 * asked, which is honest: the rung genuinely never happened.
 *
 * Pure. No I/O, no env, so it's safe to call inside a KV walk's filter.
 *
 * @param {object} ref
 * @param {object} [opts]
 * @param {Date}    [opts.now]     for backoff comparison, injectable for tests
 * @param {boolean} [opts.retry]   ignore permanent marks and backoff
 * @param {number}  [opts.maxTier] don't offer steps above this cost tier
 * @param {number}  [opts.redo]    re-run THIS rung even though it's satisfied
 * @param {Set}     [opts.suppressed] queue kinds loop 2 has silenced
 * @returns {{level:number, name:string, tier:number, vision:boolean,
 *   from:number, attempts:number, why:string}|null} null when topped out
 */
export function nextStep(ref, { now = new Date(), retry = false, maxTier = Infinity, redo = 0, suppressed = null } = {}) {
  if (!ref || typeof ref !== "object") return null;
  const from = levelOf(ref);

  for (const rung of RUNGS) {
    // `redo` is loop 3 saying "we last read this page a year ago, read it
    // again". It re-opens exactly ONE rung, and only the one named. `retry` is
    // the blunt instrument that re-opens all of them, and handing that to a
    // staleness finding is how the vision ration gets spent every lap of the
    // archive rediscovering the same permanent 403.
    const forced = redo === rung.level;
    if (!forced && rung.level <= from) continue;
    if (!rung.applies(ref)) continue;
    if (!forced && rung.satisfied(ref)) continue;
    if (!rung.possible(ref)) continue;
    if (rung.tier > maxTier) continue;
    // Loop 2 reaching loop 1. A rung that would ask him a question he has
    // stopped answering is not offered AT ALL — not offered with the asking
    // turned off. Running it muted would record an attempt and, at rung 1,
    // bank the record that `satisfied` reads, so that ref's question would be
    // retired for good on a night we had decided not to ask it: suppression
    // has to be reversible, and it is only reversible if it spends nothing and
    // closes nothing. The kind check is first because it's a Set lookup and
    // `asks()` runs the classifier.
    if (isSuppressed(suppressed, rung.proposes) && rung.asks(ref)) continue;
    if (isBlocked(ref, rung.level, { now, retry: retry || forced })) continue;

    const st = stepState(ref, rung.level);
    return {
      level: rung.level,
      name: rung.name,
      tier: rung.tier,
      vision: Boolean(rung.vision),
      from,
      // What this step would ASK him, if anything. On the step rather than
      // looked up from RUNGS by every caller, because "does tonight's work put
      // cards in his queue" is a question the run record has to answer.
      proposes: rung.proposes || "",
      redo: forced,
      attempts: st?.attempts || 0,
      why: forced
        ? `${rung.name} re-run on request`
        : st?.reason ? `retrying after: ${st.reason}` : `${rung.name} not yet attempted`,
    };
  }
  return null;
}

/**
 * Why is there nothing to do for this ref? "Waiting on loop 2" and "genuinely
 * finished" are the same empty answer from nextStep(), and a run record that
 * says a ref topped out when it was really holding a question we weren't
 * allowed to ask is a lie the nightly tells itself every night.
 *
 * Only runs when there is no step at all, so the second walk costs nothing on
 * the path that does work.
 */
function mutedReason(ref, { suppressed, ...opts } = {}) {
  const topped = "topped out — nothing available to climb";
  if (!suppressed) return topped;
  const unmuted = nextStep(ref, { ...opts, suppressed: null });
  if (!unmuted) return topped;
  const kind = RUNG_BY_LEVEL.get(unmuted.level)?.proposes || "";
  return `waiting — ${unmuted.name} would ask a ${kind} question and ${kind} cards are suppressed`;
}

/**
 * Perform ONE advance and persist it. Never more than one — the nightly's job
 * is breadth, and a ref that climbs three rungs in a night is three rungs the
 * rest of the archive didn't get.
 *
 * The order is deliberate: charge BEFORE the work, always. A run that died
 * between the call and the ledger write would hand tomorrow a budget that never
 * noticed tonight, and the vision ration would silently reset.
 *
 * The write-back re-reads the ref first. A climb takes seconds, and a ref he
 * edited on his phone in the meantime must not be clobbered by the copy we
 * loaded before he touched it. If the key is gone, we drop the patch — this is
 * also the guard that makes it impossible for a climb to create a ref.
 *
 * @param {object} env
 * @param {object} ref   a stored ref (must carry `id`)
 * @param {object} [opts]
 * @param {number}  [opts.tier=2]  the highest cost tier this climb may use
 * @param {Date}    [opts.now]
 * @param {boolean} [opts.retry]
 * @param {number}  [opts.redo]     re-run this one rung even though it's done
 * @param {Set}     [opts.suppressed] queue kinds loop 2 has silenced
 * @param {boolean} [opts.reindex=true] re-embed when the content changed
 * @returns {Promise<{ok:boolean, id:string, from:number, to:number,
 *   step:object|null, staged:number, spent:number, reason:string,
 *   permanent:boolean, errors:Array}>}
 */
export async function climb(env, ref, { tier = 2, now = new Date(), retry = false, reindex = true, redo = 0, suppressed = null } = {}) {
  const id = ref?.id || "";
  const from = levelOf(ref);
  const base = { ok: false, id, from, to: from, step: null, staged: 0, spent: 0, reason: "", permanent: false, errors: [] };

  if (!id) return { ...base, reason: "ref has no id" };

  const step = nextStep(ref, { now, retry, redo, suppressed });
  if (!step) return { ...base, reason: mutedReason(ref, { now, retry, redo, suppressed }) };
  if (step.tier > tier) {
    // Not an attempt and not a failure: we simply weren't allowed to try, and
    // burning a retry slot for that would punish the ref for our budget.
    return { ...base, step, reason: `next step needs tier ${step.tier}, this climb allows ${tier}` };
  }

  const rung = RUNG_BY_LEVEL.get(step.level);
  const booked = await charge(env, { tier: rung.tier, units: 1, vision: rung.vision, label: `ladder-${rung.name}` });
  if (!booked.ok) {
    // Same reasoning: a refusal by the governor is our constraint, not the
    // ref's fault. No attempt is recorded, so tomorrow's budget finds it
    // exactly where it left it.
    return { ...base, step, reason: booked.reason };
  }
  const spent = estimate(rung.tier, 1);

  let result;
  try {
    result = await rung.run(env, ref);
  } catch (err) {
    result = { ok: false, patch: {}, ...classifyFailure(err) };
  }

  const ladder = recordAttempt(ref, rung.level, {
    ok: result.ok,
    reason: result.ok ? result.note || "" : result.reason || "",
    permanent: Boolean(result.permanent),
    now,
  });

  // Re-read, merge, write. A ref that disappeared while we worked stays gone.
  const key = `ref:${id}`;
  let current;
  try {
    current = await env.REFS_KV.get(key, "json");
  } catch (err) {
    return { ...base, step, spent, reason: `re-read failed, climb dropped: ${short(err)}`, errors: [{ stage: "kv", error: short(err) }] };
  }
  if (!current) return { ...base, step, spent, reason: "ref was deleted while we climbed" };

  // The attempt record goes on BEFORE the level is computed. Rung 5's whole
  // notion of "satisfied" lives in that record — the tags are in the queue, not
  // on the ref — so measuring the level against the pre-climb ladder would
  // score every tag pass as though it had never happened.
  const merged = { ...current, ...(result.patch || {}), ladder };
  merged.ladder = { ...ladder, level: levelOf(merged) };

  try {
    await env.REFS_KV.put(key, JSON.stringify(merged));
  } catch (err) {
    return { ...base, step, spent, reason: `write failed, climb lost: ${short(err)}`, errors: [{ stage: "kv", error: short(err) }] };
  }

  const out = {
    ok: Boolean(result.ok),
    id,
    from,
    to: merged.ladder.level,
    step,
    staged: result.staged || 0,
    spent,
    reason: result.ok ? result.note || "" : result.reason || "",
    permanent: Boolean(result.permanent),
    note: result.note || "",
    errors: [],
  };

  // New body, caption or transcript means the stored vector no longer describes
  // this ref. That embed is a separate tier-2 unit and gets its own charge — if
  // the governor says no we flag the ref instead of quietly leaving a stale
  // vector behind, because a search that returns yesterday's meaning is the
  // hardest kind of wrong to notice.
  const contentChanged = Boolean(result.patch?.body || result.patch?.caption || result.patch?.transcript);
  if (out.ok && contentChanged && reindex && brainReady(env)) {
    const bill = await charge(env, { tier: 2, units: 1, label: "ladder-reindex" });
    if (!bill.ok) {
      await flag(env, key, { embedDirty: true });
      out.errors.push({ stage: "embed", refId: id, error: `reindex not booked: ${bill.reason}` });
    } else {
      out.spent += estimate(2, 1);
      if (await indexRef(env, merged)) {
        if (merged.embedDirty) await flag(env, key, { embedDirty: false });
      } else {
        // indexRef swallows its own failure and returns false. Saying so out
        // loud is the difference between "the index is stale for this ref" and
        // "there was nothing to reindex".
        await flag(env, key, { embedDirty: true });
        out.errors.push({ stage: "embed", refId: id, error: "indexRef returned false — the embed or the upsert failed" });
      }
    }
  }

  return out;
}

/** Tiny follow-up write. Re-reads so it can't resurrect a deleted ref either. */
async function flag(env, key, patch) {
  try {
    const cur = await env.REFS_KV.get(key, "json");
    if (!cur) return;
    await env.REFS_KV.put(key, JSON.stringify({ ...cur, ...patch }));
  } catch {
    // A failed flag is cosmetic — the climb itself is already banked, and the
    // caller already has the error in `errors`. Nothing here is load-bearing.
  }
}

/**
 * Choose which refs to advance tonight.
 *
 * BREADTH BEFORE DEPTH, then cheapest first. The primary sort key is the level
 * of the STEP, not the level of the ref: getting the whole archive to level 2
 * is worth more than taking a handful of refs to level 4, because level 2 is
 * what makes /browse stop being grey placeholders and what every rung above it
 * reads from. A ref sitting at level 1 whose only actionable step is rung 5
 * therefore sorts behind every rung-2 step in the pool.
 *
 * Bounded and resumable: it reads at most `maxScan` keys, returns the cursor to
 * carry into the next call, and plans against the real ledger so the cohort it
 * hands back is one the governor has already agreed to in principle.
 *
 * Returns `{items, error}` — a KV list that threw and an archive with nothing
 * left to climb are the same empty array otherwise, and one of those means
 * "well done, goodnight" while the other means the nightly is broken.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {number}  [opts.budget]  USD this cohort may plan to spend. Defaults
 *                                 to whatever tonight's ceiling has left.
 * @param {number}  [opts.limit=25] max refs in the cohort
 * @param {string}  [opts.cursor]  KV cursor from the previous call
 * @param {number}  [opts.tier=2]  highest cost tier the cohort may include
 * @param {Set}     [opts.suppressed] queue kinds loop 2 has silenced. A ref
 *                                 left with nothing but a muted rung is not a
 *                                 candidate — selecting it would spend a cohort
 *                                 slot to discover we aren't allowed to ask.
 * @returns {Promise<{items:Array, scanned:number, unreadable:number,
 *   cursor:string|null, done:boolean, levels:object, plan:object,
 *   error:string|null}>}
 */
export async function selectCohort(env, { budget, limit = 25, cursor, tier = 2, now = new Date(), retry = false, maxScan = MAX_SCAN, suppressed = null } = {}) {
  const want = Math.max(1, Math.min(Number(limit) || 25, 200));
  const pool = Math.min(want * POOL_FACTOR, MAX_POOL);

  const q = await quote(env, { tier: 0, units: 0 });
  const allowed = Number.isFinite(Number(budget)) ? Math.max(0, Number(budget)) : q.remaining;
  const visionLeft = q.visionLeft;

  const walk = await walkRefs(env, {
    cursor,
    want: pool,
    maxScan,
    pick: (ref) => nextStep(ref, { now, retry, maxTier: tier, suppressed }) !== null,
  });

  const plan = { allowed, planned: 0, visionLeft, visionPlanned: 0, considered: 0, skippedForBudget: 0 };
  if (walk.error) {
    return { items: [], scanned: walk.scanned, unreadable: walk.unreadable, cursor: walk.cursor, done: false, levels: walk.levels, plan, error: walk.error };
  }

  const candidates = walk.refs
    .map(({ ref }) => ({ ref, step: nextStep(ref, { now, retry, maxTier: tier, suppressed }) }))
    .filter((c) => c.step)
    .sort(
      (a, b) =>
        a.step.level - b.step.level ||
        a.step.tier - b.step.tier ||
        String(a.ref.id).localeCompare(String(b.ref.id))
    );
  plan.considered = candidates.length;

  const items = [];
  for (const c of candidates) {
    if (items.length >= want) break;
    const cost = estimate(c.step.tier, 1);
    if (plan.planned + cost > allowed) { plan.skippedForBudget++; continue; }
    if (c.step.vision && plan.visionPlanned >= visionLeft) { plan.skippedForBudget++; continue; }
    plan.planned = Number((plan.planned + cost).toFixed(6));
    if (c.step.vision) plan.visionPlanned++;
    items.push({ id: c.ref.id, ref: c.ref, step: c.step, cost });
  }

  return {
    items,
    scanned: walk.scanned,
    unreadable: walk.unreadable,
    cursor: walk.cursor,
    done: walk.done,
    levels: walk.levels,
    plan,
    error: null,
  };
}

/**
 * Level histogram for whatever stretch of the archive we can afford to read.
 *
 * Free, and it's what tells him whether the ladder is actually working: "412
 * refs at level 2, 9 at level 4" is the shape of an archive getting deeper, and
 * a histogram that hasn't moved in a week is a broken nightly.
 *
 * @returns {Promise<{levels:object, blocked:object, next:object, scanned:number,
 *   cursor:string|null, done:boolean, error:string|null}>}
 */
export async function ladderStats(env, { cursor, maxScan = 1000, now = new Date() } = {}) {
  const walk = await walkRefs(env, { cursor, want: Infinity, maxScan, pick: () => true });
  const next = {};
  const blocked = {};
  for (const { ref } of walk.refs) {
    const step = nextStep(ref, { now });
    if (step) next[step.level] = (next[step.level] || 0) + 1;
    for (const rung of RUNGS) {
      if (stepState(ref, rung.level)?.permanent) blocked[rung.level] = (blocked[rung.level] || 0) + 1;
    }
  }
  return {
    levels: walk.levels,
    blocked,
    next,
    toppedOut: walk.refs.length - Object.values(next).reduce((a, b) => a + b, 0),
    scanned: walk.scanned,
    unreadable: walk.unreadable,
    cursor: walk.cursor,
    done: walk.done,
    error: walk.error,
  };
}

// ------------------------------------------------------------------- plumbing

/**
 * Bounded, resumable walk of `ref:` keys, collecting the ones `pick` wants and
 * counting the level of every ref it reads on the way past.
 *
 * cron.js has scanRefs() doing much the same thing and this deliberately does
 * not import it: the nightly is where the ladder gets wired in, and a ladder
 * that imports cron while cron imports the ladder is an import cycle waiting to
 * bite. Thirty lines is cheaper than that.
 *
 * When we stop on a half-consumed page we hand back the cursor we came IN with,
 * not the one KV gave us — resuming mid-page is impossible, so re-reading it is
 * the only way not to skip its tail. The re-read is free and the refs we
 * already climbed no longer match `pick`.
 */
async function walkRefs(env, { cursor = null, want = 25, maxScan = MAX_SCAN, pick = () => true } = {}) {
  const refs = [];
  const levels = {};
  let kvCursor = cursor || undefined;
  let scanned = 0;
  let unreadable = 0;

  if (!env?.REFS_KV) {
    return { refs, levels, scanned, unreadable, cursor: cursor ?? null, done: false, error: "REFS_KV not bound" };
  }

  while (scanned < maxScan && refs.length < want) {
    const from = kvCursor;
    let page;
    try {
      page = await env.REFS_KV.list({ prefix: "ref:", limit: PAGE, cursor: from });
    } catch (err) {
      return { refs, levels, scanned, unreadable, cursor: from ?? null, done: false, error: `list: ${short(err)}` };
    }

    let filled = false;
    for (const k of page.keys) {
      scanned++;
      let ref = null;
      try {
        ref = await env.REFS_KV.get(k.name, "json");
      } catch {
        // One unreadable key must not silently shrink the cohort — it's counted,
        // and a result full of `unreadable` is its own diagnosis.
        unreadable++;
        continue;
      }
      if (!ref?.id) { unreadable++; continue; }
      const lvl = levelOf(ref);
      levels[lvl] = (levels[lvl] || 0) + 1;
      if (!pick(ref)) continue;
      refs.push({ key: k.name, ref });
      if (refs.length >= want) { filled = true; break; }
    }

    if (filled) return { refs, levels, scanned, unreadable, cursor: from ?? null, done: false, error: null };
    if (page.list_complete) return { refs, levels, scanned, unreadable, cursor: null, done: true, error: null };
    kvCursor = page.cursor;
  }

  return { refs, levels, scanned, unreadable, cursor: kvCursor ?? null, done: false, error: null };
}

const linkTimeout = (env) => Number(env?.LINK_TIMEOUT_MS ?? LINK_TIMEOUT_MS) || LINK_TIMEOUT_MS;

/** HEAD a url for its status. Returns {status, error} — never throws. */
async function probeLink(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA },
    });
    return { status: res.status, error: null };
  } catch (err) {
    // status 0 means "we never got an answer", which is a very different fact
    // from a 404 and must not be allowed to look like one.
    return { status: 0, error: short(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An image ref's bytes, with the reason when there aren't any.
 *
 * enrich.js has a private version of this that returns null on every failure.
 * The ladder cannot use that: "the host 403'd us" is permanent and "the fetch
 * timed out" is transient, and collapsing them into null is precisely how a ref
 * ends up either retried forever or abandoned for a blip.
 *
 * @returns {Promise<{bytes:ArrayBuffer|null, error:string, status:number}>}
 */
async function imageBytes(env, ref) {
  try {
    if (ref.blobKey) {
      if (env.REFS_R2) {
        const obj = await env.REFS_R2.get(`blob:${ref.blobKey}`);
        if (!obj) return { bytes: null, error: "no-bytes: blob missing from R2", status: 0 };
        return { bytes: await obj.arrayBuffer(), error: "", status: 200 };
      }
      const buf = await env.REFS_KV.get(`blob:${ref.blobKey}`, "arrayBuffer");
      if (!buf) return { bytes: null, error: "no-bytes: blob missing from KV", status: 0 };
      return { bytes: buf, error: "", status: 200 };
    }

    if (ref.image) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(ref.image, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA } });
        if (!res.ok) return { bytes: null, error: `image fetch ${res.status}`, status: res.status };
        return { bytes: await res.arrayBuffer(), error: "", status: res.status };
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    return { bytes: null, error: short(err), status: 0 };
  }
  return { bytes: null, error: "no-bytes: nothing to fetch", status: 0 };
}
