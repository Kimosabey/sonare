# Handoff: Sonare — course platform, onboarding and microphone check

## Overview

Sonare teaches spoken pronunciation in French, Spanish, German, Hindi and Kannada. A
learner hears a native-quality model voice, says the phrase back, and is scored
**syllable by syllable** — not "60%", but which sound went wrong and what to try
instead. It is a web app and an installable PWA: iOS Safari, Android Chrome, desktop
browsers. No native shell.

This bundle covers the redesign that turns the existing pronunciation trainer into a
course, plus two things that did not exist before:

- **Onboarding and a microphone check.** Every activity needs a microphone and a
  measured 7.2% of real takes come back unusable — about one in fourteen, most of them
  the recording rather than the scoring service. Today a learner with a dead, muted or
  wrongly-routed microphone finds out *after* they have spoken. The check moves that
  discovery before the first activity and ends in a plain verdict.
- **A teacher view**, designed so that a per-pupil ranking is not constructible from
  what the teacher is given.

The product is **B2C learner-first**. The teacher view is a secondary surface on its
own address and must not appear in the learner's tab bar.

## About the design files

The files in `designs/` are **design references written as HTML** — prototypes showing
intended look and behaviour. They are **not production code to copy**. They are
"Design Components": a single `.dc.html` file each, with a small runtime (`support.js`)
that renders an inline-styled template. That format exists for design iteration, not
for shipping.

The task is to **recreate these designs inside the existing Sonare codebase** — React
18 + TypeScript + Vite, `react-router-dom` with `HashRouter`, plain CSS in
`src/styles/` — using its established patterns:

- Tokens live in `src/styles/tokens.css`. **Every value in this document is already a
  token there.** Use `var(--signal)`, not `#41009a`.
- Components live in `src/components/` and `src/speech/components/`. Several already
  exist in a form very close to what these designs show: `RecordButton`, `ScoreCard`,
  `ScoreCardSkeleton`, `WordChips`, `SyllableChips`, `PhonemeDetail`, `LevelMeter`,
  `LiveLevel`, `CaptureSettings`, `SessionSummary`, `ActivityReport`.
- Screens live in `src/pages/`: `Today`, `ActivityTest`, `Progress`, `Settings`,
  `LanguagePicker`, `Authoring`, `Diagnostics`, `FixtureRunner`.
- The capture layer under `src/speech/capture/` is framework-free by rule (no React
  imports, no browser-persistent storage) and the Azure SDK is only importable from
  `server/services/`. `npm run verify` fails the build on violations. **Do not
  reorganise those directories** — five rules are enforced by path, and moving a
  directory makes its check pass vacuously.

Read `docs/CONTEXT.md` in the repo before deciding any constraint here is arbitrary.

## Fidelity

**High fidelity.** Final colours, typography, spacing, states and copy, all drawn on
the shipped Lingotran token system. Recreate pixel-for-pixel using the existing
stylesheet's tokens and classes. The exception is illustration: there is none, and
none is required.

Copy in these designs is final and deliberate. Several lines exist to satisfy a hard
constraint (see below) — **do not paraphrase them** without checking which constraint
they carry.

---

## Hard constraints — read before implementing

Each is enforced somewhere in the repo by a test or build-time check, and most were
added after something went wrong. A screen that violates one is not shippable however
closely it matches the mock.

1. **No points, XP, hearts, lives, leagues or leaderboards.** Every one attaches a
   number to performance, and whether the scorer is fair across accents is
   **unmeasured**. The streak counts *attendance* and takes no score — guaranteed by
   `recordPractice`'s signature.
2. **No streak freezes, repair tokens or make-up days.** A lapsed learner is greeted by
   the gap and what survived it, never by a broken counter and an offer to buy it back.
3. **No hard gates.** After three *scored* attempts a learner moves on, marked
   `skipped`. A gate strands exactly the learner whose accent the scorer mishandles.
