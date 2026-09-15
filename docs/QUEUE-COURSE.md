# Course MVP — build queue

Branch `redesign/course-platform`. Worked top to bottom. One feature per commit,
all five gates by exit code before each, push after each.

Spec of record: `docs/design/README.md` and the seven boards beside it. Screens
are cited by their board id (`1a`, `2c`, …).

## Hard rules — unchanged from the platform work

- **Add no new dependency without asking.** `docs/CLAUDE.md`'s wording, and it
  is an ask rather than a ban.
- **Never weaken a rule in `scripts/verify.mjs`** or edit requirement text in
  `PRD.md`. Twelve rules; five enforced BY PATH. **A reorganisation is a rule
  change** — five checks pass *vacuously* if a watched directory moves, which
  is why `src/speech/` must not be reorganised.
- **Do not touch** `.env`, provider config, the Azure rate, `audio-debug/`,
  `voice-cache/`, or `server/data/attempts.jsonl`.
- Gates read by **exit code**, never piped to `grep -c`.
- Three known flakes in env-dependent server tests, deliberately unfixed.
- Every property asserted must be broken and proved to fail.

## The nine design constraints — enforce, do not re-litigate

No XP/leaderboards · no streak repair · no hard gates · an unusable recording is
never a score · no vendor vocabulary on screen · motion never the only carrier ·
44px targets (48 where thumb-driven) · nothing pointer-only · every
language-bearing string carries `lang`.

---

## Wave 1 — the critical path and the assets

- [x] **C1 — Content spine + the field everything waits on.**
      `Language → Unit → Lesson → Activity`, and `soundTargets` on an activity.
      `server/routes/next.ts` states in its own comment that `selectActivity`
      is "already written and tested" and waits only on this mapping. Content
      is versioned and immutable, so this publishes a **new version** rather
      than migrating documents; the bundled set stays the floor so an old
      client keeps working. Authoring captures both.
      Also in scope because it is the same file: **`recall` added to
      `ActivityKind`** (the union is `"repeat" | "respond" | "read"` today, so
      `recall` does not exist), and **`read` content authored** (the type
      exists with zero content ever written).
- [x] **C2 — PWA assets, and split the static budget.**
      Place the seven exports in `public/`, wire `apple-touch-startup-image`
      per device, and declare `purpose: "maskable"` **only** for
      `icon-maskable-512.png` (art at 60% inside the 40% safe circle; the
      existing 512 icon was not drawn for a circular crop).
      The budget must be **split, not raised**: a tight ceiling on parsed
      bytes, a separate limit for conditionally-fetched media keyed on the
      **largest single asset** rather than the sum. Prove the new limit is
      non-vacuous.

## Wave 2 — the session

- [x] **C3 — `composeSession()`**, a pure client-side function.
      `(content, progress, skills, today) → new activities + due reviews`.
      Client-side always: offline-first means a learner on a plane still gets
      a sensible sitting, so the server cannot be on the critical path.
      Property-tested over random orderings.
- [x] **C4 — Wire `selectActivity` behind `GET /next`**, and feed it to the
      composer **as an input, not an alternative**. Two implementations of
      "what next" is the shape that drifts silently and shows a learner a
      different session when they come online. Contract test: a session
      composed with and without the server's input differs only in
      **ordering**, never in **membership**.
- [x] **C5 — `attempts` gains a discriminated kind**, so a non-scored answer
      has a shape. Then the **`listen`** activity, with **authored**
      distractors — a random other phrase is usually absurdly wrong and
      teaches nothing, so the plausible near-miss is the content.
- [x] **C6 — `read` and `recall` screens.** `read` has **no Listen button at
      all** — hearing it first would make it a `repeat` — and the model
      unlocks after the first take.

## Wave 3 — the learner's surfaces

- [x] **C7 — Onboarding and the microphone check**, boards 1a–1q. Eight check
      states including *no microphone hardware* and *insecure context*, both of
      which are nobody's fault and must not read as though they were.
- [x] **C8 — Session screen, every state**, board 2. Prompt, listening,
      scoring, result, **indeterminate**, error, offline, mic-unavailable.
- [ ] **C9 — Today, Journey, Progress**, board 3. Journey is **not a locked
      path**. Progress carries "not enough history yet" as a real state.
- [ ] **C10 — Navigation at four widths**, board 4. Four destinations —
      Today · Journey · Progress · You — and never five. The session runs
      *over* the tabs. An installed iOS PWA has **no browser back button**, so
      every non-root screen needs its own way back, and the current one is an
      **11px breadcrumb link** that NFR-03 cannot see.
