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
import { isSlug } from "../domain/merge.js";
import { logger } from "../logger.js";

/**
 * The three kinds the activity screen knows how to render. A fourth renders as
 * nothing at all: no type error, no failed request, just a blank task.
 */
export const ACTIVITY_KINDS = ["repeat", "respond", "read"] as const;

/** Bounded, so one publish cannot store an unbounded document. */
export const MAX_ACTIVITIES = 50;

/**
 * Roughly 2.5 words a second — a slow learner's pace — against the capture
 * ceiling of 15s plus up to 2400ms of trailing silence. A longer target is cut
 * off mid-phrase and scored as an omission, which blames the learner for our
 * timing. The same number src/activities/languages/languages.test.ts holds the
 * bundle to.
 */
export const MAX_TARGET_WORDS = 14;

/** Azure pronunciation-assessment locales are BCP-47: two-letter, region-qualified. */
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

function isActivityKind(value: unknown): boolean {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

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

  /**
   * Checked against the three kinds the UI can render, not merely for being a
   * string. src/content/cache.ts has always required one of the three, so a
   * set carrying `kind: "reppeat"` used to pass here, be served happily, and
   * then be discarded by every client's own validation — whoever published it
   * would see success and no learner would ever receive it. Refusing here is
   * what makes the two ends agree on what "usable" means.
   */
  if (!isActivityKind(c.kind)) return null;

  for (const field of ["title", "kind", "prompt", "gloss", "target", "focus"] as const) {
    // Trimmed: a target of one space is speech scored against nothing, which
    // is the empty-target failure wearing a disguise.
    if (typeof c[field] !== "string" || c[field].trim().length === 0) return null;
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

  if (!isSlug(c.slug)) return null;
  if (typeof c.code !== "string" || c.code.length === 0) return null;
  if (typeof c.label !== "string" || c.label.length === 0) return null;
  if (typeof c.version !== "number" || !Number.isInteger(c.version) || c.version < 1) return null;
  if (!Array.isArray(c.activities)) return null;

  const activities = c.activities
    .map(readActivity)
    .filter((a): a is ContentActivity => a !== null);

  /**
   * One activity per id. `id` is the React key, the progress key and what the
   * report joins on, so two rows sharing one silently merge two activities'
   * attempts — a learner who passes one appears to have passed the other.
   *
   * Dropped rather than refused, keeping this function's posture: a duplicated
   * row costs that row, not the whole language. The publish path refuses it
   * outright (`contentProblems`), so this only ever sees a document written
   * before that gate existed, or one edited straight into the database.
   */
  const seen = new Set<number>();
  const unique = activities.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  /**
   * A set with no usable activities is refused rather than served empty. An
   * empty language reads to a learner as "this is broken", and serving it
   * would replace a working bundled set with nothing.
   */
  if (unique.length === 0) return null;

  return {
    _id: `${c.slug}:${c.version}`,
    slug: c.slug,
    code: c.code,
    label: c.label,
    version: c.version,
    activities: unique,
    publishedAt: c.publishedAt instanceof Date ? c.publishedAt : new Date(),
  };
}

/**
 * Everything wrong with a set somebody is trying to publish, named in language
 * an author can act on. Empty means publishable.
 *
 * Separate from `readContent` because the two boundaries want opposite
 * postures, and conflating them would break one of them.
 *
 * **Reading is lenient on purpose.** A bad row costs that row and the language
 * stays up, because the alternative is a learner staring at an empty screen.
 *
 * **Publishing has to be the opposite.** Somebody who types ten activities,
 * gets a green tick, and has row three silently dropped has published nine and
 * been told nothing. So nothing is dropped here: it is refused, and named.
 *
 * The rules are the ones src/activities/languages/languages.test.ts already
 * enforces on the bundle, which is the whole of the validation
 * `npm run seed-content` has ever had — its input is the bundle, and the bundle
 * cannot land without passing that test. An authoring screen has no test
 * standing in front of it, so the same rules have to exist at runtime or
 * publishing from a browser is strictly less safe than publishing from a
 * checkout.
 */
export function contentProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return ["the set is not an object"];
  const c = raw as Partial<ContentDocument>;
  const problems: string[] = [];

  if (!isSlug(c.slug)) problems.push("slug must be 2–16 lowercase letters, like “fr”");
  if (typeof c.code !== "string" || !LOCALE.test(c.code)) {
    // A malformed locale is not rejected until the provider call, by which
    // point the learner has already recorded.
    problems.push("locale must look like “fr-FR” — the provider rejects anything else");
  }
  if (typeof c.label !== "string" || c.label.trim().length === 0) {
    problems.push("label cannot be empty — it is what a learner sees in the picker");
  }

  if (!Array.isArray(c.activities)) {
    problems.push("activities must be a list");
    return problems;
  }
  if (c.activities.length === 0) {
    problems.push("a set needs at least one activity — an empty language reads as a broken app");
  }
  if (c.activities.length > MAX_ACTIVITIES) {
    problems.push(`a set cannot hold more than ${MAX_ACTIVITIES} activities`);
  }

  const ids = new Set<number>();
  const targets = new Set<string>();

  c.activities.forEach((entry, index) => {
    const where = `activity ${index + 1}`;
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${where} is not an object`);
      return;
    }
    const a = entry as Partial<ContentActivity>;

    if (typeof a.id !== "number" || !Number.isInteger(a.id) || a.id < 1) {
      problems.push(`${where}: id must be a whole number, 1 or more`);
    } else if (ids.has(a.id)) {
      problems.push(`${where}: id ${a.id} is already used — a duplicate merges two activities' attempts`);
    } else {
      ids.add(a.id);
    }

    if (!isActivityKind(a.kind)) {
      problems.push(`${where}: kind must be one of ${ACTIVITY_KINDS.join(", ")}`);
    }

    for (const field of ["title", "prompt", "gloss", "target", "focus"] as const) {
      if (typeof a[field] !== "string" || a[field].trim().length === 0) {
        problems.push(`${where}: ${field} cannot be empty`);
      }
    }

    if (typeof a.target === "string" && a.target.trim().length > 0) {
      const target = a.target.trim();
      const words = target.split(/\s+/).length;
      if (words > MAX_TARGET_WORDS) {
        problems.push(
          `${where}: target is ${words} words — over ${MAX_TARGET_WORDS} is cut off mid-phrase and scored as an omission`,
        );
      }
      if (targets.has(target)) problems.push(`${where}: target repeats an earlier activity's`);
      else targets.add(target);
    }
  });

  return problems;
}

