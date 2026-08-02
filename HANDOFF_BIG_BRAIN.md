# HANDOFF — 🧠 BIG BRAIN (RAG archive + taste layer)

*Written 2026-07-29 by Claude at the end of the build session, for whoever picks
this up next. Everything below is **verified state**, not aspiration, unless
explicitly marked TODO or UNVERIFIED.*

---

## 0. THE 60-SECOND VERSION

Big Brain is Rader Turner's reference archive, and it now answers questions
about itself. 1,578 refs from his Notion database are embedded in Cloudflare
Vectorize; asking a question retrieves the nearest refs and a model answers
**from them**, with citations.

It is **LIVE** at `https://save-ref-v2.raderturner-e87.workers.dev`.

Proof it works — real output, his actual archive, question *"what is my
through-line as a set designer?"*:

> **In-camera mechanism over post-fix.** The curtain rig [1] and the
> rhinestone-on-mirror lighting trick [6] are the same move: build a physical rig
> that does the effect for real, on set, rather than faking it after. […] So the
> through-line: **you build the effect, don't simulate it** — rigs, projection,
> and raw material are all treated as functional mechanisms first, aesthetic
> second. The look is a byproduct of the engineering.
>
> Thin spots: [2], [3], [5] don't fit cleanly into this —

That last line matters: it flags where its own reading breaks down. That's the
honesty instruction in `SYSTEM_PROMPT` holding, and it's the bar to maintain.

---

## 1. WHO THIS IS FOR

**Rader Turner**, Vancouver. Runs **rent.co / RaderENT** (prop, wardrobe and set
rental — 590 curated items) and is relaunching **THANKS** as **FUTURE OUTFIT**.
Production designer / set decorator by trade.

**What he actually wants** (his words, asked directly, 2026-07-28):

> "LEVEL UP CREATIVELY. ALLOW FOR MY BRAIN TO HAVE PERSONIFICATION DIGITALLY AND
> HELP WITH MY MEMORY AND ABSORBING THE WORLD WHOLE-LY AND WITH RECEIPTS. I WANT
> TO INTERVIEW MY FAVOURITE ARTISTS, START A 3 DAY FEST, RELEASE ART / MOVIES /
> MUSIC OF MY OWN AND THIS IS ALL THE SAVED INSPO THAT WILL BE MY ARMOUR GOING
> FORWARD."

Plus: close more rent.co work, and ship future-outfit as a real product.

**Read that paragraph before deciding what to build.** Everything in this repo so
far is infrastructure that clears the ground for it. The archive can now name his
through-line with receipts — that is the raw material for the interviews, the
festival, and his own releases. None of those are built.

**Daily shape he asked for:** a morning brief, a decision queue, and work already
done awaiting review. Engine: all three layered — Cloudflare cron for cheap
always-on jobs, scheduled agent sessions for judgment, his Mac for heavy batches.

---

## 2. HARD CONSTRAINTS — non-negotiable, learned from him directly

1. **NEVER auto-add references to Big Brain.** Curation is his craft — *"the
   thing I do with my eyes closed."* Agents **enrich existing refs only**.
2. **Taste calls are staged, not applied.** Boring factual repairs (dead links,
   missing titles) may apply directly. Anything deciding what a ref *means*
   (realm, tags, aesthetic judgment) becomes a **proposal** in the swipe queue
   (`src/stage.js` → `/queue`) awaiting his thumb.
3. **Token spend needs same-moment OK.** He was billed badly once. Comfort
   ceiling ≈ **$5/night**, vision rationed to **20 calls/night**. Enforced in
   code (`src/budget.js`), not by convention. A job that wants 1,200 vision calls
   is **refused, not invoiced**.
4. **Money is the point.** He has no degrees and no financial backing. Rank every
   feature by distance-to-dollars.
5. **`claude.ai/code` is DISABLED on his account** (redirects to `/code/disabled`).
   Never route anything user-facing through it. Delivery is Notion today; the
   worker's own pages otherwise; phone push is the end goal.
6. **Interrupt on gold, quietly pile the rest.**
7. **Guide him one step at a time** on any CLI/dashboard/API-key task, and do as
   much as possible *for* him. See §9 — this is not a preference, it's what makes
   the difference between a session that ships and one that stalls.

---

## 3. LIVE INFRASTRUCTURE — verified

### The worker
| | |
|---|---|
| URL | `https://save-ref-v2.raderturner-e87.workers.dev` |
| Name | `save-ref-v2` |
| Source | `worker/save-ref/` in `rrraaddeerr/futureoutfit` |
| Branch | `claude/big-brain-llm-learning-39fpf1` |

