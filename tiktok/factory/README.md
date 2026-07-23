# 🏭 The Factory — Big Brain → TikTok pipeline

Operating model: **Rader curates, the factory produces.** You drop references
into Big Brain (the `save-ref` worker) like you always do. Its export lands
here, gets sorted into production buckets, and comes out the other side as
scripted, ready-to-generate before/after videos.

## The concept being produced

See [CONCEPT.md](CONCEPT.md) — **Stuff × Receipts, FROM 2030.** Everyday
objects now → their 2030 version, every claim timestamped, receipts posted
when reality catches up.

## Getting Big Brain's contents in

This build environment **cannot reach `*.workers.dev`** (network policy
denies the connection — verified 2026-07-23), so the export has to come from
your side. Any of these, 60 seconds each:

**Option A — browser (easiest):** open Big Brain `/browse` → Export →
you get `bigbrain-export.ndjson`. Then either paste chunks straight into
chat, or:

**Option B — commit it:**

```bash
git checkout claude/tiktok-faceless-account-u9zltx
cp ~/Downloads/bigbrain-export.ndjson tiktok/factory/inbox/
git add tiktok/factory/inbox/ && git commit -m "big brain dump" && git push
```

**Option C — curl:**

```bash
curl -H "X-Auth-Token: $TOKEN" \
  https://save-ref-worker.<subdomain>.workers.dev/api/export \
  > bigbrain-export.ndjson
```

Then tell Claude **"brain dump is up"** and the pipeline runs.

## What the pipeline does

```bash
node tiktok/factory/scripts/ingest-refs.mjs tiktok/factory/inbox/bigbrain-export.ndjson
```

Sorts every ref into a production bucket (see CONCEPT.md for the mapping),
writes `queue.md` (human review) + `queue.json` (machine), and flags the
top candidates for the next slate. Claude then turns queued items into
scripts like [slate-01.md](slate-01.md), and every planted claim gets a row
in [CLAIMS_LEDGER.csv](CLAIMS_LEDGER.csv) so receipts are trackable from
day one.

## Files

| File | What |
| --- | --- |
| [CONCEPT.md](CONCEPT.md) | The fused format, the stamp, bucket mapping |
| [scripts/ingest-refs.mjs](scripts/ingest-refs.mjs) | Big Brain export → sorted production queue |
| [CLAIMS_LEDGER.csv](CLAIMS_LEDGER.csv) | Every timestamped claim + its receipt status |
| [slate-01.md](slate-01.md) | First 10 scripted videos (seeded from research, pre-dump) |
| `inbox/` | Drop exports here |
| `queue.md` / `queue.json` | Generated — the sorted backlog |

Slate 01 was seeded from verified research so the account can start posting
before the first dump lands. Once real Big Brain material arrives, your
refs take priority over seeded concepts — same rule as always: the curator's
pulse beats the plan.
