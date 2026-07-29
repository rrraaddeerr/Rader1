# Concept — Stuff × Receipts, FROM 2030

One account, one fused format:

- **Stuff** (the daily blast): an everyday object today → its 2030 version.
  Real object on screen → AI-generated 2030 render → three fast beats of
  *why*, each traceable to something real. Educational futurism, not sci-fi
  slop.
- **Receipts** (the payoff): every Stuff video plants a timestamped claim.
  When reality catches up, we post the split-screen: our old video → the
  news. A before/after OF a before/after. Being provably early is the brand.

## The stamp

Every video ends with the same on-screen stamp, same font, same corner:

> **CALLED IT — JUL 2026**

(month updates as we go). The stamp is the brand asset: it makes receipt
callbacks instantly legible and trains viewers to expect us to come back
and settle scores. Never ship a video without it.

## Claim rules (what keeps this "educational")

1. Every claim has a **source** — a regulation with a date, a shipping
   product, a market number. No vibes-only claims.
2. Every claim has a **check date** and lives in CLAIMS_LEDGER.csv from the
   day its video posts.
3. **Misses get owned.** A "we got this one wrong" video is a receipt too —
   it buys credibility the hits spend.
4. AI visuals are always labeled AIGC. Nobody thinks the 2030 footage is
   real; the ideas are the product.

## Big Brain → production bucket mapping

The ingest script sorts each ref by its Big Brain `category`/`host`/`tags`:

| Big Brain ref | Bucket | Used for |
| --- | --- | --- |
| `shop` (Grailed, Depop, SSENSE, Amazon, eBay…) | **stuff-target** | An object to transform — the daily video subjects |
| `article` / `link` (news, Substack, wiki…) | **claim-source** | Evidence that grounds a claim; feeds the ledger |
| `post` (X, IG, Reddit, Threads…) | **pulse** | Trend signal — curator flags whether it's a target or a source |
| `video` (TikTok, YouTube…) | **format-ref** | Style studies — hooks, pacing, edits to steal structure from |
| `image` / uploads | **visual-ref** | Aesthetic fuel for the AI-gen shot prompts |
| `note` | **idea** | Direct concepts from the curator — jump the queue |

## Video contract (every Stuff video)

1. **0.0–0.5s** — flash the 2030 "after" render. Hard cut back to today.
2. **0.5–3s** — the real object + spoken hook.
3. **3–35s** — three beats of why: `[regulation/date] → [product shipping
   now] → [what your version looks like in 2030]`.
4. **~80%** — the full 2030 reveal, one continuous AI-gen shot.
5. **Last 2s** — side-by-side + **the stamp**.
6. **Caption** plants the claim in words + "bookmark this for 2030."

Length 35–60s. AIGC label ON. One object per video, never two.

## Receipt video contract

1. Open on the original video playing in a phone frame — "We posted this
   on [date]."
2. Hard cut to the news/screenshot of the thing happening.
3. Side-by-side: our render vs. reality.
4. Stamp, plus a second line: **RECEIPT — [date]**.
5. End on the next claim ("here's what we're calling next") — every receipt
   recruits followers for a future receipt.