4. **An unusable recording is never a score.** `indeterminate` is visibly distinct from
   a low score, costs none of the three attempts, and is never celebrated. ~7.2% of
   takes. Design state, do not style as zero.
5. **No vendor vocabulary on screen.** No "Omission", no "Mispronunciation", no error
   codes, no confidence values. Provider wording stays behind `?debug=1`.
6. **Motion is decoration, never information.** A blanket
   `* { animation: none !important; transition: none !important }` runs under
   `prefers-reduced-motion` (test T13 keeps it blanket). Anything conveyed only by
   movement is invisible to the people that switch protects, so **every state change
   must read as a static difference too**. This is also why Lottie was rejected: a JS
   player is not reached by that CSS rule.
7. **Minimum target 44px, 48px where thumb-driven.** `--tap: 44px`, build-checked
   including the token itself.
8. **Nothing reachable by pointer alone.** Keyboard and screen reader reach everything.
9. **The goal is intelligibility, not native-likeness.** Check every label,
   celebration and progress metaphor against that. *Clearer* is the axis; *more native*
   is not.

---

## Screens

### 1. Onboarding — `designs/Sonare Onboarding.dc.html`

Sequence: hear it first → language → optional name → the microphone ask → the check →
first activity. **Demonstrate, then request**: today the app asks for a name, a
language and mic permission before showing any value.

| Id | Screen | Purpose |
|---|---|---|
| 1a | Hear it first | Play a phrase and show a real scored example, before any ask |
| 1b | Pick a language | Five languages, each rendered in its own script |
| 1c | Name | Optional, and the label says so; skip is a full-width button |
| 1d | The microphone ask | Explains the recording before the OS prompt fires |
| 1e–1l | The check, eight states | idle · listening · good · quiet · silent · denied · no hardware · insecure context |
| 1m | First activity | Carries the check's verdict forward |
| 1n–1p | The check at 430 / 768 / 1280 | |

**Layout (phone, 360×760):** column flex. Header row (48px controls, centred two-line
title) → optional step-pip row → content region (`flex:1; min-height:0`) → bottom dock
(`border-top: 1px solid var(--rule)`, `background: var(--surface)`, padding
`14px 16px 20px` plus `env(safe-area-inset-bottom)`).

**Step 4 (1d) is load-bearing, not decorative.** iOS gives exactly one permission
prompt; a denial cannot be re-asked from the page. The screen states four things
before the prompt:

1. Each take is recorded on this device and uploaded to be scored. Nothing is uploaded
   until you speak.
2. Takes are kept 90 days then deleted. Sound history — the numbers, not the audio — is
   never expired on a timer.
3. **When diagnostics are switched on by whoever runs this service, a copy of a
   recording can also be written to their disk. So we will not tell you nothing is ever
   stored.** An operator-enabled diagnostic path exists (`audio-debug/`), so "never
   stored" is not supportable. Keep this line true and checkable.
4. Export or erase everything from the You tab, with counts.

Plus a warn-tinted panel: "Your browser will ask once."

**The check (1e–1l).** Instruction is "say anything" — no phrase to get right, because
this is about the device. The meter is the only place live movement is information, so
the same box prints the static equivalents: `−16 dB`, `15 of 24 bars`, "Speech
detected", "2.9s". Verdict is plain language with the measurement beside it, plus a
collapsed **granted-vs-asked** record (`asked 16 kHz mono, plain` / `granted 48 kHz
mono, noise suppression on`) — kept because iOS routinely ignores constraints, and it
is the first thing support looks at.

Eight states, all real failure modes:

| State | Verdict tag | Key copy | Notes |
|---|---|---|---|
| Idle | — | "The bars move when the microphone hears something." | Device name + Change |
| Listening | — | "Keep going" / "Speech detected · 2.9s" | Static twins printed |
| Good | `GOOD` | "This device can be scored." | ~25 dB above room |
| Too quiet | `QUIET` | "We heard you, but only just." | Four fixes ordered by how often they work; **Carry on anyway** stays available |
| No signal | `SILENT` | "Nothing reached us at all. Not quiet — flat." | Splits **muted mic** from **wrong device**; device list inline |
| Denied | — | "The microphone was turned down" | iOS: four named Settings steps. Android: padlock → Permissions |
| No hardware | — | "This device has no microphone" | **Nobody's fault.** No instructions to undo something they did |
| Insecure context | — | "This address cannot use a microphone" | **Nobody's fault.** `getUserMedia` needs a secure context; a LAN IP has no microphone by design. Shows the http address and the https one to use |

Both no-fault states offer listening practice, which needs no microphone.

### 2. Session — `designs/Sonare Session.dc.html`

The sitting runs **over** the tabs as a modal flow with its own back affordance and
finish line. The record control sits in the lower third.

| Id | Screen |
|---|---|
| 1a | Prompt (idle) |
| 1b | Listening — level meter, silence countdown |
| 1c | Scoring — skeleton |
| 1d | Result A, numbers-led |
| 1e | Result B, phrase-led (alternative layout) |
| 1f | Indeterminate — `UNCLEAR` and `NO MATCH` |
| 1g | Microphone unavailable |
| 1h | Offline and capture error |
| 1i | `listen` activity |
| 1j | Corrective A — vowel chart |
| 1k | Corrective B — yours against the model |
| 1l | Record control B — mic disc, 430 |
| 1m–1o | `listen` at 430 / 768 / 1280 |
| 1p | `recall` — sees English, produces the target aloud |
| 1q | `read` — reads aloud, no model first |

**Prompt:** mono uppercase task label (`--text-xs`, `.08em`, `--dim`) → the phrase at
`clamp(26px, 6.5vw, 38px)`/700, `text-wrap: balance`, `lang` set to the target locale →
italic gloss → `<details>` "Why this phrase". Dock: tries-left line, then **Listen**
(tonal: `--signal-soft` fill, `--signal` border) and **Say it** (solid `--signal`) as
peers, Listen first because that is the order they are used in. "Can't speak right now"
below.

**Result, two layouts to choose between.** A (1d) leads with two figures — **sounds**
(accuracy, the one that decides) and **words said** (completeness) — then advice, then
word chips. B (1e) leads with the phrase itself, each syllable underlined by how it
landed, one figure beside a sentence of context. Both drop `overall` and `fluency` from
the learner view; both print no threshold.

**Word and syllable chips** are one vocabulary: `--surface` ground, 1px `--rule` border
with a 3px banded bottom rule (`--pass` / `--warn` / `--fail` at 80/60 via `band()`),
`--radius-lg`, `min-height: var(--tap)`. An **omitted** word shows `—` not `0`, and is
banded `lo` regardless of score — 0 out of 100 is a claim nothing measured. An
**inserted** word shows `+` and bands `mid`.

**Indeterminate (1f)** — the two variants are not interchangeable. Azure returns the
same shape for "no speech" and "speech that did not match the phrase"; the capture
layer's SNR is what distinguishes them, and telling a fluent speaker "couldn't get a
clear read" sent a debugging session hunting a microphone fault for hours. Free-retry
line leads: **"This one didn't count as an attempt."**

**Corrective detail (1j/1k)** — the differentiator. Syllable-level data already exists
in every result and is largely unused. 1j plots where the learner's vowel landed
against the target: a *measurement*, not a grade, honest even while fairness is
unmeasured, computable in the browser from audio already captured. 1k is the
lower-reading-cost alternative — two traces, yours and the model.

**`recall` (1p)** hides the target; the escape is a reveal that makes the take
unscored, not a Listen button that gives the answer away. **`read` (1q)** has **no
Listen button at all** — hearing it first would make it a `repeat`. The model unlocks
after the first take.

### 3. Course — `designs/Sonare Course.dc.html`

