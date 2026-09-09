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

import type { ActivityKind } from "../activities/types.js";

/** Offered as a fixed list, so a kind cannot be mistyped into existence. */
export const DRAFT_KINDS: readonly ActivityKind[] = ["repeat", "respond", "read"];

/** Mirrors MAX_ACTIVITIES in server/store/content.ts. */
export const MAX_DRAFT_ACTIVITIES = 50;

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
}

export interface ContentDraft {
  slug: string;
  code: string;
  label: string;
  activities: DraftActivity[];
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
  }[];
}

/** A row with nothing in it, for "add an activity". */
export function emptyActivity(id: number): DraftActivity {
  return { id: String(id), title: "", kind: "repeat", prompt: "", gloss: "", target: "", focus: "" };
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
    })),
  };
}
