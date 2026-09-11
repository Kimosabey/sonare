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

- [ ] **C3 — `composeSession()`**, a pure client-side function.
      `(content, progress, skills, today) → new activities + due reviews`.
      Client-side always: offline-first means a learner on a plane still gets
      a sensible sitting, so the server cannot be on the critical path.
      Property-tested over random orderings.
- [ ] **C4 — Wire `selectActivity` behind `GET /next`**, and feed it to the
      composer **as an input, not an alternative**. Two implementations of
      "what next" is the shape that drifts silently and shows a learner a
      different session when they come online. Contract test: a session
      composed with and without the server's input differs only in
      **ordering**, never in **membership**.
- [ ] **C5 — `attempts` gains a discriminated kind**, so a non-scored answer
      has a shape. Then the **`listen`** activity, with **authored**
      distractors — a random other phrase is usually absurdly wrong and
      teaches nothing, so the plausible near-miss is the content.
- [ ] **C6 — `read` and `recall` screens.** `read` has **no Listen button at
      all** — hearing it first would make it a `repeat` — and the model
      unlocks after the first take.

## Wave 3 — the learner's surfaces

- [ ] **C7 — Onboarding and the microphone check**, boards 1a–1q. Eight check
      states including *no microphone hardware* and *insecure context*, both of
      which are nobody's fault and must not read as though they were.
- [ ] **C8 — Session screen, every state**, board 2. Prompt, listening,
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
