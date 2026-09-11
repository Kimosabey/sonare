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

- [ ] **C1 — Content spine + the field everything waits on.**
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
- [ ] **C2 — PWA assets, and split the static budget.**
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

## Log

- 11 Sep 2026 — Queue created. Platform work is done and pushed on
  `revamp/platform`: 50 commits, 3240 tests + 1 expected fail + 3 soak-only
  across 143 files, all five gates green. Design handoff landed under
  `docs/design/`, all 38 tokens it names verified present.