| Id | Screen |
|---|---|
| 1a | Today — daily returner, session shape stated before committing |
| 1b | Today — first run |
| 1c | Today — lapsed |
| 1d | Journey A — outcomes list with receipts |
| 1e | Journey B — the spine |
| 1f | Progress — sounds, attendance, coverage |
| 1g | Progress — "not enough history yet" |
| 1h | End of sitting |
| 1i | Journey · 768 |
| 1j | Progress · 1280 |

**Content spine is new:** `Language → Unit → Lesson → Activity`. Today it is
`Language → Activity[]` — a flat ten, no units, no lessons, and "next" is the next
array index.

**Two clocks, and conflating them is the classic mistake.** *Progression* walks the
content spine (new). *Review* is the existing `[1, 3, 7, 16, 35]`-day ladder on
**sounds** (built, and good). A sitting blends both — new content plus what is due —
and that blend is why it feels like a course rather than a playlist.

**Today** states the sitting's shape before the learner commits: "Four activities,
about five minutes", with each item tagged `NEW` or `DUE` and the days since. Three
attendance tiles (streak / this week / best run) with the line "Attendance only. None
of these three takes a score."

**Lapsed (1c)** names the gap first, then what survived it, dated: "**Three weeks
away** — your best sounds are still here: `on` at 88 · `é` at 84 *(measured before you
left)*". Streak zero reads "ready to start again" — the same fact stated forwards.
Nothing is credited, restored or sold back.

**Journey is never a locked path.** No padlocks anywhere; every lesson is openable. 1d
pairs each unit's can-do statement with its receipts (lessons done, which sounds at
which rung, how recently) — that pairing is what separates an outcome from a marketing
line. 1e is the lighter spine.

**Outcomes may only claim what is measured:** per-syllable pronunciation and
attendance. Not comprehension, vocabulary, grammar or fluency. The `listen` activity is
the first that would earn a comprehension claim.

**Progress** puts sounds first. "Not enough history yet" is a real state: `trendFor`
returns a null `before` until there is history either side of the window, and a dash
means *not enough history*, never "no change".

### 4. Platform — `designs/Sonare Platform.dc.html`

| Id | Screen |
|---|---|
| 1a–1d | Navigation at 360 / 430 / 768 / 1280 |
| 1e | Back behaviour, as a table |
| 1f | Splash composition + export cut + maskable icon |
| 1g | Splash handover + device-transfer code |
| 1h | Authoring · 1280 |
| 1i | Leave-sitting confirmation |
| 1j | You tab |
| 1k | Publish diff · 1280 |

**Four destinations, never five:** Today · Journey · Progress · You. Bottom tabs under
620px, side rail above, labelled sidebar with breadcrumbs on desktop. The session is
never a tab.

**Back behaviour:**

| Where | Behaviour |
|---|---|
| Tab root | No in-app back. Android system back closes the app; confirm first if a sitting is in progress |
| Inside a tab | Back chevron, top left, 44px, **always present** — an installed iOS PWA has no browser back |
| In a sitting | Back steps within; close asks keep-or-discard |
| Mid-take | Both disabled *visibly* |
| Desktop | Breadcrumbs; Esc leaves the sitting with the same confirmation |

Left edge keeps 20px clear of horizontal gestures (iOS edge-swipe back owns that strip).

**Device transfer (1g)** is a required MVP screen with no current home. `ensureLearnerId`
mints a fresh id per browser and there is **no transfer, pairing or recovery mechanism
anywhere in the codebase** — a learner who changes phone silently loses everything. A
code or QR shown on the old device and entered on the new one fixes it with no accounts
and no paid service.

**Publish diff (1k)** is built on how the pipeline already behaves: forward-only,
idempotent by refusal, and `GET /api/v1/content/:slug` returning 404 is the normal
answer with the client falling back to its bundle. So publishing never gates and never
reaches into a sitting in flight — a client keeps the version it resolved until the
sitting ends. The screen's job is the one irreversible case: removing an activity
learners have attempts against. That gets a typed confirmation; a diff with no removal
publishes in one click.

### 5. Teacher — `designs/Sonare Teacher.dc.html`

