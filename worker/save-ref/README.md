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
- **A trash can** — deleting moves things to `🗑 trash` where they can be
  restored for 30 days before being purged for good. No more accidental losses.
- **Real note editing** — every card's ✎ editor now has a title field and a
  big textarea for the note text, and `/drop` has a proper "✍️ Write a note"
  composer with room to think (⌘/Ctrl+Enter saves).
- **Hold-down reminders** — long-press any card or tile (or tap its ⏰) to get
  reminded about it: a push **notification from Big Brain**, a **WhatsApp/SMS**
  via Twilio, and/or an **Apple Reminders / Calendar** `.ics` download.
- **Recent strip on `/drop`** — instant visual confirmation each save landed.
- **Richer auto-categorization** — image / video / audio / post / article / code /
  shop / document / note / link, by content-type, file extension, and a domain
  ruleset (YouTube→video, X/IG→post, GitHub→code, SSENSE→shop, …).
- **Link previews** — fetches Open Graph title/description/image so saved links
  show real thumbnails.
- **Multi-file drop + paste** — drag many files, paste screenshots or URLs (⌘V).
- **Export / import** — NDJSON round-trip, so you can migrate data in and out.
- **R2-ready** — large uploads can offload to R2 instead of KV (optional).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/drop` | public page | the drop SPA |
| GET | `/browse` | public page | the gallery SPA |
| POST | `/save` | token | save a link/note (JSON) or file (raw bytes) |
| GET | `/api/list?q=&cat=&cursor=&limit=` | token | list / search / filter |
| GET | `/api/ref/:id` | token | fetch one ref |
| PATCH | `/api/ref/:id` | token | edit `category` / `tags` / `title` / `text` / `desc` |
| DELETE | `/api/ref/:id` | token | move a ref to the trash (blob kept) |
| POST | `/api/ref/:id/restore` | token | bring a trashed ref back |
| GET | `/api/trash` | token | list the trash (auto-purges after 30 days) |
| DELETE | `/api/trash/:id` | token | delete forever (+ its blob) |
| GET | `/api/export` | token | NDJSON of all refs |
| POST | `/api/import` | token | bulk insert (array of refs) |
| GET | `/api/reminders/config` | token | which reminder channels are available |
| GET/POST | `/api/reminders` | token | list upcoming / schedule a reminder |
| DELETE | `/api/reminders/:id` | token | cancel a reminder |
| POST | `/api/reminders/ics` | token | downloadable `.ics` for Apple Reminders/Calendar |
| POST | `/api/push/subscribe` | token | register this device for notifications |
| GET | `/api/push/pending?k=` | subKey capability | the service worker pulls due notifications |
| GET | `/sw.js`, `/manifest.json`, `/icon.svg` | public | notification SW + PWA bits |
| GET | `/blob/:key` | public (key is the capability) | raw upload bytes |
| GET | `/health` | public | liveness |

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

## Reminders — how each channel works

Hold down any card in `/browse` (or any recent tile on `/drop`), or tap its
⏰ button. Pick a time (In 1 hour / Tonight / Tomorrow 9am / custom) and how
you want to be nagged. A minute-cron on the Worker fires whatever is due.

**🔔 Notification from Big Brain (web push)** — zero setup: the VAPID keypair
is auto-generated into KV the first time it's needed. The first time you set a
push reminder, the browser asks for notification permission and registers this
device. Each device you do that on gets the notification.
*iPhone caveat (Apple's rule, not ours):* web push only works from an
installed web app — in Safari hit **Share → Add to Home Screen**, open Big
Brain from that icon, then set a push reminder once to grant permission.

**💬 WhatsApp / 📱 SMS (Twilio)** — appears in the sheet only once the Twilio
secrets exist on the Worker:

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put REMINDER_PHONE        # your phone, e.g. +17785550000
npx wrangler secret put TWILIO_FROM           # a Twilio number -> enables SMS
npx wrangler secret put TWILIO_WHATSAPP_FROM  # Twilio WhatsApp sender -> enables WhatsApp
```

(Twilio's free trial + WhatsApp sandbox is enough for personal use.)

**🍎 Apple Reminders / Calendar (.ics)** — no server involvement: picking it
downloads a calendar file with an alert at the due time. Opening it on
iPhone/Mac adds it to Apple Calendar with an alarm; on a Mac you can drag it
into Reminders instead. This one fires from Apple's side, so it works even if
the Worker is asleep.

Scheduled reminders live in KV (`rem:` keys), fire from the `[triggers]`
minute-cron in `wrangler.toml`, and retry up to 5 times if a channel fails.
See what's queued via the ⏰ button in the gallery header.

## Trash

Deleting from the gallery is now a soft delete: the ref (and its uploaded
blob) moves to `trash:` keys, restorable from the `🗑 trash` chip in `/browse`.
Anything older than 30 days is purged automatically (lazily on trash views and
by the minute-cron). "Delete forever" in the trash view skips the wait.

## Deploy

```bash
npm run deploy
```

Open `https://save-ref-worker.<your-subdomain>.workers.dev/drop`, paste the same
token, and start dropping. The gallery is at `/browse`.

## Develop / test locally

```bash
npm test                 # pure-logic categorization tests (no deps, no network)
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
