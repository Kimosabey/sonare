/**
 * The streaks collection — one document per learner, no language.
 *
 * A practice day is a fact about a person. French on Monday and Hindi on
 * Tuesday is two days running, not two streaks of one, which is why the id is
 * the bare learner id.
 *
 * The document holds days and the record. It deliberately does not hold the
 * current run: that depends on what day it is for the learner, and the server
 * does not know their timezone. The client derives it against its own clock.
 *
 * No TTL. The learner's own record — and of everything here, the one a learner
 * would be most upset to lose.
 */

import { mergeAndSave, deleteAllFor, type VersionedDocument } from "./mergeStore.js";
import { getDb } from "../db.js";
import { mergeStreaks, type StreakState } from "../domain/merge.js";

export interface StreakDocument extends VersionedDocument {
  days: string[];
  longest: number;
}

const EMPTY: StreakState = { days: [], longest: 0 };

function fromDocument(doc: VersionedDocument): StreakState {
  const typed = doc as StreakDocument;
  return {
    days: Array.isArray(typed.days) ? typed.days : [],
    longest: typeof typed.longest === "number" && Number.isFinite(typed.longest) ? typed.longest : 0,
  };
}

export async function readStreak(learnerId: string): Promise<StreakState | null> {
  const db = await getDb();
  const doc = await db.collection<StreakDocument>("streaks").findOne({ _id: learnerId });
  return doc === null ? null : fromDocument(doc);
}

export async function mergeAndSaveStreak(
  learnerId: string,
  incoming: StreakState,
): Promise<StreakState> {
  return mergeAndSave<StreakState>({
    collection: "streaks",
    // The learner id alone. No slug: see the note above.
    id: learnerId,
    learnerId,
    incoming,
    merge: mergeStreaks,
    empty: EMPTY,
    toFields: (state) => ({ days: state.days, longest: state.longest }),
    fromDocument,
  });
}

export async function deleteStreak(learnerId: string): Promise<void> {
  return deleteAllFor("streaks", learnerId);
}
