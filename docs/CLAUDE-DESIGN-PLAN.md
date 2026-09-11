# Sonare — design plan

A paste-ready brief. Give this whole file to Claude (or a designer) and ask for
the deliverables in §8. It is written to be acted on without further context.

Branch: `redesign/course-platform`, cut from `revamp/platform`.
Companion artifacts: course plan, algorithm plan, persona audit, design-system
audit, design brief.

---

## 1. What you are designing

Sonare teaches **spoken pronunciation** in French, Spanish, German, Hindi and
Kannada. A learner hears a native-quality model voice, says the phrase back,
and is scored **syllable by syllable** — not "60%", but *which sound* went
wrong and what to try instead. It works offline, on a phone, in short sittings.

It is a web app. It runs in iOS Safari, Android Chrome, desktop browsers, and
installed as a PWA. There is no native shell.

**The job:** turn a strong pronunciation trainer into a **course**, without
turning it into a game show.

### The thesis, and the name of this product's discipline

The goal is **intelligibility, not native-likeness**. A learner succeeds when a
native speaker understands them easily — not when their accent is erased.

This is both current pedagogical consensus and, here, an engineering
necessity: **whether the scorer is fair across accents is still unmeasured.**
Any design implying "sound like a native" makes a promise the measurement
cannot support, and sets a goal many learners should not want.

Check every label, celebration and progress metaphor against that sentence.
*Clearer* is the axis. *More native* is not.

---

## 1b. Scope — production-near MVP, paid things held

Two decisions, both made by the owner, that settle questions the rest of this
file would otherwise leave open.

**PWA, not a native shell.** No Capacitor, no React Native. The app installs
from the browser. This settles §7's navigation questions rather than leaving
them open: an installed iOS PWA has **no browser back button**, so an in-app
back affordance on every non-root screen is mandatory, not a nicety.

**Anything requiring payment is held.** In scope is everything free; out of
scope for now are payments, email or OAuth accounts, a CDN and object storage,
push notifications, and paid analytics.

That line is more generous than it sounds, and two things commonly assumed to
be behind it are not:

- **A browser test runner is free.** It is an open-source dev dependency plus a
  few hundred megabytes of browsers. It unlocks real-device passes, visual
  regression, an automated accessibility audit, and the PWA back-button test —
  four of the eleven testing kinds the plan needs.
- **Backups are free.** A scheduled `mongodump` with a rehearsed restore costs
  nothing and addresses the largest single operational risk on the board. It
  does not need a managed service.

**Accounts are not needed for this MVP.** Identity is already anonymous: a
locally minted id signed by the server, with working data export and deletion.
No email, no password, no login screen — and that is a defensible product
position, not a gap.

**But there is a real gap behind it, and it must be designed.** `ensureLearnerId`
mints a fresh id per browser, and there is **no transfer, pairing or recovery
mechanism anywhere in the codebase**. A learner who changes phone silently
loses everything. For a production-near MVP that is not shippable, and the fix
needs no accounts and no paid service: **a device-transfer code or QR** — shown
on the old device, entered on the new one, moving the identity across. Treat it
as a required MVP screen, sitting beside export and delete in Settings.

---

## 2. Hard constraints — read before drawing

Each is enforced somewhere in the codebase by a test or a build-time check, and
most were added after something went wrong. They are the product's memory, not
its opinions. **A design that violates these is not usable, however good it
looks.**

1. **No points, XP, hearts, lives, leagues or leaderboards.** Every one
   attaches a number to performance, and accent fairness is unmeasured — a
   leaderboard over these scores ranks accents and calls it progress. The
   streak counts *attendance* and takes no score, guaranteed by a function
   signature. This is the most likely way a well-meaning redesign breaks the
   product.
2. **No streak freezes, repair tokens or make-up days.** Consolation mechanics
   for a number this product refuses to weaponise. A lapsed learner is greeted
   by the gap — "Three weeks away — your best sounds are still here" — never by
   a broken counter and an offer to buy it back.
3. **No hard gates.** After three attempts a learner moves on, marked skipped.
   A gate strands exactly the learner whose accent the scorer mishandles, which
   is the failure this product exists to detect, not to inflict. Journeys and
   maps must not lock the path.
4. **An unusable recording is never a score.** If the microphone caught nothing
   usable the result is *indeterminate*: visibly distinct from a low score,
   costing none of the three attempts, never celebrated. Roughly **one take in
   fourteen** (7.2% measured) lands here. Design the state; do not style it as a
   zero.
