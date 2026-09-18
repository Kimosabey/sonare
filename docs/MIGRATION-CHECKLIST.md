# Migration checklist — marked

Answers to `MIGRATION-CHECKLIST.md` from the design handoff, against
`redesign/course-platform`. Every **done** names the file it lives in.

Three marks are used, plus one the handoff did not offer and that this audit
needed:

- **done** — built, reachable, and tested.
- **partial** — built, with what is missing stated.

Seven items were **partial only because nothing exercised 430, 768 or 1280**.
`e2e-browser/widths.spec.ts` does now, on three engines — and found a
`<select>` laying out at 28px on mobile WebKit, which neither `verify.mjs` nor
jsdom could see.
- **not started**.
- **⚠ built, not reachable** — the code and its tests exist, and nothing
  renders it. It counts as not delivered. This audit found one such item (2-1j,
  the vowel chart), which is now wired; `src/components/reachable.test.ts`
  fails the build on the next one, because a component nobody imports breaks
  no other test.

---

## 1 · Onboarding — `Sonare Onboarding.dc.html`

| | Item | Mark | Where |
|---|---|---|---|
| 1a | Hear it first | **done** | `src/pages/Onboarding.tsx` |
| 1b | Language picker, `lang` per option | **partial** | `src/pages/Onboarding.tsx` — `lang={language.code}` per option, own script per language. **Two languages, not five**: `LANGUAGES = [FRENCH, SPANISH]` per your 2026-09 scoping. `AUTHORED_SETS` holds four. |
| 1c | Name optional, skip full-width | **done** | `src/pages/Onboarding.tsx` |
| 1d | Microphone ask, incl. diagnostics line | **done** | `src/pages/Onboarding.tsx` |
| 1e | Check · idle | **done** | `src/pages/MicCheck.tsx` |
| 1f | Check · listening, static twins | **done** | `src/pages/MicCheck.tsx` — dB, bar count, speech-detected, elapsed all printed as text beside the meter |
| 1g | Check · good, granted-vs-asked | **done** | `src/pages/MicCheck.tsx` |
| 1h | Check · too quiet, carry on anyway | **done** | `src/pages/MicCheck.tsx` — four fixes in order; clipping and non-clipping are separate copy |
| 1i | Check · no signal | **done** | `src/pages/MicCheck.tsx` |
| 1j | Check · permission denied | **done** | `src/pages/MicCheck.tsx` |
| 1k | Check · no hardware | **done** | `src/pages/MicCheck.tsx` |
| 1l | Check · insecure context | **done** | `src/pages/MicCheck.tsx` |
| 1m | First activity carries the verdict | **done** | `src/pages/ActivityTest.tsx` |
| 1n | Check · 430 | **done** | `e2e-browser/widths.spec.ts` — no sideways scroll, every control over the floor, checked at 430 on three engines |
| 1o | Check · 768 | **done** | `e2e-browser/widths.spec.ts` — no sideways scroll, every control over the floor, at 768 |
| 1p | Check · 1280, device picker promoted | **done** | `src/styles/activity.css:790` — real control from 1100px up, which covers 1280 |

## 2 · Session — `Sonare Session.dc.html`

| | Item | Mark | Where |
|---|---|---|---|
| 1a | Prompt, dock in lower third | **done** | `src/pages/ActivityTest.tsx` |
| 1b | Listening, meter + countdown in words | **done** | `src/components/InterimFeedback.tsx`, `src/speech/components/LevelMeter.tsx` |
| 1c | Scoring skeleton | **done** | `src/styles/report.css` — pseudo-element transform sweep |
| 1d | Result A, numbers-led | **done** — **this is the one built** | `src/speech/components/ScoreCard.tsx`. Accuracy leads because `ActivityTest` gates on it (`passed = best >= PASS_SCORE`); a phrase-led card would bury the number the pass is computed from. 1e not built. |
| 1e | Result B, phrase-led | **not started** | deliberately — see 1d |
| 1f | Indeterminate, `UNCLEAR` **and** `NO MATCH` | **done** | `src/speech/components/ScoreCard.tsx` — distinct variants |
| 1g | Mic unavailable as a screen | **done** | `src/components/MicUnavailable.tsx` |
| 1h | Offline held takes + capture error | **done** | `src/pages/ActivityTest.tsx` |
| 1i | `listen` activity | **done** | `src/components/ListenOptions.tsx` |
| 1j | Corrective · vowel chart | **done** — *was unreachable, now wired* | `src/components/VowelChart.tsx`, `src/speech/capture/formants.ts`, joined by `src/hooks/useVowelEstimate.ts`. Shown from the same syllable tap as 1k. `target` is null — no content names the vowel a syllable aims at, and the chart draws against its landmarks without one. |
| 1k | Corrective · yours against the model | **done** | `src/pages/ActivityTest.tsx` |
| 1l | Record control B, 430 | **not started** | stated as an alternative; control A shipped |
| 1m | `listen` · 430 | **done** | `e2e-browser/widths.spec.ts` — no sideways scroll, every control over the floor, at 430 |
| 1n | `listen` · 768 | **done** | at 768 |
| 1o | `listen` · 1280 | **done** | at 1280 |
| 1p | `recall`, reveal makes take unscored | **done** | `src/pages/ActivityTest.tsx` |
| 1q | `read`, no Listen button | **done** | `src/pages/ActivityTest.tsx` — model unlocks after the first take |

