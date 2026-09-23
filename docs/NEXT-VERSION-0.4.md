# 0.4.0 — the release that can be trusted

**Where we are:** `v0.3.0-alpha.1` tagged, 8 commits on top, every item in
0.3.0's definition of done met. Five languages ship, five gates green, browser
suite green on three engines.

No test count, deliberately — see `docs/VERSIONS.md`. It rots within a day and
a stale one stops people running the command that would tell them the truth.

**Written:** 2026-09-23.

---

## The thesis, and it is uncomfortable

0.3.0 made a built classroom reachable. It also shipped **five languages
resting on content nobody who speaks them has read**:

- Spanish has never had a native reader — true since before this cycle.
- The German per-sound advice was written on 21 September by somebody who does
  not teach German.
- Janvi was chosen as the Hindi voice from labels that had just been proven
  unreliable — every Kannada voice in the library is tagged `language=hi`.
- The ten Kannada phrases were written on 22 September by somebody who does not
  speak Kannada.
- The CEFR levels were authored without anyone who teaches to the framework.

Each was shipped with the caveat written into the file rather than buried, and
each is defensible on its own. Together they are a product whose central claim
is honesty, running on material its authors cannot vouch for.

**0.4.0 is where that stops being true.** Not more features on top — the
opposite. The one thing that would make 0.3.0's claims stand up.

A second reason, less moral and more commercial: **content depth is the
weakest dimension in the competitive analysis by a distance.** Competitors ship
hundreds of hours; French has 21 activities. Every honesty advantage is worth
nothing to a learner who finishes in a fortnight. Depth and verification are
the same project — you cannot add three hundred phrases nobody has checked.

---

## Part 1 — The gate on everything

### D3 · One reviewer per language

Unchanged, unmoved, and now holding five things instead of one. It is not an
engineering question and no amount of building goes round it.

`voice-check.html` is the surface and already carries **50 clips across five
languages**. A reviewer needs one sitting per language: listen to ten clips,
read ten phrases, say which are wrong.

**Recommended: one person per language, as a standing arrangement.** Borrowed
from Busuu, which answered this structurally rather than by hiring. French and
Spanish first — they are what a trial would be run in.

Until this happens, everything in Part 2 is building on sand.

---

## Part 2 — The work, once D3 moves

### 1 · Act on the review

Fix what comes back. This is the item everything else waits behind and it
cannot be scoped until somebody has looked.

### 2 · Depth, in the languages that have been reviewed

French to roughly fifty activities, Spanish behind it. Written against the CEFR
map that already exists, so the additions fill gaps rather than repeat A1
greetings.

**Not before the review.** Three hundred unchecked phrases is the current
problem at ten times the size.

### 3 · Publish the courses · **D5**

`COURSES` exists and reaches nobody: French has 21 activities against the
bundled 10, and publishing is a command nobody has run. One piece of work comes
with it — the model voice must regenerate at publish time, because the cache
key includes the content version, so course phrases generated at version 0 are
never found.

### 4 · Load a language's activities with the language — **measured, and deferred to six**

Measured 2026-09-23 rather than assumed, and the numbers say not yet:

| | |
|---|---|
| Entry chunk | **48,162 B gzipped** |
| All five language sources together | **7,005 B gzipped**, including comments and TypeScript that never ship |
| Realistic saving from lazy loading | **3–4 KB of 48 KB — about 7%** |
| Cost | `LANGUAGES` is consumed synchronously by **12 source files and 27 test files**, including the server and the path that feeds the scorer |

A 39-file refactor turning a synchronous API async, in the scoring path, for
7% of one chunk. Not worth it at five languages.

**Worth it at six**, because by then the ceilings have moved three times and
have stopped measuring anything except how many languages have shipped. So the
trigger is enforced rather than remembered: `perf-budgets.test.ts` fails on a
sixth eager language and says what to do instead. Raising that number is the
move it exists to prevent.

### ✅ 5 · Show the syllabus — **done 2026-09-23**

`CourseSyllabus` on the teacher board, from the same resolver a learner reads —
so a teacher sees the syllabus for content their pupils can actually reach,
never for whatever is newest in the repository.

It takes activity ids and no learner, deliberately. A CEFR level is exactly the
kind of figure that invites "Maya is A2", which is what the class boundary
exists to keep off this screen, so the wrong version is unbuildable rather than
merely discouraged. It states its own ceiling too: nothing goes beyond A2, and
a department buying for a B1 cohort should learn that here rather than in the
first lesson.

### ✅ 6 · A verification surface for diagrams — **done 2026-09-23**

`scripts/diagram-check.mjs` builds it; sixteen diagrams are generated and
waiting in `diagram-cache/`. Each sits beside its sound, its syllables, the
substitution an English speaker makes and the advice it is meant to illustrate,
with the three questions a reviewer is actually being asked.

They are **out of `public/` on purpose**: unreviewed content in the build is
shipped content, and they are ~890 KiB each — sixteen is 14 MB against a
144 KiB learner bundle, so they need re-encoding before shipping even if every
one is correct. Both facts were caught by the perf budget within a minute of
them landing in the wrong place.

Still needs a reviewer who can judge phonetics. That part has not changed.

---

## Part 3 — Decisions still open

### D8 · Which market

The largest strategic question and still unanswered. ELSA teaches English to
speakers of other languages; this teaches French and Spanish to English
speakers, and those are not comparable markets. The mechanism is
language-agnostic — the scorer takes a locale — and the syllable problem that
degrades Hindi and Kannada as *taught* languages does not apply when the taught
language is English.

**No recommendation. It is a business decision** and it is here so it is asked
deliberately rather than settled by inertia.

### D9 · The Duolingo for Schools window

Duolingo for Schools sunsets **31 July 2027**; new accounts are already closed.
Those schools lose a *free* incumbent on a published date, and this product is
free.

**Recommended: aim at it.** It changes what to build first — a free
single-teacher tier and a fast join flow matter more than a site-licence
motion. The class and join-code machinery already exists.

---

## Part 4 — Definition of done for 0.4.0

1. Every shipped language has been read by somebody who speaks it, and what
   came back has been acted on.
2. French has enough content that a learner does not finish it in a fortnight.
3. The courses are published, and the model voice regenerates when they are.
4. A language's activities load with the language, and the three ceilings come
   back down.
5. What a course covers is visible in the product, not only in `cefr.ts`.
6. All five gates green, browser suite green on three engines.

---

## Part 5 — Deliberately out

- **The vowel chart.** Male voices 11–17 Hz error, female 327–368, child up to
  1087, against a 60 Hz tolerance. The gate refusing to draw it is correct.
- **Generated articulation diagrams**, until somebody can check one.
- **Engagement mechanics.** Not an omission — the position, and `verify.mjs`
  T16 fails the build on them.
- **A native app.** The web is the advantage: it runs on locked-down school
  fleets and Chromebooks, where a native app is not an option at all.

## Part 6 — Needs hands, not decisions

- **VoiceOver and TalkBack**, one activity each. Unautomatable, and the part of
  an accessibility claim that most deserves a person.
- **The accent fairness study** (T19) — whether the scorer is harder on some
  first languages than others.
- **Willingness to pay**, for when free ends. Competitor prices and our own
  unit costs are in `docs/COMPETITIVE-POSITION.md`; what a school would pay is
  not derivable from either.
