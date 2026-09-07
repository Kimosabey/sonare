/**
 * A learner's sound history, merged across devices.
 *
 * This is the data behind the one claim no competitor makes — "‑ent is at 61,
 * up from 48 last week" — so losing half of it is not a cosmetic bug. Under
 * last-write-wins the device that synced second would *replace* the other's
 * history rather than add to it, and every screen would still show a
 * plausible-looking trend computed from a fraction of the takes. There is
 * nothing to notice.
 */

import { describe, expect, it } from "vitest";
import {
  mergeSkill,
  mergeSkills,
  readSkill,
  readSkillState,
  type Skill,
  type SkillState,
} from "./merge.js";

function sample(at: string, accuracy: number) {
  return { at, accuracy };
}

function skill(grapheme: string, samples: Array<{ at: string; accuracy: number }>): Skill {
  return { grapheme, samples };
}

function state(skills: Skill[], slug = "fr"): SkillState {
  return { slug, skills };
}

describe("history is added to, never replaced", () => {
  it("unions two devices' samples", () => {
    const phone = skill("ment", [sample("2026-09-01T10:00:00.000Z", 48)]);
    const laptop = skill("ment", [sample("2026-09-05T10:00:00.000Z", 61)]);

    const merged = mergeSkill(phone, laptop);

    expect(merged.samples).toHaveLength(2);
    expect(merged.samples.map((s) => s.accuracy)).toEqual([48, 61]);
  });

  it("does not drop the other device's evidence", () => {
    // The bug worth the test. Nothing looks broken when this is wrong.
    const phone = skill("ment", [
      sample("2026-09-01T10:00:00.000Z", 40),
      sample("2026-09-02T10:00:00.000Z", 42),
    ]);
    const laptop = skill("ment", [
      sample("2026-09-03T10:00:00.000Z", 70),
      sample("2026-09-04T10:00:00.000Z", 72),
    ]);

    expect(mergeSkill(phone, laptop).samples).toHaveLength(4);
    expect(mergeSkill(laptop, phone).samples).toHaveLength(4);
  });

  it("counts the same take pushed twice only once", () => {
    // A retry after a timeout must not double a sample and quietly weight it.
    const once = skill("ment", [sample("2026-09-01T10:00:00.000Z", 48)]);

    expect(mergeSkill(once, once).samples).toHaveLength(1);
  });

  it("orders samples oldest first, so a trend can be read", () => {
    const a = skill("ment", [sample("2026-09-05T10:00:00.000Z", 61)]);
    const b = skill("ment", [sample("2026-09-01T10:00:00.000Z", 48)]);

    expect(mergeSkill(a, b).samples.map((s) => s.at)).toEqual([
      "2026-09-01T10:00:00.000Z",
      "2026-09-05T10:00:00.000Z",
    ]);
  });

  it("commutes", () => {
    const a = skill("ment", [sample("2026-09-01T10:00:00.000Z", 40), sample("2026-09-03T10:00:00.000Z", 50)]);
    const b = skill("ment", [sample("2026-09-02T10:00:00.000Z", 45), sample("2026-09-03T10:00:00.000Z", 50)]);

    expect(mergeSkill(a, b)).toEqual(mergeSkill(b, a));
  });
});

describe("the cap discards the least useful samples", () => {
  it("keeps the twenty most recent", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      sample(`2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`, i),
    );

    const merged = mergeSkill(skill("ment", many), skill("ment", []));

    expect(merged.samples).toHaveLength(20);
    // Trimmed from the front, so the oldest go — not whichever arrived last.
    expect(merged.samples[0]?.accuracy).toBe(10);
    expect(merged.samples[19]?.accuracy).toBe(29);
  });

  it("keeps recent samples from both devices over old ones from either", () => {
    const old = Array.from({ length: 15 }, (_, i) =>
      sample(`2026-08-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`, 30),
    );
    const recent = Array.from({ length: 15 }, (_, i) =>
      sample(`2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`, 80),
    );

    const merged = mergeSkill(skill("ment", old), skill("ment", recent));

    expect(merged.samples).toHaveLength(20);
    expect(merged.samples.filter((s) => s.accuracy === 80)).toHaveLength(15);
  });
});

describe("merging a whole language", () => {
  it("keeps syllables only one device has seen", () => {
    const merged = mergeSkills(
      state([skill("ment", [sample("2026-09-01T10:00:00.000Z", 40)])]),
      state([skill("jour", [sample("2026-09-01T10:00:00.000Z", 70)])]),
    );

    expect(merged.skills.map((s) => s.grapheme)).toEqual(["jour", "ment"]);
  });

  it("commutes across syllables too", () => {
    const a = state([
      skill("ment", [sample("2026-09-01T10:00:00.000Z", 40)]),
      skill("jour", [sample("2026-09-02T10:00:00.000Z", 70)]),
    ]);
    const b = state([
      skill("ment", [sample("2026-09-03T10:00:00.000Z", 55)]),
      skill("vous", [sample("2026-09-04T10:00:00.000Z", 88)]),
    ]);

    expect(mergeSkills(a, b)).toEqual(mergeSkills(b, a));
  });

  it("is idempotent", () => {
    const a = state([skill("ment", [sample("2026-09-01T10:00:00.000Z", 40)])]);

    expect(mergeSkills(mergeSkills(a, a), a)).toEqual(mergeSkills(a, a));
  });

  it("sorts syllables, so identical facts give an identical document", () => {
    const merged = mergeSkills(
      state([skill("vous", [sample("2026-09-01T10:00:00.000Z", 1)]), skill("ment", [sample("2026-09-01T10:00:00.000Z", 1)])]),
      state([skill("jour", [sample("2026-09-01T10:00:00.000Z", 1)])]),
    );

    expect(merged.skills.map((s) => s.grapheme)).toEqual(["jour", "ment", "vous"]);
  });
});

