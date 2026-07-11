# HUSH — a silent-speech + bone-conduction wearable

> Talk without talking. Hear without earbuds. Wear it like jewelry.
>
> An art-object that actually works: a small piece worn along the jaw / collarbone
> that reads the speech you *almost* make, lets a small on-site crew "talk" to each
> other without a sound in the room, plays music and voices into your skull through
> bone, and connects to your phone. Built for the introvert who thinks better when
> the pressure of speaking out loud is gone.

This folder is the **design brief + buildable prototype plan**. It is intentionally
separate from the Future Outfit fashion app — it just shares the repo because this
is where the branch lives. Nothing here touches the Next.js site.

**Status:** concept + hardware plan. No code yet. This document is the thing to
argue with, cut down, and turn into a parts order.

---

## 1. What we're actually making

Three things fused into one object:

1. **Silent-speech input** — you mouth/subvocalize words (little or no sound, no
   air), and the device turns that into text or synthesized voice. This is the
   "MRI wand for your throat" you were excited about. The real versions don't use
   MRI — they use tiny skin sensors. More on that below.
2. **Bone-conduction output** — audio (music, the other person's voice, an AI
   voice) is played by vibrating the bone of your jaw/cheek/skull, so your ear
   canal stays open. You hear it *and* the room at the same time.
3. **The mesh** — 2–8 people on site each wear one. What you silently "say" comes
   out as a low whisper in *their* skull, not out loud in the room. That's the
   walkie-talkie replacement: nobody is actually talking, but everyone's in sync.

Plus the two softer goals you named:

- **Looks like jewelry**, not a medical device or a headset. Sculptural, wearable,
  a little Matrix, but real.
- **An open-heart channel** — a private, no-audience way to think out loud to an AI
  (or to one trusted person) with the specific frictionlessness you feel typing to
  an assistant but lose when a human is in the room.

---

## 2. How the real technology works (so we pick the right one)

You saw an "imaging wand that sees your throat." That's real, but it's actually
**three different families** of tech, and they have very different build costs.
Picking correctly is the single most important decision here.

### A. sEMG — surface electromyography (READ THE MUSCLES)
Tiny electrodes on the skin of the jaw/neck pick up the faint electrical signals
your speech muscles fire when you *intend* to speak — even if you make no sound.
A model maps those signals to words.

- **This is what MIT's AlterEgo uses** (spun out of MIT in 2025, ~7 electrodes
  around the jaw/ear, "near-telepathic" demo). It's also the most **DIY-reproducible**
  path — the hobbyist/research world (OpenBCI, NeuroTechX teams, Hackaday's Cerebro
  Voice) has built working prototypes with 8 electrodes along the jaw.
- **Pros:** cheap-ish to prototype, low power, tiny, hides under jewelry easily.
- **Cons:** electrode placement is fussy; accuracy is per-person and needs training
  data; sweat/skin contact matters.
- **Verdict: this is our prototype path.** Best power-to-hideability-to-buildability.

### B. Textile strain / vibration sensors on the neck (FEEL THE THROAT MOVE)
Ultra-sensitive fabric sensors sit against the throat and read muscle vibration +
carotid pulse, fed to a language model that fills in the sentence. This is the 2025–26
clinical wave (the *"intelligent throat"* / Revoice-style work for stroke & ALS
patients — published in Nature Communications, Jan 2026).

- **Pros:** soft, comfortable, continuous natural speech, clinically validated.
- **Cons:** the good sensors are custom-fabricated research textiles — you can't
  buy them off a shelf yet. Great north star, wrong starting point.

### C. Ultrasound / acoustic imaging (SEE THE TONGUE)
A small ultrasound transducer under the chin, or ultrasound *inside the ear/glasses*
(EchoSpeech, EarCommand), images tongue and jaw movement and decodes speech from the
shapes. This is the closest to the literal "imaging wand" you described.

- **Pros:** genuinely images articulation; doesn't care about skin electrical contact.
- **Cons:** transducers + the DSP pipeline are heavier to build; more power; harder
  to hide in jewelry at prototype stage.
- **Verdict: a great Phase 3 variant**, not the first build.