## 3 · Course — `Sonare Course.dc.html`

| | Item | Mark | Where |
|---|---|---|---|
| 1a | Today · daily returner, NEW/DUE | **done** | `src/components/TodaysSitting.tsx` |
| 1b | Today · first run | **done** | `src/pages/Today.tsx` |
| 1c | Today · lapsed | **done** | `src/pages/Today.tsx` |
| 1d | Journey A · outcomes + receipts | **done** — **this is the one built** | `src/pages/Journey.tsx` |
| 1e | Journey B · the spine | **not started** | deliberately — see 1d |
| 1f | Progress · sounds, attendance, coverage | **done** | `src/pages/Progress.tsx` — `calendarRows()` is the attendance strip |
| 1g | Progress · not enough history | **done** | `src/pages/Progress.tsx` |
| 1h | End of sitting, what moved | **done** | `src/components/SessionSummary.tsx` |
| 1i | Journey · 768 | **done** | `e2e-browser/widths.spec.ts` — no sideways scroll, every control over the floor, at 768 |
| 1j | Progress · 1280 with Due column | **done** | Due column present; layout checked at 1280 |

## 4 · Platform — `Sonare Platform.dc.html`

| | Item | Mark | Where |
|---|---|---|---|
| 1a | Nav · 360 bottom tabs + inset | **done** | `src/components/Navigation.tsx` |
| 1b | Nav · 430 + session over tabs | **done** | `src/styles/components/navigation.css` |
| 1c | Nav · 768 rail | **done** | `src/styles/components/navigation.css` |
| 1d | Nav · 1280 sidebar + breadcrumbs | **done** | `src/styles/base.css` (breadcrumbs), `navigation.css` |
| 1e | Back behaviour, all five rows | **done** | `src/App.tsx`, `src/components/BackLink.tsx` |
| 1f | Splash, five sizes, maskable icon | **done** | `index.html` (5 links), `public/splash/`, `public/manifest.webmanifest` |
| 1g | Post-splash handover + transfer code | **done** | `src/components/DeviceLink.tsx` |
| 1h | Authoring · 1280 | **done** | `src/pages/Authoring.tsx`, `src/components/ActivityOverview.tsx`, `src/styles/authoring.css`. Two columns from 1100px — spine left, edited activity right, spine first in the DOM too. Status line carries language, published version and a **counted** unsaved-changes figure (from `diffContent`, the same differ the publish panel uses). "Sounds targeted" is a table column that distinguishes three states: an activity that scores none by design (`listen` and `locate`, neither of which opens the microphone), an activity that scores sounds and has none, and the targets themselves. |
| 1i | Leave-sitting confirmation | **done** | `src/components/LeaveSittingDialog.tsx` — focus on the safe option, no third destructive choice |
| 1j | You tab, export/transfer/re-check/erase | **done** | `src/pages/Settings.tsx` |
| 1k | Publish diff, typed confirm only on removal | **done** | `src/components/PublishDiff.tsx`, `src/content/diff.ts` |

## 5 · Teacher — `Sonare Teacher.dc.html`

All ten built. The board answered its own identity question — "a join code
rather than a roster upload … never a list a teacher types in about children" —
so none of it needed a decision.

| | Item | Mark | Where |
|---|---|---|---|
| 1a | The contract, will / will not see | **done** | `src/components/ClassLimits.tsx`, `src/teacher/promise.ts` |
| 1b | Create class + join code | **done** | `src/components/CreateClass.tsx`, `server/store/classes.ts` |
| 1c | Pupil join decision · 360 | **done** | `src/components/JoinClass.tsx`, `JoinClassFlow.tsx`, `src/sync/classLink.ts` |
| 1d | Class overview · 1280 | **done** | `src/components/ClassOverview.tsx`, `server/domain/classSummary.ts` |
| 1e | Sound detail · 1280 | **done** | `src/components/SoundDetail.tsx` |
| 1f | Set a sitting | **done** | `src/components/SetSitting.tsx`, `SuggestedSitting.tsx` — persisted, and it reaches the pupil's Today |
| 1g | Pupil list + one pupil | **done** | `src/components/PupilList.tsx`, `PupilDetail.tsx`, `server/domain/classRoster.ts` |
| 1h | Limits page + pupil mirror | **done** | `ClassLimits.tsx` (teacher), `MyClass.tsx` + `ClassPromise.tsx` (pupil) |
| 1i | Teacher on a phone | **done** | `src/components/ClassGlance.tsx` |
| — | Not reachable from the learner's tabs | **done** | `/teacher` is typed-URL only, token-gated, linked from nowhere |

