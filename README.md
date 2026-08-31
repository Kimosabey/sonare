# Sonare — Lingotran French speech activity

Phoneme-level French pronunciation practice: ten activities, unlocked one at a
time, ending in a report. Built on Azure AI Speech phoneme scoring instead of
the Web Speech API's transcript-match approach (no phoneme data, and biased
against accented speech — see `files/CONTEXT.md`).

Started as a scoring POC; the research question it existed to answer is
settled (see "Verification evidence" below), and this repo is now the MVP
product surface. `files/CONTEXT.md`, `CLAUDE.md`, `PRD.md`, `TASKS.md`,
`HANDOFF.md` are the historical record of the hard rules (R1–R12) the capture
pipeline still follows — read `CONTEXT.md` first if a constraint looks
arbitrary.

## Setup

```bash
cp .env.example .env     # fill AZURE_SPEECH_KEY; region is southeastasia
npm install
```

Needs a MongoDB instance reachable at `MONGO_URL` (defaults to
`mongodb://localhost:27017`) — attempt records and capture/scoring
diagnostics are persisted there (`attempts` and `diagnostics` collections).
A connection failure is logged, not fatal: scoring itself doesn't depend on
it, only the analysis trail does.

## Run

```bash
npm run dev:server        # API on :5181
npm run dev:client        # web on :5180, separate terminal
```

(`npm run dev` — both at once via `scripts/dev.mjs` — spawns `npx` without a
shell and fails with `ENOENT` on Windows; run the two above instead there.)

Ports are deliberately off the usual 3000/5173/8080 to avoid collisions. Vite
proxies `/api` to the API, so the browser only ever talks to one origin.

Single view, no routing — <http://localhost:5180/>. For real iOS testing,
`getUserMedia` needs a secure context (`localhost` is exempt, a LAN address is
not); `vite.config.ts` already allows `ngrok`/Cloudflare tunnel hosts, so
`ngrok http 5180` and opening the HTTPS URL on-device works out of the box.

### Microphone settings

Three independent toggles on every recording screen. **Auto-stop + Interim** is
the default.

| Toggle | What it does |
|---|---|
| **Continuous listening** | Session stays open across utterances until you end it. Still batch per utterance (R6) — each segment uploads as a complete WAV. |
| **Auto-stop** | Ends the take on trailing silence. Window scales with prompt length × a Quick/Normal/Patient setting, and is shown in seconds so it is not a guess. |
| **Interim results** | Live capture feedback while speaking — level, speech detection, elapsed time, silence countdown. **Not transcription** (see below). |

Continuous × Auto-stop are genuinely independent; all four combinations mean
something different:

```
continuous + autoStop   session open, segments on each silence, scores each
continuous only         one long take until you end the session
autoStop only           one utterance, ends itself             (default)
neither                 tap to start, tap to stop
```

**Interim results is deliberately not transcription.** Partial hypotheses
require streaming recognition over a WebSocket, which R6 forbids and PRD §4
lists as out of scope. Rather than break that — or fake a plausible-looking
live transcript — the toggle shows what can be derived locally from audio we
already hold. That covers what a partial transcript is usually wanted for:
proof the microphone is hearing you, and warning the take is about to end.
Decision confirmed with Harshan on 15 Aug 2026.

The microphone is held open between takes so the next Start records instantly;
it auto-releases after 45 s idle.

### French Activity Test

Ten activities unlock one at a time, ending in a report covering score, per
activity breakdown, word-level mistakes, weak sounds and areas to improve.

Pass at 60. After three *scored* attempts the learner may move on with the
activity marked `skipped` — a hard gate would strand anyone whose accent the
scorer mishandles, which is the failure this POC exists to detect, not inflict.
An indeterminate attempt does not burn a try.

Test the whole flow without a microphone:

```bash
npm run test:french
```

It runs all ten activities twice — once with a French TTS voice, once with an
English voice reading the same French — and imports the real `buildReport()`,
so the numbers it prints are the numbers the UI renders.

### On a real iPhone

`getUserMedia` needs a secure context. `localhost` is exempt; a LAN address is
not, so plain `http://192.168.x.x:5180` will not open the microphone. Put an
HTTPS tunnel in front of the Vite port, or serve the built output over TLS.

## Verify

```bash
npm run typecheck
npm run lint
npm run verify           # the rule checks — see scripts/verify.mjs
```