### Cloudflare (account `raderturner@gmail.com`)
| binding | resource |
|---|---|
| `REFS_KV` | KV `e9c59ebc5134468bbb4b486a4261f2c2` |
| `VECTORS` | Vectorize `bigbrain-refs` (768 dims, cosine) — 1,575 vectors |
| `INV_VECTORS` | Vectorize `bigbrain-inventory` (768 dims, cosine) — 590 vectors |
| `AI` | Workers AI |
| `AUTH_TOKEN` | secret — his Big Brain token, in his password manager |
| `ANTHROPIC_API_KEY` | secret — enables the "deep" (Claude) tier |

Account ID `e87845f0432428cd66fc37867b2cc01e`, pinned in `wrangler.toml`.

### Notion (account `rt@raderturner.com` — **different from Cloudflare**)
| | |
|---|---|
| 🧠 Big Brain database | `59aa4929-3ca6-41ff-ad4a-9c41d2f23b36` |
| …its data source | `collection://9a3c0605-32d9-4362-a95b-ee9abe51a008` |
| 🧠 Big Brain — Saved (unsorted) | `8db833c0-8e94-4d2a-a842-1771510753ec` |
| ⛏️ PROSPECTOR page | `3a648fc8-acd0-8131-9a79-cb00769a0842` |

Schema: `Name` (title), `URL`, `Type` (News/AI/Design Reference), `Tags`
(multi-select, 16 fixed options), `Source App`, `Notes`, `Look`, `Date Added`.
**There is no realm field in Notion** — realm lives only in the worker so far.

### Related live infrastructure — do NOT duplicate
**The Prospector** — nightly cloud agent mining paid gigs, auctions and cultural
events, delivering to the ⛏️ PROSPECTOR Notion page. Trigger
`trig_01TNy7JTCotMsQBWrAErcLK1`, cron `30 12 * * *` UTC. Big Brain's nightly job
deliberately runs at `10 11 * * *` to avoid colliding with it.

---

## 4. THE ARCHIVE — measured, not guessed

| | count |
|---|---|
| refs in Notion | 1,578 |
| imported into the worker | 1,578 |
| embedded in Vectorize | 1,575 (3 had no text) |
| from Instagram | 1,241 |
| …already carrying caption text as a title | 1,158 |
| **titled literally "Instagram"** | **83** |
| rows with no tags | 445 |
| realm split | INSPO 1,265 · CULTURE+NEWS 236 · KNOWLEDGE 77 |
| rent.co inventory indexed | 590 |

⚠️ **Correction worth inheriting:** an earlier pass claimed 1,216 rows were
titled "Instagram" and built a whole strategy on it. That was wrong — it
generalised from a 12-row sample of the *newest* refs. It is **83**. Measure
before you build on a number.

### The taste seed
`~/Dropbox/_PROSPECTOR/TASTE_SOURCES.md` — distilled from his Instagram export
(11,922 saved posts / 2,863 accounts / 3,105 follows / 203 collections).

Eight axes, encoded in `src/realm.js` as `TASTE_AXES`: ① post-internet fashion &
object design ② rap/hip-hop as live culture ③ weird-beautiful objects &
interiors ④ digital/3D post-internet image culture ⑤ fashion image-making &
beauty ⑥ **set design, north star Gary Card** ⑦ club/experimental music ⑧
internet-brain humor (a *cultural pulse sensor*, not personal — so it maps to
CULTURE+NEWS, never SELF).

Top curators (his human algorithm, by save count): `welcome.jpeg` (195),
`noeloquence` (173), `trashcanpaul` (142), `software2050` (111),
`fantasyafantasya` (102), `nathanielknows` (97).

---

## 5. ARCHITECTURE

~6,800 lines. `worker/save-ref/src/`:

| file | what it owns |
|---|---|
| `index.js` | the router. Every API route is token-guarded via `requireToken()`. Also exports `scheduled()` for the cron. |
| `embed.js` | embeddings + both Vectorize indexes. `METADATA_TOPK_MAX` lives here — read §7. |
| `enrich.js` | deep content: page text, YouTube transcripts, vision captions, og:image thumbnails |
| `ask.js` | RAG + the model tiers. `SYSTEM_PROMPT` is his voice — archive/warehouse/operating-system, functional but hot. |
| `realm.js` | REALMS, TASTE_AXES, CURATORS, `classify()` — all pure, Tier 0, no model |
| `stage.js` | the swipe queue. Nothing here can mutate a ref or reach Notion. That is the point. |
| `budget.js` | the cost governor: tier ladder, `$5` ceiling, vision ration |
| `propose.js` | generates proposals for the queue (tags, dead links, low-confidence realms) |
| `gaps.js` | sourcing gaps — clusters of refs with no close inventory match |
| `brief.js` | assembles the morning brief |
| `cron.js` | the nightly job |
| `rentco.js` | inventory match + client Set drafting |
| `og.js` | Open Graph scraping |
| `categorize.js` | kind/category bucketing (pre-existing) |
| `pages/*.js` | self-contained HTML as template literals — no external assets, no build step |

