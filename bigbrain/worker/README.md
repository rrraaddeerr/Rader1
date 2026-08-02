# 🧠 Big Brain — the Worker

Rader Turner's reference archive, turned into something that **answers questions
about itself**. 1,578 refs — links, screenshots, articles, notes saved over years
— embedded in Cloudflare Vectorize. Ask a question, it retrieves the nearest refs
and a model answers **from them, with citations**.

This directory is the whole server: a single Cloudflare Worker, no build step, no
framework, no dependencies outside `wrangler`.

Two things it is for:

1. **It keeps teaching itself every night**, on compute that is already paid for.
2. **It works on an iPhone.** He is on his phone constantly. A surface that
   doesn't work on a 6-inch screen does not exist.

---

## Run it

```
npm test
```
```
npm run doctor
```
```
npm run deploy
```

`npm test` is plain Node — no deps, no network, no bindings, no Cloudflare
account. It globs `test/*.test.mjs`, so a new test file is picked up without
anyone remembering to register it, and it runs **every** file before reporting,
rather than stopping at the first failure. (It used to be an `&&` chain, and a
failure in the eighth file meant the ninth silently never ran for weeks.)

`npm run doctor` diagnoses the whole Cloudflare setup in one command — account
id mismatches, missing indexes, unset secrets.

---

## The four hard rules

These are not style preferences. Each one is here because breaking it cost real
money or real trust.

1. **Nothing ever adds a reference.** Curation is his craft. Every job in this
   codebase starts from a `ref:` key that already exists, and every write is a
   re-read-then-put of that key. A ref that vanished mid-job stays gone.
2. **Taste is staged; facts are applied.** A thumbnail, extracted page text, a
   caption, a link status — those are facts about the content and go straight
   onto the ref. Anything deciding what a ref *means* — its realm, its tags —
   becomes a card in the swipe queue (`src/stage.js`) and waits for his thumb.
3. **Spend is metered in code, not by convention.** `src/budget.js` holds a
   ~$5/night ceiling and a 20/night vision ration. Every paid call charges
   *before* it runs, so a job that dies mid-flight has already spent what it
   spent and tomorrow does not get a fresh ration. A job that wants 1,200 vision
   calls is refused, not invoiced.
4. **Never write a bare `catch { return [] }`.** A rejected query and an honest
   no-match have looked identical here three separate times, and each one cost
   hours. Every failure path returns `{items, error}` or carries a `debug` field.
   An empty result must never be able to mean "it broke".

And one more: with no `AI` or `VECTORS` binding the worker still saves, lists,
browses and serves. Only a missing `REFS_KV` is a hard wall.

---

## The layout

| file | owns |
|---|---|
| `src/index.js` | the router. Every `/api` route guarded by `requireToken()`. Exports `scheduled()` for the cron. |
| `src/embed.js` | embeddings + Vectorize. `METADATA_TOPK_MAX` lives here — read the gotchas. |
| `src/enrich.js` | page text, YouTube transcripts, vision captions, og:image thumbnails |
| `src/ask.js` | RAG + model tiers. `SYSTEM_PROMPT` is his voice. |
| `src/realm.js` | `REALMS`, `TASTE_AXES`, `CURATORS`, `classify()` — pure, Tier 0, no model |
| `src/stage.js` | the swipe queue. Cannot mutate a ref or reach Notion. That is the point. |
| `src/budget.js` | the cost governor: tier ladder, ceiling, vision ration |
| `src/propose.js` | generates queue proposals (tags, dead links, weak realms) |
| `src/brief.js` | the morning brief |
| `src/cron.js` | the nightly job — the seven-job pass below |
| `src/ladder.js` | **loop 1** — a ref is never finished, it climbs |
| `src/learn.js` | **loop 2** — every swipe is signal |
| `src/selfgaps.js` | **loop 3** — the archive audits itself |
| `src/mapdata.js` | the phone map's tree, precomputed into KV |
| `src/local.js` | Tier 1 — the lease/submit pair his Mac talks to |
| `src/pages/*.js` | self-contained HTML as template literals. No build step, no external assets. |

---

## The three loops

The nightly is not a fixed script. The loops feed each other, in this order.

### Loop 1 — every ref gets deeper (`src/ladder.js`)

A ref climbs levels across successive nights:

| level | what it gains | tier |
|---|---|---|
| 0 | raw: title, url, whatever the import carried | — |
| 1 | realm + coarse classification | 0 |
| 2 | thumbnail, readable page text, dead-link status | 0 |
| 3 | vision caption — what is *literally in the picture* | 2 (or 1 on his Mac) |
| 4 | video watched: transcript pulled and summarised | 2 |
| 5 | detail tags proposed from the deepened content | 0 |

**The level is inferred, never migrated** — `levelOf()` reads what a ref already
carries, so all 1,578 refs got correct levels the first time the nightly looked
at them, with no backfill and no window where the stored level and the stored
content disagreed.

