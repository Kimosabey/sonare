/**
 * The pupil list — Teacher board 1g.
 *
 * This is the one payload in the teacher view that names individuals, and it
 * is therefore the one that has to be most careful about what it names them
 * *with*. The board's framing: "The list carries attendance and what each
 * pupil is working on — no figure, so no ordering by attainment is possible."
 *
 * Three facts per pupil, and each one earns its place:
 *
 * - **attendance**, which is whether they turned up, not how they did
 * - **which sounds they are working on**, as graphemes — the board is explicit
 *   that this is "which sounds, not how well"
 * - **capture health**, which is a fact about a microphone and a room
 *
 * That third one is the reason this file is interesting. "Six of Ben's last
 * eight takes came back unusable" is not a judgement of Ben; it is the R8
 * indeterminate count, which exists precisely because the product refuses to
 * score audio it could not hear. The board calls it "the one thing on this
 * screen that might explain a pupil quietly giving up" — and it is safe to
 * show a teacher for the same reason it is safe to show the learner: nobody
 * is being told how well anybody spoke.
 *
 * ── the ordering is the safeguard ──────────────────────────────────────────
 *
 * Alphabetical, always, and the board labels it "the only order there is".
 * That is not a default; it is the mechanism. A list that could be ordered by
 * anything else would need something to order it *by*, and the entire teacher
 * view exists without that. Sorting is therefore not a feature this file
 * declines to offer — there is nothing here it could sort on.
 */

import type { Skill } from "./merge.js";
import type { ProgressEntry } from "./merge.js";

/** How a pupil appears to their teacher, per the class's own setting. */
export type NameVisibility = "first-name" | "anonymous";

export interface PupilRecord {
  learnerId: string;
  /** The name they chose to share, or null if they joined without one. */
  sharedName: string | null;
  skills: readonly Skill[];
  progress: readonly ProgressEntry[];
  /** Takes that came back unusable — R8 indeterminate, not low scores. */
  unusableTakes?: number;
  /** Takes in the same window, so the first number has a denominator. */
  totalTakes?: number;
}

export interface PupilRow {
  /**
   * What the teacher sees. A real name when the pupil shared one, otherwise a
   * stable positional label.
   *
   * Never the learner id. The board's own list shows "Pupil 4" beside four
   * named pupils and says it "joined without a name, which is their right and
   * needs no explanation" — so the label has to read as an ordinary row rather
   * than as a gap somebody should go and fill.
   */
  label: string;
  /** True when this row is a positional label rather than a shared name. */
  anonymous: boolean;
  /** Days practised, most recent first. */
  days: string[];
  /** ISO day of the most recent practice, or null. */
  lastPractised: string | null;
  /** The sounds they are working on. Graphemes, never a figure. */
  workingOn: string[];
  /**
   * Unusable takes out of total, when there are enough to mean anything.
   *
   * Null below `MIN_TAKES_FOR_CAPTURE_HEALTH`. Two bad takes out of two is a
   * ratio of one, and shown to a teacher it reads as a broken microphone when
   * it is a pupil who has practised twice.
   */
  capture: { unusable: number; total: number } | null;
}

/**
 * Below this many takes, a ratio of unusable ones says more about the sample
 * than about the microphone.
 */
export const MIN_TAKES_FOR_CAPTURE_HEALTH = 5;


/**
 * Builds the roster, alphabetically, with no figure anywhere in it.
 *
 * Pupils without a shared name are labelled by their position in the finished
 * order, so the labels stay stable for a given class and never leak the order
 * somebody joined in — which would be a fact about them that nobody agreed to
 * share.
 */
export function buildRoster(
  pupils: readonly PupilRecord[],
  visibility: NameVisibility = "first-name",
): PupilRow[] {
  const named = pupils.map((pupil) => {
    const days = [...new Set(pupil.progress.map((entry) => entry.at.slice(0, 10)))].sort().reverse();

    const workingOn = pupil.skills
      .filter((skill) => skill.samples.length > 0)
      .map((skill) => skill.grapheme)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const total = pupil.totalTakes ?? 0;
    const unusable = pupil.unusableTakes ?? 0;

    return {
      sharedName: visibility === "anonymous" ? null : pupil.sharedName,
      anonymous: visibility === "anonymous" || pupil.sharedName === null,
      days,
      lastPractised: days[0] ?? null,
      workingOn,
      capture: total >= MIN_TAKES_FOR_CAPTURE_HEALTH ? { unusable, total } : null,
    };
  });

  // Named pupils sort by name; unnamed ones follow, and only then are numbered
  // — so a label never encodes where somebody sat in an earlier ordering.
  const withNames = named
    .filter((row) => row.sharedName !== null)
    .sort((a, b) => ((a.sharedName ?? "") < (b.sharedName ?? "") ? -1 : 1));
  const withoutNames = named.filter((row) => row.sharedName === null);

  return [
    ...withNames.map((row) => ({ ...row, label: row.sharedName ?? "", anonymous: false })),
    ...withoutNames.map((row, index) => ({
      ...row,
      label: `Pupil ${index + 1}`,
      anonymous: true,
    })),
  ].map(({ sharedName: _sharedName, ...row }) => row);
}
