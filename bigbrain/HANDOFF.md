# 🧠 BIG BRAIN — HANDOFF & EXPANSION PLAN

*Written 2026-07-29. Big Brain only. Nothing here about rent.co, future-outfit,
events, or any other project — if you find that creeping in, delete it.*

*Everything marked **VERIFIED** was measured or run. Everything marked
**UNVERIFIED** was built and unit-tested but has never executed against the live
worker. Nothing else is claimed.*

---

## 1. WHAT BIG BRAIN IS

Rader Turner's reference archive — links, screenshots, articles, notes he has
been saving for years — turned into something that **answers questions about
itself**.

1,578 refs are embedded in Cloudflare Vectorize. Ask a question, it retrieves
the nearest refs and a model answers **from them, with citations**.

**VERIFIED** — real output, his archive, *"what is my through-line as a set designer?"*:

> **In-camera mechanism over post-fix.** The curtain rig [1] and the
> rhinestone-on-mirror lighting trick [6] are the same move: build a physical rig
> that does the effect for real, on set, rather than faking it after. […] So the
> through-line: **you build the effect, don't simulate it** — rigs, projection,
> and raw material are all treated as functional mechanisms first, aesthetic
> second. The look is a byproduct of the engineering.
>
> Thin spots: [2], [3], [5] don't fit cleanly into this —

That closing line is the bar. It says where its own reading breaks down instead
of smoothing over it. Do not let that honesty regress.

---

## 2. THE EXPANSION — what this is actually for

**Big Brain should keep teaching itself every night, on compute already paid
for, and be genuinely usable on an iPhone.**

That's the whole brief. Three learning loops, one interface problem, three
compute tiers.

### Loop 1 — every ref gets deeper
The enrichment ladder. A ref is not finished when it lands; it climbs levels
across successive nights:

| level | what it gains |
|---|---|
| 0 | raw: title, url, whatever the import carried |
| 1 | realm + coarse classification (free, deterministic) |
| 2 | thumbnail, readable page text, dead-link status |
| 3 | vision caption for images — what is *literally in the picture* |
| 4 | video actually watched: transcript pulled and summarized |
| 5 | detail tags proposed from the deepened content |

Each ref carries its own level. The nightly job advances whatever it can afford,
cheapest tier first, and stops when the budget says stop. **The archive is never
"done" — it keeps getting richer while he sleeps.**

### Loop 2 — it learns his judgment
Every swipe is signal. Approve, reject, or edit on a proposal tells the system
what he'd have said yes to. Over time:

- generators whose proposals keep getting rejected get **suppressed**
- generators he keeps approving get **more rope**
- per-source and per-axis acceptance rates steer future confidence
- his edits (changing a realm before approving) are the strongest signal of all

The goal: proposal quality converges on his taste instead of guessing at it
forever. **He should have to swipe less each week, not more.**

### Loop 3 — it finds its own gaps
Self-directed, not a fixed script. The brain evaluates its own coverage —
questions it answers thinly, clusters with no good captions, refs that
contradict each other, regions of the archive it has never enriched — and
**queues its own work list for the next night.**

This is what makes it a learning system rather than a cron job.

### The interface problem — it must work on a phone
The existing taste map (1,698 nodes, 6,962 connections, from the BIG BRAIN 2.0
session) is **too dense to read on a 6-inch screen**. His words. It needs a
phone-native rebuild:

- progressive zoom — the galaxy resolves into regions, regions into clusters
- tap to drill into one cluster at a time, never the whole graph at once
- touch targets sized for a thumb
- fast enough to feel like an app, not a diagram

He works from his phone constantly. **A surface he can't use on a phone doesn't
exist.**

### The compute — three tiers, by job type
| tier | runs on | good for | cost |
|---|---|---|---|
| 0 | Cloudflare Worker cron | deterministic work: rules, joins, dead links, realm | ~free |
| 1 | **his Mac via Ollama** | bulk model work: captioning thousands of images | free, idle hardware |
| 2 | Workers AI | per-item classify, embed, summarize | cents |
| 3 | scheduled Claude session | judgment: what to work on, reading the archive | metered |