| Id | Screen |
|---|---|
| 1a | The contract — what a teacher will and will not see |
| 1b | Create a class + join code |
| 1c | Pupil side — the join decision |
| 1d | Class overview — group sound difficulty + attendance |
| 1e | Sound detail — group distribution, three buckets |
| 1f | Setting a sitting |
| 1g | Pupil list and one pupil |
| 1h | The limits, and the pupil-facing mirror |
| 1i | Teacher on a phone |

**The governing rule, and it is structural rather than a policy setting: no
pronunciation figure about an identified pupil exists in this view.** Consequently
there is no column to sort, no average to compute and no ranking to assemble. Group
difficulty is *a count of pupils still working on a sound*, not a mean of scores — so
it cannot be inverted back to anybody's number. The distribution in 1e is three named
buckets (JUST STARTED / GETTING THERE / HOLDING) and **no bar is clickable**, because a
drill-through would be a list of children at a level.

Do not add: a class average, a sort control, a pupil score, audio playback of a pupil,
or an admin switch that reveals any of them. The class view is not *given* the data.

Pupils join by choice with a code, see exactly the list the teacher was shown, can drop
their name without leaving, and can leave while keeping everything they learned. A set
sitting is a **suggestion on Today**, not a gate with a deadline.

### 6. Motion and responsive spec — `designs/Sonare Motion.dc.html`

Clickable five-step walkthrough with a **reduced-motion toggle**, so both renderings of
every state change can be seen side by side. This file is the spec; the tables in it
are the source of truth for the values below.

### 7. Splash — `designs/Sonare Splash.dc.html` + `assets/splash/`

Frames drawn at true resolution and exported. See `assets/splash/README.md` for the
manifest block and the `apple-touch-startup-image` link tags.

---

## Interactions & behaviour

**One curve, three durations.** `cubic-bezier(.4, 0, .2, 1)` = `var(--ease)`.

| Duration | Token | Used for | What remains under reduced motion |
|---|---|---|---|
| 150ms | `--dur-quick` | Taps, chips, word handover, hover tints | The colour or scale it lands on |
| 350ms | `--dur-standard` | Screen arrival: 12px + fade, one direction, **no exit** | The screen, already there |
| 500ms | `--dur-slow` | A pass, once; the brand rule drawing in | The banner and the rule |

Three loops only, each with a static twin in the same box: the live level meter, the
mic-is-open pulse (`rec-pulse`), the playing syllable ring (`sy-sound`).

- **No exit animation anywhere.** An exit must finish before the next screen starts,
  which doubles every tap.
- **Everything animates transform or opacity.** Nothing animates height, width or
  background-position — no frame costs a layout pass. The skeleton sweep is a
  transform on a pseudo-element, not a moving background.
- **Word highlight during playback** is driven by real per-character timings from the
  voice, not a guessed interval, and uses `box-shadow` for breathing room rather than
  padding (padding on an inline word shuffles the rest of the line).
- **The scoring skeleton is shaped like what arrives** and is never animated as though
  it were progress — nothing knows how far along the scorer is.
- **The celebrate pop (420ms)** is reserved for a first try or a personal best so it
  does not wear out on every pass.
- **Every tappable thing needs its own pressed state.**
  `-webkit-tap-highlight-color: transparent` is already set globally, so without one
  the control feels dead. The designs use `transform: scale(.97)` at 150ms.
- **Never rely on `:hover`.**

**Focus:** one treatment for every interactive role —
`outline: var(--focus-ring); outline-offset: var(--focus-offset)` on `:focus-visible`.
Programmatic focus targets are `tabIndex={-1}` and use plain `:focus` with a 4px offset
(`:focus-visible` generally does not fire when script moves focus). Focus moves on
arrival at a new activity and on an error appearing. The delete-my-record control is
the one place the ring recolours, to `--fail`.

**Responsive.** Fluid, not breakpoint-switched, except where a layout genuinely
changes:

| What | Value |
|---|---|
| Page padding | `clamp(20px, 2.6vw, 40px)` |
| Heading | `clamp(26px, 3.2vw, 38px)` |
| Body | `clamp(15px, 1.3vw, 16.5px)` |
| Meter height | `clamp(56px, 7vw, 104px)` |
| Columns | `flex-wrap` at a 280–300px basis — one column on a phone, two from ~700px, no media query |
| Figure cells | `repeat(auto-fit, minmax(120px, 1fr))` |
| Layout switch | Bottom tabs < 620px · rail 620–1023px · sidebar ≥ 1024px |

Two things deliberately **do not** scale: the **48px tap floor** (a minimum, not a
proportion) and the **16.5px input size** (the iOS zoom floor). A fluid scale that dips
under either breaks the product on the device that matters.

**iOS Safari:** any focusable input ≥16px or the page zooms on focus and the layout
breaks mid-session. `env(safe-area-inset-*)` for notch, Dynamic Island and home
indicator, resolved left and right separately (in landscape the notch is on one side).
`dvh`/`svh`, never `vh`. Audio and microphone need a real user gesture, and the call
into the capture layer must happen **synchronously** inside the handler.

**Android Chrome:** 48dp preferred for thumb-driven controls. System back must be
handled — mid-session it must not exit without asking. TalkBack is the screen reader to
test against. A light vibration tick on record start/stop is appropriate; iOS web has
no haptics, so nothing may depend on it.

**Offline:** everything works offline, sync is silent and never blocks, and no failure
is shown that a learner cannot act on. Held takes are listed as `HELD` with "Nothing is
lost, and your practice day is already credited."

## State management

Existing stores and hooks already cover most of this — extend rather than replace:
`levelStore`, `skillStore`, `streakStore`, `useRecorder`, `useProgressPersistence`,
`useModelSpeech`, `useSyllablePlayback`, `useCompareToModel`,
`useMicrophonePermission`, `useOnlineStatus`, `useWakeLock`, and
`learning/session.ts` + `learning/nextUp.ts`.

**Session phase** is derived from the recorder every render, never held in state:

```
requesting | ready | recording          -> "speaking"
processing | result !== null | error     -> "result"
otherwise                                -> "prompt"
```

A second settable copy of "where are we" is a copy that can disagree with the take in
flight.

**New state for the microphone check** — a per-session record, not persisted by the
capture layer (R11 forbids browser-persistent storage under `src/speech/`):

```
verdict:        "idle" | "listening" | "good" | "quiet" | "silent"
                | "denied" | "no-device" | "insecure"
voiceDb, roomDb, snrDb, bars, clipping, durationMs
askedConstraints, grantedSettings   // iOS ignores what was asked
deviceId, deviceLabel, availableDevices[]
```

`insecure` is decided from `window.isSecureContext` before any prompt; `no-device` from
an empty `enumerateDevices()` audioinput list; `denied` from the `getUserMedia`
rejection; `silent` vs `quiet` from the measured floor, and **muted vs wrong-device is
not distinguishable from the signal** — which is why that screen offers both causes
rather than guessing.

The verdict is carried into the first activity as one line. A `quiet` verdict changes
that line so an unclear first result is already half-explained.

## Design tokens

All of these exist in `src/styles/tokens.css`. Use the variables.

**Colour (light only; dark was built, measured and removed)**

| Token | Value | |
|---|---|---|
| `--signal` | `#41009a` | brand violet |
| `--signal-soft` / `--panel` | `#f0e6ff` | lilac |
| `--ink` | `#1a0b2e` | |
| `--ink-2` | `#443a52` | defined, deliberately unused |
| `--ground` | `#fcfbfe` | page; **must equal manifest `background_color`** |
| `--surface` | `#ffffff` | cards |
| `--rule` | `#dddddd` | |
| `--dim` | `#666666` | |
| `--pass` / `-soft` / `-line` | `#1b7a5a` / `#e7f3ee` / `#b4dbcb` | |
| `--warn` / `-soft` / `-fill` / `-line` | `#8a5200` / `#fcf3e3` / `#f7e8cb` / `#ead2a4` | `--warn` is a measured replacement for a value that failed AA |
| `--fail` / `-soft` / `-fill` / `-line` | `#c0273c` / `#fbe9ec` / `#f7d5da` / `#eec0c7` | |

