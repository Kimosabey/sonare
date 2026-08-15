# CONTEXT.md

Background behind the constraints in `CLAUDE.md`. Read this before deciding any of them looks
excessive — several encode findings that took a week of analysis to establish.

---

## The product

**Lingotran** — a live language-learning web app. React frontend, Node backend, Azure App
Service (not containerised). Real users today. Learners are second-language speakers, most on
phones, many in classrooms.

The pronunciation feedback feature is **already shipped**. That's what makes this urgent
rather than exploratory.

## Why the current feature is suspect

The browser's Web Speech API returns a transcript and a confidence number. It returns **no
word timings and no phoneme data at all**. Any pronunciation score built on it is inferred
from whether the recognizer produced the expected word.

That means a learner with a strong Tamil or Telugu accent who pronounces a word acceptably
can be marked wrong, because the recognizer's accent bias failed to return it. And a learner
who mispronounces badly can be marked right, because the language model filled in the
expected word from context.

Neither is a pronunciation measurement. This is the reason for rule **R3**.

## The iOS constraint (why R4 and R5 exist)

iOS applies voice processing — automatic gain control, noise suppression, echo cancellation —
at the **audio session** level, which sits below the browser. Safari owns the audio session;
our page does not. `getUserMedia` constraints are a request the browser may decline, and iOS
may apply processing regardless.

We cannot disable this from a web app. A native app can, via `AVAudioSession` measurement
mode. That is the single genuine advantage native holds, and whether it matters is exactly
what the fixture measures.

**Why this matters for scoring:** gain control compresses level, which flattens syllable
stress. Noise suppression operates on spectrum, which is where phoneme identity lives. Both
plausibly degrade assessment — but this is **unmeasured**, and there are reasonable arguments
it may not matter much. Modern speech models are trained on processed phone audio precisely
because clean capture is unattainable at consumer scale.

So we record what was granted (**R5**) and let the fixture tell us.

## Why the reliability problems are separate

Users report speech "not working" on iPhone. Most of those reports are **Web Speech
failures, not microphone failures**:

- `SpeechRecognition` is unavailable in WKWebView, so every non-Safari iOS browser fails
- Safari's recognition times out after 30–60 seconds
- Apple applies an undocumented per-device request quota
- A system chime plays before every attempt

All four disappear when we move to `getUserMedia`. None require a native app. This is why
**R1** is absolute — leaving a Web Speech fallback in place would preserve the bugs we are
here to remove.

## Why batch, not streaming (R6)

Streaming reduces latency for *continuous* recognition — free dictation, conversation — where
partial results arrive mid-sentence.

Pronunciation assessment scores a **bounded utterance against a known reference text**. The
scorer cannot start until the learner finishes. Streaming adds a WebSocket, session state,
and reconnection handling while reducing nothing.

Keeping these paths separate also means the highest-value work needs no streaming
infrastructure at all.

## Why the vendor sits behind an interface (R12)

Azure is the starting choice because it is already our cloud: existing billing, existing data
processing agreement, region pinning, and no new sub-processor for compliance to review.

But **SpeechAce** is built specifically for second-language learners, where Azure is
general-purpose. A scorer trained mainly on L2 speakers plausibly penalises accent less —
which is precisely our failure mode. We will benchmark both on the fixture.

Swapping must therefore be a file change in `server/services/`, not a refactor.

## Why the capture layer is framework-free

A native POC in React Native may follow, depending on the fixture result. The capture logic —
constraint handling, resampling, WAV encoding, state machine — should port with minimal
change. Keeping React out of `src/speech/capture/` costs nothing now and saves rework later.

## What we already know, and how confidently

| Statement | Confidence |
|---|---|
| iOS processes microphone audio before our code sees it | Established |
| A web app cannot disable it | Established |
| Web Speech provides no phoneme data | Established |
| Recognition accent bias is identical on web and native | Established |
| Most current failures come from Web Speech, not the mic | Likely |
| Modern scorers tolerate processed consumer audio | Likely |
| **iOS processing meaningfully degrades our scores** | **Unknown — the fixture measures this** |
| **Our current feature misjudges accented learners** | **Suspected — the fixture measures this** |

The last two rows are the reason for the whole POC.

## What this POC is not deciding

Whether Lingotran should have a native app. That may well be right for retention, push
notifications, or store presence — real arguments, entirely separate from audio. This POC
only removes one bad reason for that decision.

## Prior artifacts

Produced during analysis, available from Harshan:

- `Lingotran-iOS-Platform-Analysis.pdf` — the full 7-page analysis
- `probe.html` — measures whether a device honours DSP-disable constraints
- `scorer-harness.html` — standalone capture-and-score page; **the reference implementation
  for FR-01 to FR-03 and FR-12 to FR-16**
- POC A and POC B plans, with work packages and gates

**Read `scorer-harness.html` before writing the capture code.** It already solves the
worklet, resampling and WAV encoding correctly, and its Node endpoint sample is the shape
`server/services/azureSpeech.ts` should take.