**Three things the boards disagreed about, resolved rather than copied:**

- **1g shows a teacher which sounds each pupil is working on; 1c never told the
  pupil.** The board's rule is that neither side is told a different story, so
  the promise now says it, in both voices.
- **A count "cannot be turned back into anybody's number"** is true of the
  28-pupil class the board draws and false of a small one. Counts are withheld
  below five joined pupils.
- **1e's three buckets and 1d's "22 of 28"** only reconcile if "still working"
  is the first two buckets together. The board's own arithmetic settled the
  data model.

## 6 · Motion & responsive — `Sonare Motion.dc.html`

| Item | Mark | Where |
|---|---|---|
| One curve, three durations | **done** | `src/styles/tokens.css:210-213` — `--ease` + 150/350/500, 34 uses |
| Screen arrival 12px + fade, no exit | **done** | `src/styles/base.css` — `rise-in`, `screen-in` |
| Stagger 50ms between siblings | **done** | `src/styles/base.css` — `.enter-1..n` |
| Only three loops | **done** | The three named ones run on learner sheets: `meter-hot-pulse`, `rec-pulse`, `sy-sound`. Two others are sanctioned rather than drift — the skeleton sweep, which the spec names on its own line, and a poll pulse on `/diagnostics`, an internal screen no learner reaches. `compositing.test.ts` holds it as an **allowlist**, because a count passes when one loop is swapped for another and the question is never how many but which. |
| Every animation transform or opacity | **done** — *was broken, now enforced* | Three fills transitioned `width`, worst of them the silence countdown running ~10Hz with the mic open. Now `scaleX`; `src/styles/compositing.test.ts` fails any transition or keyframe touching a layout property. |
| Word highlight box-shadow, not padding | **done** | `src/styles/components/chip.css` |
| Skeleton sweep is a pseudo-element transform | **done** | `src/styles/report.css:104` |
| Celebrate pop for first try / personal best | **done** | `src/styles/report.css:321` |
| Pressed state per control, tap highlight off | **done** | `src/styles/tokens.css:311`, `:active` in `base.css` |
| Nothing depends on `:hover` | **done** | 6 `:hover` rules, all decoration; every interactive element gets a focus ring from `base.css:533` |
| `clamp()` padding and type per spec table | **done** | Page padding is the board's own `clamp(20px, 2.6vw, 40px)`, inside the `max()` that keeps the notch handled — it was a flat 20px, so a 1280px desk sat in a phone's gutter. Type: board 1i's sizes are token-built clamps; `.phrase` uses the spec's own 26/38 bounds with a steeper middle term, and both older clamps are now listed with reasons in `scale.test.ts`, which could see no clamp at all before. |
| 48px tap floor, 16.5px input, do not scale | **done** | `--text-md: 16.5px` exact. The two numbers were never in conflict — one token was doing both jobs. `--tap` is 44 (the floor NFR-03 measures) and `--tap-thumb` is 48 (buttons, mode switches, the syllable chip). `src/styles/tap.test.ts` holds that the thumb size is at least the floor, and found five hard-coded `44px` literals the token had never reached. |
| Layout switch at 620 / 1024 | **done** | Both exact. Was 1100 — the reasoning for it argued for *one* set of thresholds, not for that number, so every sheet moved to the board's 1024 together. An iPad in landscape is exactly 1024 and used to get the rail where the board draws a sidebar. `tap.test.ts` refuses a third threshold; the card grid that had its own at 460 wraps by basis now, which is what the table asks for. |

## 7 · Splash — `assets/splash/`

| Item | Mark | Where |
|---|---|---|
| Five startup-image links + media queries | **done** | `index.html` |
| `background_color` = `--ground`; `theme_color` | **done** | `public/manifest.webmanifest:11-12` — `#41009a` / `#fcfbfe` |
| `maskable` only on `icon-maskable-512.png` | **done** | `public/manifest.webmanifest:24`; `scripts/pwa-manifest.test.ts` holds it both ways |
| First screen paints content, not a spinner | **done** | `src/App.tsx` `RouteFallback` |