- [ ] **C11 — The You tab**: name, switch learner, export, delete, and the
      **device-link screen** (mint a code, enter a code). The server side is
      built and pushed; `src/lib/learnerId.ts` still cannot adopt a claimed id.
- [ ] **C12 — Corrective detail**: syllable tap-through, the vowel chart,
      yours-against-the-model. The data already exists and is unused.
- [ ] **C13 — Outcomes as a derived function**, shown **with their evidence**.
      Nothing new stored — which is what keeps "promises with receipts" honest.

## Wave 4 — testing the new surface

- [ ] **N1 — Content migration**: existing flat progress survives the move.
- [ ] **N2 — Session blend**: no duplicates, deterministic for a day and state.
- [ ] **N3 — Algorithm state commutes**: the same results in any order give the
      same estimate. **The critical one** — the merge layer is proved
      commutative and Elo is sequential by nature.
- [ ] **N4 — Outcome honesty**: no can-do statement renders without evidence.
- [ ] **N5 — `listen` makes no scorer call** and needs no mic permission.
- [ ] **N6 — Curriculum coverage**: every phoneme in the inventory appears.
- [ ] **N7 — L1 difficulty table** complete for every shipped pair.
- [ ] **N8 — Formant accuracy** against published reference vowels.
- [ ] **N9 — PWA standalone back**: every non-root screen offers a way back.
- [ ] **N10 — Real-device browsers** (needs the runner install).
- [ ] **N11 — VoiceOver and TalkBack**, one activity each, by hand.

## Blocked on the owner — do not start

**An offline outbox for takes** — board 1h shows takes *held* and scored on
reconnect. There is none, and building one means persisting recorded audio on
the device until the network returns. That is a privacy posture decision, not a
coding one, and it sits beside the `SAVE_AUDIO_DIR` question: the onboarding
screen currently promises a take is uploaded when you speak, which an outbox
changes. The offline state ships saying what actually happens instead.

T19's eighty recordings · ten Kannada phrases · a second German voice id ·
Playwright and axe-core (free, need asking) · `SAVE_AUDIO_DIR` privacy posture ·
the `mergeStreaks` longest-run schema decision · the naming question (Sonare as
product, or as the activity inside Lingotran — the manifest bakes it in) ·
teacher accounts, which is where real auth belongs and the learner side stays
anonymous.

## Where to pick this up

**Read this first if you are returning to the queue.**

Everything committed is pushed and green — no half-finished work sits in a
worktree without a record here. If a wave was in flight when the session ended,
its agents' commits are on their own `worktree-agent-*` branches and were
**never integrated**: check `git branch --list "worktree-agent-*"` and cherry-pick
onto `redesign/course-platform`, gating all five by exit code before each.

**The loop only advances while a session is alive.** Background agents keep
working, but nothing integrates them without a turn — so a queue that looks
stalled is usually waiting for an integrator, not for a worker.

**Four decisions cost the owner a sentence each and unblock real work:**

| Decision | Unblocks |
|---|---|
| Playwright + axe-core — free, open source, needs a yes not a purchase | **N9, N10, N11** and the automated a11y audit — four testing items that cannot be faked |
| A second German voice id | Voice variation for the `listen` activity; the `repeat` voice is settled |
| Sonare as product, or as the activity inside Lingotran | The PWA manifest bakes a name and an icon into the installed app |
| `SAVE_AUDIO_DIR` privacy posture | The onboarding copy in C7 — "never stored" is not currently supportable |

**And two things no decision can shorten:** T19's eighty recordings, and the
curriculum — roughly 60 activities per language against the 20 that exist.
Both have been the critical path for weeks and neither moves with code.

## Log

- 12 Sep 2026 — **Correcting yesterday's diagnosis, because it was wrong.**
  I concluded from three stalls that large items were the problem and that the
  fix was smaller scope. C5 was then written deliberately narrow to test that —
  the attempt record and authored distractors, with the screen explicitly out
  of scope — and it **stalled earlier than any of them, before writing a single
  line, while still reading files.** Scope was not the variable.
  The likely cause is environmental. This session hit
  *"claude-sonnet-5 temporarily unavailable, so auto mode cannot determine the
  safety of Bash"* twice within minutes. Agents need that same classifier to
  approve every tool call, so when it times out they cannot proceed, and ten
  minutes of that is a stall. That explanation covers all five failures
  including a pure-research agent and one that produced nothing.
  **So: stop launching agents while it is degraded.** More would produce more
  stalls and more half-finished worktrees to salvage. Re-launch when a plain
  Bash call succeeds without a classifier timeout. The briefs were not the
  problem and do not need rewriting.
  Worth keeping as a rule of thumb regardless: an agent's work is only as safe
  as its last commit, and four of five stalls lost uncommitted work. Every
  brief now says to commit early and report honestly rather than press on.