/** A set that is publishable, or the reasons it is not. */
export type DraftResult =
  | { ok: true; set: Omit<ContentDocument, "_id" | "version" | "publishedAt"> }
  | { ok: false; problems: string[] };

/**
 * A submitted set, checked and normalised — the one entry point the authoring
 * route uses, so the route holds no validation of its own to drift from this.
 *
 * Whitespace is trimmed on the way in rather than being grounds for refusal. A
 * trailing space is the single most likely thing to survive a copy-paste, and
 * refusing the publish over one would teach an author to distrust the screen;
 * storing it would put it in front of the scorer.
 */
export function readDraft(raw: unknown): DraftResult {
  const problems = contentProblems(raw);
  if (problems.length > 0) return { ok: false, problems };

  // Every field below was checked by contentProblems, which is the only reason
  // this cast is safe — and the only reason the two must stay in one function.
  const c = raw as ContentDocument;

  return {
    ok: true,
    set: {
      slug: c.slug,
      code: c.code,
      label: c.label.trim(),
      activities: c.activities.map((a) => ({
        id: a.id,
        title: a.title.trim(),
        kind: a.kind,
        prompt: a.prompt.trim(),
        gloss: a.gloss.trim(),
        target: a.target.trim(),
        focus: a.focus.trim(),
      })),
    },
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

  /**
   * Strict, and before the write. `readContent` would have refused the worst
   * of these too, but it *drops* bad rows rather than naming them — so a set
   * that lost half its activities on the way in would still have been
   * published, and reported as a success. Every publisher goes through here:
   * `npm run seed-content` and the authoring screen get the same gate rather
   * than one having its own.
   */
  const problems = contentProblems(document);
  if (problems.length > 0) {
    throw new Error(`refusing to publish an invalid set for ${set.slug}: ${problems.join("; ")}`);
  }

  await db.collection<ContentDocument>("content").insertOne(document);
  return document;
}

/** One line per published version, for the authoring screen's history. */
export interface VersionSummary {
  version: number;
  publishedAt: Date;
  activityCount: number;
}

/**
 * Bounded: the screen shows a history to pick from, not an archive, and an
 * unbounded read grows with every correction ever published.
 */
const MAX_VERSIONS = 50;

/** What has been published for one language, newest first. */
export async function listVersions(db: Db, slug: string): Promise<VersionSummary[]> {
  const docs = await db
    .collection<ContentDocument>("content")
    .find({ slug })
    .sort({ version: -1 })
    .limit(MAX_VERSIONS)
    .toArray();

  return docs.map((doc) => ({
    version: doc.version,
    publishedAt: doc.publishedAt,
    activityCount: Array.isArray(doc.activities) ? doc.activities.length : 0,
  }));
}

/**
 * One named version, exactly as it was published.
 *
 * Deliberately **not** validated on the way out. This is what the authoring
 * screen loads into the editor, and a set that fails validation is precisely
 * the one somebody needs to open and repair — validating here would hide the
 * broken version from the only screen that can fix it. Nothing a learner reads
 * comes through this function: `readLatest` is that path, and it still refuses.
 */
export async function readVersion(
  db: Db,
  slug: string,
  version: number,
): Promise<ContentDocument | null> {
  const doc = await db
    .collection<ContentDocument>("content")
    .findOne({ _id: `${slug}:${version}` });

  return doc ?? null;
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
