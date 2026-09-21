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
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

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
  /**
   * Keyed digest of the teacher key that owns this class. Never the key.
   *
   * Before this existed, every teacher surface was gated by one shared
   * `DIAGNOSTICS_TOKEN` and then read whichever `classId` was asked for. The
   * token was checked; **who was asking was not**. Anybody holding the link
   * could read every class on the server — another teacher's, another
   * school's — and handing teachers that link was the step that would have
   * turned a contained arrangement into a breach.
   *
   * Nullable because classes created before this shipped have no owner. Those
   * stay reachable by the operator token alone, which is what created them.
   */
  ownerDigest?: string | null;
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

/**
 * The domain separating an owner key's digest from a join code's.
 *
 * Distinct literals with no `|` in either, so ("class-join", x) and
 * ("class-owner", x) cannot collide — the reason `keyedDigest` takes a domain
 * at all. Without it a join code and an owner key would hash alike, and a
 * pupil's code would be a teacher's credential.
 */
const OWNER_DOMAIN = "class-owner";

/** How long a teacher key is, in bytes before encoding. */
const OWNER_KEY_BYTES = 32;

/**
 * Mint a teacher key. Returned once, never stored — only its digest is.
 *
 * 32 bytes from `randomBytes`, not the human-typeable alphabet the join codes
 * use. A join code is short because a child types it off a whiteboard under a
 * rate limit; this is pasted from a link and guarded by nothing but its own
 * length, so it gets the full keyspace.
 */
export function mintTeacherKey(): string {
  return randomBytes(OWNER_KEY_BYTES).toString("base64url");
}

/** The digest stored against a class for a given teacher key. */
export function teacherKeyDigest(key: string): string {
  return keyedDigest(OWNER_DOMAIN, key);
}

/**
 * Whether this key owns this class.
 *
 * A class with no owner answers `false` — it predates ownership and is
 * reachable only by the operator token that made it. Answering `true` would
 * make every legacy class readable by anybody who minted themselves a key.
 */
export async function ownsClass(classId: string, key: string | null): Promise<boolean> {
  if (key === null || key === "") return false;
  const klass = await readClass(classId);
  if (klass === null) return false;

  const stored = klass.ownerDigest ?? null;
  if (stored === null) return false;

  // Compared as buffers of equal length, so this leaks no timing signal about
  // how much of a digest matched.
  const expected = Buffer.from(stored, "utf8");
  const actual = Buffer.from(teacherKeyDigest(key), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface CreatedClass {
  /**
   * The teacher key for this class. **Returned once and never again** — only
   * its digest is stored, so a lost key means a class nobody can administer
   * rather than one anybody can.
   */
  teacherKey: string;
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
  // Minted here rather than by the caller, so there is exactly one place a
  // class can come into existence without an owner.
  const teacherKey = mintTeacherKey();

  const doc: ClassDocument = {
    _id: classId,
    name: input.name,
    teacherName: input.teacherName,
    slug: input.slug,
    codeDigest: classCodeDigest(code),
    expectedCount: input.expectedCount ?? null,
    ownerDigest: teacherKeyDigest(teacherKey),
    createdAt: now,
  };

  await db.collection<ClassDocument>("classes").insertOne(doc);
  return { classId, code: formatCode(code), teacherKey };
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

/**
 * The sitting a teacher has suggested to a class — board 1f.
 *
 * One per class, replaced rather than accumulated. A teacher who suggests a
 * second lesson has changed their mind, not added a queue: a list of pending
 * suggestions is a homework backlog, and a backlog is the deadline this screen
 * exists without.
 *
 * `window` is stored and shown, and **nothing enforces it**. It is the phrase
 * a teacher used, so a pupil sees "this week" rather than a date — and a
 * stored date is the thing a later feature would be tempted to compare against
 * `now`.
 */
export interface SuggestionDocument {
  /** The class id. One suggestion per class, so the class is the key. */
  _id: string;
  lessonId: number;
  /** The teacher's own words — never a timestamp to compare against. */
  window: string;
  suggestedAt: Date;
}

export async function suggestSitting(
  classId: string,
  lessonId: number,
  window: string,
  now: Date = new Date(),
): Promise<void> {
  const db = await getDb();
  await db
    .collection<SuggestionDocument>("classSuggestions")
    .updateOne(
      { _id: classId },
      { $set: { lessonId, window, suggestedAt: now } },
      { upsert: true },
    );
}

export async function readSuggestion(classId: string): Promise<SuggestionDocument | null> {
  const db = await getDb();
  return db.collection<SuggestionDocument>("classSuggestions").findOne({ _id: classId });
}

/**
 * Every class this learner is in, so their own device can ask what was
 * suggested without being told which class ids exist.
 *
 * Returns the memberships rather than the classes: the caller decides what of
 * a class a learner may see, and a learner may see the name of one they are
 * in and nothing about one they are not.
 */
export async function membershipsFor(learnerId: string): Promise<MembershipDocument[]> {
  const db = await getDb();
  return db.collection<MembershipDocument>("classMembers").find({ learnerId }).toArray();
}

/**
 * Changing the name a pupil shares, without leaving.
 *
 * Board 1h offers "Remove my name" beside "Leave the class" as two different
 * things, and they have to be: a pupil who wants out of a name list but still
 * wants the lesson suggestions should not have to leave and rejoin. Rejoining
 * would also need the code again, which they may no longer have.
 *
 * Returns false when there is no membership to change, so a caller cannot
 * report success for a class the learner is not in.
 */
export async function setSharedName(
  classId: string,
  learnerId: string,
  sharedName: string | null,
): Promise<boolean> {
  const db = await getDb();
  const result = await db
    .collection<MembershipDocument>("classMembers")
    .updateOne({ _id: `${classId}:${learnerId}` }, { $set: { sharedName } });
  return result.matchedCount > 0;
}
