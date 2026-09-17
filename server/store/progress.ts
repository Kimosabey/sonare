/**
 * The progress collection.
 *
 * One document per learner per language, so every merge is a single-document
 * update. That is deliberate: Mongo guarantees atomicity within one document
 * but needs a replica set for transactions across several, and a schema of one
 * row per activity would have made correctness depend on infrastructure this
 * project does not have. Sizes are tiny — four languages of ten activities.
 *
 * The read-modify-write race, and the optimistic-concurrency fix for it, now
 * live in mergeStore.ts. They moved there when skills became the second domain
 * to need them: three copies of a race fix is three places for it to be subtly
 * different, and the difference would only ever surface as one device's
 * practice quietly going missing.
 */

import { mergeAndSave, readAllFor, deleteAllFor, type VersionedDocument } from "./mergeStore.js";
import { getDb } from "../db.js";
import { mergeProgress, type ProgressEntry, type ProgressState } from "../domain/merge.js";

export interface ProgressDocument extends VersionedDocument {
  slug: string;
  entries: ProgressEntry[];
}

function documentId(learnerId: string, slug: string): string {
  return `${learnerId}:${slug}`;
}

/** Tolerant of a document written before a field existed. */
function fromDocument(doc: VersionedDocument): ProgressState {
  const typed = doc as ProgressDocument;
  return {
    slug: typeof typed.slug === "string" ? typed.slug : "",
    entries: Array.isArray(typed.entries) ? typed.entries : [],
  };
}

export async function readProgress(learnerId: string, slug: string): Promise<ProgressState | null> {
  const db = await getDb();
  const doc = await db
    .collection<ProgressDocument>("progress")
    .findOne({ _id: documentId(learnerId, slug) });
  return doc === null ? null : fromDocument(doc);
}

/** Every language this learner has touched, for a full sync pull. */
export async function readAllProgress(learnerId: string): Promise<ProgressState[]> {
  return readAllFor("progress", learnerId, fromDocument);
}

/**
 * Merges an incoming push into the stored state and returns the result.
 *
 * The return value is what the client stores, so a push is also a pull: one
 * round trip leaves both sides holding the same merged state.
 */
export async function mergeAndSaveProgress(
  learnerId: string,
  incoming: ProgressState,
): Promise<ProgressState> {
  return mergeAndSave<ProgressState>({
    collection: "progress",
    id: documentId(learnerId, incoming.slug),
    learnerId,
    incoming,
    merge: mergeProgress,
    empty: { slug: incoming.slug, entries: [] },
    toFields: (state) => ({ slug: state.slug, entries: state.entries }),
    fromDocument,
  });
}

/** Part of a deletion request. The route owns the whole set of collections. */
export async function deleteProgress(learnerId: string): Promise<void> {
  return deleteAllFor("progress", learnerId);
}

/**
 * How many learners have taken at least one attempt at each of these
 * activities, in this language.
 *
 * Exists for the publish diff (Platform board 1k), which has to say who a
 * removal reaches before an operator commits to it — "41 learners have
 * attempts against this activity" is the sentence that makes the irreversible
 * case visible, and it is only worth showing if it is true. The alternative
 * was a plausible-looking number, which is the one thing this product refuses
 * everywhere else it reports a measurement.
 *
 * `attemptsUsed > 0` rather than the entry merely existing. A progress entry
 * is written when an activity is *offered*, so counting rows would report
 * every learner the activity was ever scheduled for — a much larger number
 * than the one an operator is being asked to weigh, and wrong in the direction
 * that makes the warning easy to dismiss.
 *
 * One document per learner per language, so counting documents counts
 * learners; `$addToSet` on the id would be the same answer at more cost.
 * Activities nobody has attempted are absent from the result rather than
 * present as zero — the caller distinguishes "no learner is affected" from
 * "this activity was not asked about", and a defaulted zero conflates them.
 */
export async function countLearnersWithAttempts(
  slug: string,
  activityIds: number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (activityIds.length === 0) return counts;

  const db = await getDb();
  const rows = await db
    .collection<ProgressDocument>("progress")
    .aggregate<{ _id: number; learners: number }>([
      { $match: { slug } },
      { $unwind: "$entries" },
      { $match: { "entries.activityId": { $in: activityIds }, "entries.attemptsUsed": { $gt: 0 } } },
      { $group: { _id: "$entries.activityId", learners: { $addToSet: "$learnerId" } } },
      { $project: { learners: { $size: "$learners" } } },
    ])
    .toArray();

  for (const row of rows) counts.set(row._id, row.learners);
  return counts;
}