**A permanent failure is not retried; a transient one is.** A host that 403s a
bot will 403 it tomorrow, and paying for that discovery every night forever is
the exact leak the governor exists to stop. Anything unrecognised is treated as
transient — we never permanently give up on a failure we can't read — but four
attempts converts it to permanent anyway, so "don't know" costs at most four
nights. Backoff is 1/2/4/8 days.

One rung per ref per night. Breadth beats depth: getting the whole archive to
level 2 is worth more than taking a handful of refs to level 4.

### Loop 2 — it learns his judgment (`src/learn.js`)

Every swipe is recorded — by one line in `stage.js`'s `decide()`, placed *before*
the edits are applied, because once `edits.realm` overwrites `proposal.realm` the
strongest signal in the system (that he changed INSPO to KNOWLEDGE) is
unrecoverable.

- Rates are **`null`, never `0`**, when nothing has been decided.
- Every rate ships with its sample count and a Wilson interval. A bonus uses the
  lower bound, a penalty the upper; if the interval straddles a coin flip the
  adjustment is exactly zero.
- A generator is suppressed only after 12 decided swipes *and* an upper bound
  under 25%. Skips are counted but kept out of the denominator — a lazily-swiped
  queue must not read as a queue full of bad proposals.
- About one suppressed pass in ten runs anyway, as a probe. Without it a silenced
  generator could never produce the evidence that it improved. The roll is
  derived from the date, not `Math.random()`, so a night can be explained
  afterwards and tested beforehand.

The goal is that **he swipes less each week, not more.**

### Loop 3 — it finds its own gaps (`src/selfgaps.js`)

The archive audits itself — thin regions, questions its own vectors answer
weakly, refs last read a year ago, near-duplicates, tag contradictions — ranks
the findings by impact per dollar, trims them to fit tonight's budget, and hands
back a work list. That list is what loop 1 climbs.

Nothing it finds is applied. Every taste call in the list is a `stage` job.

---

## The nightly

`src/cron.js`, on `10 11 * * *` UTC (04:10 Vancouver in summer, 03:10 in winter).
Also runnable on demand: `POST /api/nightly/run`.

Seven jobs. It quotes the budget **before touching anything** and stops the
moment the governor refuses.

| job | tier | what |
|---|---|---|
| `gaps` | 0/2 | loop 3 audits and writes tonight's work list |
| `triage` | 0 | dead links + weak realms, staged — loop 2 decides who may ask |
| `ladder` | 0/2 | loop 1 climbs, working the audit's ref ids first |
| `embed` | 0/2 | refs with no vector — detection is free, only the fill is paid |
| `enrich` | 2 | refs with no body: page text or transcript, then re-embed |
| `vision` | 2 | uncaptioned images, strictly inside the 20/night ration |
| `map` | 0 | rebuild the phone map — last, because it is the heaviest walk |

Resumable and idempotent, in that order of importance. Cursors live in KV and
survive across nights, so the archive is walked end to end over a week instead of
re-reading the newest 50 refs forever. Paid work checkpoints on the **ref** — an
enriched ref has a body, a captioned one has a caption — so there is no
bookkeeping to fall out of sync, because there is no bookkeeping.

Designed to cost about two cents a night. The $5 ceiling is the backstop that
catches a bug, not the target to spend up to.

---

## The compute tiers

Always climb from the bottom. The expensive tier decides *what* to do; the cheap
tiers do the volume.

| tier | runs on | good for | cost |
|---|---|---|---|
| 0 | the Worker | rules, joins, dead links, realm, clustering | free |
| 1 | **his Mac, via Ollama** | bulk captioning and summarising | free, idle hardware |
| 2 | Workers AI | per-item classify, embed, summarize | ~$0.0002/call |
| 3 | Claude | judgment, taste, the morning synthesis | metered |

### Tier 1 — the Mac

```
cd ~/futureoutfit/bigbrain/local
```
```
npm run overnight
```

See `../local/README.md`. It leases work, does it on Ollama, and submits.

**Leases, not claims.** Every job carries a deadline and a nonce. If the laptop
lid closes the lease simply lapses and the job returns to the pool — nothing has
to notice the crash, and a runner that wakes up twenty minutes late has its
answer refused as stale rather than overwriting a live one.

**Released ≠ reported.** A job handed back because Ollama died is *released*:
back in the pool with no attempt recorded, because our laptop is not the ref's
fault. A job that failed because the image 404s is *reported*: a real attempt,
and the ladder's backoff owns it from there.

Local captions charge tier 1 with `vision: false`. They must **not** eat the
20/night Workers AI ration — that ration exists to stop *paid* vision, and
spending it on free compute would defeat the entire point of the tier.

---

## Endpoints

Auth on everything under `/api` and `/save`: header `X-Auth-Token`.
`/health` and `/blob/:key` are the only unauthenticated routes — the blob key is
itself the capability, so `<img>` tags work.

