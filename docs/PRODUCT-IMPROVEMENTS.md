# Where this product should go next

Not a feature wishlist. Every item below is something I hit while building
Sonare, with the evidence that surfaced it and the file it lives in. They are
ordered by who they affect, not by effort.

---

## Tier 1 — who the product currently works for

### 1.1 The vowel chart works for adult men only

`MAX_TRUSTED_F0_HZ = 140` in `src/speech/capture/formants.ts`. Above that the
LPC fit latches onto a harmonic instead of the formant and F1 comes back wrong,
so the estimator refuses rather than lying — which is the right call and is
tested.

But look at who that excludes. Adult male F0 sits around 85–155 Hz. Adult
female is 165–255. Children are 250–400. **The corrective this product built —
board 2-1j, twenty tests against Peterson & Barney — is unavailable to
essentially every woman and every child who uses it.** The Teacher board is
about Year 9 pupils. Not one of them can see it.

The refusal copy is honest ("this measurement only works for lower-pitched
voices at the moment"), which makes it a known limitation rather than a bug.
It is still the single largest gap between what this product does and who it
is for.

*Shape of the work:* LPC is the wrong tool above ~140 Hz because the harmonics
are too far apart to interpolate a spectral envelope from. The usual answers
are cepstral smoothing, or closed-phase LPC synchronised to the glottal cycle,
or simply a much higher LPC order with heavy pre-emphasis. All three are
testable against the same Peterson & Barney fixtures already in the repo — the
accuracy suite would need female and child reference vowels added to it, which
Peterson & Barney also published.

*How to know it worked:* the existing sweep, rerun against female and child
references, with the same 60 Hz tolerance.

### 1.2 The scorer's accent fairness has never been measured

This is stated on the Teacher board as the reason a whole feature category does
not exist: "a class view is an authority figure holding a number about a child
produced by a scorer whose fairness across accents is unmeasured."

Everything downstream is shaped by that one unknown. There is no per-pupil
figure, no ranking, no sortable column — and the board is explicit that "if
that measurement is ever done and comes back clean, this decision can be
revisited."

So the measurement is worth more than any feature waiting behind it. It also
protects the product in the other direction: if the scorer *is* unfair across
accents, that is something worth knowing before a school deploys it, not after.

*Shape of the work:* a fixed phrase set, read by speakers of known L1
backgrounds, scored through the existing pipeline. The fixture runner
(`/fixture`) already exists to run exactly this kind of batch and record it.
The output is a per-accent distribution, and the question is whether the
distributions overlap.

### 1.3 Hindi cannot deliver the product's core promise

Measured: hi-IN returns **0 of 7** syllables named. Azure gives back empty
`Phoneme` labels for every locale this product ships, and syllable graphemes
are what the whole per-sound layer is keyed on. French names them 83% of the
time; Hindi names none.

So for Hindi there is no sound history, no scheduler input, no per-sound
advice, and no vowel chart. A learner gets an overall accuracy number and
nothing actionable — which is the product this was built not to be.

*Shape of the work:* either a locale-specific syllabifier that derives
graphemes from the target text and aligns them to the returned timings, or an
honest product decision that Hindi ships as a different, simpler thing. The
second is cheaper and more truthful than a half-working first.

---

## Tier 2 — promises the product half-keeps

### 2.1 The vowel chart shows a measurement with no target

`target` is `null` everywhere, because no content names the vowel a syllable is
aiming at. The chart draws where a learner's vowel sat against four landmarks,
which is interesting but not actionable: it says "here you are" and not "here
is where you were going".

*Shape of the work:* a per-language table of syllable → `{ipa, f1Hz, f2Hz}`.
This is authoring, not engineering, and it needs a phonetician rather than a
developer. `describeGap()` already exists and already has thresholds; it has
simply never been given a goal to compare against.

### 2.2 Three of the four "who this reaches" counts are unmeasurable

The publish diff names them as unrecorded rather than inventing them, which is
right. But "how many learners are in a sitting right now", "how many are
mid-lesson" and "how many are still on an older content version" are all
reasonable things for an operator to want, and none of them is recorded
anywhere.

*Shape of the work:* the client already resolves a content version and already
knows whether a sitting is open. Reporting either is a single field on an
existing sync call. The question worth asking first is whether an operator
actually needs them, or whether the one real count — who loses a started
activity — was always the only one that changed a decision.

### 2.3 Nothing is scored offline

A learner offline can practise, and their takes are held. They cannot be told
anything about them until they reconnect. The service worker, the held-takes
queue and the bundle fallback are all built; the gap is that scoring is a
network call by definition.

*Shape of the work:* probably not full offline scoring. More likely an honest
interim: a local capture-quality verdict (level, SNR, clipping, duration) is
already computed on device and could tell a learner "that take was clear" or
"the room was too loud, try again" without claiming a pronunciation score. That
is a real answer to the most common offline frustration, and it does not need a
provider.

---

## Tier 3 — content and scale

### 3.1 The Spanish course has never been read by a Spanish speaker

All 18 activities — phrases, glosses, focus lines, unit outcomes — were written
during implementation to have a second language to build against. French came
from an authored set. Spanish should not meet a learner until a native reader
has been through it.

### 3.2 Language scope was cut from five to two

`LANGUAGES = [FRENCH, SPANISH]`; `AUTHORED_SETS` holds four. German and Hindi
exist as content and are not offered. The onboarding picker is built for five
and shows two.

### 3.3 Authoring has no preview of a single activity

An author can preview the published language as a learner, which is the wrong
granularity: the thing they just edited is one activity, and checking it means
publishing or walking the whole course.

---

## Tier 4 — what the codebase has learned to check, and has not

Three defects this repository shipped were all the same shape: **a check that
reads what the source says cannot see what the source omits.**

- Every button was 42px, because the base rule had padding and no `min-height`,
  so NFR-03 had nothing to read.
- `VowelChart` and `formants.ts` were complete, tested, and imported by nobody.
- The guard written to catch *that* passed vacuously for months because it
  normalised paths wrongly and checked an empty list.

Each is now caught (`compositing.test.ts`, `reachable.test.ts`, the NFR-03
tap-floor rule). The pattern worth institutionalising is the third one: **every
guard needs a planted failure in its own test file**, or it is a green light
wired to nothing. Three of the checks in this repo now do that. The rest do
not.

*Shape of the work:* a convention, not a feature — each `verify.mjs` rule and
each structural test gets one case that plants the defect it exists to catch
and asserts the check fires.

---

## What I would do first

**1.1**, and not because it is the most interesting. Everything else on this
list improves a product that already works for its user. 1.1 is the item where
a girl in Year 9 taps the syllable her teacher told her to practise and is told
the measurement does not work for her voice.
