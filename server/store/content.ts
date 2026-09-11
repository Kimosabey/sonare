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
 * The four kinds the activity screens know how to render. A fifth renders as
 * nothing at all: no type error, no failed request, just a blank task.
 *
 * `recall` — see the English, produce the target aloud — is the newest, and it
 * is why this list is checked rather than assumed: it did not exist in the
 * client's union until the course spine landed, and a `recall` row published
 * against a client that predates it is dropped by that client's own validation
 * rather than rendered wrong.
 */
export const ACTIVITY_KINDS = ["repeat", "respond", "read", "recall"] as const;

/** Bounded, so one publish cannot store an unbounded document. */
export const MAX_ACTIVITIES = 50;

/**
 * How many activities make one lesson — one sitting, with an end.
 *
 * Mirrors MIN/MAX_LESSON_ACTIVITIES in src/activities/types.ts, which carries
 * the reasoning. Duplicated for the same reason every other content constant
 * on this side of the boundary is: the store must not import from `src/`.
 */
export const MIN_LESSON_ACTIVITIES = 3;
export const MAX_LESSON_ACTIVITIES = 6;

/**
 * Bounds on the spine, so one publish cannot store an unbounded document —
 * the same posture as MAX_ACTIVITIES, applied to the two lists that nest.
 */
export const MAX_UNITS = 20;
export const MAX_LESSONS = 60;

/**
 * How many written syllables one activity may name.
 *
 * A phrase of fourteen words has nowhere near this many syllables worth
 * drilling, and a list longer than the phrase is a sign somebody pasted the
 * whole thing in — which would make the activity "cover" every due sound and
 * win every scheduling comparison for reasons that are not about the content.
 */
export const MAX_SOUND_TARGETS = 12;

/**
 * A written syllable: letters, combining marks, apostrophes and hyphens.
 *
 * The same shape server/domain/merge.ts accepts as a skill's grapheme, and it
 * has to be — an entry that the skills store would refuse can never match a
 * learner's history, so it is data that looks like a mapping and is not one.
 * Combining marks are kept deliberately: Devanagari matras are marks, and
 * stripping them as punctuation is a mistake this project has already made.
 */
const SOUND_TARGET = /^[\p{L}\p{M}'’-]{1,24}$/u;

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
  /**
   * The written syllables this activity exercises — what `selectActivity` has
   * been waiting on to choose an activity rather than only rank sounds.
   *
   * Optional here because the sets published before the spine existed carry no
   * mapping and are still valid content. Required by `contentProblems` of any
   * activity a lesson references, because a lesson is what the scheduler picks
   * from: an activity in a lesson with no sound targets is one the scheduler
   * can only ever offer as a fallback.
   */
  soundTargets?: string[];
}

/** One sitting. `activityIds` rather than nested activities — see ContentDocument. */
export interface ContentLesson {
  id: number;
  title: string;
  outcome: string;
  activityIds: number[];
}

/** A theme carrying a can-do statement, and the lessons that reach it. */
export interface ContentUnit {
  id: number;
  title: string;
  outcome: string;
  lessons: ContentLesson[];
}

export interface ContentDocument {
  /** `{slug}:{version}` — immutable once published. */
  _id: string;
  slug: string;
  /** BCP-47, e.g. "fr-FR". */
  code: string;
  label: string;
  version: number;
  /**
   * Every activity in the language, flat and authoritative. The spine points
   * into this list rather than containing it, which is what lets a client
   * built before lessons existed read a course-shaped document and get a
   * complete, working language out of it.
   */
  activities: ContentActivity[];
  /**
   * The course spine, `Unit → Lesson → Activity`. Absent on every set
   * published before it existed, and absent is a valid, servable shape rather
   * than a document to migrate — content is immutable, so the spine arrives as
   * a new version and the old ones stay exactly as they were.
   */
  units?: ContentUnit[];
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

  /**
   * Sound targets are folded and filtered rather than being grounds for
   * refusal. An entry that cannot match anything — wrong case, punctuation,
   * an IPA symbol that belongs in `focus` — costs the scheduler nothing it
   * had, whereas dropping the whole activity over one would cost the learner
   * a phrase. The publish gate refuses it outright, so this only ever sees a
   * document written before that gate existed or edited into the database.
   */
  const soundTargets = Array.isArray(c.soundTargets)
    ? c.soundTargets
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim().toLocaleLowerCase())
        .filter((s) => SOUND_TARGET.test(s))
    : [];

  return {
    id: Math.trunc(c.id),
    title: c.title as string,
    kind: c.kind as string,
    prompt: c.prompt as string,
    gloss: c.gloss as string,
    target: c.target as string,
    focus: c.focus as string,
    // Omitted rather than stored empty, so "no mapping" has one
    // representation instead of two that have to be checked separately.
    ...(soundTargets.length > 0 ? { soundTargets: [...new Set(soundTargets)] } : {}),
  };
}