### Pages
| path | |
|---|---|
| `/drop` | the capture SPA |
| `/browse` | the gallery |
| `/queue` | the swipe feed |
| `/brief` | the morning brief |
| `/map` | the phone map: regions → clusters → refs |
| `/shortcuts` | iOS Shortcuts setup (share sheet, Back Tap, Siri) |

### Refs
| method | path | |
|---|---|---|
| POST | `/save?similar=1` | save a ref (JSON, or raw bytes + `X-Note`) |
| GET | `/api/list` | keyword search / filter / page |
| GET·PATCH·DELETE | `/api/ref/:id` | one ref |
| POST | `/api/ref/:id/thumb` | repair one thumbnail |
| GET | `/api/export` · POST `/api/import` | NDJSON out, bulk in |

### The brain
| method | path | |
|---|---|---|
| POST | `/api/search` | semantic search `{q, cat, realm, limit}` |
| POST·GET | `/api/ask` | answer from refs `{q, deep}`; `?format=text` for Siri |
| GET | `/api/similar/:id` | nearest refs to this one |
| GET | `/api/profile` | taste fingerprint |
| POST | `/api/reindex?deep=1` | rebuild embeddings, cursor-paged |

### The queue
| method | path | |
|---|---|---|
| GET·POST | `/api/queue` · `/api/queue/:id` | the swipe feed and its decisions |
| GET | `/api/queue/stats` · `/api/queue/export` | counts; approved-and-unpushed |
| POST | `/api/queue/propose` · `/api/queue/applied` | queue a batch; mark pushed |
| POST | `/api/propose` · GET `/api/propose/preview` | generate proposals |

### The loops
| method | path | |
|---|---|---|
| GET | `/api/ladder/stats` | level histogram, permanent blocks, what's next |
| GET | `/api/ladder/next/:id` | why is this one ref stuck? |
| POST | `/api/ladder/run` | advance a cohort by one rung each |
| GET | `/api/learn` | acceptance rates; `?rebuild=1` replays the outcome log |
| POST | `/api/learn/score` | what learning would do to one proposal, and why |
| GET | `/api/selfgaps` | the audit. Free unless `?probe=1` |
| GET·POST | `/api/selfgaps/plan` | tonight's work list. The **GET never spends** |
| GET | `/api/map` | one level of the map — one KV read, no scan, no query |
| POST | `/api/map/rebuild` | recompute the whole tree |

### The nightly, the Mac, the money
| method | path | |
|---|---|---|
| GET | `/api/brief` | what landed, what's waiting, what it cost |
| GET | `/api/nightly` · `/api/nightly/:day` | the last few nights; one night |
| POST | `/api/nightly/run` | run the pass now `{dryRun, jobs, limits, retry}` |
| POST | `/api/local/lease` · `/api/local/submit` | Tier 1. `limit: 0` is a ping |
| GET | `/api/local` | what's still waiting for the Mac |
| POST | `/api/thumbs` | og:image backfill |
| GET | `/api/budget` | tonight's ledger and what still fits |
| GET | `/health` | liveness + which subsystems are wired |

---

## Gotchas that each cost an hour

1. **Vectorize REJECTS `topK > 20` when `returnMetadata: "all"`.** It refuses; it
   does not truncate. Over-fetching to filter in JS therefore returns
   **nothing**. See `METADATA_TOPK_MAX` in `src/embed.js`.
2. **Workers AI model ids move.** A renamed model presents exactly like an
   unbound AI. `ask.js` tries a list of ids for this reason.
3. **`/health` needs no token**, so a green health check proves nothing about
   `AUTH_TOKEN`. Verify with
   `curl -H "X-Auth-Token: $TOKEN" "$URL/api/list?limit=1"`.
4. **Vectorize is eventually consistent.** `npx wrangler vectorize info
   bigbrain-refs` shows the true `vectorCount`.
5. **`charge()` books against the real UTC day**, always — it has no injectable
   clock, while `buildBrief()` and `runNightly()` do. They agree in production
   (both are "now"); in a test with a frozen clock they do not, and a ledger
   parked under the frozen day will be quietly ignored.
6. **`wrangler secret put` reads stdin** — `printf '%s' "$TOKEN" | npx wrangler
   secret put AUTH_TOKEN` guarantees the shell var and the secret match.
7. **A stale `CLOUDFLARE_ACCOUNT_ID` in `~/.zshrc` beats `wrangler.toml`.**
   `npm run doctor` catches it.

---

## Setup from scratch

One command per block. Never paste several at once — a pasted block makes
`read -rs` swallow the next line.

```
npx wrangler kv namespace create save-ref-kv
```
```
npx wrangler vectorize create bigbrain-refs --dimensions=768 --metric=cosine
```
```
openssl rand -hex 32
```
```
npx wrangler secret put AUTH_TOKEN
```
```
npm run deploy
```

Then paste the same token into `/drop`'s first-time setup field, and:

```
curl -s -H "X-Auth-Token: $TOKEN" "$URL/api/list?limit=1" | head -c 120
```
