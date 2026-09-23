# CLAUDE.md

Rules for working in this repository. Read `CONTEXT.md` before writing code — several
constraints here look arbitrary and are not.

## What this is

A proof of concept for Lingotran's pronunciation feedback. It replaces the browser's Web
Speech API with our own audio capture pipeline, and replaces transcript-match scoring with
real phoneme-level assessment from Azure AI Speech.

**Stack:** React + TypeScript (existing Lingotran app) · Node/Express backend · Azure App
Service · Azure AI Speech.

## Hard rules

These are not preferences. Breaking any of them invalidates the POC.

| # | Rule | Why |
|---|---|---|
| **R1** | **Never reference `SpeechRecognition` or `webkitSpeechRecognition`.** Not in comments, not behind a flag, not as a fallback. | It is what we are replacing. It gives no phoneme data. |
| **R2** | **Azure keys live only in server environment variables.** Never in client code, never in a response body, never in a log line. | A key in the bundle is a key in every user's devtools. |
| **R3** | **Never derive a pronunciation score from recognition confidence or from transcript match.** | That is the current bug. Confidence answers "did I hear you," not "did you say it right." |
| **R4** | **Capture with `echoCancellation`, `autoGainControl` and `noiseSuppression` all `false`.** | Browser DSP removes the spectral detail phoneme scoring reads. |
| **R5** | **Record what the browser actually granted** via `track.getSettings()` on every session. | iOS often ignores the request. We need per-recording evidence, not assumptions. |
| **R6** | **Batch upload. No WebSocket, no streaming.** | Scoring needs the complete utterance against a reference text. Streaming reduces nothing here. |
| **R7** | **Audio sent as 16 kHz mono 16-bit PCM WAV.** | Azure's prescribed format, and it makes web and native captures byte-comparable. |
| **R8** | **When the scorer returns nothing usable, return `indeterminate: true`** — never a fabricated number. | "I couldn't get a clear read" is more trustworthy than a confident wrong score. |
| **R9** | **Per-phoneme detail comes from `JSON.parse(result.json).NBest[0]`,** not the typed `PronunciationAssessmentResult`. | The typed object only carries the four top-level scores. |
| **R10** | **`start()` must be called from a user gesture.** | iOS requires it. Document the constraint; do not try to work around it. |
| **R11** | **No `localStorage` or `sessionStorage` for capture state.** In-memory React state only. | Session state should not survive a reload; stale audio config causes confusing bugs. |
| **R12** | **Keep the scoring vendor behind `server/services/` and one response type.** | We will benchmark SpeechAce against Azure. Swapping must be a file change, not a refactor. |

## Code conventions

- TypeScript strict. No `any` in `src/speech/` or `server/services/`.
- Errors are typed objects with a `code` and a `domain` (`client` | `network` | `server` | `provider` | `model`), never bare strings. Failure attribution depends on this.
- The capture layer is framework-free — plain Web Audio in `src/speech/capture/`, with one thin React hook on top. It has to be portable to React Native later.
- No new dependencies without asking. The capture path needs none.
- Comments explain *why*, not *what*.

## Verification before declaring anything done

Run these. Do not report success without them.

```bash
npm run typecheck        # must pass with zero errors
npm run lint             # must pass
npm run verify           # custom checks — see scripts/verify.mjs
npm test                 # the suite
npm run build            # a type error can hide until the build resolves it
```

**All five**, and read each **by exit code**. Piping to `grep -c` exits zero
when it finds errors and has let a broken typecheck through; so has chaining a
commit after an `echo` rather than after the gate. This list said three for a
long time, which meant the suite was not a gate at all for anybody following
it.

`npm run verify` fails the build on fourteen rules, not the four this section
used to name. They are grouped in `scripts/verify.mjs` under headings, and
`scripts/verify-rules.test.ts` fails if one is added there without appearing
here — a list of "everything" that is maintained by hand goes wrong, and this
one had:

- **R1** — the API we exist to remove
- **R3** — the scoring bug
- **R2 / NFR-04** — credentials
- **R11** — capture state must not survive a reload
- **Portability** — the capture layer ports to React Native
- **R12** — one vendor, one file
- **T12** — every band the code can return has a style
- **rate limiting** — trust exactly one proxy hop
- **NFR-03** — nothing interactive below the tap floor
- **T13** — reduced motion stays a blanket, not a list
- **T14** — no source file is invisible to git
- **T16** — the constraint the product is sold on
- **T17** — nothing watches a child
- **T15** — the provider's worst case fits inside the client's deadline

The browser suite (`npm run test:browser`) is deliberately not one of the five
— four thousand jsdom tests run in thirty seconds and making each wait on a
browser launch stops people running them — so it needs a person before a
release. See `docs/RELEASE.md`.

Then the manual check, which no script can do:

1. `npm run dev`, open on a desktop browser, record a known-good phrase, confirm phoneme scores render
2. Open on an actual iPhone over HTTPS, repeat
3. Confirm the granted-constraints panel shows what iOS reported

## What not to build

Streaming recognition. Free-speech dictation. Multi-provider routing. Auth (the app has it).
Offline scoring. Production UI polish. Anything in the Cochlea design set that is not in `PRD.md`.

If a task seems to need one of these, stop and ask — it usually means the requirement was
misread.

## When you are unsure

Ask rather than guess, particularly about: Azure response shape, audio format requirements,
and whether a behaviour on iOS is a bug or a platform property. Getting these wrong silently
produces a POC that measures the wrong thing.
