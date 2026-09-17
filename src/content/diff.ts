/**
 * What changes between two published versions of a language. Pure, no I/O.
 *
 * Platform board 1k. The board is explicit about what this is for: "publishing
 * never blocks and never reaches into a sitting in flight — a client holds the
 * version it resolved until the sitting ends. So this screen's job is not a
 * gate, it is making one irreversible case visible."
 *
 * That framing decides everything here. Nothing in this file refuses a
 * publish, scores a risk or blocks anything. It answers one question — *what
 * will this do to people who have already practised* — and the two answers
 * that matter are the two nobody notices until a learner does.
 *
 * ## The two that matter
 *
 * **A removed activity.** Its takes and sound history stay in the learner's
 * record; nothing is erased. But it stops resolving, so it disappears from
 * their lesson and from any outcome that counted it — a unit that read "4 of
 * 4" yesterday reads "3 of 3" today, and a can-do statement that rested on it
 * quietly rests on less.
 *
 * **A changed `target`.** Every other field is cosmetic to the learner's
 * record. `target` is not: the syllables an activity measures are derived from
 * the phrase, so changing it **re-keys the sound history** that activity has
 * been feeding. The old syllables stay in the store attached to nothing, and
 * the new ones start from no history at all. A gloss fixed for a typo is
 * harmless; the same edit one field to the left is not, and the two look
 * identical in a form.
 */

import type { Activity, LanguageActivitySet } from "../activities/types.js";

/** Where an activity sits, in the words an author uses. */
export interface ActivityLocation {
  unitId: number | null;
  unitTitle: string | null;
  lessonId: number | null;
  lessonTitle: string | null;
}

export interface AddedActivity {
  kind: "added";
  activityId: number;
  activity: Activity;
  where: ActivityLocation;
}

export interface RemovedActivity {
  kind: "removed";
  activityId: number;
  activity: Activity;
  where: ActivityLocation;
}

export interface ChangedField {
  kind: "changed";
  activityId: number;
  field: string;
  before: string;
  after: string;
  where: ActivityLocation;
  /**
   * True only for `target`, and it is the reason this type has a flag at all.
   * A changed phrase re-keys the syllables the activity measures, so the sound
   * history it has been feeding stops matching what it now asks for.
   */
  reKeysSoundHistory: boolean;
}

export type ContentChange = AddedActivity | RemovedActivity | ChangedField;

/** Fields worth diffing. `soundTargets` is compared separately, as a set. */
const COMPARED_FIELDS = ["title", "kind", "prompt", "gloss", "target", "focus"] as const;

function locate(set: LanguageActivitySet, activityId: number): ActivityLocation {
  for (const unit of set.units ?? []) {
    for (const lesson of unit.lessons) {
      if (lesson.activityIds.includes(activityId)) {
        return {
          unitId: unit.id,
          unitTitle: unit.title,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
        };
      }
    }
  }
  // A flat set, or an activity no lesson references.
  return { unitId: null, unitTitle: null, lessonId: null, lessonTitle: null };
}

/**
 * Every change from one version to the next, in a stable order.
 *
 * Ordered added → changed → removed rather than by activity id, because that
 * is the order of increasing consequence: an addition reaches nobody who has
 * already practised, a change may re-key a history, a removal takes something
 * out of a lesson somebody has finished. The screen reads top to bottom and so
 * does the risk.
 */
export function diffContent(
  before: LanguageActivitySet,
  after: LanguageActivitySet,
): ContentChange[] {
  const beforeById = new Map(before.activities.map((a) => [a.id, a]));
  const afterById = new Map(after.activities.map((a) => [a.id, a]));

  const added: AddedActivity[] = [];
  const changed: ChangedField[] = [];
  const removed: RemovedActivity[] = [];

  for (const [id, activity] of afterById) {
    if (!beforeById.has(id)) {
      added.push({ kind: "added", activityId: id, activity, where: locate(after, id) });
    }
  }

  for (const [id, was] of beforeById) {
    const now = afterById.get(id);
    if (now === undefined) {
      removed.push({ kind: "removed", activityId: id, activity: was, where: locate(before, id) });
      continue;
    }

    for (const field of COMPARED_FIELDS) {
      const from = String(was[field] ?? "");
      const to = String(now[field] ?? "");
      if (from === to) continue;

      changed.push({
        kind: "changed",
        activityId: id,
        field,
        before: from,
        after: to,
        where: locate(after, id),
        reKeysSoundHistory: field === "target",
      });
    }

    /**
     * Sound targets compared as a set rather than a list: reordering them
     * changes nothing a learner can observe, and reporting it as a change
     * would bury the ones that matter under noise.
     */
    const wasSounds = [...(was.soundTargets ?? [])].sort().join(", ");
    const nowSounds = [...(now.soundTargets ?? [])].sort().join(", ");
    if (wasSounds !== nowSounds) {
      changed.push({
        kind: "changed",
        activityId: id,
        field: "soundTargets",
        before: wasSounds,
        after: nowSounds,
        where: locate(after, id),
        /**
         * False, and the distinction is worth stating. Editing this list
         * changes which syllables the *scheduler* looks at; it does not change
         * what the scorer returns, which is derived from the phrase. The
         * history keeps matching.
         */
        reKeysSoundHistory: false,
      });
    }
  }

  return [...added, ...changed, ...removed];
}

/**
 * The changes a learner's record will actually notice, which is not all of
 * them.
 *
 * A screen that flagged every edit would train an author to click past the
 * panel, and the one edit in fifty that matters would go with it.
 */
export function consequentialChanges(changes: ContentChange[]): ContentChange[] {
  return changes.filter(
    (change) =>
      change.kind === "removed" || (change.kind === "changed" && change.reKeysSoundHistory),
  );
}
