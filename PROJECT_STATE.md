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
- **Vercel "Production Branch":** `rentco-site` — pushing to it auto-deploys
  production at https://r-ent.co. (`main` belongs to the separate Future
  Outfit project; it can no longer touch the rent.co domain.)
- **Vercel project:** `rentco` (team RENTCO, repo `rrraaddeerr/Rader1`)
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

- **Roles:** codes are guest by default. Operator surfaces (/sets, /ops,
  /curate, /api/sets) need an operator-role code: append `:op`
  (e.g. `mysecret:Rader:op`) or use the separate `OPERATOR_CODES` env var.
  With neither set, operator pages are locked for everyone.
- **Fail-closed:** if `ACCESS_CODES` is unset entirely, NO code works
  (the old fallback `operator`/`launch` dictionary words are gone).
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

## Sets (client proposals)

Operator-built proposals you send to clients/directors. They open a
public URL, vote on items (Approve / Maybe / Pass), and you watch
responses come in live.

- **Operator pages** (gated): `/sets`, `/sets/new`, `/sets/<id>`
- **Public presentation:** `/set/<slug>` — no login, slug is the auth
- **Storage:** Cloudflare Worker at `worker/rentco-sets/` (KV-backed)
- **Vercel env vars required:**
  - `RENTCO_SETS_URL` — `https://rentco-sets.raderturner.workers.dev`
  - `RENTCO_SETS_TOKEN` — the same hex you set as worker secret
    `OPERATOR_TOKEN`
  - `NEXT_PUBLIC_RENTCO_SETS_URL` — same URL, exposed to the browser so
    the public `/set/<slug>` page can POST responses
- **Worker setup:** see `worker/rentco-sets/README.md`. Quick re-deploy:
  ```bash
  cd ~/Documents/rentco/worker/rentco-sets
  npx wrangler deploy
  ```
- **Worker secret rotation:** pipe the value to avoid clipboard mangling:
  ```bash
  echo -n "<token>" | npx wrangler secret put OPERATOR_TOKEN
  ```

### Operator workflow

1. `/sets/new` — pick a starter template (Blank, Lounge, Dinner, Film
   set, Bar). Templates pre-populate group labels + pick rules.
2. `/sets/<id>` — add items per group via multi-select picker (search,
   filter by VPC subcategory, select N tiles, "Add selected"). Mark
   your favorites with ★ pick, add operator notes per item.
3. Group pick rules: **Open** (any combination), **Pick one**
   (alternatives), **All confirmed** (no choice — the spec).
4. Click **Publish** in the top bar to make the public URL live.
5. **Copy share link** or **Send** (Web Share / mailto with subject +
   body pre-filled) to text the client.
6. Responses appear on `/sets/<id>` and refresh every 12 seconds while
   the editor is open. Per-response tally shows approve/maybe/pass counts.

### Client experience at `/set/<slug>`

- Editorial layout, big photos, name field at top, group jump nav with
  per-section progress (0/3, 0/2, etc).
- Three taps per item: ✓ Approve · ◐ Maybe · ✗ Pass.
- Auto-saves to KV every 900 ms keyed by visitor name.
- "Send to Rader" final button shows a thank-you panel with their tally
  summary. Revise button lets them go back.

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

- **Domain LIVE** — `r-ent.co` A-record points to Vercel; site serves production.
- **Email** — MX for r-ent.co exists (Outlook protection). Send one test mail to
  `hello@r-ent.co` and confirm receipt — it's the only public contact address.
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
git push origin <branch>:rentco-site   # rentco-site is the production branch
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