- 12 Sep 2026 — **C11's mechanism landed** (`f197cf2`); its UI stays open.
  **C12 is parked with a diagnosis, not abandoned.**
  **Three agents stalled or were rate-limited today, all on large items**, and
  the salvage cost was the same each time: the tests. C11 committed 528 lines
  of production code with zero tests and a failing lint gate, having never run
  one. I wrote its 24 tests and proved three non-vacuous by mutation — strip
  unknown characters instead of separators, save the token before adopting the
  identity, move the code into the query string; each fails exactly one test.
  ~~**Scope the remaining items smaller.**~~ **That conclusion was wrong and is
  corrected below (12 Sep) — the variable was not scope.**
  **C12's formant estimator is on `worktree-agent-aaef63311d55877f0`** and
  deliberately not here. The method is right — pre-emphasis, Hamming frames,
  Levinson-Durbin, peaks of 1/|A| — but it avoided root-solving A(z), so there
  are no bandwidths and nothing to reject a spurious peak with. Nine
  reference-vowel cases fail with errors from **34.9 Hz** against a 30 Hz
  tolerance up to **1587 Hz**, which is the wrong peak selected rather than a
  near miss.
  Shipping it would contradict the only argument for building it: the vowel
  chart earns its place by being a *measurement* rather than a grade, which is
  what lets it stay honest while accent fairness is unmeasured. An estimator
  that can miss F2 by 1587 Hz is not a measurement, and a confident point in
  the wrong place is worse than no point. Its test file is the valuable half —
  whoever resumes starts from a failing specification with published reference
  vowels in it, not a blank page.

- 11 Sep 2026 — **C1 done** (`a1552b6`). 3352 tests + 1 expected fail + 3
  soak-only across 144 files, all five gates green. **The field
  `selectActivity` waited on now exists**, so C3 and C4 are unblocked.
  The spine **points into** the flat `activities[]` by id rather than
  containing it, and `units` is optional — so a set with no spine is the shape
  that already shipped rather than a document to migrate, and an old client
  resolves a whole language by ignoring a field it has never heard of. Four
  such mechanisms, each tested.
  `soundTargets` are graphemes folded to lower case, matching how the skills
  store keys, and the publish gate refuses a syllable **that does not occur in
  the phrase** — a mapping to nothing looks exactly like one that works. That
  rule caught two real cases in the existing Authoring tests.
  One honest exception recorded rather than papered over: `soundTargets` is
  required for every activity a lesson references, but not globally, because
  **hi-IN returns no syllable graphemes at all** (0 of 7 named) and a Hindi
  list could only be data that never matches.
  14 mutations, all caught. The one worth naming: `resolve.ts` rebuilt each set
  from a written-out list of four fields, so it **would have dropped `units`
  silently** — every activity present, the set valid, the journey empty, and
  nothing to attribute it to. It now hands the cached set over by omission.
  **Follow-up nobody should lose:** `--course` is opt-in. `npm run seed-content`
  behaves exactly as before, so **the spine does not reach a learner until
  someone runs it with that flag** — and it should not, until C6 ships the
  `read` screen, because today's session screen would render a Listen button on
  a `read` activity, which is the one thing that makes it a `repeat`.

- 11 Sep 2026 — **C2 done** (`2ebbc46`). 3252 tests + 1 expected fail + 3
  soak-only across 143 files, all five gates green. Static budget **split
  rather than raised**: 205 KiB for bytes every learner parses, 256 KiB **per
  file** for conditionally-fetched media, because iOS requests one splash frame
  once at install and a sum measures a transfer nobody makes. The measurement
  is now a classification asserted to **partition** the build output, so the
  next unclassified file fails loudly instead of slipping through a `.filter()`
  — which is how `public/sw.js` had been in no budget at all.
  **Two process failures of mine, recorded rather than quietly fixed.** I
  launched agents against this branch while it was five commits stale, so C2
  reconstructed ~2,500 lines of reviewed code that already existed; the real
  history is now merged and the reconstruction discarded. And I committed
  `docs/design/` after running `verify` but **not `lint`**, breaking the gate
  with 97 errors from the design tool's vendored runtime — having told five
  agents in a row to read every gate by exit code. A partial gate run reports a
  clean result for a check that was never made.
  **Re-export ask for the design side:** all seven splash PNGs are RGBA with
  every pixel opaque. Alpha-free is **45.4% smaller, losslessly** — 1.09 MiB to
  ~625 KB — plus 40 KB of canvas metadata currently shipped. Nothing installed
  can re-encode and `sips` cannot drop an alpha channel.

