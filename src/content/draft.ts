/**
 * A set being edited, and everything wrong with it.
 *
 * The authoring screen holds a draft as strings, because that is what a form
 * field gives you — `id` included, since a half-typed number is `""` and
 * `NaN`, neither of which is a number worth storing. Conversion to the wire
 * shape happens once, at publish, in `draftToPayload`.
 *
 * **The server is the gate; this is the explanation.** `contentProblems` in
 * server/store/content.ts is what actually refuses a publish, and this is a
 * client-side mirror of the same rules — deliberate duplication, the same
 * convention the content types and `PronunciationResult` already follow across
 * this boundary (PRD §6), because a page cannot import from `server/`.
 *
 * Written so that disagreement can only ever cost a failed publish, never
 * produce a bad one: this check can refuse something the server would accept,
 * which is an annoyance, and the screen renders the server's own `problems`
 * verbatim when a publish comes back 422, so the authoritative answer is
 * always the one on screen. It cannot accept something the server refuses and
 * have that reach a learner.
 *
 * Lives here rather than in `src/activities/`, which is a DOM-free zone shared
 * with the Node scripts. Nothing in this file touches the DOM, but the draft is
 * a screen's concern and `src/content/` is already where the client's side of
 * served content lives.
 */

import {
  ACTIVITY_KINDS,
  MAX_LESSON_ACTIVITIES,
  MIN_LESSON_ACTIVITIES,
  type ActivityKind,
} from "../activities/types.js";

/**
 * Offered as a fixed list, so a kind cannot be mistyped into existence.
 *
 * The list itself rather than a second copy of it: this was a hand-written
 * `["repeat", "respond", "read"]` beside a hand-written union of the same three
 * strings, and `recall` had to be added to both or the screen would offer
 * three options for a four-kind model.
 */
export const DRAFT_KINDS: readonly ActivityKind[] = ACTIVITY_KINDS;

/** Mirrors MAX_ACTIVITIES in server/store/content.ts. */
export const MAX_DRAFT_ACTIVITIES = 50;

/** Mirrors MIN/MAX_LESSON_ACTIVITIES — one sitting, with an end. */
export const MIN_DRAFT_LESSON_ACTIVITIES = MIN_LESSON_ACTIVITIES;
export const MAX_DRAFT_LESSON_ACTIVITIES = MAX_LESSON_ACTIVITIES;

/** Mirrors MAX_SOUND_TARGETS in server/store/content.ts. */
export const MAX_DRAFT_SOUND_TARGETS = 12;

/**
 * A written syllable — the same shape the skills store accepts as a grapheme,
 * because an entry it would refuse can never match a learner's history.
 */