describe("reading what a client sent", () => {
  it("case-folds, so one sound has one history", () => {
    /**
     * A sentence-initial "Bon" and a mid-phrase "bon" are the same sound.
     * Kept apart, each would carry half the samples and both trends would be
     * noise.
     */
    expect(readSkill({ grapheme: "Bon", samples: [sample("2026-09-01T10:00:00.000Z", 50)] })?.grapheme).toBe("bon");
  });

  it("combines two entries that fold to the same syllable", () => {
    const read = readSkillState({
      slug: "fr",
      skills: [
        { grapheme: "Bon", samples: [sample("2026-09-01T10:00:00.000Z", 40)] },
        { grapheme: "bon", samples: [sample("2026-09-02T10:00:00.000Z", 60)] },
      ],
    });

    expect(read?.skills).toHaveLength(1);
    expect(read?.skills[0]?.samples).toHaveLength(2);
  });

  it("drops an unnamed syllable rather than pooling it", () => {
    /**
     * Azure returns an empty grapheme where it could not map one — always for
     * Hindi, and around elision and hyphenation in French. Pooled, every one
     * of those lands in a single "" bucket which then gets presented to the
     * learner as their weakest sound.
     */
    expect(readSkill({ grapheme: "", samples: [sample("2026-09-01T10:00:00.000Z", 50)] })).toBeNull();
    expect(readSkill({ grapheme: "   ", samples: [sample("2026-09-01T10:00:00.000Z", 50)] })).toBeNull();
  });

  it("accepts syllables with accents and matras", () => {
    // Devanagari matras are combining marks, and stripping them as punctuation
    // is a mistake this project has already made once.
    expect(readSkill({ grapheme: "élè", samples: [sample("2026-09-01T10:00:00.000Z", 50)] })?.grapheme).toBe("élè");
    expect(readSkill({ grapheme: "कि", samples: [sample("2026-09-01T10:00:00.000Z", 50)] })?.grapheme).toBe("कि");
    expect(readSkill({ grapheme: "l'ai", samples: [sample("2026-09-01T10:00:00.000Z", 50)] })?.grapheme).toBe("l'ai");
  });

  it("rejects structural junk in a grapheme", () => {
    /**
     * Markup, digits, spaces, paths, and anything over-long. Not phonetic
     * symbols: `ə` is a Unicode letter, and excluding IPA by codepoint block
     * would be fragile and would risk excluding real letters from languages
     * this may yet support. It also is not the guard's job — graphemes come
     * from the reference text's own orthography, so a phonetic symbol never
     * arrives as one.
     */
    for (const bad of ["<script>", "1234", "a b", "../etc", "x".repeat(50), "a.b", "a/b"]) {
      expect(readSkill({ grapheme: bad, samples: [sample("2026-09-01T10:00:00.000Z", 50)] })).toBeNull();
    }
  });

  it("clamps an impossible accuracy", () => {
    // Averaged into a figure shown as how well the learner says a sound.
    expect(readSkill({ grapheme: "ment", samples: [sample("2026-09-01T10:00:00.000Z", 5000)] })?.samples[0]?.accuracy).toBe(100);
    expect(readSkill({ grapheme: "ment", samples: [sample("2026-09-01T10:00:00.000Z", -20)] })?.samples[0]?.accuracy).toBe(0);
  });

  it("drops a syllable whose samples are all unusable", () => {
    expect(readSkill({ grapheme: "ment", samples: [{ at: 5, accuracy: "x" }] })).toBeNull();
    expect(readSkill({ grapheme: "ment", samples: [] })).toBeNull();
  });

  it("keeps good samples alongside bad ones", () => {
    const read = readSkill({
      grapheme: "ment",
      samples: [sample("2026-09-01T10:00:00.000Z", 40), null, { at: "x".repeat(90), accuracy: 1 }, sample("2026-09-02T10:00:00.000Z", 60)],
    });

    expect(read?.samples).toHaveLength(2);
  });

  it("bounds how many syllables one push can store", () => {
    const many = Array.from({ length: 900 }, (_, i) => ({
      // Distinct letter-only graphemes.
      grapheme: `s${"a".repeat((i % 20) + 1)}${String.fromCharCode(98 + (i % 24))}`,
      samples: [sample("2026-09-01T10:00:00.000Z", 50)],
    }));

    expect(readSkillState({ slug: "fr", skills: many })?.skills.length).toBeLessThanOrEqual(400);
  });

  it("rejects a state with no usable slug", () => {
    expect(readSkillState({ slug: "FR", skills: [] })).toBeNull();
    expect(readSkillState({ skills: [] })).toBeNull();
  });
});
