# Design data — draw against this, not against placeholders

Real figures from the **139 stored attempts** in this repository. Attach this
alongside `CLAUDE-DESIGN-PLAN.md`.

Extracted deliberately narrowly: reference phrases (which are our own content),
scores, and error types. **No session ids, no device fingerprints, no learner
ids, no timestamps, no audio.** Nothing here identifies anybody.

Everything below is measured. Where a design decision follows from it, the
decision is stated.

---

## 1. The single most important number

**The median real score is 95.2.**

| | |
|---|---|
| n | 129 scored attempts (10 more were indeterminate) |
| min | 0 |
| 25th percentile | **82** |
| median | **95.2** |
| 75th percentile | 99.4 |
| max | 100 |
| below the pass mark of 60 | **17 of 129 — 13%** |

### What this means for design

**Do not design a 0–100 instrument.** A gauge, dial or progress arc that looks
considered at 50 spends nine tenths of its range on scores that almost never
occur, and squeezes the range that actually matters into a sliver.

**The interesting band is 80–100.** A learner's real experience is the
difference between 88 and 96, and a design must make that legible. The
difference between 12 and 20 is decoration.

**82 must not look like failure.** It is the 25th percentile — one take in four
is at or below it — and it is comfortably a pass. A red-amber-green treatment
calibrated for a 0–100 spread will paint a quarter of all successful attempts
in a warning colour.

A defensible approach: a scale that is honest about where the mass is, or no
scale at all — the syllable chips carry the actionable information, and the
number is a summary. This product already removed the pass threshold from the
activity screen deliberately, so the score is context rather than a verdict.

---

## 2. Real results, verbatim

Three real French attempts. Word scores and error types exactly as the provider
returned them.

```
"Bonjour, comment allez-vous"              overall 71.2
    Bonjour       85   None
    comment       97   None
    allez-vous    54   Mispronunciation
```

```
"Je m'appelle Marie et j'habite à Paris"   overall 97.0
    Je            97   None
    m'appelle     97   None
    Marie        100   None
    et            94   None
    j'habite      97   None
    à             97   None
    Paris         82   None
```

```
"Je voudrais un café et un croissant s'il vous plaît"   overall 95.8
    Je            97   None       voudrais     100   None
    un            94   None       café          97   None
    et            94   None       un            80   None
    croissant     82   None       s'il          85   None
    vous         100   None       plaît         97   None
```

### Design notes from these

- **Word scores cluster high too** — mostly 82–100, with the occasional
  genuine outlier. A word chip design must distinguish 94 from 97 without
  making either look alarming, and must still make 54 stand out.
- **The outlier is `allez-vous` at 54.** That is not a coincidence: the misses
  cluster on elision and hyphenation — `allez-vous`, `m'appelle`, `j'habite`,
  `quarante-deux`, `L'addition` — where the provider cannot map a grapheme
  across the boundary. Expect hyphenated and elided words to score low and to
  need the most explanatory room.
- **Ten words is a real phrase length.** The last example has ten word chips at
  a phone width. Design the wrapping, not a single row.
- A whole phrase can be 97 with one word at 82. The summary and the detail
  disagree by design, and both are true.

---

## 3. What is empty in production

**Phoneme labels come back blank for every locale this product ships.**

Measured across the three examples above: **0 of 14**, **0 of 23** and **0 of
28** phoneme labels populated. Every phoneme was *scored*; none was *named*.
Only `en-US` — reachable from the internal fixture screen — returns names.

**So do not design an IPA phoneme strip.** It will be an empty row in
production for French, Spanish, German, Hindi and Kannada.

The real per-sound surface is the **syllable chips**, which come from the
grapheme field and *are* populated — around 83% named for French, with the
unnamed ones falling on the same elision boundaries. For Hindi, none are named
at all, which is why a positional label ("1st", "2nd") is the entire
per-syllable experience there rather than a fallback for the odd miss.

---

## 4. The indeterminate state, with real reasons

**10 of 139 attempts — 7.2%, about one take in fourteen.** Common enough to be
a designed state, not an edge case.

The exact reasons, as stored:

| Count | Reason | What it means to a learner |
|---|---|---|
| 5 | `no speech found to assess — every word was omitted` | The microphone worked; nothing matched the phrase |
| 2 | `no speech recognised in the recording` | The microphone caught nothing usable |
| 3 | `provider cancelled (Error)` | Not the learner's fault at all |

### Design notes

- **Three distinct causes, and they deserve different copy.** Telling someone
  who spoke clearly to be louder sends them off to debug a microphone that is
  fine. The app already distinguishes "we heard you clearly, try slower" from
  "try a little louder or somewhere quieter" using the signal-to-noise reading.
- **The third kind is not about the learner.** A provider failure should not be
  phrased as anything the learner did.
- None of these may render as a score, a zero, or a failure. No attempt is
  spent, and nothing is celebrated.

---

## 5. Edge cases worth drawing

Every one of these exists in the real content or the real data.

| Case | Why it breaks a naive design |
|---|---|
| **`allez-vous` — 54 with `Mispronunciation`** | One bad word inside a phrase scoring 71. Both numbers are true and both must be visible. |
| **A ten-word phrase** | `"Je voudrais un café et un croissant s'il vous plaît"` at 360px wide. |
| **German compounds** | The longest targets are already at 244px of 280px available at a 320px width — 13% spare. One longer compound overflows, and `.phrase` currently has no `overflow-wrap`. |
| **Devanagari and Kannada** | Different script, no named syllables, and an untagged string is *skipped* by a screen reader rather than mispronounced. |
| **A word the learner never said** | `Omission`. Shows as `—` with "not said" — never a zero, because zero is a claim about pronunciation that nothing measured. |
| **A word not in the phrase** | `Insertion`. Shows as `+` with "extra". |
| **No model voice** | Hindi has no chosen voice, so the platform synthesiser handles it — and on a device with no Hindi voice the Listen control *hides* rather than lying. Design that absence. |
| **Never enough history** | `"not enough history yet"` is a real, frequent state on Progress — a trend needs more than five samples with at least two behind the window. |

---

## 6. Content scale, today and planned

| | Today | MVP target |
|---|---|---|
| Phrases per language | 10 | ~60 |
| Languages | 4 shipped, Kannada verified | 5 |
| Activity types in use | 2 of 3 declared (`repeat` 25, `respond` 16, `read` 0) | 4 |
| Units / lessons | none — a flat list | 3 units × 4 lessons |

Design the Journey screen for **three units of four lessons**, not for ten flat
items and not for a fifty-unit tree. And note that the session rail currently
spans all ten activities; a sitting is 4–6, which is what makes a finish line
possible.

---

## 7. Where these numbers came from

`server/data/attempts.jsonl` — the local fallback log written when MongoDB is
unreachable. 139 records: 84 `en-US`, 54 `fr-FR`, 1 `en-GB`. The English ones
are development and fixture runs; the French ones are real practice.

The distribution is therefore **small and skewed toward development use**, and
it should be re-measured once real learners have used the product. Treat the
median of 95.2 as a strong signal about where the mass sits and a weak one
about its exact value.