**Decision: build the prototype on sEMG (A), design the jewelry so it could later
swap to textile (B) or in-ear ultrasound (C).**

---

## 3. The fastest path to "it works" — buy, don't build (Phase 0)

Before soldering anything, prove the *experience* with off-the-shelf parts. This
de-risks the whole thing in a weekend and gives you something to feel.

- **Silent input, faked well enough to test the feel:** on-device whisper/lip
  input. Modern phones can do surprisingly good *whispered* speech-to-text. Wear a
  throat-contact mic (a cheap "laryngophone"/throat mic, ~$20–40, used by motorcyclists
  and airsoft players) — it only picks up *your* throat, not the room, so you can
  whisper almost inaudibly and it still transcribes. **This is not true silent
  speech, but it proves the mesh + bone-audio experience today.**
- **Bone-conduction output:** buy bone-conduction headphones (Shokz/others, ~$80–150)
  or a bare bone-conduction transducer disc (~$5–15) you can later embed.
- **The mesh + AI:** a phone app (or even a group call + push-to-talk) where each
  person's whispered text is TTS'd into everyone else's bone speaker, and an AI
  voice is one of the "people" you can talk to privately.

If Phase 0 feels good — the open-ear whisper-and-hear loop — *then* we invest in the
real sEMG silent-speech and the jewelry. If it doesn't feel magic, we learned that
for $150 instead of $1,500.

---

## 4. The real prototype — bill of materials (Phase 1, sEMG)

A wearable dev rig. Not pretty yet; pretty comes in Phase 2.

| Subsystem | Part | Rough cost | Notes |
|---|---|---|---|
| Silent-speech sensing | OpenBCI Ganglion (4ch) or Cyton (8ch) biosensing board | $200–500 | The de-facto DIY sEMG brain; clean signal, open SDK |
| Electrodes | Gold-cup or dry sEMG electrodes ×8 + skin prep | $40–90 | Placement along jaw/neck per AlterEgo maps |
| Compute | Raspberry Pi Zero 2 W / ESP32-S3 | $15–25 | Runs the inference / streams to phone |
| Bone audio out | Bone-conduction transducer disc + small amp (PAM8403) | $10–20 | Presses against jaw/cheekbone |
| Link | BLE (built into ESP32) to phone | — | Phone = the router + AI + TTS |
| Power | 400–800 mAh LiPo + charge board (TP4056) | $10 | A few hours; jewelry version optimizes later |
| Body | 3D-printed jaw/collar cradle for fitting | $5 | Iterate the fit before making it jewelry |

**Ballpark: ~$300–650** for one working unit, less per unit at small batch.

### Where the signal goes
```
[jaw electrodes] → OpenBCI → BLE → phone app
                                     ├─ silent-speech model → text
                                     ├─ text → your choice: keep private (journal/AI) OR
                                     │         broadcast to the mesh
                                     ├─ incoming mesh text → TTS → BLE → bone transducer
                                     └─ music / AI voice → BLE → bone transducer
```
The **phone does the heavy lifting** (model inference, TTS, routing, AI). The
wearable stays small, cheap, and low-power. That's the trick to making it jewelry-sized.

---

## 5. The software (Phase 1)

Three components, all buildable incrementally:

1. **Signal → words (the hard, fun part).**
   Start with a *small vocabulary* — this is the honest move. Full open-vocabulary
   silent speech is a research problem (AlterEgo reported ~92% *word* accuracy in
   controlled conditions after per-user training). For an art prototype that
   actually works, begin with **20–50 words/commands + a yes/no channel** ("copy,"
   "on me," "two minutes," "hold," names, directions). Train a small classifier per
   wearer. It will feel like magic *because it's reliable*, not because it's
   unlimited. Grow the vocabulary as the model improves.

2. **The mesh.** A tiny relay: each unit publishes its decoded phrases to a shared
   session; everyone else's phone TTS's them into their bone speaker with the
   speaker's name/voice. Runs over the phones' internet, or peer-to-peer BLE/Wi-Fi
   for true no-infrastructure on-site use. Push-to-"talk" = a jaw clench or a
   discreet tap so you don't broadcast every subvocalization.