**Type** — Nunito 400/600/700/800, plus Noto Sans Devanagari and (to add) Noto Sans
Kannada, matched per character via `unicode-range` so Latin stays on Nunito. Mono is
`ui-monospace, "SF Mono", Menlo, Consolas, monospace` for labels, figures and eyebrows.

`--text-2xs` 10.5 · `--text-xs` 11 · `--text-sm` 12.5 · `--text-base` 15 ·
`--text-md` 16.5 · `--text-lg` 23 · `--text-xl` 30. **16.5 is the floor for inputs.**

**Space** (4px base) — `--space-0` 2 · `1` 4 · `2` 6 · `3` 8 · `4` 12 · `5` 16 ·
`6` 24 · `7` 32 · `8` 48.

**Radius** — `xs` 3 · `sm` 4 · `md` 6 · `lg` 10 · `xl` 14 · `pill` 999.

**Elevation** — `--elev-1: 0 1px 3px rgb(22 32 43 / 30%)` ·
`--elev-2: 0 8px 28px rgb(22 32 43 / 18%)`.

**Other** — `--tap: 44px` (build-checked) · `--focus-ring: 2px solid var(--signal)` ·
`--focus-offset: 2px` · `--signal-rgb: 65 0 154` · `--fail-rgb: 192 39 60` ·
breakpoints 460 / 620.

Every language-bearing string carries `lang` on the element — WCAG 3.1.2, and for
Devanagari and Kannada an untagged string is **skipped** by a screen reader, not
mispronounced.

## Assets

| Asset | Where it came from |
|---|---|
| `designs/brand/wordmark-purple.png` | The repo's own `public/brand/wordmark-purple.png` |
| `designs/brand/icon.png` | The repo's own `public/brand/icon.png` |
| `assets/splash/apple-splash-*.png` | Exported from `Sonare Splash.dc.html` at true resolution — five iPhone sizes |
| `assets/splash/icon-maskable-512.png` | Art at 60% inside the 40% safe circle. **Declare `purpose: "maskable"` only for this file**; the existing 512 icon was not drawn for a circular crop |
| `assets/splash/icon-1024.png` | Android splash source icon |

No illustration assets exist. Where the designs would benefit from one — the first-run
screen, the empty Progress state — they use type and layout instead. **Lottie was
considered and rejected**: it is a JS player, so the blanket CSS reduced-motion rule
does not reach it, and adding one means a second parallel mechanism for a guarantee
currently held in a single line.

Icons in the mocks are placeholder glyphs. Use whatever icon set the codebase settles
on; nothing in these designs depends on a specific one.

## Files

```
design_handoff_sonare_course/
├── README.md                          this document
├── designs/
│   ├── Sonare Onboarding.dc.html      onboarding + the eight check states
│   ├── Sonare Session.dc.html         the sitting, every state, all five activity types
│   ├── Sonare Course.dc.html          Today, Journey, Progress
│   ├── Sonare Platform.dc.html        navigation, splash, authoring, You, publish diff
│   ├── Sonare Teacher.dc.html         the teacher view, end to end
│   ├── Sonare Motion.dc.html          clickable motion + responsive spec
│   ├── Sonare Splash.dc.html          splash frames at true resolution
│   ├── support.js                     the Design Component runtime (not for shipping)
│   └── brand/                         wordmark + icon, from the repo
└── assets/splash/                     exported PNGs + manifest README
```

Open any `.dc.html` directly in a browser. Each is a board of labelled screens with an
id badge (`1a`, `1b`, …) — those ids are what the design conversation refers to, so
they are the right way to cite a screen in a PR or an issue.