/**
 * The spine, read strictly — all of it or none of it.
 *
 * The opposite posture to the rest of this function, and deliberately. A
 * dropped *activity* costs one phrase and the language stays up. A dropped
 * *lesson* leaves a course whose units no longer cover their activities, so a
 * learner would be shown a journey with a hole in it and no way to tell that
 * something is missing. Falling back to no spine at all is the shape that
 * shipped and that every screen already handles: the flat list, in order.
 *
 * `known` is the set of activity ids that survived validation, not the ids the
 * document claimed — so a lesson pointing at an activity that was itself
 * dropped takes the spine with it rather than producing a sitting that ends
 * early on a blank screen.
 */
function readUnits(raw: unknown, known: ReadonlySet<number>): ContentUnit[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_UNITS) return null;

  const unitIds = new Set<number>();
  const lessonIds = new Set<number>();
  const covered = new Set<number>();
  const units: ContentUnit[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const u = entry as Partial<ContentUnit>;

    if (typeof u.id !== "number" || !Number.isInteger(u.id) || u.id < 1) return null;
    if (unitIds.has(u.id)) return null;
    unitIds.add(u.id);

    // Named one at a time rather than looped, so the narrowing survives to the
    // construction below — the same reason readActivity casts after its loop.
    if (typeof u.title !== "string" || u.title.trim().length === 0) return null;
    if (typeof u.outcome !== "string" || u.outcome.trim().length === 0) return null;
    if (!Array.isArray(u.lessons) || u.lessons.length === 0) return null;

    const lessons: ContentLesson[] = [];
    for (const lessonEntry of u.lessons) {
      if (typeof lessonEntry !== "object" || lessonEntry === null) return null;
      const l = lessonEntry as Partial<ContentLesson>;

      if (typeof l.id !== "number" || !Number.isInteger(l.id) || l.id < 1) return null;
      if (lessonIds.has(l.id)) return null;
      lessonIds.add(l.id);
      if (lessonIds.size > MAX_LESSONS) return null;

      if (typeof l.title !== "string" || l.title.trim().length === 0) return null;
      if (typeof l.outcome !== "string" || l.outcome.trim().length === 0) return null;

      if (!Array.isArray(l.activityIds)) return null;
      if (l.activityIds.length < MIN_LESSON_ACTIVITIES) return null;
      if (l.activityIds.length > MAX_LESSON_ACTIVITIES) return null;

      for (const id of l.activityIds) {
        if (typeof id !== "number" || !known.has(id)) return null;
        // One take must not read as progress in two places.
        if (covered.has(id)) return null;
        covered.add(id);
      }

      lessons.push({ id: l.id, title: l.title, outcome: l.outcome, activityIds: [...l.activityIds] });
    }

    units.push({ id: u.id, title: u.title, outcome: u.outcome, lessons });
  }

  // An activity in no lesson is content a learner can never reach from the
  // journey, so a spine that does not cover everything is not a spine.
  if (covered.size !== known.size) return null;

  return units;
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

  /**
   * The spine is read against the activities that *survived*, and dropped
   * whole if it does not hold up. Serving a course with a hole in it is worse
   * than serving no course: the flat list is a shape every screen already
   * handles, a half-spine is not.
   *
   * Logged, because a published set whose spine silently disappears looks from
   * the outside like the Journey screen being broken.
   */
  let units: ContentUnit[] | undefined;
  if (c.units !== undefined) {
    const read = readUnits(c.units, new Set(unique.map((a) => a.id)));
    if (read === null) {
      logger.warn(
        { slug: c.slug, version: c.version },
        "[content] published spine failed validation — serving the flat set",
      );
    } else {
      units = read;
    }
  }

  return {
    _id: `${c.slug}:${c.version}`,
    slug: c.slug,
    code: c.code,
    label: c.label,
    version: c.version,
    activities: unique,
    ...(units === undefined ? {} : { units }),
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

    /**
     * Sound targets, wherever they appear. Absence is checked further down —
     * it depends on whether a lesson references the activity — but a malformed
     * entry is wrong in any set, because it is a mapping that cannot map.
     */
    if (a.soundTargets !== undefined) {
      if (!Array.isArray(a.soundTargets)) {
        problems.push(`${where}: soundTargets must be a list of written syllables`);
      } else {
        if (a.soundTargets.length > MAX_SOUND_TARGETS) {
          problems.push(
            `${where}: ${a.soundTargets.length} sound targets — more than ${MAX_SOUND_TARGETS} means the whole phrase, which would win every scheduling comparison`,
          );
        }
        const seen = new Set<string>();
        const targetText = typeof a.target === "string" ? a.target.toLocaleLowerCase() : "";
        for (const entry of a.soundTargets) {
          if (typeof entry !== "string" || entry.trim().length === 0) {
            problems.push(`${where}: a sound target cannot be empty`);
            continue;
          }
          const sound = entry.trim().toLocaleLowerCase();
          if (!SOUND_TARGET.test(sound)) {
            problems.push(
              `${where}: “${entry.trim()}” is not a written syllable — letters, apostrophes and hyphens only, and no phonetic symbols (those belong in focus)`,
            );
            continue;
          }
          if (seen.has(sound)) {
            problems.push(`${where}: sound target “${sound}” is listed twice`);
            continue;
          }
          seen.add(sound);
          /**
           * The one rule that catches a plausible-looking mistake. A syllable
           * that does not occur in the phrase can never come back from the
           * scorer, so the activity would carry a mapping that matches nothing
           * and be invisible to the scheduler — while looking, in the editor,
           * exactly like one that works.
           */
          if (!targetText.includes(sound)) {
            problems.push(
              `${where}: sound target “${sound}” does not appear in the target — the scorer can only ever return syllables of the phrase itself`,
            );
          }
        }
      }
    }
  });

  problems.push(...spineProblems(c.units, c.activities, ids));

  return problems;
}

