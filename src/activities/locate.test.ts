/**
 * Composing a "which sound was in that?" question.
 *
 * One property matters more than the rest, and it is the one that would be
 * invisible: a wrong option that happens to occur in the phrase is a second
 * right answer, and the learner is marked wrong for hearing correctly. Most of
 * this file is that.
 */

import { describe, expect, it } from "vitest";
import { LOCATE_OPTIONS, locateOptions, phraseContains } from "./locate.js";
import type { Activity, LanguageActivitySet } from "./types.js";

function activity(id: number, over: Partial<Activity> = {}): Activity {
  return {
    id,
    title: `Activity ${id}`,
    kind: "repeat",
    prompt: "Say it",
    gloss: "a coffee",
    target: "je voudrais un café",
    focus: "the French r",
    soundTargets: ["vou", "drais"],
    ...over,
  };
}

/** A language with enough distinct syllables to compose against. */
function language(activities: Activity[]): LanguageActivitySet {
  return { code: "fr-FR", slug: "fr", label: "French", activities };
}

const OTHERS = [
  activity(2, { target: "bonjour", soundTargets: ["bon", "jour"] }),
  activity(3, { target: "merci beaucoup", soundTargets: ["mer", "ci", "beau"] }),
  activity(4, { target: "s'il vous plaît", soundTargets: ["plaît", "sil"] }),
];

describe("there is exactly one right answer", () => {
  /**
   * The failure this file exists for. A syllable drawn from another activity
   * that also occurs in *this* phrase is a second correct option, and the
   * learner who picks it is told they were wrong.
   */
  it("never offers a wrong option that the phrase actually contains", () => {
    const subject = activity(1, { target: "je voudrais un café", soundTargets: ["vou"] });
    const options = locateOptions(subject, language([subject, ...OTHERS]));

    expect(options).not.toBeNull();
    for (const option of options ?? []) {
      if (option.correct) continue;
      expect(
        phraseContains(subject.target, option.grapheme),
        `"${option.grapheme}" is in "${subject.target}" but offered as wrong`,
      ).toBe(false);
    }
  });

  /**
   * Swept over every activity in a realistic set rather than checked once. A
   * collision depends on which phrases sit beside each other, so one example
   * proves nothing about the set a learner actually meets.
   */
  it("holds across every activity in the set", () => {
    const all = [
      activity(1, { target: "je voudrais un café", soundTargets: ["vou", "café"] }),
      activity(2, { target: "bonjour", soundTargets: ["bon", "jour"] }),
      activity(3, { target: "un café, s'il vous plaît", soundTargets: ["plaît"] }),
      activity(4, { target: "merci beaucoup", soundTargets: ["mer", "beau"] }),
      activity(5, { target: "où se trouve la pharmacie", soundTargets: ["trouve", "phar"] }),
    ];
    const set = language(all);

    for (const subject of all) {
      const options = locateOptions(subject, set);
      if (options === null) continue;
      for (const option of options) {
        if (option.correct) continue;
        expect(
          phraseContains(subject.target, option.grapheme),
          `activity ${subject.id}: "${option.grapheme}" occurs in "${subject.target}"`,
        ).toBe(false);
      }
    }
  });

  it("offers exactly one correct option", () => {
    const subject = activity(1, { soundTargets: ["vou", "drais"] });
    const options = locateOptions(subject, language([subject, ...OTHERS])) ?? [];

    expect(options.filter((o) => o.correct)).toHaveLength(1);
  });

  /**
   * Case-folded both ways, because the skills store folds too. "Jour" in a
   * sentence and "jour" in a target list are the same sound, and a check that
   * missed that would let one through as a distractor.
   */
  it("matches a syllable whatever case the phrase wrote it in", () => {
    expect(phraseContains("Bonjour tout le monde", "jour")).toBe(true);
    expect(phraseContains("bonjour", "JOUR")).toBe(true);

    const subject = activity(1, { target: "Bonjour", soundTargets: ["bon"] });
    const options = locateOptions(subject, language([subject, ...OTHERS])) ?? [];
    expect(options.some((o) => !o.correct && o.grapheme === "jour")).toBe(false);
  });
});

