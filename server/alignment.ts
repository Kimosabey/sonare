/**
 * Expected versus heard, decided by us rather than by the vendor.
 *
 * Azure's miscue detection already reports `Omission` and `Insertion` per
 * word, and it works — 57 omissions and 5 insertions across the 401 words
 * currently on disk. This module is not here to replace that. It is here for
 * the three things Azure's per-word verdict cannot give:
 *
 *  - **Substitution as one event.** Azure has no Substitution error type. A
 *    learner who says "café" where "croissant" was expected produces an
 *    omission and an insertion that nothing pairs, so the report says two
 *    things went wrong when one did.
 *  - **Repeated words.** Nothing detects them anywhere. A learner who stumbles
 *    and repeats a word has done something specific, and "extra word" is not
 *    what happened.
 *  - **A second opinion.** Alignment against the reference was a vendor
 *    judgement with nothing to check it against.
 *
 * That third justification has now been measured, and it came out at zero.
 * Run over the 129 scored attempts on disk (`npm run alignment-report`),
 * Azure's word-presence verdict and this alignment agree on **every single
 * take** — 100%, no disagreements in either direction. Azure was already
 * right about which words were said, every time.
 *
 * So this module earns its place on the first two reasons and not the third:
 * 2 of 129 takes (1.6%) carry a substitution or a repetition that Azure has
 * no error type for. That is a real gap and a small one, and it is worth
 * saying plainly rather than leaving the "second opinion" claim standing.
 *
 * Two caveats keep the 100% from being the last word. The transcripts are
 * Azure's own, so what was measured is Azure's internal consistency between
 * its transcript and its miscue verdict — not whether either matches the
 * audio. And the trail is thin: 79 of those takes are English smoke tests, 49
 * are French, the median take is 1.0 seconds, and three shipped languages have
 * no real attempts at all. A human-confirmed fixture run is the only thing
 * that can settle it.
 *
 * Pure and dependency-free on purpose: no DOM, no I/O, no provider types. The
 * route can call it, a test can call it, and a future fixture analysis can
 * call it over stored attempts without standing anything up.
 */

/**
 * What happened to a word the learner was asked to say.
 *
 * `numeric` is not a fault. Azure transcribes spoken numbers as digits — "3"
 * for "three", "32" for "trente-deux" — so a learner who says the number
 * correctly produces a token that cannot be compared with the reference
 * without a number-word table for every shipped language. Calling that a
 * substitution told them they got it wrong; this says we could not check.
 *
 * Found by running the alignment over the 139 real attempts on disk, where
 * "Il y a trente-deux étudiants" against "Il y a 32 étudiants" read as a
 * missing word plus a substitution. The French set ships "Il y a quarante-deux
 * personnes à la réunion", so this is live content, not an edge case.
 */
export type TokenStatus = "match" | "missing" | "substituted" | "numeric";

export interface AlignedToken {
  /** The reference word as written, for display. */
  expected: string;
  status: TokenStatus;
  /** What was heard in its place. Present only for a substitution. */
  heard?: string;
}

export interface ExtraToken {
  /** The word that was heard but not asked for. */
  heard: string;
  /**
   * True when it duplicates the word before it. A stumble is a different
   * event from saying a word that was never in the phrase, and the advice
   * differs: one is "you said that twice", the other is "that word is not in
   * this sentence".
   */
  repeated: boolean;
  /**
   * How many reference words had been accounted for when this was heard, so
   * the extra can be shown in the right place rather than in a list at the end.
   */
  afterExpectedIndex: number;
}

export interface Alignment {
  tokens: AlignedToken[];
  extras: ExtraToken[];
  matched: number;
  missing: number;
  substituted: number;
  /** Extras that are not repetitions. */
  extra: number;
  repeated: number;
  /**
   * Aligned pairs where one side wrote a number in digits and the other in
   * words. Counted separately from every fault, because it is not one — and
   * reported rather than hidden, so a take containing one is known to carry a
   * word verdict we could not fully check.
   */
  numericForms: number;
  /**
   * Matched words over the reference words we could actually check — numeric
   * forms are excluded from the denominator rather than counted as misses,
   * since we do not know either way. Null when nothing was checkable.
   *
   * Deliberately *not* called a score: it counts words, and says nothing about
   * how any of them were pronounced. That is Azure's job and conflating the
   * two is the mistake this whole product exists to avoid.
   */
  wordCoverage: number | null;
}

