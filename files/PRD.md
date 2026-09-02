# PRD — Lingotran Pronunciation POC

| | |
|---|---|
| **Version** | 1.0 |
| **Owner** | Harshan |
| **Duration** | 10 working days |
| **Status** | Ready to build |
| **Depends on** | Azure AI Speech resource (Standard tier, Southeast Asia) — provisioned |

---

## 1. Problem

Lingotran's shipped pronunciation feedback is built on the browser's Web Speech API, which
returns a transcript and a confidence number and **no phoneme-level data**. The score is
therefore inferred from whether the recognizer returned the expected word.

That fails in both directions:

- **False negative.** A learner with a strong accent pronounces acceptably, the recognizer
  fails to return the word, the learner is marked wrong. Every Lingotran user is a
  second-language speaker, so this hits precisely the population the feature exists for.
- **False positive.** A learner mispronounces badly, but the recognizer's language model
  supplies the expected word anyway, and they are told they were correct.

Additionally, Web Speech does not work at all in non-Safari iOS browsers, times out after
30–60 seconds, and is subject to an undocumented per-device request quota.

## 2. Goal

Prove that phoneme-level scoring from a purpose-built assessment service **separates
accented-but-correct speech from fluent-but-incorrect speech**, on the devices our learners
actually use.

This is a measurement exercise with a working feature attached — not the reverse.

## 3. Success criteria

| # | Criterion |
|---|---|
| S1 | A learner records a target phrase and receives per-word and per-phoneme feedback |
| S2 | Works on iPhone Safari, iPad Safari, macOS Safari, Chrome, and Android Chrome |
| S3 | No Web Speech API anywhere in the code path |
| S4 | A fixture of 80 recordings can be run through the scorer and exported |
| S5 | Every session records what audio constraints the browser actually granted |
| S6 | Score distributions per set, per platform, are exportable for analysis |

## 4. Out of scope

Streaming recognition · free-speech dictation · WebSocket transport · multi-provider routing ·
new authentication · offline scoring · production visual design · native app work
(tracked separately).

---

## 5. Functional requirements

### Capture (`src/speech/capture/`)

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Acquire microphone via `getUserMedia` with `echoCancellation`, `autoGainControl`, `noiseSuppression` set `false` and `channelCount: 1` | P0 |
| FR-02 | Capture through an `AudioWorklet`, not `MediaRecorder` or `ScriptProcessorNode` | P0 |
| FR-03 | Resample to 16 kHz with anti-aliasing before decimation; encode 16-bit mono PCM WAV | P0 |
| FR-04 | Read `track.getSettings()` after acquisition and attach it to every recording | P0 |
| FR-05 | Expose a lifecycle state machine: `idle · requesting · ready · recording · processing · error` | P0 |
| FR-06 | Emit a level value at ≥ 20 Hz for the meter | P0 |
| FR-07 | Require a user gesture to start; surface `GESTURE_REQUIRED` if called without one | P0 |
| FR-08 | Detect track-ended, device change, and suspended `AudioContext`; fail with a typed error rather than hanging | P0 |
| FR-09 | Detect zero audio energy within 3 s and raise `NO_AUDIO_ENERGY` | P0 |
| FR-10 | Reject a recording below a configurable SNR threshold before upload, with a retry prompt | P1 |
| FR-11 | Enforce minimum (0.25 s) and maximum (15 s) duration | P1 | <br>Revised from 0.4 s: 8 of 80 synthetic single-word attempts were false-rejected as `AUDIO_TOO_SHORT`, since short words genuinely do not reach 0.4 s. See README "Known deviations and findings".

### Scoring endpoint (`server/`)

| ID | Requirement | Priority |
|---|---|---|
| FR-12 | `POST /api/v1/pronunciation` accepting multipart: `audio`, `referenceText`, `language`, `deviceContext` | P0 |
| FR-13 | Call Azure AI Speech with `PronunciationAssessmentConfig`, granularity `Phoneme`, miscue detection on | P0 |
| FR-14 | Return one normalized shape regardless of provider (see §6) | P0 |
| FR-15 | Parse per-word and per-phoneme detail from `JSON.parse(result.json).NBest[0]` | P0 |
| FR-16 | Return `indeterminate: true` with a reason when no usable result is produced | P0 |
| FR-17 | Record `modelVersion` and provider on every response | P0 |
| FR-18 | Persist an attempt record: device context, granted constraints, timings, scores | P0 |
| FR-19 | Validate content type, sample rate and duration; reject with a typed error | P1 |
| FR-20 | Keep the provider call in `server/services/azureSpeech.ts` behind an interface | P0 |

