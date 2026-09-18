# The next version

Written 2026-09-18, from `docs/COMPETITIVE-POSITION.md`. Every item says what
it borrows, what it costs, and who it is waiting on.

**State at the time of writing:** all five gates green. 4,287 tests pass, 1
expected fail, 3 skipped. Branch `redesign/course-platform`.

---

## Part 1 — Decisions only you can make

These are not engineering questions. Nothing below them moves until these are
settled, and each one has a recommendation rather than a menu.

### D1 · How does a teacher get in?

The teacher board is built, tested, accessible, axe-clean, and **reachable only
by typing a URL**. It is the difference between a consumer app and a classroom
product, and it is one decision away from existing.

| Option | What it means |
|---|---|
| **Token link per teacher** *(recommended)* | A teacher gets a URL with a token. No accounts, no password reset, no personal data. Fits the existing `x-diagnostics-token` gate and the product's data posture. |
| Full accounts | Email, password, recovery, and a lot of child-adjacent data policy. Real work, and it buys little the token does not. |
| Leave it internal | The class features never reach anyone, and the second USP claim is about a screen nobody uses. |

### D2 · Kannada and Hindi — perception courses, yes or no?

Azure names **0 syllables** in both, so production scoring cannot be honest.
But `listen` and `locate` need no scorer at all, and a perception-only course
is proven to publish, compose and run (`src/learning/perceptionCourse.test.ts`).

**Recommended: yes, one language first.** It serves a market the native
competitors do not serve at all, and it is honest by construction. It is also
the only thing that gives the `listen` activity kind a home — it currently
ships in no language.

**Not recommended:** shipping them with production scoring. That is the one
thing this product's positioning forbids.

### D3 · Who checks the language?

The single most recurring blocker in the repo. Spanish content has never had a
native reader. Kannada and Hindi would need one. A mispronounced generated clip
is worse than no clip — every learner copies the error, *and* the scorer marks
them down for matching it — and the provider returns HTTP 200 for audio it
mispronounces, so nothing automated can detect it.

**Recommended: one reviewer per language, as a standing arrangement, not a
hire.** `voice-check.html` already exists as the review surface: it puts every
generated clip next to the phrase it is meant to be saying. Borrowed from
Busuu, which answered this structurally rather than by hiring.

### D4 · Image activities — do we start?

You have offered Gemini and OpenAI keys. The best use is **not** a new activity
type: it is an **articulation diagram per sound** — a picture of where the
tongue goes.

This is the highest-value single borrow from ELSA. It closes the warmth gap
without conceding any measurement honesty, because a diagram of a mouth is not
a claim about the learner. It also has no privacy cost: the images are of
sounds, generated once, shipped as assets, and no learner data goes anywhere.

**Recommended: yes, scoped to articulation diagrams only.** Picture-naming
activities are a different product and should wait.

### D5 · Do we publish a course at all?

`COURSES` exists — French has 21 activities against the bundled 10 — and is
published only by running `npm run seed-content -- --course`. Until then
learners see the flat bundled set.

If the answer is yes, one piece of work comes with it: the model voice must
regenerate at publish time. The cache key includes the content version, so
course phrases generated at version 0 would never be found. This is a known
three-line addition to `POST /content/:slug`, deliberately deferred.

**Recommended: yes, after D3.** Publishing content no native reader has checked
is the thing that makes D3 urgent rather than important.

### D6 · Who runs the browser suite, and when?

`npm run test:browser` is not one of the five gates, deliberately — 4,287 jsdom
tests run in thirty seconds and making each wait on a browser launch is the
surest way to stop anyone running them.

But the 28px Safari `<select>` was live with every gate green, and two of the
five defects found on 18 September were only visible there.

**Recommended: a pre-release step, owned by a person, not a gate.** The suite
takes about three minutes. Something has to make it happen, and nothing
currently does.

---

## Part 2 — The work, ordered by what it unblocks

### 1 · Make the anti-gamification constraint structural

**Borrowed from:** nobody — this is the differentiator itself.

`docs/MIGRATION-CHECKLIST.md` claimed a `scripts/verify.mjs` rule enforced "no
points, XP, hearts, lives, leagues, leaderboards". **There is none.** The only
enforcement anywhere is one test on the Today screen.

Of the three USP claims, this is the one most likely to be said in public and
the least structurally true. A repo-wide gate fixes that.

**Cost:** small. **Blocked on:** nothing.

### 2 · Articulation diagrams, per scorable sound

**Borrowed from:** ELSA.

The diagnosis is currently a number and a syllable. A learner who cannot make a
sound needs telling what to do with their tongue. Per-sound notes exist for
some sounds; the diagram is what makes them land.

**Cost:** moderate, mostly generation and review. **Blocked on:** D4.

### 3 · One perception course

**Borrowed from:** Pimsleur.

Kannada or Hindi, built from `listen` and `locate` only. Proves the honesty
position commercially: a language competitors cannot serve well, served
honestly. The authoring template is written
(`docs/PERCEPTION-COURSE-TEMPLATE.md`).

**Cost:** small once the content exists. **Blocked on:** D2, then D3.

### 4 · A way into the teacher board

**Borrowed from:** Rosetta Stone — the observation that a classroom product
needs a door that is not a typed URL.

**Cost:** small. **Blocked on:** D1.

### 5 · Native review as a process

**Borrowed from:** Busuu.

One reviewer per language, `voice-check.html` as the surface. Unblocks Spanish
now and every language after.

**Cost:** recurring and small. **Blocked on:** D3.

### 6 · Lean into being a web app, out loud

**Borrowed from:** nobody — competitors cannot do this.

The platform is currently treated as a constraint and it is a distribution
advantage: it runs on locked-down school fleets and on Chromebooks, where a
native app is not an option at all, and a fix ships the same day.

Two pieces of work follow: **an install prompt with real guidance** (the
discovery gap is the one genuine cost of being a PWA), and saying so in the
positioning rather than treating it as a thing to apologise for.

Worth noting when the question comes up: **the PWA's weakest capability is push
notification, and this product deliberately has nothing to nag about.** The
platform's biggest limitation costs it almost nothing.

**Cost:** small. **Blocked on:** nothing.

### 7 · A coaching note for every scorable sound

**Borrowed from:** ELSA.

Content work, parallelisable, and the cheapest way to close the warmth gap.

**Cost:** content. **Blocked on:** nothing, though D3's reviewer improves it.

### 8 · Regenerate the model voice at publish time

**Cost:** small. **Blocked on:** D5 — it only matters once a course publishes.

---

## Part 3 — Deliberately not in this version

- **The vowel chart.** Measured: male voices 11–17 Hz error, female 327–368,
  child up to 1087, against a 60 Hz tolerance. Cepstral liftering was
  prototyped and was no better. The gate refusing to draw it is correct.
- **Production scoring for Kannada or Hindi.** 0 syllables named. See D2.
- **Engagement mechanics.** Not an omission — the position.
- **A native app.** See Part 2 item 6: the web is an advantage here, not a
  stage to grow out of.

---

## Part 4 — Still needing hands, not decisions

- **VoiceOver and TalkBack**, one activity each. Nobody can automate it.
- **The accent fairness study** (T19) — whether the scorer is harder on some
  first languages than others. Needs scope and a reviewer.
