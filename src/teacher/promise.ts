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
    label: "Your scores, on anything",
    because:
      "A pronunciation score is a judgement about a person's voice, and a class that could see one would sort by it.",
  },
  {
    label: "Recordings of your voice",
    because: "A recording never leaves your own record — not to a teacher, not to anyone.",
  },
  {
    label: "How you compare to anyone else",
    because: "Nothing is stored that a comparison could be built from.",
  },
];

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
