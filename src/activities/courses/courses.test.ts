/**
 * The course-shaped sets as data — the same posture as
 * src/activities/languages/languages.test.ts, applied to the spine.
 *
 * Content is the thing a type checker cannot help with. A lesson pointing at
 * an activity that does not exist, an activity in two lessons, a sound target
 * that occurs nowhere in the phrase it claims to drill: every one of those
 * compiles cleanly and fails for a whole language at runtime, and two of them
 * fail *silently* — a learner sees a shorter journey or a scheduler that never
 * picks a phrase, with nothing on screen to say why.
 *
 * The publish gate (server/store/content.ts) refuses all of them, and these
 * sets go through it on the way to the database. This file is the half of that
 * which runs without a database, at the moment the content is edited.
 *
 * DOM-free, like everything under src/activities/: tsconfig.scripts.json
 * includes this directory so Node scripts can import the content sets, so
 * nothing here may reach for browser storage, `window`, or src/content/.
 */

import { describe, expect, it } from "vitest";
import { affordancesFor } from "../../learning/affordances.js";
import { COURSES, getCourse } from "./index.js";
import { LANGUAGES, getLanguage } from "../languages/index.js";
import { PLANNED } from "../../planned.js";
import { LOCATE_OPTIONS, locateOptions, phraseContains } from "../locate.js";
import {
  ACTIVITY_KINDS,
  MAX_LESSON_ACTIVITIES,
  MIN_LESSON_ACTIVITIES,
  type ActivityKind,
  type LanguageActivitySet,
} from "../types.js";

/** Every activity id a lesson claims, in the order lessons claim them. */
function claimedIds(set: LanguageActivitySet): number[] {
  return (set.units ?? []).flatMap((u) => u.lessons.flatMap((l) => l.activityIds));
}

describe("which languages have a course", () => {
  it("has one for each language the product offers, and for nothing else", () => {
    /**
     * Scope, stated as a test rather than as a comment. French and Spanish are
     * what `LANGUAGES` offers, and both have a spine.
     *
     * German still *has* a course — the file is unchanged — but it is not in
     * `COURSES`, because its language is no longer offered and a course whose
     * language nobody can open is content these tests would otherwise be
     * vouching for on behalf of no one.
     *
     * Hindi has neither, and cannot honestly have one: hi-IN returns no
     * syllable graphemes at all, so every sound target would be a mapping that
     * can never match what the scorer returns.
     */
    expect(COURSES.map((c) => c.slug)).toEqual(["fr", "es", "de"]);
    expect(getCourse("hi")).toBeUndefined();
    expect(getCourse(undefined)).toBeUndefined();
  });

  it("leaves the bundled sets flat, because that is what an old client reads", () => {
    /**
     * The compatibility mechanism, asserted rather than assumed. If the spine
     * were added to the bundled sets instead of published as a new version,
     * there would be nothing left in the tree that still has the old shape —
     * and "an old client keeps working" would be a claim nothing checks.
     */
    for (const language of LANGUAGES) {
      expect(language.units, language.slug).toBeUndefined();
    }
  });
});