Climb from the bottom, always. The expensive tier decides *what* to do; the
cheap tiers do the volume.

---

## 3. HARD CONSTRAINTS — non-negotiable

1. **NEVER auto-add references.** Curation is his craft — *"the thing I do with
   my eyes closed."* Agents **enrich existing refs only**.
2. **Taste calls are staged, not applied.** Factual repairs (dead links, missing
   titles, thumbnails) may apply directly. Anything deciding what a ref *means*
   becomes a proposal in the swipe queue awaiting his thumb.
3. **Spend is metered in code, not by convention.** ~**$5/night** ceiling,
   vision rationed to **20 calls/night**. He was billed badly once. A job that
   wants 1,200 vision calls is **refused, not invoiced**. See `worker/src/budget.js`.
4. **`claude.ai/code` is DISABLED on his account.** Never route anything
   user-facing through it.
5. **Phone-first.** If it doesn't work on an iPhone, it isn't done.
6. **Guide him one step at a time** on any CLI task, and do as much as possible
   *for* him. See §8.

---

## 4. LIVE STATE — VERIFIED

### The worker
| | |
|---|---|
| URL | `https://save-ref-v2.raderturner-e87.workers.dev` |
| Worker name | `save-ref-v2` |
| Pages | `/drop` · `/browse` · `/queue` · `/brief` · `/shortcuts` |

### Cloudflare — account `raderturner@gmail.com`, id `e87845f0432428cd66fc37867b2cc01e`
| binding | resource |
|---|---|
| `REFS_KV` | KV `e9c59ebc5134468bbb4b486a4261f2c2` |
| `VECTORS` | Vectorize `bigbrain-refs`, 768 dims, cosine — **1,575 vectors** |
| `AI` | Workers AI |
| `AUTH_TOKEN` | secret — his token, in his password manager |
| `ANTHROPIC_API_KEY` | secret — enables the Claude tier |

### Notion — account `rt@raderturner.com` (**different account from Cloudflare**)
| | |
|---|---|
| 🧠 Big Brain database | `59aa4929-3ca6-41ff-ad4a-9c41d2f23b36` |
| data source | `collection://9a3c0605-32d9-4362-a95b-ee9abe51a008` |
| Saved (unsorted) | `8db833c0-8e94-4d2a-a842-1771510753ec` |

Schema: `Name` (title), `URL`, `Type` (News/AI/Design Reference), `Tags`
(multi-select, 16 fixed options), `Source App`, `Notes`, `Look`, `Date Added`.
**No realm field in Notion** — realm currently lives only in the worker.

### The archive — measured
| | count |
|---|---|
| refs in Notion | 1,578 |
| imported | 1,578 |
| embedded | 1,575 (3 had no text) |
| from Instagram | 1,241 |
| …already carrying caption text as a title | 1,158 |
| titled literally "Instagram" | **83** |
| rows with no tags | 445 |
| realms | INSPO 1,265 · CULTURE+NEWS 236 · KNOWLEDGE 77 |

⚠️ An earlier pass claimed 1,216 rows were titled "Instagram" and built strategy
on it. Wrong — it generalised from a 12-row sample of the newest refs. It is
**83**. Measure before building on a number.

### The taste seed
`~/Dropbox/_PROSPECTOR/TASTE_SOURCES.md`, distilled from his Instagram export
(11,922 saved posts / 2,863 accounts). Eight axes are encoded in
`worker/src/realm.js` as `TASTE_AXES`; his top curator accounts by save count are
in `CURATORS` — `welcome.jpeg` (195), `noeloquence` (173), `trashcanpaul` (142),
`software2050` (111), `fantasyafantasya` (102), `nathanielknows` (97).

Realms: `INSPO` · `KNOWLEDGE` · `CULTURE+NEWS` · `SELF`. **SELF is never
inferred** — nothing can tell what's personal to him.

---

## 5. ARCHITECTURE

`bigbrain/worker/src/`:

| file | owns |
|---|---|
| `index.js` | the router. Every API route token-guarded via `requireToken()`. Exports `scheduled()` for cron. |
| `embed.js` | embeddings + Vectorize. `METADATA_TOPK_MAX` lives here — read §6. |
| `enrich.js` | page text, YouTube transcripts, vision captions, og:image thumbnails |
| `ask.js` | RAG + model tiers. `SYSTEM_PROMPT` is his voice: archive/warehouse/operating-system, functional but hot. |
| `realm.js` | REALMS, TASTE_AXES, CURATORS, `classify()` — pure, Tier 0, no model |
| `stage.js` | the swipe queue. Cannot mutate a ref or reach Notion. That is the point. |
| `budget.js` | cost governor: tier ladder, ceiling, vision ration |
| `propose.js` | generates queue proposals (tags, dead links, low-confidence realms) |
| `brief.js` | assembles the morning brief |
| `cron.js` | the nightly job |
| `og.js` · `categorize.js` | Open Graph scraping; kind bucketing |
| `pages/*.js` | self-contained HTML as template literals. No build step, no external assets. |

**Model tiers** (`ask.js`): cheap = Workers AI, tries a **list** of model ids
because Cloudflare renames them. Deep = Claude (`claude-sonnet-5`, override with
`ANTHROPIC_MODEL`), silently falls back to cheap without a key.

The gap between tiers is large. Cheap produced *"innovative and versatile set
design solutions."* Claude produced the through-line in §1. **Use deep for
anything he'd call taste.**

### Endpoints
Auth on everything under `/api` and `/save`: header `X-Auth-Token`.

| method | path | purpose |
|---|---|---|
| POST | `/save?similar=1` | save a ref (JSON, or raw bytes + `X-Note`) |
| GET | `/api/list` | keyword search / filter / page |
| GET·PATCH·DELETE | `/api/ref/:id` | one ref |
| POST | `/api/ref/:id/thumb` | repair one ref's thumbnail |
| GET | `/api/export` · POST `/api/import` | NDJSON out, bulk in |
| POST | `/api/search` | semantic search `{q, cat, realm, limit}` |
| POST·GET | `/api/ask` | answer from refs `{q, deep}`; `?format=text` for Siri |
| GET | `/api/similar/:id` | nearest refs to this one |
| GET | `/api/profile` | taste fingerprint |
| GET·POST | `/api/queue` `/api/queue/:id` `/api/queue/stats` | the swipe feed |
| GET | `/api/queue/export` · POST `/api/queue/applied` | approved-and-unpushed; mark pushed |
| POST | `/api/queue/propose` | drop a batch of proposals into the queue |
| POST | `/api/propose` · GET `/api/propose/preview` | generate proposals |
| POST | `/api/classify` | Tier 0 realm classification, free, no model |
| POST | `/api/thumbs` | og:image backfill |
| POST | `/api/reindex?deep=1` | rebuild embeddings, cursor-paged |
| GET | `/api/brief` · page `/brief` | morning brief |
| GET | `/api/nightly` · `/api/nightly/:day` · POST `/api/nightly/run` | cron records / manual run |
| GET | `/api/budget` | tonight's ledger and what still fits |
| GET | `/health` | liveness + which subsystems are wired |

**Loop 1 — the enrichment ladder** (`src/ladder.js`)

| method | path | purpose |
|---|---|---|
| GET | `/api/ladder/stats` | level histogram, permanent blocks, what's next |
| GET | `/api/ladder/next/:id` | why is this one ref stuck? |
| POST | `/api/ladder/run` | advance a cohort by one rung each `{limit, tier, budget, retry}` |

**Loop 2 — learning from swipes** (`src/learn.js`)

| method | path | purpose |
|---|---|---|
| GET | `/api/learn` | acceptance per kind/source/axis/realm; `?rebuild=1` replays the log |
| POST | `/api/learn/score` | what learning would do to one proposal, and why |

**Loop 3 — self-directed gap-finding** (`src/selfgaps.js`)

