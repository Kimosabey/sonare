/**
 * What a class is told about a pupil, and what it is never given.
 *
 * Board 1c and 1h. This file exists before any teacher feature does, and that
 * is the point: a constraint written down after the data is already flowing is
 * a policy, and a policy is a setting somebody can change. Written first, it is
 * the shape the feature has to be built to fit.
 *
 * ## One list, two screens
 *
 * The board is explicit that the pupil sees "the same one the teacher was
 * shown, so neither side is told a different story". Two hand-written lists
 * would agree on the day they were written and drift at the first change —
 * and the drift would be invisible, because nobody reads both screens at once.
 * So there is one list here and both sides render it.
 *
 * A pupil can therefore *check* the promise rather than take it, which is what
 * board 1h's right-hand panel is for.
 *
 * ## The three that are not switches
 *
 * Scores, recordings and any ranking are not withheld by configuration. They
 * are absent from what a class view is given, so there is no setting that
 * could reveal them. `FORBIDDEN_IN_CLASS_VIEW` names them and
 * `promise.test.ts` asserts they cannot appear in the shape a class view
 * receives — which is a test that fails the moment somebody adds the field,
 * long before a screen renders it.
 */

/** Something a class can see about a pupil. In a pupil's words, not a schema's. */
export interface SharedFact {
  /** Rendered on both the teacher's limits panel and the pupil's own screen. */
  label: string;
  /** Why it is shared at all — a teacher needs it to teach. */
  because: string;
}

/** Something a class is never given, and the reason it is not a setting. */
export interface WithheldFact {
  /**
   * What is being withheld, as an identifier rather than as a sentence.
   *
   * This is what ties the pupil's copy of the promise to the teacher's. The
   * two are worded for different readers — "Your scores, on anything" against
   * "Any pupil's pronunciation score" — so the only way to check that neither
   * side has quietly stopped denying something is to link them by key. An
   * earlier version of that test compared nouns and broke on a plural, which
   * is the kind of check that gets loosened until it catches nothing.
   */
  withholds: "scores" | "recordings" | "comparison" | "unjoined";
  label: string;
  /** What would go wrong if it were shared. */
  because: string;
}

/**
 * Shared, and this is the whole of it.
 *
 * Attendance and coverage, plus a first name if the pupil chose to give one.
 * Everything here is a fact about *whether* a pupil practised, never about how
 * well — which is the line the rest of this file exists to hold.
 */
export const SHARED_WITH_CLASS: readonly SharedFact[] = [
  {
    label: "The days you practised",
    because: "A teacher can see who has been away from it, which is the thing they can act on.",
  },
  {
    label: "Which lessons you have done",
    because: "So a class can be taught what it has actually reached.",
  },
  {
    /**
     * Added when board 1g was built, because that screen shows a teacher which
     * sounds each pupil is working on — and this list, which is what a pupil
     * is shown before agreeing, did not mention it. The board's rule is that
     * neither side is told a different story, and the side that was wrong was
     * this one.
     *
     * Shareable because it is not a figure: which sounds, never how well. The
     * teacher's own screen says so in those words.
     */
    label: "Which sounds you are working on",
    because:
      "So a teacher can see whether the class is stuck on the same sounds, and teach them.",
  },
  {
    label: "Your first name, if you gave one",
    because: "So a teacher can talk to you rather than to a row in a table.",
  },
];

/**
 * Never shared, and not by configuration.
 *
 * Each of these is absent from the data a class view is given. There is no
 * administrator setting behind them, because there is nothing to switch on.
 */
export const NEVER_SHARED_WITH_CLASS: readonly WithheldFact[] = [
  {
    withholds: "scores",
    label: "Your scores, on anything",
    because:
      "A pronunciation score is a judgement about a person's voice, and a class that could see one would sort by it.",
  },
  {
    withholds: "recordings",
    label: "Recordings of your voice",
    because: "A recording never leaves your own record — not to a teacher, not to anyone.",
  },
  {
    withholds: "comparison",
    label: "How you compare to anyone else",
    because: "Nothing is stored that a comparison could be built from.",
  },
];

/**
 * The same promise, in the teacher's voice — board 1a.
 *
 * Two lists rather than one because the teacher sees things the pupil lists
 * do not mention: group difficulty is derived from many pupils and belongs to
 * none of them, so it has no pupil-side counterpart to appear beside.
 *
 * What must hold, and `promise.test.ts` holds it, is the *negative* side.
 * Everything a pupil is promised is never shared has to appear in what the
 * teacher is told they will not see. The board's rule is that neither side is
 * told a different story, and the way that breaks is not a teacher list that
 * says too little — it is one that quietly stops denying something the pupil
 * was promised.
 */