describe.each(COURSES.map((c) => [c.label, c] as const))("the %s course", (_label, set) => {
  const bundled = getLanguage(set.slug);
  if (bundled === undefined) throw new Error(`no bundled set for ${set.slug}`);

  it("keeps every bundled activity exactly as it was published", () => {
    /**
     * The ten phrases already have attempts recorded against their ids. A
     * course that renumbered or reworded one would silently re-point a
     * learner's history: `id` is what the report joins on, so activity 7
     * becoming a different phrase makes their old score a score of something
     * they never said.
     */
    expect(set.activities.slice(0, bundled.activities.length)).toEqual(bundled.activities);
  });

  it("adds activities rather than replacing them", () => {
    expect(set.activities.length).toBeGreaterThan(bundled.activities.length);
    expect(set.slug).toBe(bundled.slug);
    expect(set.code).toBe(bundled.code);
  });

  it("writes content for both kinds that had none", () => {
    /**
     * `read` existed in the type with zero content ever written for it, and
     * `recall` did not exist at all. A kind nobody authors for is a kind whose
     * screen nobody builds and whose bugs nobody finds.
     */
    const kinds = set.activities.map((a) => a.kind);
    expect(kinds.filter((k) => k === "read").length).toBeGreaterThanOrEqual(1);
    expect(kinds.filter((k) => k === "recall").length).toBeGreaterThanOrEqual(1);
  });

  it("uses only kinds a screen knows how to render", () => {
    for (const activity of set.activities) {
      expect(ACTIVITY_KINDS, `activity ${activity.id}`).toContain(activity.kind);
    }
  });

  it("numbers activities from one with no duplicates or gaps", () => {
    const ids = set.activities.map((a) => a.id);
    expect(ids).toEqual(ids.map((_, i) => i + 1));
  });

  /**
   * Scored twice is the failure, not written twice.
   *
   * Two activities that both *record* the same phrase would put two accuracies
   * on one sentence and count the syllables twice in the skills store. But a
   * `locate` asks nothing of the microphone — it plays the phrase and takes a
   * choice — so it reuses one on purpose: the ear training lands on the same
   * sounds the production drills, and inventing a new phrase for it would be
   * new French nobody has checked.
   *
   * Scoped to the kinds that actually score, by asking `affordancesFor` rather
   * than listing kinds here. A sixth kind that records is covered the day it
   * is added; one that does not is not quietly forbidden from reuse.
   */
  it("never scores the same phrase twice", () => {
    const scored = set.activities.filter(
      (a) => affordancesFor(a.kind, { takes: 0, revealed: false }).needsMicrophone,
    );
    const targets = scored.map((a) => a.target);

    expect(scored.length, "no scored activities to check").toBeGreaterThan(0);
    expect(new Set(targets).size, "two activities record the same phrase").toBe(targets.length);
  });

  /**
   * And a phrase reused by a silent kind must be one the course already
   * teaches. Reuse is the point; a `locate` on a phrase no other activity
   * drills would be a listening question about a sentence the learner never
   * meets anywhere else.
   */
  it("reuses only phrases the course already teaches", () => {
    const spoken = new Set(
      set.activities
        .filter((a) => affordancesFor(a.kind, { takes: 0, revealed: false }).needsMicrophone)
        .map((a) => a.target),
    );

    for (const activity of set.activities) {
      if (affordancesFor(activity.kind, { takes: 0, revealed: false }).needsMicrophone) continue;
      if (activity.kind === "listen") continue; // authored near-misses, not a reuse
      expect(
        spoken.has(activity.target),
        `activity ${activity.id} asks about a phrase nothing else teaches`,
      ).toBe(true);
    }
  });

  it("keeps every target inside the capture duration ceiling", () => {
    for (const activity of set.activities) {
      const words = activity.target.trim().split(/\s+/).length;
      expect(words, `activity ${activity.id} is ${words} words`).toBeLessThanOrEqual(14);
    }
  });

  it("gives every activity a prompt, a gloss and a focus", () => {
    for (const activity of set.activities) {
      for (const field of ["title", "prompt", "gloss", "target", "focus"] as const) {
        expect(activity[field].trim().length, `activity ${activity.id} ${field}`).toBeGreaterThan(0);
      }
    }
  });
});

