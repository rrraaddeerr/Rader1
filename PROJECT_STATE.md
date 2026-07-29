# rent.co — Project State

Living snapshot of the project. Update when major things change.

## What this is

**rent.co** is a phase-1 inquiry-based rental, sourcing, and archive platform
operated by **RaderENT**. It is *not* an ecommerce store — every request is
read and confirmed by a person. The site is the public face of the operator
(Rader Turner), surfacing a curated archive of physical inventory for the
music / fashion / nightlife / festival / film world.

- **Brand:** rent.co (visible name) — wordmark is "R-E-N-T" exaggerated capitals
- **Operator:** RaderENT (Rader Turner, Vancouver)
- **Domain:** **r-ent.co** (with a hyphen) — registered at GoDaddy

## Stack

- **Next.js 15** (App Router) + **TypeScript** + **React 19**
- **Zustand** for the inquiry-cart state
- Static-first: 604 prerendered pages, one API route (`/api/inquiry`)
- **Vercel Pro** hosting (Hobby plan ToS forbids commercial use)
- No database; inventory lives in `data/inventory.json`

## Where it's deployed

- **GitHub repo:** [rrraaddeerr/Rader1](https://github.com/rrraaddeerr/Rader1)
- **Working branch:** `claude/build-rentco-mvp-LNT1S` (drives PR #1)
- **Vercel "Production Branch":** `claude/photo-purge-swipe-app-Mm7sH` (legacy
  name from the original Expo project Vercel was first wired to). To ship to
  production, fast-forward this branch from `main`:
  `git push origin origin/main:refs/heads/claude/photo-purge-swipe-app-Mm7sH`.
  Pushing to `main` alone only creates Vercel previews.
- **Vercel project:** `mvp` (repo `rrraaddeerr/Rader1`)
- **Current public URL:** `https://mvp-hazel-omega.vercel.app`
- **Domain to attach:** `r-ent.co` (GoDaddy customer #117122741)
- **Pull request:** [#1](https://github.com/rrraaddeerr/Rader1/pull/1)
- **TODO when convenient:** in Vercel → mvp project → Settings → scroll for
  the Git/Production-Branch setting, change Production Branch to `main` so we
  can drop the photo-purge fast-forward step.

## Inventory

- **Source:** VPC catalog (vanprop.ca) — full catalog has 7,207 items
- **Curated for launch:** **590 items** (`data/inventory.json`)
- **Raw source-of-truth:** `data/vpc_catalog.csv` (committed)
- **Categories used:** rent.co's own 14 (Seating, Tables, Lighting, etc.) — VPC's prop-house categories are mapped in by the importer, not adopted
- **Importer:** `scripts/import-vpc.mjs` — `npm run import-vpc --count 600`
- **Photos:** real product photos from VPC's Google Drive — all 590 items have one. Pulled via `scripts/download-vpc-photos.mjs` using a GoDaddy-account OAuth client.
- **Prices:** real weekly rates from VPC's CSV (`$X/wk`). Day rate not present in the data; card UI shows weekly fallback.

## Brand

- **Voice:** archive / operating-system / warehouse / functional but hot. Avoid luxury showroom, generic prop house, startup SaaS, wedding rental, taste-filter language.
- **Colors:** stainless dark base (`#0c0c0d`), hot signal accent `#ff5a1f`, gaffer-tape green `#5f8338` (drawn as labels).
- **Fonts (bundled, `app/fonts/`):**
  - **Permanent Marker** — tape-label motif
  - **Archivo Regular/ExtraBold** — OpenGraph share images
  - **Rock Salt** — hand-drawn brand stamp
- **Logo:** `components/BrandStamp.tsx` — a Bella-Freud-homage square stamp, "Rader" top + truck-with-firecracker middle + "ENT.co" bottom, capitals R-E-N-T exaggerated to spell "rent". SVG body was generated once via rough.js and baked in.

## Key code paths

- `app/page.tsx` — Home (hero, CTAs, featured categories, featured objects)
- `app/archive/page.tsx` + `ArchiveBrowser.tsx` — searchable inventory grid
- `app/archive/[slug]/page.tsx` — item detail page (per-item OG image is dynamic)
- `app/consult/`, `app/source/`, `app/about/`, `app/request/` — other pages
- `app/api/inquiry/route.ts` — form submission endpoint (rate-limited, honeypot, optional webhook)
- `components/BrandStamp.tsx` — the hand-drawn logo (static SVG, no runtime rough.js)
- `lib/inventory.ts` — data access, facets, related-item logic
- `lib/cart.ts` — zustand store, localStorage-persisted
- `lib/vpc-catalog.ts` — VPC CSV parser, used by /curate
- `lib/categorize.ts` — VPC-subcat → rent.co category classifier (mirrored in apply-picks.mjs)
- `middleware.ts` + `app/access/` + `app/api/access/route.ts` — pre-launch invite gate (cookie-based)
- `app/curate/` — per-item VPC review tool (grid, keyboard shortcuts, bulk subcat actions)
- `app/curate/sort/` — subcategory triage (Skip / Review / Take all)
- `app/curate/preview/` — preview the resolved keep set grouped by final rent.co category
- `app/ops/` — operator dashboard (archive stats, inquiry routing, curate progress)
- `scripts/apply-picks.mjs` — applies an Export Picks JSON to data/inventory.json
- `scripts/download-vpc-thumbs.mjs` — low-rez thumb puller for /curate (240px, ~5 KB each)

## Pre-launch invite gate

The whole site is gated behind `/access` during soft launch. Anyone
without a valid `rentco_access` cookie gets redirected to the gate.
Static assets, robots, sitemap, and OG images stay public so shared
links still unfurl with the brand teaser.

- **Configure codes** via the `ACCESS_CODES` env var on Vercel:
  `alex:Alex,sam:Sam,marcus:Marcus,vip:VIP` — `code:Label` pairs,
  comma-separated. The label is the name that greets the visitor.
- **Default** (if unset): `operator:Operator,launch:Launch`.
- **Cookie lifetime:** 60 days.
- **Two ways to invite someone:**
  - Direct gate link: `https://mvp-hazel-omega.vercel.app/access` (visitor
    types their code)
  - Personal link: `https://mvp-hazel-omega.vercel.app/i/<code>` (visitor
    taps once, lands on home with cookie already set — feels personal)
- **What invited visitors see:**
  - One-time "Welcome, <name>." flash banner on the first page after entry
  - Persistent `OPERATOR // <NAME>` badge in the site header
- **Disable the gate** at full launch: delete `middleware.ts`,
  `app/access/`, `app/api/access/`, and the access CSS block at the
  bottom of `app/globals.css`.
- **OG image:** `/access/opengraph-image` — gate-specific share unfurl
  ("The archive is open for invited guests"). Used when `/i/<code>` or
  `/access` links unfurl in iMessage/Slack/Twitter.

## Curation workflow

End-to-end flow from VPC catalog to live archive:

1. **Triage** at `/curate/sort` — speed-blast through all 951 VPC
   subcategories. For each: Skip (hide forever), Review (per-item later),
   or Take all (auto-keep every item in this subcat). Keyboard 1/2/3.
2. **Review** at `/curate` — for "Review" subcats, item-by-item Keep/
   Star/Cut. Keyboard 1/2/3 on focused item, ↑↓ to navigate. ⋯ menu on
   each subcategory chip lets you rename it, bulk-cut, or reset.
3. **Preview** at `/curate/preview` — see the resolved keep set grouped
   by final rent.co category (`Seating`, `Lighting`, etc. — auto-
   classified from VPC subcat). Spot-check before export.
4. **Export** — downloads `rentco-curate-<timestamp>.json` with
   `{keep, star, cut, renames, subcategoryVerdicts}` by barcode. Import
   button on `/curate` accepts the same shape to sync between devices.
5. **Apply** — `node scripts/apply-picks.mjs path/to/picks.json` reads
   the JSON, classifies into rent.co categories, builds
   `data/inventory.json`, prints a stat summary including how many
   items still need high-rez photo backfill.
6. **Backfill** photos for kept items with no high-rez:
   `node scripts/download-vpc-photos.mjs` (resume-safe).
7. **Ship.** Commit + triple-push (see Deploy below).

## Sets (client proposals)

Operator-built proposals you send to clients/directors. They open a public
URL, see your picks grouped into sections (Seating, Lighting, etc.), and
respond Approve / Maybe / Pass per item. Real-time tally back to operator.

- **Operator pages** (gated): `/sets`, `/sets/new`, `/sets/[id]`
- **Public presentation:** `/set/[slug]` (slug is unguessable, no login)
- **Storage:** Cloudflare Worker at `worker/rentco-sets/` (deployed separately
  to e.g. `rentco-sets.raderturner.workers.dev`). KV-backed. See its README.
- **Env vars needed on Vercel:**
  - `RENTCO_SETS_URL` — worker URL
  - `RENTCO_SETS_TOKEN` — same as the worker's OPERATOR_TOKEN secret
  - `NEXT_PUBLIC_RENTCO_SETS_URL` — same as RENTCO_SETS_URL (used by client
    code on /set/[slug] to POST responses)

## Big Brain (reference archive + taste layer) — LIVE

- **Deployed:** `https://save-ref-v2.raderturner-e87.workers.dev`
  (`/drop` · `/browse` · `/queue` · `/shortcuts`)
- **Loaded:** 1,578 refs imported from Notion, 1,575 embedded.
- **Both tiers on:** Workers AI for search and quick answers, Claude via
  `ANTHROPIC_API_KEY` for synthesis. The gap between them is large enough to
  matter — the cheap model lists, Claude reads.
- **Inventory indexed:** 590 rent.co items. `/api/match` and `/api/set-draft`
  are live — drop a description or an image, get ranked items you own.
- **Still to do:** the IG join, which needs a *fresh* Instagram export — the
  April one predates most of the archive, and the zip in Downloads is a
  Markdown-only export with no CSV in it.

### Gotchas worth remembering

- **Vectorize rejects `topK > 20` when `returnMetadata: "all"`.** It refuses
  rather than truncating, so over-fetching to filter in JS returns *nothing*.
  Cost an hour; see `METADATA_TOPK_MAX` in `src/embed.js`.
- **`catch { return [] }` is how this codebase lies to you.** A rejected query
  and an honest no-match looked identical three separate times. Failures now
  surface a `debug` field instead.
- **Workers AI chat model ids move.** `src/ask.js` tries a list rather than
  betting on one string.


The drop-anything reference inbox at `worker/save-ref/`, now with an LLM layer
over it. Not a trained model — **RAG**: every ref is embedded into Cloudflare
Vectorize on save, and questions retrieve the nearest refs for a model to
answer from. New refs are searchable instantly; deleted refs are forgotten.

- **Deep enrichment on save** — images get a vision caption, articles get full
  page text, YouTube gets the caption track. Runs after the response, so drops
  stay instant.
- **Two model tiers** — Workers AI by default (free, in-worker); Claude when
  `deep` is set, for synthesis and voice. Needs `ANTHROPIC_API_KEY` secret.
- **Surfaces** — Ask box + `meaning` search mode on `/browse`, "you've saved
  things like this" on `/drop`, and `/shortcuts` for the iPhone (share sheet,
  Back Tap, Siri voice ask).
- **Feeds rent.co** — `POST /api/match` ranks `data/inventory.json` against an
  image, a ref, or a description; `POST /api/set-draft` drafts a client Set
  from a brief (hallucinated item ids are filtered out server-side).
- **Feeds future-outfit** — `GET /api/profile` returns a cached taste
  fingerprint (palette / materials / silhouettes / eras / keywords).
### The Archivist (staged enrichment)

The real archive lives in **Notion** (🧠 Big Brain, `59aa4929-…`, 1,570 rows),
not in the worker's KV — the worker is the brain layer over it. 1,241 refs come
from Instagram and 1,158 of those already carry caption text as a title; only
83 are titled literally "Instagram". So the archive has plenty of text to
embed. What it lacks is **who posted it** and **what kind of thing it is**.

- **Realms** — `INSPO` / `KNOWLEDGE` / `CULTURE+NEWS` / `SELF` as a first-class
  facet. Notion's `Type` is populated on every row, so realm is a free lookup:
  verified across the whole database as 1,258 / 236 / 76, nothing unclassified.
  `SELF` is never inferred.
- **The IG join** (`scripts/ig-join.mjs`) — the Instagram export maps every
  saved post to the account that made it; `TASTE_SOURCES.md` maps accounts to
  the 8 taste axes. Adds author attribution to all 1,241 Instagram refs and a
  title to the 83 without one. Tier 0: offline, no scraping, no spend.
- **Swipe queue** (`/queue`) — agents propose, you decide. Nothing auto-adds a
  ref; approving does not write to Notion, it marks ready for an explicit push.
- **Cost governor** (`src/budget.js`) — $5/night ceiling, vision rationed to
  20/night, tier ladder 0→3. Runaway jobs are refused, not invoiced.

Related live infrastructure (do not duplicate): **The Prospector** nightly
sweep, trigger `trig_01TNy7JTCotMsQBWrAErcLK1`, delivering to the ⛏️ PROSPECTOR
Notion page. `claude.ai/code` is disabled on this account — Notion is the
mailbox.

- **Setup:** two Vectorize indexes must be created before `wrangler deploy`,
  then backfill with `POST /api/reindex?deep=1` and load inventory with
  `node scripts/index-inventory.mjs`. Full steps in
  `worker/save-ref/README.md`.

## Inquiry routing

- Always logs to console + appends to `data/submissions/<kind>.ndjson`
  when the filesystem is writable.
- Forwards to `INQUIRY_WEBHOOK_URL` if set (Zapier, Make, generic).
- Forwards to **Notion** if both `NOTION_TOKEN` and `NOTION_DATABASE_ID`
  are set. Database needs these properties (exact names): Name (Title),
  Kind (Select: rental/consult/sourcing), Status (Select: New/...),
  Email (Email), Phone (Phone), Company (Text), Submitted (Date),
  Items (Text), Details (Text).
- `/ops` dashboard surfaces routing status and recent NDJSON entries.

## Decisions made (and why)

- **Next.js, not WordPress** — better fit for a code repo, faster, SEO clean.
- **JSON inventory, no CMS** — phase-1 simplicity; admin = edit JSON.
- **Inquiry only, no checkout** — explicit brief; every request manually confirmed.
- **Local logging for inquiries** — operator choice; `INQUIRY_WEBHOOK_URL` ready when wired.
- **Brand visible as "rent.co", URL is `r-ent.co`** — the bare `rent.co` is a six-figure premium domain. Hyphen hidden in branding.

## Open items

- **Domain not pointed yet** — `r-ent.co` is registered at GoDaddy but DNS still points to GoDaddy parking, not Vercel. See **Domain setup** below.
- **No email inbox** — `hello@r-ent.co` is the planned contact address but no MX records yet.
- **Inquiry destination** — currently local logging only; not wired to email/CRM.
- **Vercel Pro trial** — ~12 days left, needs a card before it expires.
- **GitHub 2FA** — Rader saw the prompt; should set it up at some point.
- **VPC catalog OAuth client** — secret is in chat logs; can be rotated at console.cloud.google.com/apis/credentials any time.

## Local development

```bash
git clone https://github.com/rrraaddeerr/Rader1.git
cd Rader1
npm install
npm run dev   # http://localhost:3000
```

## Re-import VPC catalog

```bash
npm run import-vpc -- --count 600
```

## Re-download VPC photos

Setup once (Google OAuth desktop client in `scripts/credentials.json`):

```bash
npm install --no-save googleapis @google-cloud/local-auth
node scripts/download-vpc-photos.mjs
```

Resume-safe: re-runs skip photos already on disk.

## Deploy

```bash
# 1. Push working branch (updates PR #1, creates a Vercel preview)
git push origin claude/build-rentco-mvp-LNT1S

# 2. Fast-forward main from the working branch
git push origin claude/build-rentco-mvp-LNT1S:main

# 3. Ship to production (Vercel only auto-deploys this branch)
git push origin origin/main:refs/heads/claude/photo-purge-swipe-app-Mm7sH
```

Production rebuilds in ~90 seconds.

## Domain setup (when ready)

To point `r-ent.co` at Vercel:

1. **Vercel:** Project → Settings → Domains → Add Domain → `r-ent.co`. Vercel will show the DNS records you need.
2. **GoDaddy:** sign in (customer #117122741) → My Products → `r-ent.co` → **DNS**. Replace or add:
   - `A` record · Name `@` · Value `76.76.21.21` · TTL `1 Hour`
   - `CNAME` record · Name `www` · Value `cname.vercel-dns.com` · TTL `1 Hour`
3. Save. DNS propagates in ~5–30 minutes; Vercel auto-detects and issues SSL.

After that, the site is live at `https://r-ent.co` and `https://www.r-ent.co`.

## Useful npm scripts

- `npm run dev` — local dev server
- `npm run build` — production build
- `npm run start` — serve the production build
- `npm run import-vpc -- --count 600` — rebuild inventory from the VPC CSV
- `npm run import-inventory` — generic CSV/JSON inventory importer (other sources)