- 11 Sep 2026 — Queue created. Platform work is done and pushed on
  `revamp/platform`: 50 commits, 3240 tests + 1 expected fail + 3 soak-only
  across 143 files, all five gates green. Design handoff landed under
  `docs/design/`, all 38 tokens it names verified present.
- 11 Sep 2026 — **C2 done.** This branch had forked from `revamp/platform`
  five commits early and was missing the whole PWA layer — manifest, service
  worker, registration, and the two test files C2 edits. Four of those five
  commits were restored here first, byte-identical, as their own commit; the
  fifth (device link codes, server-only) was left where it is. `docs` is now
  ignored by ESLint: the handoff's vendored `support.js` was failing
  `npx eslint .` on this branch with 97 `no-undef` errors before any of this
  work started.

  The seven exports are in `public/splash/`, byte-identical to the handoff.
  The budget is split three ways instead of one: what every learner fetches
  keeps the old 205 KiB ceiling and now measures 186.7 KiB (it gained the
  manifest and the worker), `index.html` and `sw.js` have ceilings of their own,
  and conditionally-fetched media is capped at **256 KiB per file** against
  236.2 KiB measured for the largest — never on the sum, which no device
  downloads. `public/` is 1306.1 KiB on disk; no device fetches more than
  236.2 KiB of it.

  `public/sw.js` was in no budget at all: the static measure excluded `.js` and
  every chunk ceiling requires the `assets/` prefix. Rather than add one
  ceiling and wait for the next gap, the buckets are now asserted to partition
  the build output by count and by bytes — reintroducing the old classifier
  fails with `expected [ 'sw.js' ] to deeply equal []`.

  **Open, for the design side:** all seven PNGs are 8-bit RGBA with every pixel
  fully opaque. Re-exported alpha-free they would be ~45% smaller, losslessly —
  1,146,305 B to ~625,386 B — plus 40,390 B of `caBX` canvas metadata. Nothing
  installed can do it (no encoder, and `sips` cannot drop an alpha channel), and
  adding one is a dependency. Numbers per file are in
  `docs/design/assets/splash/WHERE-THE-PNGS-ARE.md`.
### 2026-09-13 — C3 and C4, and the tie-break they made reachable

`composeSession` (5ee047e) and the wiring behind it (c54ff89). The contract is
held from both ends: `composeSession.contract.test.ts` sweeps every refinement
the server could express and asserts ordering-only, and
`next.contract.test.ts` drives the real route and feeds its reply into the real
composer with no adapter, so a rename on either side stops compiling.

The wire field is `refinement`, not `selection`. "Selection" invites a client
to treat it as the decision; the design is that it is an input to a decision
the client makes for itself, offline included.

Three refusals in the route, each a way a pick could have been a lie: nothing
published means no grapheme mapping and so no pick; progress that *fails to
read* is not a learner with no progress, and collapsing them would offer
someone thirty activities in the word "recommended"; and a set with a spine is
filtered to what its lessons reference, so the unpractised fallback cannot
reach past the course. Selection also reads the whole due list while the
response shows five — `MAX_DUE` is a display limit, and applying it first would
make an activity drilling six due sounds lose to a narrower one.

**A real defect fell out of the wiring** (6f36329), and only because the wiring
existed. `olderAttempt` answered "older" for two equal timestamps, and its two
callers pass their arguments in opposite orders — so one tie resolved toward
the later activity and the other toward the earlier. Unreachable until now;
the case it lands on is the most common one there is, because every activity a
fresh learner has is equally never-practised, so all of them tie all the way
down to that predicate. A beginner's first session pointed at the last activity
in their course. Both directions now have a test and each fails on its own
mutation.

The first expectation I wrote in the contract test was wrong, and that is how
this was found — the test said activity 1 and the route said 3. Worth recording
because the instinct was to correct the test.
### 2026-09-13 — C5, in two commits

