/**
 * Activity content, served from the database instead of the bundle.
 *
 * Today a phrase lives in `src/activities/languages/*.ts`, which means
 * correcting a typo in French is a deploy. That is a hard ceiling on a
 * language product: content is the thing that changes most often and it is the
 * thing that currently changes least easily.
 *
 * Versioned rather than mutable. `{slug}:{version}` as the id means a
 * published set is immutable and a correction is a new version, so a learner
 * mid-session is never handed different words for the same activity — and
 * rolling back is publishing an older version rather than restoring a backup.
 *
 * The bundled set does not go away. It becomes the seed for version 1 and the
 * offline fallback, which is what keeps the app working with no network at
 * all. Content that only exists in a database is content a learner on a train
 * cannot practise.
 */

import type { Db } from "mongodb";
import { getDb } from "../db.js";
import { logger } from "../logger.js";

/** Mirrors `Activity` in src/activities/types.ts. Duplicated deliberately —
 *  see the note below on why the server does not import from src. */
export interface ContentActivity {
  id: number;
  title: string;
  kind: string;
  prompt: string;
  gloss: string;
  target: string;
  focus: string;
}

export interface ContentDocument {
  /** `{slug}:{version}` — immutable once published. */
  _id: string;
  slug: string;
  /** BCP-47, e.g. "fr-FR". */
  code: string;
  label: string;
  version: number;
  activities: ContentActivity[];
  publishedAt: Date;
}

/**
 * The activity shape, validated rather than trusted.
 *
 * This is content a learner will be asked to read aloud and scored against,
 * arriving from a database a human edits. A missing `target` would mean
 * scoring speech against nothing; a missing `prompt` would mean an activity
 * with no instruction. Both are worth refusing at the boundary rather than
 * discovering on screen.
 */
function readActivity(raw: unknown): ContentActivity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Partial<ContentActivity>;

  if (typeof c.id !== "number" || !Number.isFinite(c.id)) return null;
  for (const field of ["title", "kind", "prompt", "gloss", "target", "focus"] as const) {
    if (typeof c[field] !== "string" || c[field].length === 0) return null;
  }

  return {
    id: Math.trunc(c.id),
    title: c.title as string,
    kind: c.kind as string,
    prompt: c.prompt as string,
    gloss: c.gloss as string,
    target: c.target as string,
    focus: c.focus as string,
  };
}

/** A whole published set, or null if it cannot be trusted. */
export function readContent(raw: unknown): ContentDocument | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Partial<ContentDocument>;

  if (typeof c.slug !== "string" || !/^[a-z]{2,16}$/.test(c.slug)) return null;
  if (typeof c.code !== "string" || c.code.length === 0) return null;
  if (typeof c.label !== "string" || c.label.length === 0) return null;
  if (typeof c.version !== "number" || !Number.isInteger(c.version) || c.version < 1) return null;
  if (!Array.isArray(c.activities)) return null;

  const activities = c.activities
    .map(readActivity)
    .filter((a): a is ContentActivity => a !== null);

  /**
   * A set with no usable activities is refused rather than served empty. An
   * empty language reads to a learner as "this is broken", and serving it
   * would replace a working bundled set with nothing.
   */
  if (activities.length === 0) return null;

  return {
    _id: `${c.slug}:${c.version}`,
    slug: c.slug,
    code: c.code,
    label: c.label,
    version: c.version,
    activities,
    publishedAt: c.publishedAt instanceof Date ? c.publishedAt : new Date(),
  };
}

/**
 * The newest published version of one language.
 *
 * Returns null on any failure — no document, an unreadable one, an
 * unreachable database. Every caller falls back to the bundled set, so null
 * means "use what you shipped with" rather than "show an error".
 */
export async function readLatest(slug: string): Promise<ContentDocument | null> {
  try {
    const db = await getDb();
    const [doc] = await db
      .collection<ContentDocument>("content")
      .find({ slug })
      .sort({ version: -1 })
      .limit(1)
      .toArray();

    if (doc === undefined) return null;
    const validated = readContent(doc);
    if (validated === null) {
      // Loud, because a published set that fails validation is a content bug
      // that silently reverts every learner to the bundled version.
      logger.error({ slug, version: doc.version }, "[content] published set failed validation");
    }
    return validated;
  } catch (err) {
    logger.error({ err, slug }, "[content] could not read");
    return null;
  }
}

/**
 * Publishes a set as the next version.
 *
 * Never overwrites: the version is part of the id, so publishing twice
 * produces two immutable documents and a learner mid-session keeps the words
 * they started with. `insertOne` rather than an upsert, so a race publishes
 * one of them and fails the other loudly rather than silently merging two
 * people's edits.
 */
export async function publish(
  db: Db,
  set: Omit<ContentDocument, "_id" | "version" | "publishedAt">,
  version: number,
): Promise<ContentDocument> {
  const document: ContentDocument = {
    ...set,
    _id: `${set.slug}:${version}`,
    version,
    publishedAt: new Date(),
  };

  const validated = readContent(document);
  if (validated === null) throw new Error(`refusing to publish an invalid set for ${set.slug}`);

  await db.collection<ContentDocument>("content").insertOne(document);
  return document;
}

/** The highest version published for a slug, or 0 if none. */
export async function latestVersion(db: Db, slug: string): Promise<number> {
  const [doc] = await db
    .collection<ContentDocument>("content")
    .find({ slug })
    .sort({ version: -1 })
    .limit(1)
    .toArray();
  return doc?.version ?? 0;
}