/**
 * Everything wrong with the spine, or nothing when there is no spine.
 *
 * Split out because it is a different question from "is this activity usable":
 * every rule here is about *relationships* — which lesson an activity is in,
 * whether a lesson points at something that exists, whether anything is
 * unreachable — and those can only be asked once every activity has been read.
 *
 * A set with no `units` produces no problems at all. That is the shape that
 * shipped and it is still publishable: content is versioned and immutable, so
 * the spine arrives as a new version rather than as a requirement imposed
 * retroactively on sets that already exist.
 */
function spineProblems(
  raw: unknown,
  activities: readonly unknown[],
  activityIds: ReadonlySet<number>,
): string[] {
  if (raw === undefined) return [];

  const problems: string[] = [];
  if (!Array.isArray(raw)) return ["units must be a list"];
  if (raw.length === 0) {
    return ["units cannot be an empty list — leave it out entirely for a set with no course spine"];
  }
  if (raw.length > MAX_UNITS) problems.push(`a set cannot hold more than ${MAX_UNITS} units`);

  const unitIds = new Set<number>();
  const lessonIds = new Set<number>();
  /** Which lesson claimed each activity, so a clash can name both. */
  const claimedBy = new Map<number, string>();

  raw.forEach((entry, unitIndex) => {
    const whereUnit = `unit ${unitIndex + 1}`;
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${whereUnit} is not an object`);
      return;
    }
    const u = entry as Partial<ContentUnit>;

    if (typeof u.id !== "number" || !Number.isInteger(u.id) || u.id < 1) {
      problems.push(`${whereUnit}: id must be a whole number, 1 or more`);
    } else if (unitIds.has(u.id)) {
      problems.push(`${whereUnit}: id ${u.id} is already used`);
    } else {
      unitIds.add(u.id);
    }

    if (typeof u.title !== "string" || u.title.trim().length === 0) {
      problems.push(`${whereUnit}: title cannot be empty`);
    }
    if (typeof u.outcome !== "string" || u.outcome.trim().length === 0) {
      problems.push(
        `${whereUnit}: outcome cannot be empty — it is the can-do statement the unit exists to earn`,
      );
    }

    if (!Array.isArray(u.lessons) || u.lessons.length === 0) {
      problems.push(`${whereUnit}: needs at least one lesson`);
      return;
    }

    u.lessons.forEach((lessonEntry, lessonIndex) => {
      const where = `${whereUnit} lesson ${lessonIndex + 1}`;
      if (typeof lessonEntry !== "object" || lessonEntry === null) {
        problems.push(`${where} is not an object`);
        return;
      }
      const l = lessonEntry as Partial<ContentLesson>;

      if (typeof l.id !== "number" || !Number.isInteger(l.id) || l.id < 1) {
        problems.push(`${where}: id must be a whole number, 1 or more`);
      } else if (lessonIds.has(l.id)) {
        // Across the whole set, not per unit: a finished sitting is recorded
        // by lesson id alone, so two lessons sharing one share a record.
        problems.push(`${where}: id ${l.id} is already used by another lesson`);
      } else {
        lessonIds.add(l.id);
      }

      if (typeof l.title !== "string" || l.title.trim().length === 0) {
        problems.push(`${where}: title cannot be empty`);
      }
      if (typeof l.outcome !== "string" || l.outcome.trim().length === 0) {
        problems.push(`${where}: outcome cannot be empty — it is what the sitting ends on`);
      }

      if (!Array.isArray(l.activityIds)) {
        problems.push(`${where}: activityIds must be a list`);
        return;
      }
      if (l.activityIds.length < MIN_LESSON_ACTIVITIES) {
        problems.push(
          `${where}: ${l.activityIds.length} activities — a lesson is one sitting, and fewer than ${MIN_LESSON_ACTIVITIES} is a drill with nothing to summarise`,
        );
      }
      if (l.activityIds.length > MAX_LESSON_ACTIVITIES) {
        problems.push(
          `${where}: ${l.activityIds.length} activities — more than ${MAX_LESSON_ACTIVITIES} outlasts the sitting it was sized for`,
        );
      }

      for (const id of l.activityIds) {
        if (typeof id !== "number" || !Number.isInteger(id)) {
          problems.push(`${where}: every activity id must be a whole number`);
          continue;
        }
        if (!activityIds.has(id)) {
          problems.push(
            `${where}: activity ${id} is not in this set — the sitting would end early on a blank screen`,
          );
          continue;
        }
        const already = claimedBy.get(id);
        if (already !== undefined) {
          problems.push(
            `${where}: activity ${id} is already in ${already} — one take cannot be progress in two lessons`,
          );
          continue;
        }
        claimedBy.set(id, where);
      }
    });
  });

  /**
   * Unreachable content. An activity in no lesson can never be reached from
   * the journey, so it is content that exists and cannot be practised — which
   * is the failure that would be discovered by nobody, because nothing shows
   * an error.
   */
  const orphans = [...activityIds].filter((id) => !claimedBy.has(id));
  if (orphans.length > 0) {
    problems.push(
      `activities ${orphans.join(", ")} are in no lesson — once a set has units, an activity outside them can never be reached`,
    );
  }

  /**
   * And the field this whole spine exists to make usable. A lesson is what the
   * scheduler picks from, so an activity inside one with no sound targets is
   * one it can only ever offer as a fallback — which is the "first unpassed
   * activity wearing the word recommended" that `GET /next` refused to ship.
   */
  activities.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) return;
    const a = entry as Partial<ContentActivity>;
    if (typeof a.id !== "number" || !claimedBy.has(a.id)) return;

    const named = Array.isArray(a.soundTargets)
      ? a.soundTargets.filter((s) => typeof s === "string" && s.trim().length > 0)
      : [];
    if (named.length === 0) {
      problems.push(
        `activity ${index + 1}: soundTargets cannot be empty in a set with units — it is which written syllables the activity drills, and without it the scheduler can never choose this activity for a reason`,
      );
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
 *
 * Sound targets are case-folded here for the same reason, and it is not
 * cosmetic: the skills store folds a grapheme to lower case on the way in, so
 * a published “Bon” would be a mapping that never matches the “bon” a
 * learner's history is keyed on. Refusing the publish over a capital letter
 * would be pedantry; storing one would be a silent no-op.
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
      activities: c.activities.map((a) => {
        const soundTargets = (a.soundTargets ?? []).map((s) => s.trim().toLocaleLowerCase());
        return {
          id: a.id,
          title: a.title.trim(),
          kind: a.kind,
          prompt: a.prompt.trim(),
          gloss: a.gloss.trim(),
          target: a.target.trim(),
          focus: a.focus.trim(),
          // Omitted rather than stored empty, so a set with no mapping has one
          // representation rather than two, and the key-set of a published
          // document says plainly whether one was authored.
          ...(soundTargets.length > 0 ? { soundTargets } : {}),
        };
      }),
      /**
       * The spine is carried only when there is one. A `units: undefined` key
       * would be stored by the driver as a null field and would make an old
       * flat set and a new course set indistinguishable by shape.
       */
      ...(c.units === undefined
        ? {}
        : {
            units: c.units.map((u) => ({
              id: u.id,
              title: u.title.trim(),
              outcome: u.outcome.trim(),
              lessons: u.lessons.map((l) => ({
                id: l.id,
                title: l.title.trim(),
                outcome: l.outcome.trim(),
                activityIds: [...l.activityIds],
              })),
            })),
          }),
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
