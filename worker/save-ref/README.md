# save-ref worker — 🧠 Big Brain

A drop-anything reference inbox on Cloudflare Workers. Drop a **link, image, or
note**; it's auto-categorized and stored. Browse/search them later in a gallery.

This is an **optimized rebuild** of the original `save-ref-worker`, built to be a
drop-in replacement. It does not touch your existing worker or its data — deploy
it under a new name first, try it, then point your bookmark at it when happy.

## What's new vs. the original drop page

- **A gallery (`/browse`)** — actually *see* everything you saved: thumbnails,
  category filter chips, full-text search, **edit (re-tag / re-categorize)**,
  delete, export. (The original only let you drop, never look.)
- **Recent strip on `/drop`** — instant visual confirmation each save landed.
- **Richer auto-categorization** — image / video / audio / post / article / code /
  shop / document / note / link, by content-type, file extension, and a domain
  ruleset (YouTube→video, X/IG→post, GitHub→code, SSENSE→shop, …).
- **Link previews** — fetches Open Graph title/description/image so saved links
  show real thumbnails.
- **Multi-file drop + paste** — drag many files, paste screenshots or URLs (⌘V).
- **Export / import** — NDJSON round-trip, so you can migrate data in and out.
- **R2-ready** — large uploads can offload to R2 instead of KV (optional).
- **It thinks now** — semantic search, an Ask box, "do I have anything like
  this?" against rent.co inventory, and a taste profile future-outfit can read.
  See [The brain](#the-brain--asking-your-archive-questions).

## The brain — asking your archive questions

Big Brain isn't just storage: it *learns from what you drop*, and you can ask
it things.

Nothing here trains a model — that's the wrong tool. Training costs millions
and freezes at training time; your archive changes daily. Instead this is
**RAG (retrieval-augmented generation)**: every ref is converted into an
*embedding* (a numeric fingerprint of its meaning) and stored in a vector
index. Ask a question, and the question is fingerprinted the same way, the
nearest refs are pulled back, and a model answers **from them**, with sources.

A ref is searchable the second it lands. Delete it and it's forgotten. No
retraining, ever.

### What it does before embedding

Titles are too thin to reason over, so each ref is deepened first:

| kind | what gets read |
|---|---|
| image / screenshot | **vision caption** — the actual garments, materials, colour, era, mood |
| article / post / shop | full readable page text, not just the `og:description` |
| video | the caption track (YouTube), so it knows what was *said* |
| note | your own words — the most valuable signal in the archive |

That happens in the background after the save returns, so dropping still feels
instant.

### Two tiers

- **cheap** (default) — Workers AI, inside the worker, no extra bill.
- **deep** (`deep: true`) — Claude, for synthesis and taste work where voice
  matters. Falls back to cheap automatically if no API key is set.

## The Archivist — realms, the swipe queue, and the cost governor

The stated goal is *"when I search in Big Brain, it filters better."* The thing
standing in the way is that **1,216 of the 1,570 refs in Notion are titled
literally "Instagram"**, with no notes and no tags. No embedding fixes a row
whose entire content is the word "Instagram".

### Realms

A top-level facet, above tags:

| realm | what lands there |
|---|---|
| `INSPO` | aesthetic reference — the classic Big Brain |
| `KNOWLEDGE` | education, technique, how things work |
| `CULTURE+NEWS` | cultural moves, news, scene intel |
| `SELF` | personal / self-help |

`SELF` is **never inferred** — nothing can tell what's personal to you, so it
only ever comes from your own hand.

### The join that costs nothing

Notion's `Type` is populated on all 1,570 rows, so realm falls out of a lookup
table with no model call. And the Instagram export knows the account behind
every saved post, while `TASTE_SOURCES.md` knows what each account *means*.
Joining them recovers a title, a realm and a taste axis for every matched ref —
offline, no scraping, no vision, no spend:

```bash
node scripts/ig-join.mjs \
  --ig ~/Downloads/instagram-raderturner-2026-04-22-HHJhrRl9.zip \
  --refs ~/Downloads/big-brain.csv \
  --out ~/Dropbox/_PROSPECTOR/proposals-realm.json
```

`--refs` is Notion's CSV export of 🧠 Big Brain (••• → Export → CSV). Add
`--push` to send the proposals straight into the swipe queue.

A row that was `Instagram` becomes `@welcome.jpeg · DbJsAVTkQGk`, realm
`INSPO`, axis `weird-beautiful-objects`, confidence `0.9`, reason
*"Type=Design Reference · curator @welcome.jpeg"*. A row with no match stays
honestly at `0.35` and gets flagged for your eyes.

### The swipe queue

**Agents propose. You decide.** Nothing auto-adds a reference, and nothing
applies a taste judgment on its own — curation is the craft. Proposals land in
`/queue`: one card at a time, phone-first, swipe right to approve, left to
reject, down to skip, or tap a realm chip to correct it before approving.
Arrow keys do the same at a laptop.

Approving does **not** write to Notion. It marks the item ready; pushing
approved changes anywhere is always a separate, explicit act
(`GET /api/queue/export`).

### The cost governor

Standing rule: no heavy background burns without a same-moment OK, ceiling
about **$5/night**. Spend is metered in `src/budget.js` rather than trusted to
calling code — a job that wants 1,200 vision calls gets **refused**, not
invoiced. Vision is rationed by count (20/night) as well as by cost.

The tier ladder, always climbed from the bottom:

| tier | what | cost |
|---|---|---|
| 0 | deterministic code on the Worker (rules, joins, diffing) | free |
| 1 | local models on the Mac via Ollama | free |
| 2 | Workers AI / Haiku — per-item classify, embed | cents |
| 3 | frontier Claude — judgment, ranking, voice only | metered |

`GET /api/budget` shows what tonight has cost and what still fits.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/drop` | public page | the drop SPA |
| GET | `/browse` | public page | the gallery SPA + Ask box |
| GET | `/shortcuts` | public page | iPhone setup guide (share sheet, Back Tap, Siri) |
| GET | `/queue` | public page | the swipe feed — approve/reject agent proposals |
| **POST** | **`/api/queue/propose`** | token | mining jobs drop proposals here |
| **GET** | **`/api/queue`** | token | the pending feed |
| **POST** | **`/api/queue/:id`** | token | `{action: approve\|reject\|skip\|reopen, edits}` |
| **GET** | **`/api/queue/stats`** | token | counts for the header and the brief |
| **GET** | **`/api/queue/export`** | token | approved, not yet pushed |
| **POST** | **`/api/classify`** | token | Tier-0 realm classification, no model call |
| **GET** | **`/api/budget`** | token | tonight's ledger + what still fits |
| POST | `/save?similar=1` | token | save a link/note (JSON, with `note`) or file (raw bytes, `X-Note`) |
| GET | `/api/list?q=&cat=&cursor=&limit=` | token | list / keyword search / filter |
| GET | `/api/ref/:id` | token | fetch one ref |
| PATCH | `/api/ref/:id` | token | edit a ref's `category` / `tags` / `title` / `note` |
| DELETE | `/api/ref/:id` | token | delete a ref (+ its blob, + its vector) |
| GET | `/api/export` | token | NDJSON of all refs |
| POST | `/api/import` | token | bulk insert (array of refs) |
| GET | `/blob/:key` | public (key is the capability) | raw upload bytes |
| GET | `/health` | public | liveness + which parts of the brain are wired |
| **POST** | **`/api/search`** | token | semantic search — `{q, cat, limit}` |
| **POST/GET** | **`/api/ask`** | token | answer from your refs — `{q, deep}`; `?format=text` for Siri |
| **GET** | **`/api/similar/:id`** | token | refs nearest to this one |
| **GET** | **`/api/profile?refresh=1`** | token | your taste fingerprint (future-outfit reads this) |
| **POST** | **`/api/match`** | token | "do I have anything like this?" — `{q}`, `{refId}`, or raw image bytes |
| **POST** | **`/api/set-draft`** | token | draft a client Set from `{brief}` |
| **POST** | **`/api/reindex?deep=1`** | token | backfill embeddings for everything already saved |
| **POST** | **`/api/inventory/index`** | token | load rent.co items into the item index |

Auth = header `X-Auth-Token: <AUTH_TOKEN>`. The token is stored only in the
browser's localStorage and sent only to your Worker.

## One-time setup

```bash
cd worker/save-ref
npm install
npx wrangler login
npx wrangler kv namespace create save-ref-kv     # prints an id
# paste that id into wrangler.toml -> [[kv_namespaces]] id = "..."

openssl rand -hex 32                              # your Big Brain token
npx wrangler secret put AUTH_TOKEN                # paste it when prompted
```

Optional, for lots of large uploads:

```bash
npx wrangler r2 bucket create save-ref-blobs
# uncomment the [[r2_buckets]] block in wrangler.toml
```

### Turning the brain on (required before `deploy`)

`wrangler.toml` binds two Vectorize indexes. They must exist first or the
deploy fails saying the index isn't found:

```bash
npx wrangler vectorize create bigbrain-refs      --dimensions=768 --metric=cosine
npx wrangler vectorize create bigbrain-inventory --dimensions=768 --metric=cosine
```

768 is the output size of `@cf/baai/bge-base-en-v1.5` (see `src/embed.js`).
Workers AI needs no setup — the `[ai]` binding is enough.

Optional, for the deep tier:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Without it, `deep` requests quietly use the fast model instead.

Then backfill everything you'd already saved:

```bash
# fast pass — embeds titles/descriptions you already have
curl -X POST "$URL/api/reindex" -H "X-Auth-Token: $TOKEN"

# deep pass — also fetches page text, transcripts, and captions images.
# Returns a cursor; keep calling with it until "done": true.
curl -X POST "$URL/api/reindex?deep=1&batch=10" -H "X-Auth-Token: $TOKEN"
```

### Feeding rent.co and future-outfit

Index the archive so Big Brain knows what you actually own:

```bash
# from the repo root
BIGBRAIN_URL=https://save-ref-v2.<you>.workers.dev \
BIGBRAIN_TOKEN=<token> \
node scripts/index-inventory.mjs
```

Then:

```bash
# "do I have anything like this?" — text, a saved ref, or a raw image
curl -X POST "$URL/api/match" -H "X-Auth-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"scuffed steel rolling cart, hospital, cold light"}'

# same thing from a photo
curl -X POST "$URL/api/match" -H "X-Auth-Token: $TOKEN" \
  -H "Content-Type: image/jpeg" --data-binary @runway.jpg

# draft a client Set from a director's brief
curl -X POST "$URL/api/set-draft" -H "X-Auth-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"brief":"1970s Vancouver newsroom, fluorescent, nicotine walls"}'

# the taste fingerprint future-outfit matches looks against
curl "$URL/api/profile" -H "X-Auth-Token: $TOKEN"
```

Re-run `index-inventory.mjs` whenever `data/inventory.json` changes — it
upserts by item id, so it refreshes rather than duplicates.

### On your phone

Open `/shortcuts` on the iPhone (after saving your token on `/drop`) — it
fills in your real URL and token and walks through four entry points: the
**share sheet** from any app, **Back Tap** for a zero-UI clipboard grab,
a **capture + one-line note** variant, and **"Hey Siri, ask Big Brain"** with
a spoken answer.

## Deploy

```bash
npm run deploy
```

Open `https://save-ref-worker.<your-subdomain>.workers.dev/drop`, paste the same
token, and start dropping. The gallery is at `/browse`.

## Develop / test locally

```bash
npm test                 # all suites: no deps, no network, no bindings needed
npm run dev              # wrangler dev --local: real KV in miniflare, hot reload
# then: curl -X POST localhost:8787/save -H "X-Auth-Token: dev" \
#   -H "Content-Type: application/json" -d '{"url":"https://github.com/x/y"}'
```

(Set a dev token for local runs with `wrangler dev` via a `.dev.vars` file
containing `AUTH_TOKEN=dev`.)

## Migrating from the old worker

If you can export your existing data as JSON, POST it to `/api/import`:

```bash
curl -X POST .../api/import -H "X-Auth-Token: <token>" \
  -H "Content-Type: application/json" --data @old-refs.json
```
