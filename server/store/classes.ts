/**
 * Classes, their join codes, and who is in them.
 *
 * Teacher board 1b: "A join code rather than a roster upload: identity here is
 * anonymous and locally minted, so a class is pupils choosing to attach
 * themselves, never a list a teacher types in about children." Everything
 * here follows from that — there is no endpoint that adds a pupil to a class,
 * only one a pupil calls themselves.
 *
 * ── how a class code differs from a device-link code ───────────────────────
 *
 * It reuses the alphabet, the normalisation and the keyed digest from
 * `linkCodes.ts`, under its own digest domain so a code minted for one can
 * never be spent on the other. But the posture is deliberately different, and
 * the difference is a judgement about what each code *grants*:
 *
 * A device-link code hands over a learner's whole record, so it is single-use
 * and lives ten minutes. A class code grants the right to *see a class name
 * and offer to join it* — nothing about any pupil, and no access to anything.
 * So it is multi-use and long-lived ("valid for this term"), which is what
 * makes writing it on a board work at all. It stays regenerable, because a
 * code on a board outlives the term it was written for.
 *
 * The digest is still what is stored, never the code. A leaked database
 * therefore does not hand out class codes, and reversing one needs the signing
 * secret.
 *
 * ── the shape carries no pupil figure ──────────────────────────────────────
 *
 * A membership row is a learner id, whether they shared a name, and when they
 * joined. There is nowhere in this collection for an accuracy to be written,
 * which is the same reasoning as `classSummary.ts`: a field that does not
 * exist cannot leak.
 */

import type { Db } from "mongodb";
import { getDb } from "../db.js";
import { keyedDigest } from "../identity.js";
import { CODE_ALPHABET, CODE_LENGTH, formatCode, normaliseCode } from "../linkCodes.js";
import { randomInt } from "node:crypto";

/** Separates a class code's digest from every other use of the secret. */
const DIGEST_DOMAIN = "class-join";

export interface ClassDocument {
  /** Opaque class id. */
  _id: string;
  name: string;
  /** How the teacher is named to a pupil, e.g. "Mr Okonjo". */
  teacherName: string;
  /** Language slug the class is practising. */
  slug: string;
  /** Keyed digest of the join code. Never the code. */
  codeDigest: string;
  /** How many pupils the teacher expects, for "28 joined of 31". Optional. */
  expectedCount: number | null;
  createdAt: Date;
}

export interface MembershipDocument {
  /** `${classId}:${learnerId}` — one row per pupil per class. */
  _id: string;
  classId: string;
  learnerId: string;
  /**
   * The name the pupil chose to share, or null when they joined without one.
   *
   * Null rather than absent, so "joined anonymously" is a recorded decision
   * rather than a missing field somebody might later fill in.
   */
  sharedName: string | null;
  joinedAt: Date;
}

/** A class as a pupil sees it before deciding — no pupil data at all. */
export interface ClassPreview {
  classId: string;
  name: string;
  teacherName: string;
  slug: string;
}

function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** The stored form of a class code. Exported so tests need not guess it. */
export function classCodeDigest(code: string): string {
  return keyedDigest(DIGEST_DOMAIN, code);
}

export interface CreatedClass {
  classId: string;
  /** Grouped for reading aloud. Returned once, and never stored. */
  code: string;
}

/**
 * Creates a class and returns its join code.
 *
 * The code is returned rather than stored, so this is the only moment it
 * exists in plaintext. A teacher who loses it regenerates rather than
 * recovers — the same trade the device-link code makes, for the same reason.
 */
export async function createClass(
  input: { name: string; teacherName: string; slug: string; expectedCount?: number | null },
  now: Date = new Date(),
): Promise<CreatedClass> {
  const db = await getDb();
  const code = generateCode();
  const classId = keyedDigest("class-id", `${input.name}|${now.toISOString()}|${code}`).slice(0, 22);

  const doc: ClassDocument = {
    _id: classId,
    name: input.name,
    teacherName: input.teacherName,
    slug: input.slug,
    codeDigest: classCodeDigest(code),
    expectedCount: input.expectedCount ?? null,
    createdAt: now,
  };

  await db.collection<ClassDocument>("classes").insertOne(doc);
  return { classId, code: formatCode(code) };
}