5. **No vendor vocabulary on screen.** No "Omission", no "Mispronunciation", no
   error codes, no confidence values. A learner gets "you didn't say this
   word".
6. **Motion is decoration, never information.** A blanket rule strips every
   animation under `prefers-reduced-motion`. Anything conveyed only by movement
   is invisible to the people most affected by it, so every state change must
   read as a static difference too.
7. **Minimum target 44px, and 48px where you can.** iOS HIG says 44pt;
   **Material says 48dp** — the shared token is `--tap: 44px`, which satisfies
   iOS and sits 4px under Android's recommendation. Prefer 48 for anything
   thumb-driven. Build-checked, including the token itself.
8. **Nothing reachable by pointer alone.** Keyboard and screen reader reach
   everything.

---

## 3. Who it is for

Ten personas. Each earns its place by forcing a different answer.

| Persona | The constraint it imposes |
|---|---|
| **Commuter who cannot speak** | Every activity today needs a microphone; the "Can't speak right now" escape leads nowhere. Drives a **non-speaking activity type**. Biggest single change in the plan. |
| **Learner with a non-standard accent** | Fairness is unmeasured. Design as though they are watching; never state what cannot be supported. This is why §2.1 exists. |
| **First-timer** | Asked for a name, a language and mic permission before seeing any value. Let them *hear* a phrase first. Be exact about the recording, not reassuring. |
| **Daily returner** | One tap, same time daily. Already works — preserve ruthlessly. Adding a decision here makes the product worse. |
| **Lapsed learner** | Back after weeks, braced for a telling-off. Greet the gap, show what held up. |
| **Assistive-technology learner** | Every pending state announces. Target-language text carries its language — for Devanagari and Kannada an untagged string is **skipped**, not mispronounced. Focus moves on arrival and on error. |
| **Shared-device learner** | Family tablet, classroom. Needs a visible "who is this?"; a name list is itself a privacy surface — first names, easy to remove. |
| **Content author** | Fix a typo, add ten phrases. Needs units, lessons, and which sounds each activity targets. |
| **Support responder** | "It never hears me" — answer it today, for this person. Operator surfaces deserve the same care. |
| **Teacher** | Design **last**. A class view means an authority figure ranking children by an unvalidated score. When it comes: group-level sound difficulty and attendance, never a per-pupil ranking. |

---

## 4. Learning outcomes

Sonare currently states none. A course must promise something **checkable**,
and here that is a hard filter: **the app may only claim what it measures.**

| Level | Outcome shape | Checked by |
|---|---|---|
| **Unit** | A can-do statement in the learner's words — *"You can order food and be understood."* CEFR A1/A2 register: concrete, situational, about being understood. | lessons done + sounds at rung ≥3 |
| **Lesson** | *"You can say the four phrases you need to order a coffee."* One sitting, one outcome. | activities passed or deliberately skipped |
| **Sound** | *"The French `u` in tu — 74, up from 52."* The real unit of learning here. | measured, per syllable |
| **Course** | *"You can hold a basic exchange and be understood."* Deliberately modest. | unit coverage |

**What it measures:** per-syllable pronunciation over time, and attendance.
**What it does not:** comprehension, vocabulary recall, grammar, conversational
fluency. No outcome may claim those until an activity type tests them — the
listening activity in §5 is the first that would earn a comprehension claim.

Design outcomes as **promises with receipts**: beside each can-do statement,
the evidence — which sounds, at what level, how recently. That pairing is what
separates an outcome from a marketing line, and it is something this product
can do that most cannot.

---

## 5. Features and content model

### Content spine — new

```
Language → Unit → Lesson → Activity
```

Today it is `Language → Activity[]`: a flat list of ten, no units, no lessons,
no levels, no prerequisites. "Next" is the next array index.

- **Unit** — a theme a learner can name ("Ordering food"), carrying the outcome.
- **Lesson** — one sitting, 3–6 activities, with a beginning and an **end**.
- **Activity** — exists; gains one field: **which sounds it targets**.

### Activity types

| Type | What the learner does | Mic | Status |
|---|---|---|---|
| `repeat` | Hears the model, says it back | yes | 25 written |
| `respond` | Answers a question aloud | yes | 16 written |
| `read` | Reads text aloud, no model first | yes | declared, 0 written |
| **`listen`** | **Hears a phrase, picks the meaning** | **no** | **new — highest value** |
| `recall` | Sees English, produces the target aloud | yes | new |