describe.each(COURSES.map((c) => [c.label, c] as const))("the %s spine", (_label, set) => {
  it("covers every activity exactly once", () => {
    /**
     * The two failures this catches are opposites and both invisible. An
     * activity in no lesson is content that exists and can never be reached
     * from the journey. An activity in two reports one take as progress in
     * both, because a lesson's completion is derived from its activities'.
     */
    const claimed = claimedIds(set);
    expect(new Set(claimed).size, "an activity appears in two lessons").toBe(claimed.length);
    expect([...claimed].sort((a, b) => a - b)).toEqual(set.activities.map((a) => a.id));
  });

  it("points only at activities that exist", () => {
    const ids = new Set(set.activities.map((a) => a.id));
    for (const id of claimedIds(set)) expect(ids, `activity ${id}`).toContain(id);
  });

  it("sizes every lesson as one sitting", () => {
    for (const unit of set.units ?? []) {
      for (const lesson of unit.lessons) {
        const where = `lesson ${lesson.id}`;
        expect(lesson.activityIds.length, where).toBeGreaterThanOrEqual(MIN_LESSON_ACTIVITIES);
        expect(lesson.activityIds.length, where).toBeLessThanOrEqual(MAX_LESSON_ACTIVITIES);
      }
    }
  });

  it("numbers lessons uniquely across the whole language, not per unit", () => {
    // A finished sitting is recorded by lesson id alone, so two lessons
    // sharing one share a record — unit 2's lesson 1 finishing unit 1's.
    const ids = (set.units ?? []).flatMap((u) => u.lessons.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("numbers units uniquely", () => {
    const ids = (set.units ?? []).map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every unit and lesson an outcome, because that is what it is for", () => {
    for (const unit of set.units ?? []) {
      expect(unit.title.trim().length, `unit ${unit.id} title`).toBeGreaterThan(0);
      expect(unit.outcome.trim().length, `unit ${unit.id} outcome`).toBeGreaterThan(0);
      for (const lesson of unit.lessons) {
        expect(lesson.title.trim().length, `lesson ${lesson.id} title`).toBeGreaterThan(0);
        expect(lesson.outcome.trim().length, `lesson ${lesson.id} outcome`).toBeGreaterThan(0);
      }
    }
  });

  it("claims only what this product measures", () => {
    /**
     * Outcomes may claim per-syllable pronunciation and attendance, and
     * nothing else. "You can understand a waiter" would be a comprehension
     * claim with no measurement behind it — the `listen` activity is the first
     * thing that would earn one, and it does not exist yet.
     */
    const forbidden = /\b(understand|comprehend|read|write|vocabulary|grammar|fluent|fluency)\b/i;
    for (const unit of set.units ?? []) {
      expect(unit.outcome, `unit ${unit.id}`).not.toMatch(forbidden);
      for (const lesson of unit.lessons) {
        expect(lesson.outcome, `lesson ${lesson.id}`).not.toMatch(forbidden);
      }
    }
  });
});

describe.each(COURSES.map((c) => [c.label, c] as const))("%s sound targets", (_label, set) => {
  it("names some for every activity a lesson references", () => {
    /**
     * The field the whole spine exists to make usable. A lesson is what the
     * scheduler picks from, so an activity inside one with no sound targets is
     * one `selectActivity` can only ever offer as a fallback — which is the
     * "first unpassed activity wearing the word recommended" that GET /next
     * refused to ship.
     */
    const claimed = new Set(claimedIds(set));
    for (const activity of set.activities) {
      if (!claimed.has(activity.id)) continue;
      expect(activity.soundTargets ?? [], `activity ${activity.id}`).not.toHaveLength(0);
    }
  });

  it("names syllables that actually occur in the phrase", () => {
    /**
     * The one mistake that looks right. A syllable the phrase does not contain
     * can never come back from the scorer, so the activity carries a mapping
     * that matches nothing — while looking, in the editor, exactly like one
     * that works.
     */
    for (const activity of set.activities) {
      const target = activity.target.toLocaleLowerCase();
      for (const sound of activity.soundTargets ?? []) {
        expect(target, `activity ${activity.id}: “${sound}”`).toContain(sound);
      }
    }
  });

  it("stores them already folded, as the skills store keys them", () => {
    // server/domain/merge.ts lower-cases a grapheme on the way in, so a stored
    // "Bon" is a mapping that never matches the "bon" a history is keyed on.
    for (const activity of set.activities) {
      for (const sound of activity.soundTargets ?? []) {
        expect(sound, `activity ${activity.id}`).toBe(sound.toLocaleLowerCase());
        expect(sound.trim(), `activity ${activity.id}`).toBe(sound);
      }
    }
  });

  it("lists no syllable twice within one activity", () => {
    for (const activity of set.activities) {
      const sounds = activity.soundTargets ?? [];
      expect(new Set(sounds).size, `activity ${activity.id}`).toBe(sounds.length);
    }
  });

  it("uses written syllables rather than phonetic symbols", () => {
    /**
     * `focus` is where IPA belongs: it is prose for a human. A sound target is
     * matched against what the provider labelled a syllable, which is always
     * the reference text's own orthography — so `/ʁ/` here would be a mapping
     * to nothing, and it is the obvious thing to type.
     */
    const grapheme = /^[\p{L}\p{M}'’-]{1,24}$/u;
    for (const activity of set.activities) {
      for (const sound of activity.soundTargets ?? []) {
        expect(sound, `activity ${activity.id}`).toMatch(grapheme);
      }
    }
  });
});

describe("the new content as Unicode", () => {
  /**
   * The same three checks src/activities/languages/i18n.test.ts makes of the
   * bundle, over the strings it does not see. Left here rather than folded into
   * that file so its exact string count — which exists to catch a sweep that
   * stopped visiting a field — stays exact.
   */
  function everyString(): [string, string][] {
    const out: [string, string][] = [];
    for (const set of COURSES) {
      for (const activity of set.activities) {
        for (const [field, value] of Object.entries(activity)) {
          if (typeof value !== "string") continue;
          out.push([`${set.slug} activity ${activity.id} ${field}`, value]);
        }
      }
      for (const unit of set.units ?? []) {
        out.push([`${set.slug} unit ${unit.id} title`, unit.title]);
        out.push([`${set.slug} unit ${unit.id} outcome`, unit.outcome]);
        for (const lesson of unit.lessons) {
          out.push([`${set.slug} lesson ${lesson.id} title`, lesson.title]);
          out.push([`${set.slug} lesson ${lesson.id} outcome`, lesson.outcome]);
        }
      }
    }
    return out;
  }

  it("stores every string already normalised", () => {
    // "é" as one code point and as "e" plus a combining acute look identical
    // and compare unequal, and the server's alignment strips combining marks.
    for (const [where, value] of everyString()) {
      expect(value.normalize("NFC"), where).toBe(value);
    }
  });

  it("uses no script the brand font cannot render, and no emoji", () => {
    const allowed =
      /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
    let checked = 0;
    for (const [where, value] of everyString()) {
      expect(value, where).toMatch(allowed);
      expect(value, `${where} contains a symbol or emoji`).not.toMatch(
        /\p{Extended_Pictographic}|\p{So}/u,
      );
      checked += 1;
    }
    // Stated so a sweep that stopped visiting a field is visible rather than
    // passing over an empty list.
    expect(checked).toBeGreaterThan(0);
  });
});

/**
 * Every kind a learner can actually meet.
 *
 * `locate` was built end to end — options derived, screen rendered, publish
 * gate taught to allow the phrase reuse it needs — and shipped in no course
 * at all, so no learner would ever have seen one. Nothing failed. Every test
 * about `locate` passed, because they all tested `locate`; none of them asked
 * whether any content used it. It is the same shape as the vowel chart that no
 * screen imported, and it is invisible to every check that reads what the
 * source says rather than what it omits.
 *
 * So the bundled sets and the courses together are the content a learner can
 * reach, and a kind is either in them or written down here with what it is
 * waiting for. Adding a line to `AWAITING_CONTENT` is then a deliberate edit
 * somebody has to justify, rather than a regression nobody sees.
 */
interface AwaitingContent {
  /** Why no shipped set uses it. */
  because: string;
  /**
   * The `PLANNED` entry that tells a learner about it, by title.
   *
   * The link matters in both directions. A kind we are not shipping that
   * nobody is told about is a feature that quietly does not exist; a `PLANNED`
   * entry removed without content arriving is a promise withdrawn in silence.
   */
  planned: string;
}

const AWAITING_CONTENT: Partial<Record<ActivityKind, AwaitingContent>> = {
  listen: {
    because:
      "its options are authored near-misses, not derived — every language needs pairs written by somebody who knows its sounds, unlike `locate`, which every language with sound targets gets for free",
    planned: "Hearing a difference before you have to say it",
  },
};

describe("the kinds a learner can actually meet", () => {
  /** Everything a learner can open: the offline floor plus the courses. */
  const shipped = new Set<ActivityKind>(
    [...LANGUAGES, ...COURSES].flatMap((set) => set.activities.map((a) => a.kind)),
  );

  it("has content for every kind, or says what that kind is waiting for", () => {
    for (const kind of ACTIVITY_KINDS) {
      if (shipped.has(kind)) continue;
      expect(
        AWAITING_CONTENT[kind],
        `\`${kind}\` is built but no set uses it, and nothing says why`,
      ).toBeDefined();
    }
  });

  /**
   * The other direction, so the list cannot rot. The day somebody authors a
   * `listen` row, this fails and the entry has to go — which is also what
   * sends them to the `PLANNED` list to remove the promise.
   */
  it("keeps nothing on that list that content already covers", () => {
    for (const kind of Object.keys(AWAITING_CONTENT) as ActivityKind[]) {
      expect(shipped.has(kind), `\`${kind}\` ships now — remove it from AWAITING_CONTENT`).toBe(
        false,
      );
    }
  });

  it("tells learners about every kind it is holding back", () => {
    for (const [kind, waiting] of Object.entries(AWAITING_CONTENT)) {
      expect(
        PLANNED.some((f) => f.title === waiting?.planned),
        `nothing on the planned list covers \`${kind}\``,
      ).toBe(true);
    }
  });

  /**
   * Reachable is not the same as working, and `locate` is the kind where they
   * come apart.
   *
   * Its options are **derived** from the language's own sound targets rather
   * than authored, so an activity can be perfectly well-formed and still
   * compose no question: too few distinct syllables in the set, or every
   * candidate distractor turning out to occur in this phrase. The screen
   * handles that honestly — it says the question could not be put together and
   * counts nothing against the learner — which means a broken one ships
   * silently, showing that message to everybody who reaches it, with every
   * test still green.
   *
   * So the question is composed here, from the shipped set, exactly as the
   * screen composes it.
   */
  it("composes a real question for every locate activity it ships", () => {
    const located = [...LANGUAGES, ...COURSES].flatMap((set) =>
      set.activities.filter((a) => a.kind === "locate").map((a) => [set, a] as const),
    );

    expect(located.length, "no locate activity to check").toBeGreaterThan(0);

    for (const [set, activity] of located) {
      const options = locateOptions(activity, set);

      expect(options, `${set.slug} activity ${activity.id} composes no question`).not.toBeNull();
      expect(options?.length, `${set.slug} activity ${activity.id}`).toBe(LOCATE_OPTIONS);

      const correct = options?.filter((o) => o.correct) ?? [];
      expect(correct.length, `${set.slug} activity ${activity.id} has no single answer`).toBe(1);

      // The answer is in the phrase and the wrong ones are not — otherwise the
      // learner is asked to hear something that is not there, or marked wrong
      // for a syllable the phrase actually contains.
      for (const option of options ?? []) {
        expect(
          phraseContains(activity.target, option.grapheme),
          `${set.slug} activity ${activity.id}: ${option.grapheme}`,
        ).toBe(option.correct);
      }
    }
  });

  /**
   * Non-vacuity, and not a formality: the first two tests both pass happily
   * against an empty `shipped` — which is precisely the state they exist to
   * catch, one kind at a time.
   */
  it("actually reads the shipped content", () => {
    expect(shipped.size).toBeGreaterThan(1);
    expect([...shipped].every((k) => (ACTIVITY_KINDS as readonly string[]).includes(k))).toBe(true);
  });
});