3. **The open-heart / AI channel.** A private mode where your silent speech goes
   *only* to an AI companion (or a transcript/journal), never the mesh. This is the
   feature you personally want most: think out loud with your heart open, no human
   audience, the way you can with an assistant — but now hands-free, eyes-up, walking
   around, with your partner in the room but not *watching you type*. It's the same
   pipeline, different destination.

---

## 6. Making it jewelry (Phase 2 — the art)

The engineering above is a brick with wires. The art is hiding it. Design directions
to prototype in parallel (cardboard/clay/print before electronics):

- **The collar / torc.** A rigid neckpiece (torc) is the most honest form: it
  naturally holds sensor contact against the neck/collarbone, hides a battery in the
  band, and reads as sculpture, not tech. Very Matrix, very now.
- **The jaw-line cuff.** Sits like an ear cuff + a fine chain along the jaw where the
  electrodes need to be anyway. The bone transducer lives at the cheekbone/mastoid.
- **The two-piece.** A visible sculptural front (pendant, brooch, ear piece) + a
  hidden soft sensor band. The jewelry is the "face"; the electronics ride behind.
- **Materials:** the electrode contacts can be *the metal of the jewelry itself*
  (conductive) — that's the elegant fusion: the beautiful object is also the sensor.
- **Signal language:** a single tiny light or a warmth/haptic pulse for "mic live,"
  "message incoming," "AI listening." No screens. It should feel like the object is
  alive, not like a notification.

Design principle: **it should look like something you'd wear if it did nothing.**
The tech is a secret it keeps.

---

## 7. Honest reality check

- **Silent speech is not solved.** Reliable, open-vocabulary, cross-person silent
  speech does not exist as a buyable chip in 2026. What *is* real: small-vocabulary,
  per-user-trained systems that work well, and clinical/lab systems that need custom
  hardware. Our plan respects that — start small-vocab, feel magic, expand.
- **"Talk with no sound at all"** is the aspiration; the reliable near-term is
  **near-silent (tiny whisper / strong subvocalization)**. That's still a total
  walkie-talkie replacement for a quiet crew and it's genuinely discreet.
- **Bone conduction + phone + music is easy and done — buy it Phase 0.** The novel,
  risky, beautiful part is the silent input and the jewelry. Spend your energy there.
- **AlterEgo is the closest shipping thing to your dream** and it's a company now —
  worth watching / possibly partnering-with rather than beating on raw silent-speech
  accuracy. Our edge is the *art object* + the *mesh* + the *open-heart AI channel*,
  not out-engineering an MIT spinout on signal decoding.

---

## 8. Suggested next 3 moves

1. **Phase 0 this month:** throat mic + bone-conduction headphones + a dead-simple
   phone relay with an AI voice in the mesh. Feel the loop. ~$150.
2. **Order the sEMG rig** (OpenBCI + electrodes) and get *your own* jaw signals
   decoding a 10-word vocabulary. This is the real proof.
3. **In parallel, sculpt the object** in clay/paper/print at 1:1 so the electronics
   get designed *into* a form you'd actually wear — not bolted on after.

---

### Sources / prior art
- AlterEgo (MIT Media Lab spinout, 2025) — sEMG jaw-line silent speech:
  https://www.media.mit.edu/projects/alterego/overview/
- "Near-telepathic wearable" coverage — Tom's Hardware:
  https://www.tomshardware.com/peripherals/wearable-tech/alterego-demoes-worlds-first-near-telepathic-wearable-that-enables-typing-at-the-speed-of-thought-other-abilities
- Wearable "intelligent throat" for stroke/dysarthria — Nature Communications (Jan 2026):
  https://www.nature.com/articles/s41467-025-68228-9
- SottoVoce — ultrasound-imaging silent speech (ACM CHI):
  https://dl.acm.org/doi/10.1145/3290605.3300376
- EchoSpeech — ultrasound-on-eyewear silent speech (Cornell)
- DIY sEMG silent speech (OpenBCI / NeuroTechSC): https://openbci.com/community/synthetic-telepathy-with-subvocal-recognition-neurotechsc/
- Cerebro Voice (Hackaday DIY subvocal): https://hackaday.io/project/160715-cerebro-voice