`listen` changes what the product *is*: practice on a bus, in an office, beside
a sleeping child. No microphone, no scorer, no new honesty rules — right-or-
wrong is a far weaker claim than a pronunciation score, so it is safer ground.

### The two clocks

Two schedulers, and conflating them is the classic mistake:

- **Progression** — "what is next to learn?" Walks the content spine. *New.*
- **Review** — "what is due again?" A ladder of `[1, 3, 7, 16, 35]` days on
  **sounds**. *Already built, and good.*

A lesson finishes once. A sound never finishes — it decays, and the ladder
already knows when. **A session blends both:** new content plus what is due.
That blend is why a learner feels a course rather than a playlist.

---

## 6. Feedback — four layers

| Layer | When | Carries | Must never |
|---|---|---|---|
| **Immediate** | <1s after a take | which syllables, where the vowel landed, one thing to try | pass verdict on the person |
| **Session** | end of a sitting | what improved, before → after, measured | claim improvement that did not happen — silent if none |
| **Longitudinal** | weeks | trend per sound, course coverage, attendance | imply a score trend is a person trend; "not enough history yet" is a real state |
| **Corrective** | on demand, tap a syllable | the substitution made, how the sound is formed, yours against the model | use vendor vocabulary |

**Every layer:** if the recording was unusable, say so. Distinct state, no
attempt spent, no celebration.

The corrective layer is the differentiator — syllable-level detail already
exists in every result and is largely unused. A **vowel chart** showing where
the learner's vowel actually landed against the target is a *measurement*, not
a grade: honest even while fairness is unmeasured, and computable in the
browser from audio already captured.

---

## 7. Platform rules — apply strictly

Sonare is a web app on iOS and Android. These are not preferences.

### iOS Safari

- **Any focusable input ≥16px.** Below that Safari zooms the page on focus and
  the layout breaks mid-session. The type scale's `--text-md` is 16.5px for
  exactly this reason — do not go under it for inputs.
- **Safe areas:** `env(safe-area-inset-*)`. Notch, Dynamic Island, home
  indicator. A bottom tab bar must pad for the home indicator.
- **Use `dvh`, not `vh`.** The address bar collapses on scroll and `100vh`
  overflows. `100dvh`/`svh` for anything full-height.
- **In standalone (installed) mode there is no browser back button.** The app
  must provide its own back affordance on every screen that is not a tab root,
  or a learner is stranded.
- **Edge-swipe back conflicts with horizontal gestures.** Do not put a
  horizontal swipe interaction within ~20px of the left edge.
- **Audio and microphone need a real user gesture**, and `getUserMedia`
  requires a secure context — on a plain LAN IP there is no microphone at all.
  Design the "microphone unavailable" state as a first-class screen, not a
  toast.
- `-webkit-tap-highlight-color: transparent` is already set; give every tappable
  thing its own pressed state or it will feel dead.
- Never rely on `:hover`.

### Android Chrome

- **48dp minimum touch target** (Material), above the shared 44px token. Prefer
  48 for thumb-driven controls.
- **System back must work and must be handled.** Mid-session it must not exit
  without asking. In a PWA, back from a tab root closes the app — confirm
  first if a session is in progress.
- Address-bar resize changes viewport height; same `dvh` rule.
- **TalkBack** is the screen reader to test against, not VoiceOver.
- Vibration API is available: a light tick on record start/stop is appropriate.
  iOS web has no haptics — do not design a pattern that depends on it.

### Both phones

- **Bottom navigation**, four destinations, thumb-reachable. Never more than
  four.
- The **session runs over the tabs**, not inside them — a sitting is a modal
  flow with its own finish line.
- The **record button sits in the lower third**, reachable one-handed.
- All work offline. Sync is silent and never blocks. Never show a failure a
  learner cannot act on.

### Tablet and desktop

- Bottom tabs under 620px; **side rail** above; **persistent left sidebar with
  labels** on desktop.
- Keyboard shortcuts and visible focus throughout; breadcrumbs instead of back.
- A device picker for the microphone is worth surfacing on desktop.

---

## 8. Deliverables, in order

Phone-first at **360** and **430** wide, tablet **768**, desktop **1280**.
Light theme only — dark was built, measured, and removed by the owner.

**Every screen, every state.** The empty, the loading, the *indeterminate*, the
offline and the error are the states this product lives or dies on.

