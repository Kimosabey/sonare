/**
 * The learners collection.
 *
 * One document per device-profile, keyed on the id the client minted. Holds no
 * personal data beyond a display name the learner typed for themselves — the
 * same string the language picker already collects.
 *
 * Kept in server/data/ because that is where Mongo query shapes live. Route
 * handlers should not know what a filter looks like, which is what makes the
 * collection model testable without a database.
 *
 * No TTL. This is the learner's own record, and expiring it on a timer would
 * silently orphan their progress — the retention split (telemetry expires, the
 * learner's record does not) is the whole point of separating them.
 */

import { getDb } from "../db.js";
import { logger } from "../logger.js";

export interface LearnerDocument {
  /** The client-minted UUID. Validated by identity.ts before it reaches here. */
  _id: string;
  /** Self-chosen, and the only thing here a person would recognise. */
  displayName?: string;
  locale?: string;
  createdAt: Date;
  lastSeenAt: Date;
}

/** Bounded so a hostile client cannot store a novel under a display name. */
const MAX_DISPLAY_NAME = 80;
const MAX_LOCALE = 20;

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Records a learner, or updates what we know about an existing one.
 *
 * `createdAt` goes in `$setOnInsert` so a returning learner keeps their
 * original date — the figure is only interesting as "when did this person
 * start", and refreshing it on every visit would make every learner look new.
 */
export async function registerLearner(
  learnerId: string,
  displayName?: unknown,
  locale?: unknown,
): Promise<void> {
  const now = new Date();
  const set: Partial<LearnerDocument> = { lastSeenAt: now };

  // Only written when supplied, so a request that omits the name does not
  // erase one the learner set earlier.
  const name = clean(displayName, MAX_DISPLAY_NAME);
  const loc = clean(locale, MAX_LOCALE);
  if (name !== undefined) set.displayName = name;
  if (loc !== undefined) set.locale = loc;

  const db = await getDb();
  await db
    .collection<LearnerDocument>("learners")
    .updateOne({ _id: learnerId }, { $set: set, $setOnInsert: { createdAt: now } }, { upsert: true });
}

/**
 * Notes that a learner was seen, without failing the request if it cannot.
 *
 * Called on authenticated requests purely to keep `lastSeenAt` useful for
 * active-learner counts. It is bookkeeping, so it never propagates — a
 * learner's take must not fail because a timestamp could not be written.
 */
export async function touchLearner(learnerId: string): Promise<void> {
  try {
    const db = await getDb();
    await db
      .collection<LearnerDocument>("learners")
      .updateOne({ _id: learnerId }, { $set: { lastSeenAt: new Date() } });
  } catch (err) {
    logger.error({ err }, "[learners] failed to update lastSeenAt");
  }
}

export async function findLearner(learnerId: string): Promise<LearnerDocument | null> {
  const db = await getDb();
  return db.collection<LearnerDocument>("learners").findOne({ _id: learnerId });
}

/**
 * Removes the learner record itself.
 *
 * Only part of a deletion: progress, skills, streaks and the attempt trail are
 * separate collections and are erased by the deletion route, which owns the
 * whole set. Kept narrow here so this module stays about one collection.
 */
export async function deleteLearner(learnerId: string): Promise<void> {
  const db = await getDb();
  await db.collection<LearnerDocument>("learners").deleteOne({ _id: learnerId });
}