describe("the shape of the question", () => {
  it("offers four options", () => {
    const subject = activity(1);
    expect(locateOptions(subject, language([subject, ...OTHERS]))).toHaveLength(LOCATE_OPTIONS);
  });

  it("never repeats an option", () => {
    const subject = activity(1);
    const options = locateOptions(subject, language([subject, ...OTHERS])) ?? [];
    expect(new Set(options.map((o) => o.grapheme)).size).toBe(options.length);
  });

  /**
   * Three options where four were intended is a different exercise with
   * different odds, and one option is not a question. A language too small to
   * compose against gets no `locate` activities rather than easy ones.
   */
  it("refuses rather than offering a short question", () => {
    const subject = activity(1, { soundTargets: ["vou"] });
    const thin = language([subject, activity(2, { target: "bonjour", soundTargets: ["bon"] })]);

    expect(locateOptions(subject, thin)).toBeNull();
  });

  /**
   * An activity whose authored targets do not occur in its own phrase has no
   * answer to offer. The publish gate refuses that, but this reads served
   * content at runtime — so it says no rather than picking a syllable at
   * random and calling it correct.
   */
  it("refuses when no authored target occurs in the phrase", () => {
    const subject = activity(1, { target: "bonjour", soundTargets: ["xyz"] });

    expect(locateOptions(subject, language([subject, ...OTHERS]))).toBeNull();
  });

  it("refuses when the activity names no sounds at all", () => {
    const subject = activity(1, { soundTargets: [] });

    expect(locateOptions(subject, language([subject, ...OTHERS]))).toBeNull();
  });
});

describe("the same question twice", () => {
  /**
   * Deterministic, and that is a usability property rather than a testing
   * convenience: options reshuffled per render would move the answer under a
   * learner's thumb between the audio ending and the tap.
   */
  it("composes identically for the same activity", () => {
    /**
     * A wide candidate list on purpose.
     *
     * The spread between distractors is `floor(candidates / 3)`, so with four
     * candidates it is 1 and *every* offset resolves to zero — which made an
     * implementation that picked its offset at random indistinguishable from
     * the deterministic one. Twelve candidates give a spread of four, where a
     * different offset really is a different question.
     */
    const wide = [
      activity(2, { target: "bonjour", soundTargets: ["bon", "jour"] }),
      activity(4, { target: "merci beaucoup", soundTargets: ["mer", "ci", "beau"] }),
      activity(5, { target: "s'il vous plaît", soundTargets: ["plaît", "sil"] }),
      activity(6, { target: "à demain", soundTargets: ["de", "main"] }),
      activity(7, { target: "quelle heure est-il", soundTargets: ["quel", "heure"] }),
      activity(8, { target: "la pharmacie", soundTargets: ["phar", "cie"] }),
    ];
    const subject = activity(3, { target: "je voudrais", soundTargets: ["vou"] });
    const set = language([subject, ...wide]);

    // Ten calls, not two. A random offset agrees with itself often enough that
    // comparing one pair passes against an implementation that reshuffles.
    const first = locateOptions(subject, set);
    expect(first).not.toBeNull();
    for (let i = 0; i < 10; i += 1) {
      expect(locateOptions(subject, set)).toEqual(first);
    }
  });

  /**
   * And the answer is not always in the same place, or a learner learns the
   * position rather than the sound.
   */
  it("does not put the answer in the same slot every time", () => {
    const all = [1, 2, 3, 4, 5, 6].map((id) =>
      activity(id, { target: `phrase ${id} avec vou`, soundTargets: ["vou"] }),
    );
    const set = language([...all, ...OTHERS]);

    const positions = new Set(
      all
        .map((subject) => locateOptions(subject, set)?.findIndex((o) => o.correct))
        .filter((at) => at !== undefined && at >= 0),
    );

    expect(positions.size).toBeGreaterThan(1);
  });
});
