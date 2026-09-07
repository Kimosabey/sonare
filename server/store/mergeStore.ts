/**
 * The read-modify-write that every synced domain needs, done once.
 *
 * Merging requires the stored state, so the operation spans a read and a
 * write — and Mongo's single-document atomicity does not cover that. Two
 * devices pushing at once can both read the same document, and the second
 * write discards the first's contribution with nothing left to show it
 * happened.
 *
 * So the update is conditional on the version that was read. A mismatch means
 * another writer committed in between, and the answer is to re-read and merge
 * again — which is safe precisely because the merge functions commute and are
 * idempotent (domain/merge.ts). Retries are bounded: an unbounded loop under
 * contention is a worse failure than a rejected push, since the client keeps
 * its local state, stays dirty, and pushes again.
 *
 * Extracted once the second domain needed it. Three copies of a race fix is
 * three places for it to be subtly different, and the difference would only
 * show up as one device's practice quietly going missing.
 *
 * The alternative was to express each merge as Mongo update operators, which
 * is race-free with no read at all. Rejected: it would smear the merge rules
 * across update documents and field paths, where they stop being the one pure
 * function that defines them and can no longer be unit-tested as such.
 */

import type { Document, Filter, OptionalUnlessRequiredId } from "mongodb";
import { getDb } from "../db.js";
import { logger } from "../logger.js";

/** Enough for real contention between one learner's devices, not a spin. */
const MAX_ATTEMPTS = 4;

/** What every synced document carries, whatever domain it holds. */
export interface VersionedDocument extends Document {
  _id: string;
  learnerId: string;
  version: number;
  updatedAt: Date;
}

export interface MergeRequest<State> {
  /** Mongo collection name. */
  collection: string;
  /** Document id — `{learnerId}:{slug}`, or just the learner id. */
  id: string;
  learnerId: string;
  /** What the client pushed, already validated. */
  incoming: State;
  /** Combines stored with incoming. Must commute and be idempotent. */
  merge: (stored: State, incoming: State) => State;
  /** The state to merge against when no document exists yet. */
  empty: State;
  /** State → the document fields that hold it. */
  toFields: (state: State) => Record<string, unknown>;
  /** Document → state. Must tolerate a document written by an older build. */
  fromDocument: (doc: VersionedDocument) => State;
}

/**
 * Merges an incoming push into stored state and returns the result.
 *
 * The return value is what the client stores, so a push is also a pull: one
 * round trip leaves both sides holding the same state, and a client that
 * pushed something stale learns the truth immediately rather than on a later
 * poll.
 */
export async function mergeAndSave<State>(request: MergeRequest<State>): Promise<State> {
  const db = await getDb();
  const collection = db.collection<VersionedDocument>(request.collection);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const existing = await collection.findOne({ _id: request.id } as Filter<VersionedDocument>);

    if (existing === null) {
      const merged = request.merge(request.empty, request.incoming);
      try {
        /**
         * A plain insert, not an upsert. It has to *fail* when another device
         * created the document first, so the retry re-reads and merges instead
         * of overwriting work that has already landed.
         */
        await collection.insertOne({
          _id: request.id,
          learnerId: request.learnerId,
          ...request.toFields(merged),
          version: 1,
          updatedAt: new Date(),
        } as OptionalUnlessRequiredId<VersionedDocument>);
        return merged;
      } catch {
        continue;
      }
    }

    const merged = request.merge(request.fromDocument(existing), request.incoming);

    const result = await collection.updateOne(
      // The version is the whole guard. Without it this write would discard
      // whatever another writer committed since the read above.
      { _id: request.id, version: existing.version } as Filter<VersionedDocument>,
      { $set: { ...request.toFields(merged), updatedAt: new Date() }, $inc: { version: 1 } },
    );

    if (result.matchedCount === 1) return merged;
    logger.warn(
      { collection: request.collection, id: request.id, attempt },
      "[mergeStore] version conflict — retrying",
    );
  }

  throw new Error(`${request.collection} merge for ${request.id} lost ${MAX_ATTEMPTS} version races`);
}

/** Every document belonging to one learner, for a full pull. */
export async function readAllFor<State>(
  collectionName: string,
  learnerId: string,
  fromDocument: (doc: VersionedDocument) => State,
): Promise<State[]> {
  const db = await getDb();
  const docs = await db
    .collection<VersionedDocument>(collectionName)
    .find({ learnerId } as Filter<VersionedDocument>)
    .toArray();
  return docs.map(fromDocument);
}

/** Part of a deletion request. The route owns the whole set of collections. */
export async function deleteAllFor(collectionName: string, learnerId: string): Promise<void> {
  const db = await getDb();
  await db
    .collection<VersionedDocument>(collectionName)
    .deleteMany({ learnerId } as Filter<VersionedDocument>);
}