/**
 * Splits on whitespace, hyphens and apostrophes.
 *
 * Hyphens and apostrophes are word boundaries here because the languages
 * shipped make them one: "allez-vous" is two words a learner can get
 * separately right or wrong, and treating it as one token would report a
 * single failure for a correct "allez" and a missed "vous". The same applies
 * to "j'habite" and "L'addition".
 *
 * Written as escapes rather than literals so the class is readable and does
 * not trip the irregular-whitespace rule. The two it covers beyond `\s` are
 * deliberate: French typography puts a no-break (U+00A0) or narrow no-break
 * (U+202F) space before "?" and "!", and the activity targets are written that
 * way — a literal space class would leave "vous\u202f?" as one token. The
 * dash range covers the typographic hyphens content and transcripts disagree
 * about, and both apostrophe forms for the same reason.
 */
const TOKEN_SPLIT = /[\s\u00a0\u202f\u2010-\u2015\-'\u2018\u2019]+/u;

/**
 * Punctuation and symbols, stripped from token edges.
 *
 * Marks (`\p{M}`) are kept, and that is not a detail. A Devanagari matra is a
 * Mark, not a Letter — so a set of "letters and digits" treats the vowel sign
 * ending most Hindi words as trailing punctuation and removes it, turning
 * नमस्ते into नमस्त. Every Hindi word comparison would then mismatch, in the
 * one language that also has no syllable names to fall back on.
 *
 * Latin diacritics are Marks too, but they are already gone by this point:
 * the combining block is stripped first, deliberately, so folding an accent
 * and preserving a matra are two separate decisions rather than one blunt one.
 */
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu;

/** Latin/Greek/Cyrillic combining diacritics only. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Comparison form of one word.
 *
 * Accents are folded so "cafe" and "café" compare equal — the reference is
 * written with them and a transcript may not be, and a missing acute is not
 * the learner mispronouncing anything.
 *
 * Only the combining-marks block is stripped, never a blanket NFD flatten:
 * Devanagari matras are separate code points that carry the vowel, so
 * removing them would turn "नमस्ते" into a different word and every Hindi
 * comparison into a mismatch.
 */
export function normaliseWord(word: string): string {
  return word
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(EDGE_PUNCTUATION, "")
    .toLocaleLowerCase();
}

/** Reference or transcript text as comparable words, empties dropped. */
export function tokenise(text: string): string[] {
  return text
    .split(TOKEN_SPLIT)
    .map(normaliseWord)
    .filter((word) => word.length > 0);
}

/** The raw words, in step with `tokenise`, so display keeps the original spelling. */
function tokeniseRaw(text: string): string[] {
  return text
    .split(TOKEN_SPLIT)
    .map((word) => word.replace(EDGE_PUNCTUATION, ""))
    .filter((word) => normaliseWord(word).length > 0);
}

/** All digits, ignoring separators a transcript may add ("08h15", "1,000"). */
const NUMERIC = /^[\d\u0966-\u096f][\d\u0966-\u096f.,:hH]*$/u;

/**
 * True when one side wrote a number as digits and the other did not.
 *
 * Devanagari digits are included in the range because a Hindi transcript can
 * use them, and a mismatch there is the same non-fault as the Latin case.
 */
function numericFormDiffers(expected: string, heard: string): boolean {
  return NUMERIC.test(expected) !== NUMERIC.test(heard);
}

type Op = "match" | "substitute" | "delete" | "insert";

/**
 * Needleman–Wunsch over word sequences with unit costs.
 *
 * Equal costs matter: a substitution costs 1 while a deletion plus an
 * insertion costs 2, so the alignment prefers to call a swapped word one
 * substitution rather than two separate faults. That preference is the whole
 * reason this exists rather than a set difference.
 */
function align(expected: string[], heard: string[]): Op[] {
  const rows = expected.length + 1;
  const cols = heard.length + 1;
  const cost = new Int32Array(rows * cols);
  const at = (r: number, c: number): number => r * cols + c;

  for (let r = 1; r < rows; r++) cost[at(r, 0)] = r;
  for (let c = 1; c < cols; c++) cost[at(0, c)] = c;

  for (let r = 1; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      const same = expected[r - 1] === heard[c - 1];
      const diagonal = (cost[at(r - 1, c - 1)] ?? 0) + (same ? 0 : 1);
      const up = (cost[at(r - 1, c)] ?? 0) + 1;
      const left = (cost[at(r, c - 1)] ?? 0) + 1;
      cost[at(r, c)] = Math.min(diagonal, up, left);
    }
  }

  /**
   * Walk back from the corner, preferring a match, then a deletion or
   * insertion, and taking a substitution only last.
   *
   * The order matters only where several paths share the same optimal cost,
   * and there it decides between two readings of the same audio. Preferring
   * the diagonal on a tie produced a *cascade of shifted substitutions*:
   * heard "il fait très froid froid et pleut…" against "il fait très froid et
   * il pleut…" is ten words either way, so three substitutions cost exactly
   * what one repetition plus one omission plus one substitution costs — and
   * the diagonal reading blamed "et" and "il", two words the learner said
   * perfectly, while missing the doubled "froid" entirely.
   *
   * Deferring substitution on a tie takes the other reading. It costs nothing
   * where a substitution is genuinely cheaper — one swapped word is cost 1
   * against 2 for a delete plus an insert, which is not a tie — so a real
   * substitution is still reported as one.
   */
  const ops: Op[] = [];
  let r = expected.length;
  let c = heard.length;
  while (r > 0 || c > 0) {
    const here = cost[at(r, c)] ?? 0;
    const diagonal = r > 0 && c > 0 ? cost[at(r - 1, c - 1)] ?? 0 : Number.POSITIVE_INFINITY;
    const same = r > 0 && c > 0 && expected[r - 1] === heard[c - 1];

    if (same && here === diagonal) {
      ops.push("match");
      r -= 1;
      c -= 1;
      continue;
    }
    if (r > 0 && here === (cost[at(r - 1, c)] ?? 0) + 1) {
      ops.push("delete");
      r -= 1;
      continue;
    }
    if (c > 0 && here === (cost[at(r, c - 1)] ?? 0) + 1) {
      ops.push("insert");
      c -= 1;
      continue;
    }
    ops.push("substitute");
    r -= 1;
    c -= 1;
  }

  return ops.reverse();
}

