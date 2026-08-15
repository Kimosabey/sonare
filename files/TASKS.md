# TASKS.md

Ordered. Each task states what "done" means. Do not start a task whose dependency is
unverified.

Legend: **[S]** server · **[C]** client capture · **[U]** UI · **[X]** tooling

---

## Phase 1 — Prove the scorer works (day 1)

### T1 [X] Smoke test the Azure resource
Write `scripts/smoke-azure.mjs`: take a WAV path, reference text and language; call Azure
pronunciation assessment; print the four overall scores and the first word's phonemes.

**Done when:** a known-good 16 kHz mono WAV returns phoneme-level scores from the command
line. No app code involved.

**If it fails:** check the region string is `southeastasia` (lowercase, no spaces), the
resource is Standard not Free, and the WAV really is 16 kHz mono PCM16 (`ffprobe` it).

---

### T2 [S] Scoring provider interface
`server/services/types.ts` defines `ScoringProvider` with one method:
`score(wav: Buffer, referenceText: string, language: string): Promise<PronunciationResult>`.

`server/services/azureSpeech.ts` implements it. **The only file in the repo that imports the
Azure SDK.**

Parse per-phoneme detail from `JSON.parse(result.json).NBest[0]` — the typed
`PronunciationAssessmentResult` carries only the four top-level scores.

**Done when:** `typecheck` passes; the response matches `PRD.md` §6 exactly; `prosody` is
optional and absent-safe; `indeterminate` is returned when `result.reason` is not
`RecognizedSpeech`.

---

### T3 [S] The endpoint
`POST /api/v1/pronunciation`, multipart: `audio`, `referenceText`, `language`,
`deviceContext`. Validates content type and duration. Calls the provider. Persists an attempt
record.

**Done when:** `curl -F` with a local WAV returns the normalized JSON. Keys appear in no
response and no log line.

---

## Phase 2 — Capture (days 2–4)

> **Read `scorer-harness.html` first.** It already implements the worklet, the resampler and
> the WAV encoder correctly. Port that logic; do not reinvent it.

### T4 [C] Constraint profile and acquisition
`constraints.ts` requests `echoCancellation: false`, `autoGainControl: false`,
`noiseSuppression: false`, `channelCount: 1`, and reads back `track.getSettings()`.

**Done when:** the granted settings object is returned alongside the stream, and a key
missing from `getSettings()` is reported as `"not reported"` rather than assumed false.
On Safari, "not reported" is the expected and correct outcome.

---

### T5 [C] Worklet capture
`worklet.ts` posts Float32 frames to the main thread. `recorder.ts` accumulates them.
Inline the worklet as a Blob URL so there is no separate asset to serve.

**Done when:** a 3-second recording yields a continuous Float32Array of roughly
`3 × contextSampleRate` samples with no gaps.

---

### T6 [C] Resample and encode
`resample.ts`: anti-alias, then decimate to 16 kHz. `wav.ts`: Int16 → WAV container.

**Done when:** the produced WAV plays back correctly, `ffprobe` reports 16000 Hz mono
pcm_s16le, and T1's smoke script scores it successfully.

---

### T7 [C] Errors and lifecycle
`errors.ts` — typed errors with `code` and `domain`. State machine:
`idle · requesting · ready · recording · processing · error`.

Cover: permission denied, permission dismissed, device lost, suspended context, no audio
energy within 3 s, gesture required, duration under 0.4 s or over 15 s.

**Done when:** every code is reachable in a test, and each carries UI text that tells the
user what to actually do.

---

### T8 [C] React hook
`useRecorder.ts` — the only React file in `src/speech/`. Exposes state, level, `start`,
`stop`, `result`, `error`.

**Done when:** `npm run verify` confirms no React import inside `src/speech/capture/`.

---

## Phase 3 — Wire it up (day 5)

### T9 [C] Upload
`scoring/client.ts` — multipart POST with audio, reference text, language and device context
(user agent, context sample rate, granted constraints). One retry on network failure.

**Done when:** an end-to-end recording on desktop returns rendered scores.

---

### T10 [C] SNR gate
Reject a recording below `MIN_SNR_DB` before upload, with a retry prompt. Do not send audio
that will produce a meaningless score.

**Done when:** recording in a noisy room prompts a retry rather than returning a low score.

---

## Phase 4 — UI (days 6–7)

### T11 [U] Drill screen
Prompt text, record button, level meter, result area. Minimal styling — this is not a design
task.

### T12 [U] Score card
Four overall scores. Word chips coloured by accuracy: ≥80 pass, 60–79 warn, <60 fail.

### T13 [U] Phoneme detail
Tapping a word reveals its phonemes with individual scores, and its error type when not
`None`.

### T14 [U] Indeterminate state
Renders as "couldn't get a clear read — try again". **Never a number.** No score bars, no
partial credit.

### T15 [U] Debug panel
Toggleable. Shows granted constraints, context sample rate, duration, provider, model
version. Needed on every device during the fixture run.

**Phase 4 done when:** the full flow works on a real iPhone over HTTPS, and the debug panel
shows what iOS granted.

---

## Phase 5 — The actual deliverable (days 8–10)

### T16 [U] Fixture runner
Separate route. Fields for set ID (`A` / `B`), speaker label, reference text. Records,
scores, appends to an in-memory log. Exports JSON.

Each entry: set, speaker, reference, language, user agent, context rate, granted constraints,
full result, timestamp.

**Done when:** 10 consecutive recordings can be made without a page reload and export
cleanly.

---

### T17 [X] Verify script
`scripts/verify.mjs` — the five checks in `HANDOFF.md`. Wire to `npm run verify`.

**Done when:** deliberately introducing each violation fails the build.

---

### T18 [X] Fixture analysis
Python script: read the exported JSON, compute per-set score distributions, plot Set A
against Set B per platform, print the separation.

**Separation** = Set A's 25th percentile minus Set B's 75th percentile. Positive means the
scorer distinguishes them. Negative means it does not.

**Done when:** it produces the table and plot from `RESULTS.md`.

---

### T19 Run the fixture
80 recordings across at least iPhone Safari and desktop Chrome, same speakers.

**Done when:** `RESULTS.md` contains the distributions, the separation figures, and a verdict
against one of these four:

| Outcome | Meaning |
|---|---|
| Sets separate cleanly on both platforms | Scoring works. Ship on web. |
| Sets separate; iPhone consistently lower | Calibratable offset. Ship on web with per-platform thresholds. |
| Sets separate on desktop; noisy on iPhone | Genuine platform problem. Escalate to the native spike. |
| Sets do not separate anywhere | Scorer is not the answer. Stop and investigate. |

---

## Notes

- **Nothing in phases 2–5 matters if T1 fails.** Do that first, alone.
- Phase 1 is verifiable entirely with `curl` — no browser needed.
- Do not begin phase 4 until phase 3 works end to end on desktop.
- The fixture recordings themselves are not a development task; Harshan owns recruiting
  speakers. Build T16 so recording is quick when they are available.
