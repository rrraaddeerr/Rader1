# 📥 Big Brain inbox

Drop `bigbrain-export.ndjson` (from Big Brain `/browse` → Export, or
`/api/export`) in this folder, commit, push, and say **"brain dump is up."**

The pipeline (`../scripts/ingest-refs.mjs`) sorts it into the production
queue. Exports are staging material — they get processed then cleaned up,
same as the photo drop zone.
