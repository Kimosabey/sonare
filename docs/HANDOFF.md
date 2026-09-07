# HANDOFF.md

Start here.

## Reading order

1. `CONTEXT.md` — why this exists and why the constraints are what they are
2. `CLAUDE.md` — the twelve hard rules
3. `PRD.md` — what to build
4. `TASKS.md` — ordered work, with acceptance criteria
5. `scorer-harness.html` — **the reference implementation.** It already solves capture,
   resampling and WAV encoding correctly. Read it before writing any of that yourself.

## Before writing code

```bash
cp .env.example .env          # fill AZURE_SPEECH_KEY and AZURE_SPEECH_REGION
npm install
npm run typecheck             # baseline must be clean
```

Confirm the Azure resource works before building anything on top of it. Smallest possible
test — one script, one known-good WAV, one call:

```bash
node scripts/smoke-azure.mjs ./fixtures/sample.wav "Would you like something to drink" en-US
```

If that does not return phoneme scores, stop. Nothing downstream is worth building until it
does. Likely causes, in order: wrong region string (`southeastasia`, lowercase, no spaces),
Free tier instead of Standard, or audio not in 16 kHz mono PCM16.

## Build order

Sequenced so each step is verifiable before the next depends on it.

```
  1  server: smoke test → endpoint → Azure service → normalized response
     └─ verifiable with curl, no UI needed

  2  capture: worklet → resampler → WAV → constraint reporting
     └─ verifiable by downloading a WAV and inspecting it

  3  wire them: upload, error states, indeterminate handling
     └─ verifiable end to end on desktop

  4  UI: drill screen, score card, phoneme detail
     └─ verifiable on a real iPhone over HTTPS

  5  fixture runner: batch mode, labels, export
     └─ the actual deliverable
```

**Do not build the UI first.** A pretty screen on top of a scorer that does not discriminate
is the failure mode this POC exists to prevent.

## Proposed structure

```
src/
  speech/
    capture/
      worklet.ts          # AudioWorkletProcessor source, inlined as a Blob URL
      recorder.ts         # framework-free: acquire, capture, stop → WAV + metadata
      resample.ts         # anti-alias + decimate to 16 kHz
      wav.ts              # Int16 → WAV container
      constraints.ts      # the analysis profile; reads back getSettings()
      errors.ts           # typed errors with code + domain
      types.ts
    scoring/
      client.ts           # POST to /api/v1/pronunciation
      types.ts            # PronunciationResult — mirrors PRD §6
    react/
      useRecorder.ts      # the ONLY React in src/speech/
    components/
      RecordButton.tsx
      LevelMeter.tsx
      ScoreCard.tsx
      WordChips.tsx
      PhonemeDetail.tsx
      DebugPanel.tsx
  pages/
    PronunciationDrill.tsx
    FixtureRunner.tsx

server/
  routes/pronunciation.ts
  services/
    types.ts              # ScoringProvider interface
    azureSpeech.ts        # the only file that imports the Azure SDK
  middleware/upload.ts

scripts/
  smoke-azure.mjs
  verify.mjs
```

**`src/speech/capture/` must contain zero React imports.** It ports to React Native later.

## Verification

```bash
npm run typecheck
npm run lint
npm run verify
```

`scripts/verify.mjs` should fail the build on any of:

| Check | Reason |
|---|---|
| `SpeechRecognition` or `webkitSpeechRecognition` anywhere in `src/` or `server/` | Rule R1 |
| `AZURE_SPEECH_KEY` outside `server/` and `.env.example` | Rule R2 |
| `localStorage` or `sessionStorage` in `src/speech/` | Rule R11 |
| `import` of `react` inside `src/speech/capture/` | Portability |
| `microsoft-cognitiveservices-speech-sdk` imported outside `server/services/` | Rule R12 |

Write this script early — it is cheap and catches the mistakes that matter.

## Manual checks no script can do

1. Record a known-good phrase on desktop Chrome → phoneme scores render and look sane
2. Same phrase on **a real iPhone over HTTPS** → works, and the debug panel shows what iOS
   granted for the three constraints
3. Record silence → `indeterminate`, not a fabricated score
4. Deliberately mispronounce a word → its chip and phonemes score visibly lower
5. Record on iPhone and desktop with the same speaker and phrase → note whether the scores
   differ. **This is the question the whole POC is answering.**

## Definition of done

- All P0 requirements in `PRD.md` pass
- `npm run verify` clean
- Manual checks 1–5 pass on all five target platforms
- Fixture runner exports JSON for 80 recordings across at least two platforms
- `RESULTS.md` written: score distributions per set, per platform, and a verdict

## Reporting back

When a task is done, state: what changed, what was verified and how, and anything that
surprised you. Surprises about iOS behaviour or Azure response shape are especially
worth reporting — they usually mean an assumption in `PRD.md` needs correcting.

Do not report a task complete without running the verification commands.

## Ask, don't guess

Stop and ask if you hit any of these:

- The Azure response shape differs from `PRD.md` §6
- A required audio format detail is unclear
- An iOS behaviour might be a platform property rather than a bug
- A requirement seems to need streaming, a second provider, or auth changes

Guessing on these produces a POC that measures the wrong thing, which is worse than a
delayed one.
