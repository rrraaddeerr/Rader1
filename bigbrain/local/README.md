# Big Brain — the local runner

This is Tier 1. It runs on your Mac, uses Ollama, and costs nothing.

The worker knows which refs still need a caption or a summary. It just can't
afford to do a thousand of them on paid inference. This asks it for a batch,
does the work here on hardware you already own, and sends the answers back.

Leave it running overnight. It stops on its own when there is nothing left.

---

## Setup

Five commands, once. Then one command every time.

### 1. Install Ollama

```
brew install ollama
```

### 2. Start it, and keep it started

```
brew services start ollama
```

### 3. Pull the vision model

```
ollama pull llava
```

### 4. Pull the text model

```
ollama pull llama3.1
```

### 5. Go to this folder

```
cd ~/futureoutfit/bigbrain/local
```

---

## Running it

### Set the worker address

```
export BIGBRAIN_URL=https://save-ref-v2.raderturner-e87.workers.dev
```

### Set your token

Type this, press return, then paste the token and press return again. Nothing
will appear as you paste. That is correct.

```
read -rs BIGBRAIN_TOKEN && export BIGBRAIN_TOKEN
```

### Start

```
npm start
```

### Or start it for the night, so the Mac does not sleep

```
npm run overnight
```

Press Ctrl-C to stop. It hands back whatever it was holding before it exits.

---

## What you will see

```
Big Brain local runner -> https://save-ref-v2.raderturner-e87.workers.dev
batch 8 - lease 900s - idle check 60s
ollama: ready at http://127.0.0.1:11434 (llava:latest, llama3.1:latest)
lease: 8 job(s) - 412 still queued
  caption   ref_01H9F2K            ok         4.1s  287 chars
  caption   ref_01H9F2M            FAILED     0.3s  image fetch 404 (permanent)
  summarize ref_01H9F2P            ok        11.8s  612 chars
batch: 7 done - 1 failed - 0 released - 405 left - worker applied 7
```

- **done** means the archive got deeper. That ref now knows what is in its picture.
- **failed** means we tried and it genuinely did not work. The worker handles the
  retry schedule, and gives up on that ref's rung after four tries.
- **released** means we did not try. Something here was wrong, not the ref. Those
  go straight back in the queue with nothing held against them.
- **left** is how many jobs remain. That number going down is the whole point.

---

## If something is wrong

The runner prints the command that fixes it. Run that command and start it
again. You should never have to work out what went wrong.

If it says nothing is listening:

```
brew services start ollama
```

If it says a model is not pulled, it prints the exact `ollama pull` line to run.

If it says `BIGBRAIN_TOKEN is not set`, you are in a new Terminal tab and the
token did not come with you. Set it again:

```
read -rs BIGBRAIN_TOKEN && export BIGBRAIN_TOKEN
```

---

## Things that are already handled

You do not need to do anything about any of these.

- **The Mac sleeps.** Jobs it was holding return to the queue by themselves. It
  picks up where it left off when the Mac wakes.
- **The wifi drops.** It waits and retries, backing off up to five minutes. It
  does not give up and it does not spin.
- **You close the laptop mid-batch.** Nothing is lost. Worst case a few refs get
  captioned twice.
- **You quit it with Ctrl-C.** It gives its work back before exiting.

It stores nothing locally. The worker is the only place state lives, so you can
delete this folder at any time and lose nothing but the current batch.

---

## Settings

All optional. The defaults are right for an overnight run.

| variable | default | what it does |
|---|---|---|
| `BIGBRAIN_URL` | none, required | the worker |
| `BIGBRAIN_TOKEN` | none, required | your auth token |
| `BIGBRAIN_BATCH` | `8` | jobs leased at a time |
| `BIGBRAIN_LEASE_SECONDS` | `900` | how long before an unfinished job returns to the queue |
| `BIGBRAIN_IDLE_SECONDS` | `60` | how long to wait when there is no work |
| `BIGBRAIN_VISION_MODEL` | `llava` | the captioning model |
| `BIGBRAIN_TEXT_MODEL` | `llama3.1` | the summarising model |
| `BIGBRAIN_ONCE` | unset | do one batch and exit |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | where Ollama is |

---

## Tests

No network, no Ollama, no worker needed.

```
npm test
```