**The attempt shape** (90deda3). `ActivityAttempt` is discriminated: `spoken`
carries the provider's result and its number, `chosen` carries the option and
whether it was right. Reading `accuracy` no longer compiles without saying
which kind is meant, and that found a consumer the greps had missed —
`report.ts`, which reads `.result` off every attempt. It is spoken-only
throughout now, so a tap contributes no phonemes and does not inflate the "N
attempts" line where the number means "times you spoke".

Two axes, neither converting into the other: a spoken take passes on the
provider's number, a chosen answer on being right, and `best` stays null when
only tapping happened. 100 for a correct tap would be a figure the provider
never produced, in the field the provider's numbers live in, and from there it
reaches the skills store and reschedules a sound the learner never said aloud.

`isSpoken` tests for **not chosen** rather than for spoken, and that is the
whole compatibility story: every attempt any learner has stored carries no
`kind`, and `readProgress` restores them with a cast. Testing for the positive
would have reclassified every history as unmeasured on the release that ships
`listen`. Three tests cover those records; all three fail on that mutation.

**The activity** (a82af64). `listen` is the fifth kind and the only one that
asks nothing of the microphone. Near-misses are authored — a random other
phrase is ruled out on length before the audio finishes — and three unaskable
shapes are refused at the authoring form, at the publish gate, and once more in
`listenOptions` for the bundled sets that pass through neither.

Options rotate by activity id rather than shuffling: the answer must not always
be first, and must not move between renders either.

A guard the kind made necessary: a `listen` activity maps to no graphemes in
`GET /next`. It legitimately names sound targets, but answering it produces no
recording, so the sound's strength cannot move — it would win again tomorrow,
and every day after, with the learner never asked to say the word.

**Still open:** the listen *screen*. It belongs with C6's read/recall screens
rather than here, and N5 ("no scorer call, no mic permission") can only be
asserted end-to-end once it exists.

Two existing tests used `listen` as their stand-in for "a kind this client
cannot render". Both quietly stopped testing anything the moment it shipped;
they now use a kind that does not exist at all, and say so.
### 2026-09-13 — C6, and the listen screen with it

**Every kind was rendered as the easiest one** (54fc16a). `ActivityTest` did not
branch on `kind` at all: phrase on screen, Listen button beside Record, for all
five. That is right for `repeat` and silently deletes three other exercises —
`read` with a Listen button *is* `repeat`, `recall` with the phrase on screen
*is* `read`, and `listen` was opening a microphone it never uses.

The rules are `affordancesFor` now: exhaustive over the union with no default
branch, so a sixth kind is a type error rather than another activity quietly
shown as the easiest one. Extracted rather than inlined for the reason
`session.ts` was — rules inside a 992-line component can only be exercised by
rendering it with a mocked recorder and reading the DOM.

The `recall` reveal costs what it should: nothing recorded after one counts,
the button says so before it is tapped, and `canAdvance` opens — without that
the escape is a trap, because nothing counts so the attempt limit never
unlocks and the design forbids hard gates. Nothing about a reveal is stored: it
is about the sitting, not the learner, and an attempt with a null accuracy
would be the obvious place and the wrong one (R8 already owns that meaning).

**The listen screen** (7905609), which completes the kind C5 left half-built.
One answer, by design — a learner either heard the difference or did not, and
with two options a second guess is certain. `attemptLimit` threaded through
`applyTake`/`canAdvanceFrom` as a defaulted parameter, so the arithmetic stays
in `session.ts` and the policy in `affordancesFor`. A wrong answer lands as
`skipped` and the **right** answer is shown beside it: marking only what they
picked leaves a learner knowing they failed and not what they missed.

Three things worth keeping:

- **The `read` unlock is not reachable the tick after a take.** A landed score
  puts the screen in its result phase, where no kind renders Listen. The real
  path is a learner *returning* to an activity they have attempted, and that is
  what the test drives. My first version asserted the unreachable one.
- **The authoring form now shows the near-miss field only on a `listen` row.**
  Publishing refuses distractors on every other kind, so offering the box
  everywhere invites a mistake reported as a refusal after a round trip. It
  also took the form back under the render budget — the extra field on all 18
  course activities had pushed `Authoring.test.tsx` over its 5s timeout under
  full-suite load.
- **The type scale rules did their job twice**: refused a bare `20px`, then
  made the replacement a deliberate line in the diff via their exact count.
### 2026-09-13 — C7, in three commits

**The verdict logic** (4773b6f). The file's shape is one distinction:
*availability* is what the environment allows and is knowable before any audio;
*verdict* is how good a signal is once there is one. The old screen had a single
"microphone problem" state covering causes with nothing in common, which is how
a blocked permission came to be rendered as a quiet room.

