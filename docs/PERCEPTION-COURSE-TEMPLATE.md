# Authoring a perception course

**For a language the scorer cannot assess.** Fill this in and the course can be
built; nothing here needs a developer to decide.

## Why this exists

Sonare scores pronunciation at phoneme level. For Kannada, Azure returns **0 of
0** syllable graphemes on every phrase measured; for Hindi, **0 of 7**. A score
is still returned — around 100 — but there is no sound to point at. Shipping
that would mean telling a learner "78" and being unable to say which sound to
fix, which is the one thing this product exists to do.

Two activity kinds ask nothing of the scorer and nothing of the microphone:

| Kind | What the learner does | Needs |
|---|---|---|
| `listen` | Hears a phrase, picks which of several written phrases it was | Near-miss phrases you write |
| `locate` | Hears a phrase, picks which sound was in it | Syllables you name |

A course made only of these is honest in any language ElevenLabs can speak: it
teaches **hearing** the difference and never claims to measure production.

`src/learning/perceptionCourse.test.ts` proves such a course publishes,
composes a real question for every activity, and produces a sitting.

**One limitation, up front.** A perception course gets no spaced repetition.
Nothing in it produces an accuracy, so no sound ever becomes due and the
sitting is simply the content in order. That is asserted in the test above so
it cannot be discovered late.

## What to supply

### Every activity needs

| Field | What it is |
|---|---|
| `title` | A few words naming the activity, in English |
| `prompt` | What the learner is being asked to do, in English |
| `gloss` | What the phrase means, in English |
| `target` | **The phrase, in the language.** At most **14 words** |
| `focus` | One line on what it teaches, in English |

The phrase is what the voice will say and what the learner will hear. It is the
only field in the language itself — everything else is interface text.

### A `locate` also needs `soundTargets`

One or more syllables, written in the language's own script, **each of which
actually occurs in that activity's own phrase**. This is checked: a syllable
that does not appear in its phrase is refused at publish.

The wrong answers are not written by you. They are drawn automatically from
syllables *other* phrases in the course drill, choosing only ones absent from
this phrase. Two consequences:

- The course needs **at least 4 distinct syllables** across all its activities,
  or no question can be composed.
- The more phrases share a syllable, the better the distractors get.

### A `listen` also needs `distractors`

**1 to 3** near-miss phrases, in the language. These are the wrong answers, and
they are the whole activity — the difficulty is entirely in how near the misses
are.

A good near-miss differs in **one sound**, the sound being taught. If a learner
can tell them apart by length, by an obviously different word, or by meaning
alone, the activity tests reading rather than hearing. This is the part no
machine can check and the reason this file exists.

## The shape, filled in

Nonsense words below — replace every `target`, `soundTargets` and `distractors`
with real ones.

```ts
{
  id: 1,
  title: "Hearing the retroflex",
  kind: "locate",
  prompt: "Listen, then choose which sound was in the phrase.",
  gloss: "Where is the station?",
  target: "<the phrase, in the language>",
  focus: "Telling the retroflex from the dental by ear",
  soundTargets: ["<a syllable that occurs in the phrase above>"],
},
{
  id: 2,
  title: "Two words a beat apart",
  kind: "listen",
  prompt: "Listen, then choose which phrase you heard.",
  gloss: "I would like some water.",
  target: "<the phrase, in the language>",
  focus: "One sound apart, and which one",
  distractors: ["<the same phrase with one sound changed>"],
},
```

## Rules a publish will enforce

- A phrase is at most **14 words** — past that the capture ceiling cuts it off
- A `listen` carries **1–3** distractors; no other kind may carry any
- A `locate`'s `soundTargets` must occur in its own phrase
- Ids are whole numbers, unique, and never renumbered once published
- A lesson is **3 to 6** activities
- Two activities that *record* may not share a phrase. Silent kinds are exempt —
  reuse is how they work, and a `locate` on a phrase the course already teaches
  is the point rather than a duplicate

## Before it ships

The voice is generated from your phrases, and **a mispronounced clip is worse
than no clip**: every learner copies the error. `eleven_v3` returns HTTP 200 for
text it mispronounces, so nothing in the pipeline can detect it.

Run `node scripts/voice-check.mjs` and open `voice-check.html` — it puts every
generated clip next to the phrase it is meant to be saying. Someone who speaks
the language has to listen to all of them. That is the only detector there is.