/**
 * Compares what the learner was asked to say with what the provider heard.
 *
 * `heard` is Azure's own transcript. An empty one is the honest input for a
 * take that produced no speech, and it yields every reference word missing
 * rather than an error — the caller decides whether that is worth showing,
 * since an indeterminate take should not be described as a wrong answer.
 */
export function alignSpoken(expectedText: string, heardText: string): Alignment {
  const expected = tokenise(expectedText);
  const expectedRaw = tokeniseRaw(expectedText);
  const heard = tokenise(heardText);
  const heardRaw = tokeniseRaw(heardText);

  const ops = align(expected, heard);

  const tokens: AlignedToken[] = [];
  const extras: ExtraToken[] = [];
  const counts = { matched: 0, missing: 0, substituted: 0, extra: 0, repeated: 0, numericForms: 0 };
  let e = 0;
  let h = 0;

  for (const op of ops) {
    if (op === "match") {
      tokens.push({ expected: expectedRaw[e] ?? expected[e] ?? "", status: "match" });
      counts.matched += 1;
      e += 1;
      h += 1;
      continue;
    }
    if (op === "substitute") {
      const expectedWord = expected[e] ?? "";
      const heardWord = heard[h] ?? "";
      // A digits-versus-words pair is not a fault, so it is neither a match
      // nor a substitution — it is a comparison we could not make.
      const numeric = numericFormDiffers(expectedWord, heardWord);
      tokens.push({
        expected: expectedRaw[e] ?? expectedWord,
        status: numeric ? "numeric" : "substituted",
        heard: heardRaw[h] ?? heardWord,
      });
      if (numeric) counts.numericForms += 1;
      else counts.substituted += 1;
      e += 1;
      h += 1;
      continue;
    }
    if (op === "delete") {
      tokens.push({ expected: expectedRaw[e] ?? expected[e] ?? "", status: "missing" });
      counts.missing += 1;
      e += 1;
      continue;
    }

    /**
     * An insertion that sits next to an identical word is a stumble, not a
     * word from outside the phrase.
     *
     * Checked on *both* sides. Given "bonjour bonjour" against one expected
     * "bonjour", the aligner is free to match either half and call the other
     * the extra, and it picks the first — so looking only backwards finds
     * nothing before it and reports a stray word. Which of an identical pair
     * the aligner happened to choose is an implementation detail; that the
     * learner said it twice is the fact.
     *
     * Compared against the heard sequence rather than the reference, because
     * a phrase that legitimately repeats a word ("à la prochaine à bientôt")
     * has that word matched, not inserted, and never reaches here.
     */
    const word = heard[h] ?? "";
    const repeated = heard[h - 1] === word || heard[h + 1] === word;
    extras.push({
      heard: heardRaw[h] ?? word,
      repeated,
      afterExpectedIndex: e,
    });
    if (repeated) counts.repeated += 1;
    else counts.extra += 1;
    h += 1;
  }

  return {
    tokens,
    extras,
    ...counts,
    // Numeric forms leave the denominator, not the numerator: we do not know
    // whether the learner said them right, and assuming either way would be
    // inventing a result.
    wordCoverage:
      expected.length - counts.numericForms <= 0
        ? null
        : counts.matched / (expected.length - counts.numericForms),
  };
}