`npm run verify` fails the build on: any `SpeechRecognition` identifier in
`src/` or `server/` (R1); a confidence-derived score (R3); `AZURE_SPEECH_KEY`
outside `server/`, `scripts/` and `.env.example` (R2); client code reading a
`process.env` value containing `KEY`/`SECRET`; a hard-coded credential literal;
browser-persistent storage in `src/speech/` (R11); a React import inside
`src/speech/capture/` (NFR-05); the Azure SDK imported outside
`server/services/` (R12).

## Scripts

| Command | Purpose |
|---|---|
| `npm run smoke <wav> "<text>" [lang]` | Call Azure directly, no app code. Validates the WAV header first — useful after rotating `AZURE_SPEECH_KEY`. |
| `npm run verify` | The rule checks. |
| `npm run test:french` | Headless regression test for the activity flow (see above). |

`smoke` needs no browser.

## Layout

```
src/speech/capture/     framework-free capture — ports to React Native, zero React
src/speech/react/       useRecorder.ts, the only React file under src/speech/
src/speech/scoring/     upload client + the PRD §6 response type
src/speech/components/  score card, word chips, phoneme detail, debug panel
src/activities/         the activity set, progress types, report aggregation
src/pages/              FrenchActivityTest — the whole app
server/services/        ScoringProvider interface + azureSpeech.ts (only SDK importer)
server/routes/          POST /api/v1/pronunciation
scripts/                smoke, verify, dev, test:french
```

## Known deviations and findings

- **`AZURE_SPEECH_KEY` is permitted in `scripts/`.** HANDOFF specifies `server/`
  and `.env.example` only, which would fail the smoke script that T1 mandates.
  `scripts/` runs on a developer machine and is never bundled, so NFR-04 (no
  credentials reachable from the client) still holds.
- **Azure does not report silence as `NoMatch`.** It returns `RecognizedSpeech`
  with `PronScore: 0`, `Display: "."`, and every word `Omission` with no
  phonemes. Taken at face value that is a fabricated 0. `azureSpeech.ts` treats
  all-words-omitted-with-no-phonemes as `indeterminate` (R8).
- **No prosody for `en-US`.** Azure returned no `ProsodyScore`. PRD §6 was right
  to make it optional; coverage for other languages is unconfirmed (OQ-1).
- **The resampler is the harness's moving-average filter.** Adequate-looking so
  far, but PRD OQ-4 tracks whether it needs a windowed-sinc kernel. Revisit if
  fixture scores come back uniformly low.
- **Blob Storage is not used.** It appears in no PRD requirement and nothing in
  the scoring path needs it.
- **Azure returns unlabeled phonemes for `fr-FR`.** Segments come back with real
  `AccuracyScore`, `Offset` and `Duration`, but `Phoneme` is an empty string —
  under the default alphabet, `IPA` and `SAPI` alike. FR-23 therefore degrades
  for non-English: sounds are numbered in order rather than named, and the
  report's per-sound advice is suppressed instead of collapsing every French
  sound into one blank bucket. **Worth confirming per target language before
  committing to the phoneme UI for anything but English.**
- **Single words routinely fall below FR-11's 0.4 s floor.** 8 of 80 synthetic
  single-word attempts were rejected as `AUDIO_TOO_SHORT`. PRD §8 specifies "40
  target words", which is in direct tension with a 0.4 s minimum — short words
  simply are not that long. Either the fixture uses short phrases or the floor
  drops to about 0.25 s.
- **Single words separate poorly.** Across 8 word pairs, median Set A − Set B
  gap was **0.5** (only `world`, at 22, separated strongly; `very` and `clothes`
  did not separate at all). The same scorer separated a French sentence set by
  **37.6**. This suggests the phrase-level fixture is far more discriminating
  than a word-level one — see `RESULTS.md` guidance in TASKS.md T19 before
  committing 80 human recordings to single words.

## Verification evidence

| What | Result |
|---|---|
| T1 smoke, live Azure | phoneme scores returned, 1442 ms |
| T3 endpoint via `curl -F` | normalized PRD §6 shape |
| Silence | `indeterminate`, never a number |
| 48 kHz stereo | typed `BAD_AUDIO_FORMAT` |
| Credential in logs / bundle / tree | none — `.env` only |
| French activity test, 20 scored attempts | native 92 vs learner 55, gap **37.6** |
| Synthetic word fixture, 72 scored attempts | gap 0.5 — see finding above |