export const TEACHER_WILL_SEE: readonly SharedFact[] = [
  {
    label: "Which sounds the class finds hard, as a group",
    because: "It is the one thing here that changes what you teach next.",
  },
  {
    label: "The words those sounds show up in",
    because: "So the lesson can be built from phrases the class has already met.",
  },
  {
    label: "Who has practised, and when",
    because: "Attendance is a fact about turning up, not about how well anyone spoke.",
  },
  {
    label: "Which lessons the class has been through",
    because: "So a class can be taught what it has actually reached.",
  },
  {
    label: "Which sounds each pupil is working on",
    because:
      "Which sounds, never how well — it is the one per-pupil fact on this screen, and it is not a measurement of them.",
  },
];

export const TEACHER_WILL_NOT_SEE: readonly WithheldFact[] = [
  {
    withholds: "scores",
    label: "Any pupil’s pronunciation score",
    because:
      "Whether this scorer is fair across accents has not been measured, so it does not put a number about a named child in front of you.",
  },
  {
    withholds: "comparison",
    label: "A class average or a ranking",
    because: "Nothing is stored that a comparison could be built from.",
  },
  {
    withholds: "recordings",
    label: "Recordings of a pupil’s voice",
    because: "A recording never leaves the pupil’s own record.",
  },
  {
    withholds: "unjoined",
    label: "Anything a pupil has not chosen to join",
    because: "Joining is the pupil’s decision, and nothing about them reaches you before it.",
  },
];

/**
 * Why there is no per-pupil figure, in the words the board uses.
 *
 * Unparaphrased on purpose: this is copy that carries a constraint, and the
 * product's rule is that such copy is not reworded. It is also the paragraph
 * that stops a teacher spending a week looking for a gradebook.
 */
export const WHY_NOT_PER_PUPIL = [
  "A number attached to a child’s accent, shown to the adult who grades them, is the one use of this scorer that could do real harm — and the accent fairness needed to rule that out has not been measured. Group difficulty answers the teaching question anyway: what do I reteach on Monday.",
  "If that measurement is ever done and comes back clean, this decision can be revisited. Until then it is not a missing feature, it is the design.",
] as const;

/**
 * Field names a class view must never carry.
 *
 * Checked against the shape rather than the screen. A screen that does not
 * render a field it was given is one refactor away from rendering it; a shape
 * that never carries the field cannot.
 */
export const FORBIDDEN_IN_CLASS_VIEW: readonly string[] = [
  "accuracy",
  "best",
  "bestAccuracy",
  "score",
  "scores",
  "strength",
  "rank",
  "ranking",
  "position",
  "wav",
  "audio",
  "recording",
  "result",
  "attempts",
];

/** A teacher request, and the honest answer. Board 1h's left-hand panel. */
export interface ClassCapability {
  request: string;
  allowed: boolean;
  answer: string;
}

export const CLASS_CAPABILITIES: readonly ClassCapability[] = [
  {
    request: "Export the class's sound difficulty",
    allowed: true,
    answer: "Yes — a CSV of the group table, with nobody named in it.",
  },
  {
    request: "Export attendance",
    allowed: true,
    answer: "Yes — days practised, per pupil.",
  },
  {
    request: "See a pupil's pronunciation score",
    allowed: false,
    answer: "No — it is not stored against a class.",
  },
  {
    request: "Rank or sort the class by progress",
    allowed: false,
    answer: "No — there is nothing to rank on.",
  },
  {
    request: "Hear a pupil's recording",
    allowed: false,
    answer: "No — it never leaves their own record.",
  },
  {
    request: "Remove a pupil from the class",
    allowed: true,
    answer: "Yes — and they are told.",
  },
];

/**
 * Whether a candidate class-view payload carries anything it must not.
 *
 * Returns the offending paths rather than a boolean, because "something is
 * wrong" is not actionable and "`pupils[0].bestAccuracy`" is. Walks the whole
 * structure: a forbidden field three levels down is still a forbidden field,
 * and that is exactly where one would arrive from a careless spread.
 */
export function forbiddenPathsIn(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];

  if (Array.isArray(value)) {
    return value.flatMap((item, i) => forbiddenPathsIn(item, `${path}[${String(i)}]`));
  }

  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (FORBIDDEN_IN_CLASS_VIEW.includes(key)) found.push(here);
    found.push(...forbiddenPathsIn(child, here));
  }
  return found;
}