/** Replaces a class's join code, invalidating the one on the board. */
export async function regenerateCode(classId: string): Promise<string | null> {
  const db = await getDb();
  const code = generateCode();
  const result = await db
    .collection<ClassDocument>("classes")
    .updateOne({ _id: classId }, { $set: { codeDigest: classCodeDigest(code) } });

  return result.matchedCount === 0 ? null : formatCode(code);
}

/**
 * What a pupil is shown before they decide, looked up by the code they typed.
 *
 * Returns the class name, the teacher's name and the language — and nothing
 * else, because at this point the pupil has agreed to nothing. Deliberately
 * reveals no membership: "how many have joined" is a fact about other pupils.
 */
export async function previewByCode(value: unknown): Promise<ClassPreview | null> {
  const code = normaliseCode(value);
  if (code === null) return null;

  const db = await getDb();
  const doc = await db
    .collection<ClassDocument>("classes")
    .findOne({ codeDigest: classCodeDigest(code) });

  if (doc === null) return null;
  return { classId: doc._id, name: doc.name, teacherName: doc.teacherName, slug: doc.slug };
}

export type JoinOutcome =
  | { ok: true; classId: string; alreadyMember: boolean }
  | { ok: false; reason: "no-such-code" };

/**
 * A pupil attaching themselves to a class.
 *
 * Idempotent: joining twice is not an error and does not duplicate a row. A
 * pupil who taps join on a flaky connection must not end up counted twice in
 * the figure their teacher plans a lesson from.
 *
 * Re-joining **updates** the shared name, which is how "remove your name
 * without leaving" is implemented — the board offers that as a thing a pupil
 * can always do, so it cannot require leaving and rejoining.
 */
export async function joinClass(
  value: unknown,
  learnerId: string,
  sharedName: string | null,
  now: Date = new Date(),
): Promise<JoinOutcome> {
  const preview = await previewByCode(value);
  if (preview === null) return { ok: false, reason: "no-such-code" };

  const db = await getDb();
  const id = `${preview.classId}:${learnerId}`;
  const existing = await db.collection<MembershipDocument>("classMembers").findOne({ _id: id });

  await db.collection<MembershipDocument>("classMembers").updateOne(
    { _id: id },
    {
      $set: { classId: preview.classId, learnerId, sharedName },
      // Not overwritten on a re-join: when they joined is when they first
      // joined, and attendance would otherwise restart on a name change.
      $setOnInsert: { joinedAt: now },
    },
    { upsert: true },
  );

  return { ok: true, classId: preview.classId, alreadyMember: existing !== null };
}

/** A pupil detaching themselves. Their own record is untouched. */
export async function leaveClass(classId: string, learnerId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db
    .collection<MembershipDocument>("classMembers")
    .deleteOne({ _id: `${classId}:${learnerId}` });
  return result.deletedCount > 0;
}

export async function readClass(classId: string): Promise<ClassDocument | null> {
  const db = await getDb();
  return db.collection<ClassDocument>("classes").findOne({ _id: classId });
}

/** Every learner id in a class. The only place membership is enumerated. */
export async function membersOf(classId: string): Promise<MembershipDocument[]> {
  const db = await getDb();
  return db.collection<MembershipDocument>("classMembers").find({ classId }).toArray();
}

/** Indexes this collection needs. Called from the migration runner. */
export async function ensureClassIndexes(db: Db): Promise<void> {
  // The lookup every pupil join performs.
  await db.collection<ClassDocument>("classes").createIndex({ codeDigest: 1 });
  await db.collection<MembershipDocument>("classMembers").createIndex({ classId: 1 });
}