const SOUND_TARGET = /^[\p{L}\p{M}'’-]{1,24}$/u;

/**
 * Mirrors MAX_TARGET_WORDS in server/store/content.ts: past this a target is
 * cut off mid-phrase by the capture ceiling and scored as an omission, with the
 * learner blamed for our timing.
 */
export const MAX_DRAFT_TARGET_WORDS = 14;

/** Azure pronunciation-assessment locales are BCP-47: two-letter, region-qualified. */
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

const SLUG = /^[a-z]{2,16}$/;

/** Every field a string, because every field came from an input. */
export interface DraftActivity {
  id: string;
  title: string;
  kind: string;
  prompt: string;
  gloss: string;
  target: string;
  focus: string;
  /**
   * The written syllables this activity drills, as the author typed them:
   * comma-separated, because a list of short strings in a form is either that
   * or a row of controls per entry, and the row of controls buys nothing an
   * author wants at the moment they are typing four syllables.
   */
  soundTargets: string;
}

/** A lesson being edited. `activityIds` is comma-separated, for the same reason. */
export interface DraftLesson {
  id: string;
  title: string;
  outcome: string;
  activityIds: string;
}

export interface DraftUnit {
  id: string;
  title: string;
  outcome: string;
  lessons: DraftLesson[];
}

export interface ContentDraft {
  slug: string;
  code: string;
  label: string;
  activities: DraftActivity[];
  /**
   * Empty means no spine, which is a valid set rather than an unfinished one —
   * three of the four shipped languages are that shape. An empty list is
   * therefore not sent at all, rather than sent as `units: []`.
   */
  units: DraftUnit[];
}

/** What `POST /api/v1/content/:slug` accepts. */
export interface DraftPayload {
  code: string;
  label: string;
  baseVersion: number;
  activities: {
    id: number;
    title: string;
    kind: string;
    prompt: string;
    gloss: string;
    target: string;
    focus: string;
    soundTargets: string[];
  }[];
  units?: {
    id: number;
    title: string;
    outcome: string;
    lessons: { id: number; title: string; outcome: string; activityIds: number[] }[];
  }[];
}

/** A row with nothing in it, for "add an activity". */
export function emptyActivity(id: number): DraftActivity {
  return {
    id: String(id),
    title: "",
    kind: "repeat",
    prompt: "",
    gloss: "",
    target: "",
    focus: "",
    soundTargets: "",
  };
}

/** An empty lesson, for "add a lesson". */
export function emptyLesson(id: number): DraftLesson {
  return { id: String(id), title: "", outcome: "", activityIds: "" };
}

/** An empty unit, carrying one empty lesson — a unit with none is never valid. */
export function emptyUnit(id: number, lessonId: number): DraftUnit {
  return { id: String(id), title: "", outcome: "", lessons: [emptyLesson(lessonId)] };
}

/**
 * A comma-separated field as the entries an author meant.
 *
 * Commas *and* whitespace, so a list pasted as "bon jour" is read as two
 * syllables rather than one that matches nothing. Empty entries are dropped
 * rather than reported: a trailing comma is a typing artefact, not a mistake
 * worth a line in the problem list.
 */
function entries(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The two things a draft can be seeded from: the bundled `LanguageActivitySet`
 * and a version fetched from the server. Typed structurally so both fit — the
 * fetched one crossed a network, so its `kind` is a `string` rather than the
 * bundle's `ActivityKind`, and narrowing it is `draftProblems`'s job rather
 * than something to assert on the way in.
 */
export interface DraftSource {
  slug: string;
  code: string;
  label: string;
  activities: readonly {
    id: number;
    title: string;
    kind: string;
    prompt: string;
    gloss: string;
    target: string;
    focus: string;
    soundTargets?: readonly string[];
  }[];
  /** Absent on the sets that shipped before the spine, and on any flat set. */
  units?: readonly {
    id: number;
    title: string;
    outcome: string;
    lessons: readonly { id: number; title: string; outcome: string; activityIds: readonly number[] }[];
  }[];
}

/**
 * A draft seeded from an existing set — the bundled one, or a published
 * version somebody wants to correct or roll forward.
 */
export function draftFromSet(set: DraftSource): ContentDraft {
  return {
    slug: set.slug,
    code: set.code,
    label: set.label,
    activities: set.activities.map((a) => ({
      id: String(a.id),
      title: a.title,
      kind: a.kind,
      prompt: a.prompt,
      gloss: a.gloss,
      target: a.target,
      focus: a.focus,
      soundTargets: (a.soundTargets ?? []).join(", "),
    })),
    units: (set.units ?? []).map((u) => ({
      id: String(u.id),
      title: u.title,
      outcome: u.outcome,
      lessons: u.lessons.map((l) => ({
        id: String(l.id),
        title: l.title,
        outcome: l.outcome,
        activityIds: l.activityIds.join(", "),
      })),
    })),
  };
}

/**
 * Everything wrong with the draft, in the order somebody would fix it. Empty
 * means publishable.
 *
 * Nothing is dropped and nothing is corrected. An author who types ten
 * activities, sees a green tick, and has row three quietly discarded has
 * published nine and been told nothing — which is worse than being refused.
 */
export function draftProblems(draft: ContentDraft): string[] {
  const problems: string[] = [];

  if (!SLUG.test(draft.slug)) problems.push("slug must be 2–16 lowercase letters, like “fr”");
  if (!LOCALE.test(draft.code)) {
    problems.push("locale must look like “fr-FR” — the provider rejects anything else");
  }
  if (draft.label.trim().length === 0) {
    problems.push("label cannot be empty — it is what a learner sees in the picker");
  }

  if (draft.activities.length === 0) {
    problems.push("a set needs at least one activity — an empty language reads as a broken app");
  }
  if (draft.activities.length > MAX_DRAFT_ACTIVITIES) {
    problems.push(`a set cannot hold more than ${MAX_DRAFT_ACTIVITIES} activities`);
  }

  const ids = new Set<number>();
  const targets = new Set<string>();

  draft.activities.forEach((a, index) => {
    const where = `activity ${index + 1}`;
    const id = Number(a.id.trim());

    if (a.id.trim().length === 0 || !Number.isInteger(id) || id < 1) {
      problems.push(`${where}: id must be a whole number, 1 or more`);
    } else if (ids.has(id)) {
      problems.push(`${where}: id ${id} is already used — a duplicate merges two activities' attempts`);
    } else {
      ids.add(id);
    }

    if (!(DRAFT_KINDS as readonly string[]).includes(a.kind)) {
      problems.push(`${where}: kind must be one of ${DRAFT_KINDS.join(", ")}`);
    }

    for (const field of ["title", "prompt", "gloss", "target", "focus"] as const) {
      if (a[field].trim().length === 0) problems.push(`${where}: ${field} cannot be empty`);
    }

    const target = a.target.trim();
    if (target.length > 0) {
      const words = target.split(/\s+/).length;
      if (words > MAX_DRAFT_TARGET_WORDS) {
        problems.push(
          `${where}: target is ${words} words — over ${MAX_DRAFT_TARGET_WORDS} is cut off mid-phrase and scored as an omission`,
        );
      }
      if (targets.has(target)) problems.push(`${where}: target repeats an earlier activity's`);
      else targets.add(target);
    }

    const sounds = entries(a.soundTargets);
    if (sounds.length > MAX_DRAFT_SOUND_TARGETS) {
      problems.push(
        `${where}: ${sounds.length} sound targets — more than ${MAX_DRAFT_SOUND_TARGETS} means the whole phrase, which would win every scheduling comparison`,
      );
    }
    const seenSounds = new Set<string>();
    for (const entry of sounds) {
      const sound = entry.toLocaleLowerCase();
      if (!SOUND_TARGET.test(sound)) {
        problems.push(
          `${where}: “${entry}” is not a written syllable — letters, apostrophes and hyphens only, and no phonetic symbols (those belong in focus)`,
        );
        continue;
      }
      if (seenSounds.has(sound)) {
        problems.push(`${where}: sound target “${sound}” is listed twice`);
        continue;
      }
      seenSounds.add(sound);
      if (!target.toLocaleLowerCase().includes(sound)) {
        problems.push(
          `${where}: sound target “${sound}” does not appear in the target — the scorer can only ever return syllables of the phrase itself`,
        );
      }
    }
  });

  problems.push(...draftSpineProblems(draft, ids));

  return problems;
}

/**
 * Everything wrong with the spine, or nothing when there is no spine.
 *
 * Mirrors `spineProblems` in server/store/content.ts, which is the gate. The
 * same one-way guarantee holds as for the rest of this file: this can refuse
 * something the server would accept, which costs a failed publish and is shown
 * with the server's own wording when it happens; it cannot accept something
 * the server refuses.
 */
function draftSpineProblems(draft: ContentDraft, activityIds: ReadonlySet<number>): string[] {
  if (draft.units.length === 0) return [];

  const problems: string[] = [];
  const unitIds = new Set<number>();
  const lessonIds = new Set<number>();
  const claimedBy = new Map<number, string>();

  draft.units.forEach((u, unitIndex) => {
    const whereUnit = `unit ${unitIndex + 1}`;
    const unitId = Number(u.id.trim());

    if (u.id.trim().length === 0 || !Number.isInteger(unitId) || unitId < 1) {
      problems.push(`${whereUnit}: id must be a whole number, 1 or more`);
    } else if (unitIds.has(unitId)) {
      problems.push(`${whereUnit}: id ${unitId} is already used`);
    } else {
      unitIds.add(unitId);
    }

    if (u.title.trim().length === 0) problems.push(`${whereUnit}: title cannot be empty`);
    if (u.outcome.trim().length === 0) {
      problems.push(
        `${whereUnit}: outcome cannot be empty — it is the can-do statement the unit exists to earn`,
      );
    }
    if (u.lessons.length === 0) {
      problems.push(`${whereUnit}: needs at least one lesson`);
      return;
    }

    u.lessons.forEach((l, lessonIndex) => {
      const where = `${whereUnit} lesson ${lessonIndex + 1}`;
      const lessonId = Number(l.id.trim());

      if (l.id.trim().length === 0 || !Number.isInteger(lessonId) || lessonId < 1) {
        problems.push(`${where}: id must be a whole number, 1 or more`);
      } else if (lessonIds.has(lessonId)) {
        problems.push(`${where}: id ${lessonId} is already used by another lesson`);
      } else {
        lessonIds.add(lessonId);
      }

      if (l.title.trim().length === 0) problems.push(`${where}: title cannot be empty`);
      if (l.outcome.trim().length === 0) {
        problems.push(`${where}: outcome cannot be empty — it is what the sitting ends on`);
      }

      const ids = entries(l.activityIds).map((part) => Number(part));
      if (ids.length < MIN_DRAFT_LESSON_ACTIVITIES) {
        problems.push(
          `${where}: ${ids.length} activities — a lesson is one sitting, and fewer than ${MIN_DRAFT_LESSON_ACTIVITIES} is a drill with nothing to summarise`,
        );
      }
      if (ids.length > MAX_DRAFT_LESSON_ACTIVITIES) {
        problems.push(
          `${where}: ${ids.length} activities — more than ${MAX_DRAFT_LESSON_ACTIVITIES} outlasts the sitting it was sized for`,
        );
      }

      for (const id of ids) {
        if (!Number.isInteger(id)) {
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

  const orphans = [...activityIds].filter((id) => !claimedBy.has(id));
  if (orphans.length > 0) {
    problems.push(
      `activities ${orphans.join(", ")} are in no lesson — once a set has units, an activity outside them can never be reached`,
    );
  }

  draft.activities.forEach((a, index) => {
    const id = Number(a.id.trim());
    if (!claimedBy.has(id)) return;
    if (entries(a.soundTargets).length === 0) {
      problems.push(
        `activity ${index + 1}: soundTargets cannot be empty in a set with units — it is which written syllables the activity drills, and without it the scheduler can never choose this activity for a reason`,
      );
    }
  });

  return problems;
}

/**
 * The draft as the endpoint wants it. Only ever called on a draft with no
 * problems — a `NaN` id here would mean `draftProblems` let one through.
 *
 * `slug` is not sent: it comes from the path, and two sources for one value is
 * a way to publish French content under the Spanish slug.
 */
export function draftToPayload(draft: ContentDraft, baseVersion: number): DraftPayload {
  return {
    code: draft.code.trim(),
    label: draft.label.trim(),
    baseVersion,
    activities: draft.activities.map((a) => ({
      id: Number(a.id.trim()),
      title: a.title.trim(),
      kind: a.kind,
      prompt: a.prompt.trim(),
      gloss: a.gloss.trim(),
      target: a.target.trim(),
      focus: a.focus.trim(),
      // Folded here as well as on the server, so what the author sees in the
      // next version they load back is what will actually match a learner's
      // history rather than a capitalised near-miss of it.
      soundTargets: entries(a.soundTargets).map((s) => s.toLocaleLowerCase()),
    })),
    /**
     * Omitted entirely when there is no spine. Sending `units: []` would ask
     * the server to store an empty course, which it refuses — correctly, since
     * "no spine" and "a spine with nothing in it" are not the same claim.
     */
    ...(draft.units.length === 0
      ? {}
      : {
          units: draft.units.map((u) => ({
            id: Number(u.id.trim()),
            title: u.title.trim(),
            outcome: u.outcome.trim(),
            lessons: u.lessons.map((l) => ({
              id: Number(l.id.trim()),
              title: l.title.trim(),
              outcome: l.outcome.trim(),
              activityIds: entries(l.activityIds).map((part) => Number(part)),
            })),
          })),
        }),
  };
}
