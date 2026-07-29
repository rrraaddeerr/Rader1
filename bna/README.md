# b4/after — the before & after page

Project #2, now the active build. A faceless, high-volume before/after
page: clickbait mechanics, automated production, **with intention** — every
post carries exactly one true, interesting line. That line is the
difference between this page and the slop farms, and it's also what makes
posts get saved and shared instead of just swiped.

Independent of Big Brain. The whole operation is: fill a CSV row, drop two
images, run one command.

## The unit of content

A 2-slide swipe post (works as IG carousel and TikTok photo mode):

1. **Slide 1 — BEFORE.** Full-bleed image, hook line, swipe cue.
2. **Slide 2 — AFTER.** Full-bleed image, payoff line, + the **intent
   line** (the one true thing).

`make-post.mjs` renders both slides at 1080×1350 with consistent branding
(handle watermark, BEFORE/AFTER tags, typography) plus a ready
`caption.txt`. AI-sourced posts get an "AI-generated" mark on-slide and a
reminder in the caption to toggle the platform AIGC label.

## Series (the 1–3 categories, swappable)

Seeded in `queue.csv`:

| series | what | source |
| --- | --- | --- |
| `timegap` | same place/thing, decades apart | public-domain archives (city archives, Library of Congress, Wikimedia) — fully automatable, zero rights drama |
| `restore` | restoration payoffs (chairs, cars, sneakers) | AI-generated pairs, labeled |
| `hypothetical` | "your street if cars never existed" | AI-generated, labeled — the shareable/argument-starter lane |
| `glowup-things` | $3 thrift find styled up | ties to futureoutfit's world |
| `marine` | wrecks→reefs, coastlines over time | archive + AI — test cell |

Rule: launch with **at most 3 series** on the page. The rest are benched
until data says otherwise. No people-glow-ups — other humans' bodies and
faces at volume is a rights + platform-risk minefield; things only.

## Daily workflow (target: 15 min for 3+ posts)

1. Add rows to `queue.csv` (id, series, hook, payoff, intent, caption, tags).
2. Drop images at `assets/<id>/before.jpg` + `after.jpg` (archive scans or
   AI renders). Missing art renders as a placeholder for previewing copy.
3. `node make-post.mjs` — renders every un-rendered row into `out/<id>/`.
4. Post the two slides + paste `caption.txt`. Toggle AIGC label when the
   bundle says so. Batch a week in one sitting; drip-post daily.

## Volume with intention — the rules

- **One true line per post.** If the intent line isn't verifiably true or
  isn't interesting, the post doesn't ship. This is the "little bit."
- 2–5 posts/day. Volume is the strategy; the intent line is the moat.
- Same watermark, same tags, same typography on every post — the template
  IS the brand.
- Never repost someone else's before/after. Archive material must be
  public domain / properly licensed; everything else we generate.

## Monetization (same Canada-real ladder as `tiktok/MONETIZATION.md`)

Affiliate links matched to series (restoration tools/products for
`restore`, styling for `glowup-things`), brand placements once the page
has a number, and cross-promo real estate for the flagship account and
futureoutfit when they're live. Photo pages sell ad slots surprisingly
well — "this slide could be your product's before/after" is a native ad
unit here.

## Files

- `make-post.mjs` — the renderer (playwright-core + system Chromium)
- `queue.csv` — the content queue; 10 seed rows across 5 series
- `assets/<id>/` — source images (gitignored; drop zone)
- `out/<id>/` — rendered bundles (gitignored)
