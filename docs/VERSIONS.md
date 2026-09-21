# Where this product is, by version

The short answer, so nobody has to dig for it:

| | |
|---|---|
| **`package.json` says** | `0.3.0-alpha.1` |
| **Last git tag** | `v0.3.0-alpha.1` |
| **Branch** | `redesign/course-platform` |
| **Gates** | all five green · 4,403 tests pass, 1 expected fail, 3 skipped |
| **Browser suite** | 464 pass, 4 skipped, three engines |

The version was stale for a long time — `0.2.0-alpha.1` with **212 commits** on
top of it, so no bug report could be tied to anything. That is what
`v0.3.0-alpha.1` names.

---

## v0.1.0 — the proof of concept

The original question: can we replace the browser's Web Speech API with our own
capture pipeline and get real phoneme-level assessment out of Azure?

Answered yes. Capture in `src/speech/capture/`, framework-free, 16 kHz mono
16-bit PCM WAV, scoring behind `server/services/`. The twelve hard rules in
`docs/CLAUDE.md` come from this period and still hold.

## v0.2.0-alpha.1 — the learner's product

87 commits. The POC became something a learner could use: sessions, progress,
a streak that counts attendance only, the indeterminate path, the vowel work,
the offline floor.

## v0.3.0-alpha.1 — the classroom release

The largest body of work in the project, and for a long time it had no name.
Broadly four things:

**A course platform.** Content gained a spine — language, unit, lesson,
activity — and the scheduler gained the sound mapping it had been waiting for.
Content became versioned and immutable, published rather than edited, with an
authoring screen and a publish gate. Six activity kinds now exist where there
were two.

**A classroom.** Classes, join codes, and the boundary that is the product's
second-strongest claim: a teacher receives standings and never a pupil's score,
because the conversion happens before the figure crosses. A pupil sees the
consequences before agreeing, can join without their name, and can leave or
remove their name at any time.

**A real client.** Ten stylesheets, a navigation shell that becomes a bar, a
rail and a sidebar, offline practice that survives the network coming back, a
PWA that installs and serves itself with the network cut, and browser tests on
three engines at four widths.

**The honesty machinery.** The refusals that are now the positioning: an
unusable take costs nothing, a vowel chart that is built and withheld, two
languages held back rather than scored hollowly, and — as of today — a build
that fails on a leaderboard.

### What landed on 18 September specifically

Worth separating, because it was mostly defect work and the defects say
something about the method:

- **Safari discarded the declared 44px floor on every `<select>`** — 28px on
  the target platform, invisible to every gate.
- **A listening question was spending iOS's one microphone prompt.**
- **A `locate` asked which sound was in a phrase the device could not play.**
- **One malformed row hid every class a pupil was in**, taking the only route
  to "leave" and "remove my name" with it.
- **The teacher board rendered two `<h1>`s** and had never had axe run on it.
- **`locate` shipped in no course**, so no learner would ever have met one.
- **T16** — the anti-gamification constraint became a build failure rather than
  a claim. The checklist had asserted a verifier rule for months; there was
  none.

Every one was invisible to a passing test suite and visible only to something
that rendered or drove the real thing.