| # | Deliverable |
|---|---|
| **D1** | **Session screen, all states** — prompt, listening, scoring, result, indeterminate, error, offline, mic-unavailable |
| **D2** | **Journey** — units, lessons, outcomes, position. Not a locked path |
| **D3** | **Today** — session shape stated before committing; first-time and lapsed variants |
| **D4** | **The `listen` activity** in the session shell |
| **D5** | **Progress** — sounds and coverage on one screen, including "not enough history yet" |
| **D6** | **Corrective detail** — syllable tap-through, vowel chart, yours-against-the-model |
| **D7** | **Navigation** — tab bar, rail and sidebar across the four platforms, with safe areas and back behaviour |
| **D8** | **Authoring** — units, lessons, sound targets. Operator density |
| **D9** | **Splash and first run** — see below. iOS needs real assets; Android does not |

---

### D9 — splash screens, and the asymmetry

**Android / Chromium: free, if the manifest is right.** The browser generates a
splash from `name`, `background_color` and a ≥512×512 icon. The one detail that
matters: **`background_color` must equal the app's real page background**
(`--ground: #fcfbfe`). If it does not, there is a visible colour jump between
splash and first paint — a flash that reads as a bug and is entirely avoidable.
Note that `theme_color` is a separate decision: it paints OS chrome, the brand
violet suits it, and it would be a poor `background_color` for exactly that
flash reason.

**iOS: not free.** Safari historically ignores the manifest for splash and
wants explicit `apple-touch-startup-image` links with a `media` query **per
device resolution** — a long list and a known maintenance burden. Newer iOS
does better but coverage is inconsistent across versions.

So this is a real design deliverable, not a config line:

- A splash composition — wordmark on `--ground`, centred, no motion (it is a
  static image the OS shows; nothing can animate).
- Exported at the iPhone resolutions worth supporting. Decide the cut deliberately
  rather than exporting forty variants nobody audits.
- **A maskable icon**, which is separate: Android crops into a square icon
  unless the artwork carries roughly 20% safe-zone padding. The current
  `icon.png` is 512×512 and was not drawn for masking, so it should not be
  declared maskable until a padded version exists.

**And check the handover.** A splash covers until first paint; if the app then
shows a route-level "Loading…", the learner sees two loading states in a row.
The splash background matching `--ground` is what makes that seam invisible.

---

## 9. Foundations — use these, do not invent them

A measured token system already exists and ships under the Lingotran brand. The
palette is not open for revisiting; layouts and components are.

**Palette (light only)**

| Token | Value | |
|---|---|---|
| `--signal` | `#41009a` | brand violet |
| `--panel` | `#f0e6ff` | lilac |
| `--ink` | `#1a0b2e` | ink |
| `--ground` | `#fcfbfe` | page |
| `--surface` | `#ffffff` | cards |
| `--pass` | `#1b7a5a` | |
| `--warn` | `#8a5200` | measured replacement for a value that failed AA |
| `--fail` | `#c0273c` | |

**Type** — Nunito 400/600/700/800, plus Noto Sans Devanagari and (to add) Noto
Sans Kannada, matched per character so Latin stays on Nunito.
Scale: `10.5 · 11 · 12.5 · 15 · 16.5 · 23 · 30`. **16.5 is the floor for inputs.**

**Space** — 4px base: `2 4 6 8 12 16 24 32 48`.
**Radius** — `3 · 4 · 6 · 10 · 14 · pill`.
**Targets** — `--tap: 44px`, build-checked including the token itself.
**Breakpoints** — 460, 620.

**Motion** — `cubic-bezier(.4, 0, .2, 1)`; quick **150ms** (taps, chips),
standard **350ms** (screens), slow **500ms** (a pass, once). All stripped under
reduced motion.

- **Screen arrival** — 350ms, one direction, the platform's own idiom. Not a
  bounce.
- **Level meter** — the one place live movement *is* the information. Give it a
  static equivalent too.
- **Word highlight during playback** — driven by real per-character timings from
  the voice, not a guessed interval. Must read statically under reduced motion.
- **Scoring wait** — a skeleton shaped like what arrives, so nothing jumps.
  Never animate it as though it were progress.

**"Modern" here means calm:** generous type, real hierarchy, one accent used
sparingly, elevation only where something genuinely floats. The subject is a
learner's own voice and a foreign sound; the interface should get out of the way
of both.

Two anti-patterns specific to this product: **gradient-and-glow dashboards**,
which make a measured 74 look like a marketing number; and **dense card grids**,
when the core screen has exactly one thing on it — a phrase to say.