| method | path | purpose |
|---|---|---|
| GET | `/api/selfgaps` | the audit. Free unless `?probe=1` |
| GET·POST | `/api/selfgaps/plan` | tonight's work list. **The GET never spends** |

**The phone map** (`src/mapdata.js`, page `src/pages/map.js`)

| method | path | purpose |
|---|---|---|
| GET | `/map` | the page: regions → clusters → refs, one tap at a time |
| GET | `/api/map?region=&cluster=` | one level — one KV read, no scan, no vector query |
| POST | `/api/map/rebuild` | recompute the whole tree (also the nightly's last job) |

**Tier 1 — his Mac over Ollama** (`src/local.js`, runner in `bigbrain/local/`)

| method | path | purpose |
|---|---|---|
| POST | `/api/local/lease` | hand out caption/summarize work. `limit: 0` is a ping |
| POST | `/api/local/submit` | answers, failures and hand-backs, in one call |
| GET | `/api/local` | what's still waiting for the Mac, and what's leased |

### Tests
**No deps, no network, no bindings.** `cd bigbrain/worker && npm test`

---

## 6. GOTCHAS THAT EACH COST AN HOUR

1. **Vectorize REJECTS `topK > 20` when `returnMetadata: "all"`.** It refuses; it
   does not truncate. Over-fetching to filter in JS therefore returns
   **nothing**. See `METADATA_TOPK_MAX` in `embed.js`.
2. **`catch { return [] }` is how this codebase lies to you.** A rejected query
   and an honest no-match looked identical **three separate times**. Every
   failure path must surface a `debug` field. Never add a bare empty catch.
3. **Workers AI model ids move.** A renamed model presents exactly like an
   unbound AI. `ask.js` tries a list.
4. **`/health` needs no token**, so a green health check proves nothing about
   `AUTH_TOKEN`. Verify with
   `curl -H "X-Auth-Token: $TOKEN" "$URL/api/list?limit=1"`.
5. **Vectorize is eventually consistent.** `npx wrangler vectorize info <index>`
   shows the true `vectorCount`.
6. **Notion CSV export only contains properties visible in the exported view**,
   and nests the CSV in a zip inside a zip. `scripts/notion-import.mjs` handles
   both and names any missing column.
7. **`wrangler secret put` reads stdin** — `printf '%s' "$TOKEN" | npx wrangler
   secret put AUTH_TOKEN` guarantees shell var and secret match.
8. Cloudflare auth failures with a mismatched account id are usually a stale
   `CLOUDFLARE_ACCOUNT_ID` in `~/.zshrc`. The env var beats `wrangler.toml`.
   `npm run doctor` diagnoses all of this in one command.

---

## 7. STATE — done vs outstanding

### Working, VERIFIED against live data
- Semantic search over 1,575 refs
- Ask with citations, both model tiers
- Similar-to, realm filtering
- Swipe queue mechanics, cost governor
- iPhone capture guide at `/shortcuts` (share sheet, Back Tap, Siri)

### Built, unit-tested, **UNVERIFIED against the live worker**
The build environment cannot reach `workers.dev`, so none of these have run for
real. Deploy, then check each:
- `/api/thumbs` — og:image backfill. **Highest value.** The archive is visual and
  currently renders as grey placeholders. Instagram may block a large share.
- `/api/propose` — fills the queue. Until it runs, `/queue` is empty.
- `/brief` — the morning brief page.
- nightly cron at `10 11 * * *` UTC.
- **Loop 1** — the enrichment ladder (`src/ladder.js`). Levels are *inferred*
  from what a ref carries, so the 1,578 already in KV need no backfill. Permanent
  failures close a rung; transient ones back off 1/2/4/8 days and convert to
  permanent after four. `/api/ladder/stats` is the number that says whether the
  nightly is working — a histogram that hasn't moved in a week is a broken cron.
- **Loop 2** — learning from swipes (`src/learn.js`), recorded by one line in
  `stage.js`'s `decide()`. Rates are `null` and never `0` before he has decided
  anything. Suppression needs 12 decided swipes *and* an upper bound under 25%,
  and probes about one pass in ten so it stays reversible.
- **Loop 3** — self-directed gap-finding (`src/selfgaps.js`). Ranks findings by
  impact per dollar and hands the nightly a work list. Every taste call in that
  list is a `stage` job; nothing it finds is applied.
- **Mobile map** — `/map` plus `src/mapdata.js`. Three KV key shapes so drilling
  in is one read at any depth. Regions capped at 9 so the opening screen fits a
  thumb. **Nothing renders until `POST /api/map/rebuild` (or one nightly) has
  run** — an unbuilt map answers `needsBuild`, and the page offers a build button.
- **Tier 1 compute** — `POST /api/local/lease` · `/api/local/submit` plus the
  runner in `bigbrain/local/`. Leases, not claims: a closed laptop lapses back
  into the pool with no attempt charged to the ref. Local captions charge tier 1
  with `vision:false`, so they never touch the 20/night paid ration.
- **The nightly, rewritten** to run the loops in order — loop 3 plans, loop 1
  climbs inside that plan, loop 2 decides which generators may still ask — and to
  rebuild the map last. Seven jobs; still quotes before touching anything and
  still stops the moment the governor refuses.

### Not started
- **Tier 3 compute**: scheduled Claude session for judgment
- **Applying approved proposals** — nothing writes `ref.realm` or `ref.tags`.
  The queue records his answer and `/api/queue/export` hands it over; the step
  that puts it back on the ref (and re-embeds) does not exist yet.
- **Loop 3's `stage` jobs** — the audit finds near-duplicates and tag
  contradictions but has no proposal shape for them, and `stage.js` drops any
  proposal that changes no title, realm or tag. The nightly reports these as
  unhandled rather than queueing an empty card.
- **Realm back into Notion** — realm exists only in the worker; writing it back
  needs a Notion token the worker doesn't have and he hasn't been asked for.
- **The IG join** — needs a *fresh* Instagram export. His is from 2026-04-22 and
  predates most of the archive; the zip in Downloads is Markdown-only, no CSV.
  Would add author + taste axis to 1,241 refs.

---

## 8. RULES OF ENGAGEMENT — what actually worked

- **Verify before asserting.** Two confident claims this session were wrong (the
  1,216 figure; a "missing vectorize scope" that the API disproved on the very
  next line). Both were caught by checking. Check first.
- **Never hand him a multi-line paste block.** Pasted blocks make
  `read -rs TOKEN` swallow the next line, feed `#` comments to `npm`, and
  concatenate `curl` onto `git pull`. **One command per block. No trailing
  comments. No em dashes inside commands.**
- **Don't make him type paths.** Have him type up to `--refs ` and drag the file
  from Finder into Terminal.
- **Write the diagnostic instead of the explanation.** `npm run doctor` and
  `npm run setup-kv` each replaced entire rounds of back-and-forth.
- **When output looks stale, suspect the deploy.** Twice the code was right and
  the worker was running an older version.
- **He is on his phone often.** Answers must survive being read on a phone.
- **Scope discipline.** This project is Big Brain. It is not rent.co, not
  future-outfit, not a festival. Mixing them in is what forced this document to
  be rewritten.

---

## 9. FIRST COMMANDS

```
cd ~/futureoutfit/bigbrain/worker
```
```
npm test
```
```
npm run deploy
```

Credentials — one line at a time, never pasted as a block:

```
export URL=https://save-ref-v2.raderturner-e87.workers.dev
```
```
read -rs TOKEN && export TOKEN
```

Confirm auth actually works:

```
curl -s -H "X-Auth-Token: $TOKEN" "$URL/api/list?limit=1" | head -c 120
```

Then the highest-value unverified thing:

```
curl -s -X POST "$URL/api/thumbs" -H "X-Auth-Token: $TOKEN" | head -c 400
```

---

## 10. IF YOU ONLY DO ONE THING

Make the archive teach itself overnight and make it readable on his phone.
Everything else is detail.