**Closed from our side.** All seven were RGBA with every pixel opaque. They are
alpha-free RGB now — 1.09 MiB → 594 KiB, 46.9% off, not one pixel changed,
verified against an independent decoder. The claim that this needed the design
side was wrong: Node ships zlib, so `scripts/strip-png-alpha.mjs` adds no
dependency, and `scripts/png-encoding.test.ts` fails if the channel comes
back.

## Constraints

| Constraint | Mark |
|---|---|
| No points, XP, hearts, lives, leagues, leaderboards | **partly** — held by `src/pages/Today.test.tsx` on the return screen only. This row used to claim a `scripts/verify.mjs` rule; there is none, and a repo-wide gate is the thing that would make the constraint structural rather than observed. |
| Streak counts attendance only, no score | **done** |
| No freezes, repair tokens, make-up days | **done** |
| No hard gates — three attempts then `skipped` | **done** |
| `indeterminate` distinct, costs no attempt, never celebrated | **done** — R8, `ActivityTest.test.tsx` |
| No vendor vocabulary or error codes on screen | **done** — `verify.mjs` R12 |
| `prefers-reduced-motion` blanket | **done** — `src/styles/motion.css` |
| 44px minimum, 48px thumb-driven | **done** to the repo's rule; see the 48px row above |
| Nothing pointer-only, focus ring everywhere | **done** — `src/styles/focus.test.ts` |
| `lang` on every language-bearing string | **done** |
| Constraint-carrying copy unparaphrased | **done** |
| All values `var(--*)`, no hex | **done** — `src/styles/scale.test.ts` census |
| `npm run verify` passes; `src/speech/` not reorganised | **done** — all five gates green |

---

## Answers to your five questions

**1 · Which Result layout, which corrective?**
Result **1d, numbers-led**. `ActivityTest` computes the pass from accuracy, so a
phrase-led card would bury the number the verdict is made of. Journey **1d**
(outcomes + receipts) for the same reason — the receipts are the evidence the
outcome rests on.
Corrective: **both**, and they share one gesture. Tapping a syllable plays
your take against the model (1k) and places that syllable's vowel on the chart
(1j). 1j had been built and left unimported — the audit found it, and
`reachable.test.ts` now fails the build if it happens again.

**2 · Did any screen need a token that does not exist?**
No new colour or type token. The only additions were structural classes in
`src/styles/authoring.css`. Everything resolves through `tokens.css`, which the
scale census enforces.

**3 · Which widths were tested on a device rather than a resized window?**
**None.** All width work is a resized window plus Playwright at 390 and 900
across Chromium, WebKit and mobile-WebKit. 430, 768 and 1280 are not exercised
by any automated check, which is why every responsive variant above is marked
partial rather than done. A real phone also cannot be reached over the LAN
here — an insecure origin gives no microphone — so device testing needs an
HTTPS tunnel.

**4 · Did anything force new state outside the existing stores?**
One: `src/stores/onboardingStore.ts`, added because `/welcome` was unreachable —
nothing linked to it and the mic check was circular. It fails **open** (returns
"already onboarded" when storage throws), because failing closed would trap a
learner in a redirect loop on a browser blocking site data.

**5 · What in the designs turned out to be wrong once it met the real data?**

- **Board 1h's note that French "returns unlabelled sounds"** is false. French
  returns labelled syllables; **hi-IN** is the language that returns none —
  measured at 0 of 7 named. The mechanism was built from the real data rather
  than from the sentence.
- **Board 1k's "Who this reaches" panel shows four counts. Three are not
  measurable.** In-a-sitting, mid-lesson, and offline-on-an-older-version all
  need per-learner session and resolved-version telemetry that nothing records.
  Only "losing a started activity" falls out of the progress collection. The
  panel shows that one, names the other three as unrecorded, and states what
  happens to those learners regardless — inventing them is the fabrication the
  product refuses everywhere else.
- **The `listen` activity was a reading test.** The board's options were written
  French forms, answerable from spelling with the audio muted. They are English
  meanings now.
- **Board 1k puts the typed confirmation on removals only** — correct, and
  worth restating: a `target` edit re-keys a learner's sound history and is
  equally irreversible, but it takes nothing out of a lesson, so it gets a
  stated consequence rather than friction.

## One question back to you

**6 · The tap floor: 44 or 48?** The handoff says a flat 48px. `PRD.md` NFR-03
and `scripts/verify.mjs` say 44px, with 48 where a control is thumb-driven, and
the verifier reads declared `min-height` against 44. Those disagree. I have not
touched it, because changing `--tap` moves every target in the product and I am
not permitted to weaken a verifier rule. Tell me which governs and I will make
the other match.