### UI (`src/speech/components/`, `src/pages/`)

| ID | Requirement | Priority |
|---|---|---|
| FR-21 | Drill screen: prompt text, record button, level meter, result | P0 |
| FR-22 | Result view: four overall scores, per-word chips coloured by accuracy | P0 |
| FR-23 | Tapping a word reveals its phonemes with individual scores | P0 |
| FR-24 | `indeterminate` renders as "couldn't get a clear read — try again", never a number | P0 |
| FR-25 | Debug panel (toggleable) showing granted constraints, context rate, duration | P0 |
| FR-26 | Fixture runner page: set ID, speaker label, batch record, export JSON | P0 |

---

## 6. Response contract

The one shape everything downstream depends on. Do not change it without updating this file.

```ts
type PronunciationResult =
  | { indeterminate: true; reason: string; provider: string; modelVersion?: string }
  | {
      indeterminate: false;
      provider: string;             // "azure"
      modelVersion?: string;
      recognized: string;           // what the scorer heard
      overall: number;              // 0–100
      accuracy: number;
      fluency: number;
      completeness: number;
      prosody?: number;             // not available for every language
      words: Array<{
        word: string;
        accuracy: number;
        errorType: "None" | "Omission" | "Insertion" | "Mispronunciation" | string;
        phonemes: Array<{ phoneme: string; accuracy: number }>;
      }>;
    };
```

**`prosody` is optional deliberately.** Its language coverage is narrower than the other
scores. Handle it missing; do not assume it is present.

---

## 7. Non-functional

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Time from tap to recording active | < 400 ms |
| NFR-02 | Time from upload to result rendered | < 2.5 s on a good network |
| NFR-03 | Works on the five target platforms in §3 S2 | All pass |
| NFR-04 | No credentials reachable from the client bundle | Verified by `npm run verify` |
| NFR-05 | Capture layer has zero React imports | Verified by `npm run verify` |

Targets, not measurements. Replace with real numbers once the POC runs.

---

## 8. Fixture mode

The reason the POC exists. A separate route, not part of the learner flow.

**Set A** — 40 target words pronounced *acceptably* by speakers with strong L1 accents.
Every recording must be independently confirmed acceptable by a fluent speaker; drop
anything ambiguous. **A contaminated Set A invalidates the entire experiment.**

**Set B** — the same words *deliberately mispronounced* by fluent speakers. Realistic learner
errors: substituted phonemes, wrong stress, dropped final consonants. Not comic
mispronunciation.

The runner records set ID, speaker label, reference text, device context, granted constraints
and the full result for each attempt, and exports JSON for analysis.

**The outcome that matters:** the gap between Set A's scores and Set B's scores. If they do
not separate, the scorer is not measuring pronunciation and nothing downstream is worth
building.

---

## 9. Environment

```
AZURE_SPEECH_KEY=          # server only, never client
AZURE_SPEECH_REGION=southeastasia
PRONUNCIATION_PROVIDER=azure
MAX_AUDIO_SECONDS=15
MIN_SNR_DB=10
```

Set in App Service → Configuration → Application settings. `.env.example` is committed;
`.env` is not.

---

## 10. Open questions

| # | Question | Needed by |
|---|---|---|
| OQ-1 | Does Azure support prosody scoring for our target languages? | Before FR-13 |
| OQ-2 | Does Azure bill a minimum duration per request? Short drills change the economics if so. | Before the fixture run |
| OQ-3 | Do iOS-captured recordings score differently from desktop for the same speaker? | This is what the fixture measures |
| ~~OQ-4~~ | ~~Is the moving-average resampler good enough, or does it need windowed-sinc?~~ Resolved: replaced with a windowed-sinc (polyphase, precomputed) kernel — `src/speech/capture/resample.ts`, verified in `scripts/resample-bench.ts` (10kHz-tone alias rejection ~1.0→0.01, passband gain ~1.0, 15s@48kHz resamples in ~30ms). | Done |
