# 0.4.0 — the release that can be trusted

**Where we are:** `v0.3.0-alpha.1` tagged, 8 commits on top, every item in
0.3.0's definition of done met. Five languages ship. 4,459 tests pass, five
gates green, browser suite green on three engines.

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

### 4 · Load a language's activities with the language

The perf debt, now explicit. Three ceilings moved twice in two days — 932 B for
Hindi, 1,123 B for Kannada — and the comment in `perf-budgets.test.ts` says
that was the last time they may move for this reason.

**Every learner downloads every language's content.** A sixth language is a
third ceiling move, at which point the number measures nothing but how many
languages have shipped. The fix is lazy content per language, and it is a real
change rather than a tweak.

### 5 · Show the syllabus

`cefr.ts` maps every activity to a level and a can-do statement, and **nothing
renders it**. A head of department cannot see what the course covers without
reading the source. This is the cheapest commercial item on the list: the data
exists, the page does not.

### 6 · A verification surface for diagrams

Only after D3, and only if a reviewer can judge phonetics. The pipeline is
built and measured; what is missing is anybody able to say whether a tongue is
in the right place. See `scripts/generate-diagrams.ts`, which records the three
attempts and why none shipped.

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