**Model tiers** (`ask.js`): cheap = Workers AI, tries a **list** of model ids
because Cloudflare renames them. Deep = Claude (`claude-sonnet-5` by default,
override with `ANTHROPIC_MODEL`). Deep silently falls back to cheap without a key.

**The quality gap between tiers is large.** Cheap gave *"innovative and versatile
set design solutions"*; Claude gave the through-line quoted in §0. For search and
lookup, cheap is fine. For anything he'd call taste, use deep.

### Pages
`/drop` · `/browse` · `/queue` · `/brief` · `/shortcuts`

### Endpoints
Auth on everything under `/api` and `/save`: header `X-Auth-Token: <AUTH_TOKEN>`.

| method | path | purpose |
|---|---|---|
| POST | `/save?similar=1` | save a ref (JSON, or raw bytes + `X-Note`) |
| GET | `/api/list` | keyword search / filter / page |
| GET·PATCH·DELETE | `/api/ref/:id` | one ref |
| POST | `/api/search` | **semantic** search `{q, cat, realm, limit}` |
| POST·GET | `/api/ask` | answer from refs `{q, deep}`; `?format=text` for Siri |
| GET | `/api/similar/:id` | nearest refs to this one |
| GET | `/api/profile` | taste fingerprint (future-outfit reads this) |
| POST | `/api/match` | "do I have anything like this?" — text, refId, or raw image |
| POST | `/api/set-draft` | draft a client Set from `{brief}` |
| GET·POST | `/api/gaps` | sourcing gaps |
| GET | `/api/brief` · page `/brief` | the morning brief |
| POST | `/api/propose` · GET `/api/propose/preview` | generate queue proposals |
| GET | `/api/queue` · `/api/queue/stats` · `/api/queue/export` | the swipe feed |
| POST | `/api/queue/:id` | `{action: approve\|reject\|skip\|reopen, edits}` |
| POST | `/api/thumbs` | backfill og:image across the archive |
| POST | `/api/reindex?deep=1` | rebuild embeddings, cursor-paged |
| GET | `/api/nightly` · POST `/api/nightly/run` | cron records / manual run |
| GET | `/api/budget` | tonight's ledger and what still fits |
| GET | `/health` | liveness + which subsystems are wired |

### Tests
**679 tests, 10 suites, no deps, no network, no bindings required.**
`cd worker/save-ref && npm test`

---

## 6. TOOLING — scripts that do the fiddly parts for him

| command | what it does |
|---|---|
| `npm run doctor` | Cloudflare preflight: env overrides, account mismatch, scopes, indexes, KV placeholder. **Run this first when anything Cloudflare-shaped breaks.** |
| `npm run setup-kv` | creates the KV namespace and writes the id into `wrangler.toml` |
| `node scripts/notion-import.mjs --refs <csv\|zip>` | imports the Notion export, classifies realms, builds embeddings. Takes the raw Notion `.zip` and digs out the `_all.csv` itself. Ids derive from URL + date, so re-running **updates** rather than duplicates. |
| `node scripts/ig-join.mjs --ig <export.zip> --refs <csv>` | joins the Instagram export against the archive to recover @handles and taste axes. **Proposals only.** |
| `npm run index-inventory` | loads `data/inventory.json` (590 items) into the item index |

`data/big-brain-export.csv` is committed — a verified Notion export, so an import
needs no file hunting. It's personal archive data in a private repo, committed at
his explicit request.

---

## 7. GOTCHAS THAT COST REAL TIME — read before debugging

1. **Vectorize REJECTS `topK > 20` when `returnMetadata: "all"`.** It refuses;
   it does not truncate. Over-fetching to filter in JS therefore returns
   **nothing**. This silently broke inventory match and every filtered semantic
   search. See `METADATA_TOPK_MAX` in `src/embed.js`.
2. **`catch { return [] }` is how this codebase lies to you.** A rejected query
   and an honest no-match looked identical **three separate times** — the chat
   model, the inventory match, the vector query. Every failure path now surfaces
   a `debug` field. **Never add a bare catch that returns empty.**