Three decisions are load-bearing and each fails on its own mutation:

- **Address before permission.** An insecure page has no permission worth
  reporting and usually no `mediaDevices` at all, so asking permission first
  classifies every LAN-address visit as *denied* — and marches a learner through
  settings to fix something that is not broken.
- **Silence is not a low score.** Muted and wrongly-routed are its causes and
  neither is fixed by "move closer, speak up".
- **Clipping fails however clean the ratio looks.** SNR is blind to it: a hard-
  clipped take measures a superb 37.8 dB on a real recording, because clipping
  lifts the speech percentile and leaves the floor alone.

"Good" is ten dB above the recorder's own gate rather than its own number — a
check passing *at* the gate tells a learner their device is fine while sitting
on the line that rejects takes.

**The screen** (a310ca6), eight states. Insecure address and no hardware give
**no steps to follow**, because there is nothing the learner did or can undo,
and a numbered list would imply otherwise — asserted as the absence of an `ol`.
Denied is the opposite and does route through settings, because it is genuinely
recoverable and the page genuinely cannot ask again.

The no-upload promise is asserted **against the source**, not through a mock: a
mock proves the upload layer is absent from the *test's* module graph, which is
what a mock arranges. That check needed one correction — matching bare
identifiers flagged the file's own comment explaining why it does not use
`useRecorder`, which would have left only two ways out, deleting the reasoning
or weakening the check. It matches import lines now.

**Onboarding** (253d712), boards 1a–1d. The ask comes last. Step 1 asks for
nothing and shows a **real** scored take with two weak syllables, using the
product's own `.sy` chips so the example cannot drift into showing something the
app does not produce. The microphone screen admits a recording can be written to
the operator's disk when diagnostics are on — "nothing is ever stored" would be
false whenever that setting is on, and a learner who later found it would have
no reason to believe any other sentence on the screen.

**Still open from this board:** 1m (the check's verdict carried into the first
activity as one quiet line) belongs with C8's session states, and 1n–1p (the
check at 430/768/1280) belong with C10's widths.
### 2026-09-15 — C8, and a correction to C5

**The listening question was a reading test** (9389bf2). Board 1i asks the
learner to *pick the meaning*; what shipped in C5 asked which written form had
been said. The phrase was on screen, so a learner could match an option against
it and be right every time without pressing play — the audio was decoration.

Options are English now, so nothing on screen is in the language being spoken.
Both gates compare distractors against the gloss, and the phrase is revealed
only once the question is over, with `focus` saying what separated it from the
near miss. One consequence runs opposite to the usual: the options carry **no**
`lang`, because tagging English as French would make a screen reader say
meanings in a French voice.

Found by reading the board against what shipped, not by a failing test — which
is the only way this class of thing surfaces. Every C5 test passed, because they
all tested the exercise I had built.

**A blocked microphone gets a screen** (bc77745), board 1g. A toast appears, is
missed, and leaves the learner on a screen whose record button does nothing. Two
causes with opposite advice: blocked is recoverable in the browser and gets
steps and a retry; an insecure address gets neither, because instructions to do
something impossible leave a learner who followed them concluding they broke it,
and a retry button that can never work invites them to keep tapping. Gated on
the activity needing a microphone, so `listen` is untouched — which is what
makes "practise listening instead" a real offer.

**Offline ships honest.** The board shows takes *held* and scored on reconnect;
there is no outbox, so that copy would be a promise the app does not keep. It
says a take cannot be scored right now. The outbox is now listed as blocked on
the owner — it means persisting audio on the device, which is a privacy posture
decision.

**The verdict travels** (7edcfc8), board 1m, with a fortnight's expiry: a
verdict is about a device in a room at a moment, and a stale "your check passed"
is the exact sentence that stops someone re-running a check they should.

**One piece of test infrastructure, load-bearing.** jsdom has no
`navigator.mediaDevices` and reports `isSecureContext: false` — between them
indistinguishable from an insecure origin, which is what the new check looks
for. Four end-to-end suites began asserting against a blocked app. One shared
setup file now says "an ordinary browser with a working microphone", rather than
a mock in each suite: those suites exist to drive the real app, and a mock is one
less piece of it. The states where that is not true are covered directly.

Also confirmed one of the three known flakes is still exactly that: the
diagnostics rate-limit ceiling failed once under full-suite load and passed
alone and on re-run. Shared fixed window; not a regression.