3. **Workers AI model ids move.** `ask.js` tries a list rather than betting on
   one string. A renamed model presents exactly like an unbound AI.
4. **`/health` needs no token**, so a green health check proves nothing about
   `AUTH_TOKEN`. Verify auth with `curl -H "X-Auth-Token: $TOKEN" "$URL/api/list?limit=1"`.
5. **Vectorize is eventually consistent.** Fresh upserts aren't instantly
   queryable. `npx wrangler vectorize info <index>` shows the real `vectorCount`.
6. **Notion CSV export only contains properties visible in the exported view**,
   and wraps the CSV in a zip inside a zip. `notion-import.mjs` handles both and
   names any missing column.
7. **`wrangler secret put` reads stdin** — `printf '%s' "$TOKEN" | npx wrangler
   secret put AUTH_TOKEN` guarantees the shell var and the secret match.
8. Cloudflare auth failures with mismatched account ids are usually a stale
   `CLOUDFLARE_ACCOUNT_ID` in `~/.zshrc`. The env var beats `wrangler.toml`.

---

## 8. STATE — done vs outstanding

### Working and verified
- Semantic search over 1,575 refs; Ask with citations; similar-to; realm filter
- Claude deep tier (quality gap over the cheap tier is large and obvious)
- Inventory match — *"scuffed steel rolling cart, hospital, cold light"* → *"Table
  — Medical or Hospital Equipment"* (0.74), then two mechanic carts
- Swipe queue, cost governor, iPhone capture guide at `/shortcuts`

### Built, tested, **but never run against the live worker**
Everything from the final overnight batch. Local tests and mocks only — this
build environment cannot reach `workers.dev`. **Deploy, then verify each:**
- **`/api/thumbs`** — og:image backfill. *Highest value.* The archive is almost
  entirely visual and currently renders as grey placeholders. Instagram may block
  a large share; `imageTried` stops infinite retries. **Watch this one.**
- **`/api/propose`** — fills the queue. Until it runs, `/queue` is empty.
- **`/api/gaps`** — sourcing gaps.
- **`/brief`** — the morning brief page.
- **Nightly cron** at `10 11 * * *` UTC.

### Not started
- **The IG join** — needs a *fresh* Instagram export. His is from 2026-04-22 and
  predates most of the archive; the `BIG BRAIN SHIT.zip` in Downloads is a
  Markdown-only export with no CSV in it. Would add author + taste axis to 1,241 refs.
- **Realm back into Notion** — realm exists only in the worker. Writing it back
  needs a Notion token in the worker, which he has not been asked for.
- **rent.co UI** for `/api/set-draft` — the API works; nothing in the Next.js app
  calls it.
- **future-outfit** consuming `/api/profile`.
- **Everything in §1** — the interviews, the festival, his own releases.

---

## 9. RULES OF ENGAGEMENT — what actually worked

- **Verify before asserting.** Two claims in this session were wrong and stated
  confidently (the 1,216 figure; "no vectorize scope" when the API demonstrably
  worked). Both were caught by checking. Check first.
- **Never hand him a multi-line paste block.** Pasted blocks make `read -rs TOKEN`
  swallow the next line, put comments through `npm`, and concatenate `curl` onto
  `git pull`. **One command per block, no trailing `#` comments, no em dashes.**
- **Don't make him type paths.** Tell him to type up to `--refs ` and drag the
  file from Finder into Terminal.
- **Write the diagnostic instead of the explanation.** `npm run doctor` and
  `npm run setup-kv` replaced entire rounds of back-and-forth.
- **When output looks stale, suspect the deploy.** Twice the code was correct and
  the worker was running an older version.
- He works from his phone often. Answers should survive being read on a phone.

---

## 10. FIRST COMMANDS FOR THE NEXT SESSION

```
cd ~/futureoutfit
git pull --rebase origin claude/big-brain-llm-learning-39fpf1
cd worker/save-ref && npm test
npm run deploy
```

Set credentials (one line at a time — never paste as a block):

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

Then the highest-value unverified thing — thumbnails:

```
curl -s -X POST "$URL/api/thumbs" -H "X-Auth-Token: $TOKEN" | head -c 400
```

---

## 11. IF YOU ONLY DO ONE THING

Deploy and run `/api/thumbs`, then open `/browse` on his phone. His archive is
visual and it currently looks like a spreadsheet. Nothing else in the backlog
changes his daily experience as much.

After that, ask him which of §1 he wants to start on. The infrastructure is done.
The interesting work hasn't started.
