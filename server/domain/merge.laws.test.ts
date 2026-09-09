/**
 * The three laws domain/merge.ts claims, checked rather than asserted in prose.
 *
 * That file's opening comment is a proof sketch: every rule is "chosen so that
 * merging **commutes**", which is what lets mergeStore.ts re-read and merge
 * again after losing a version race, and what lets sync resolve a conflict
 * without ever asking a learner about their own practice. Nothing measured
 * that. The existing tests check each rule's *outcome* — passed is an OR, days
 * are a union — one hand-written pair at a time, which is a different and much
 * weaker statement than the algebra the design rests on.
 *
 * So this file checks the algebra directly, over generated inputs:
 *
 *   commutative   f(a, b) = f(b, a)
 *   associative   f(f(a, b), c) = f(a, f(b, c))
 *   idempotent    f(m, x) = m  where  m = f(a, x)
 *
 * The third is the one the store leans on hardest. `mergeAndSave` retries by
 * merging the same push into freshly-read state, and a client that times out
 * pushes the same state again — so re-applying a push that has already landed
 * has to be a no-op, or a retry silently doubles something.
 *
 * The generators are seeded, so a failure names an input that can be replayed
 * rather than a run that cannot. They deliberately draw from small pools —
 * a handful of activity ids, a handful of timestamps — because the interesting
 * cases are collisions, and random values from a wide range never collide.
 *
 * Two findings came out of this file and are pinned below by name: a timestamp
 * collision in `mergeSkill` used to resolve by argument order, and `longest`
 * still loses a run that spans the 60-day trim.
 */

import { describe, expect, it } from "vitest";
import {
  longestRun,
  mergeEntry,
  mergeProgress,
  mergeSkill,
  mergeSkills,
  mergeStreaks,
  type ProgressEntry,
  type ProgressState,
  type Skill,
  type SkillState,
  type StreakState,
} from "./merge.js";

/* ── generation ─────────────────────────────────────────────────────────── */

/** mulberry32 — small, seedable, and good enough to shuffle with. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, from: readonly T[]): T {
  const value = from[Math.floor(random() * from.length)];
  if (value === undefined) throw new Error("empty pool");
  return value;
}

/** Small pools on purpose: collisions are the cases worth generating. */
const ACTIVITY_IDS = [1, 2, 3, 4] as const;
const GRAPHEMES = ["bon", "ment", "eux"] as const;
const TIMES = [
  "2026-09-01T10:00:00.000Z",
  "2026-09-02T10:00:00.000Z",
  "2026-09-03T10:00:00.000Z",
] as const;
const DAYS = ["2026-09-01", "2026-09-02", "2026-09-04", "2026-09-05", "2026-09-06"] as const;

function anEntry(random: () => number): ProgressEntry {
  return {
    activityId: pick(random, ACTIVITY_IDS),
    passed: random() < 0.5,
    bestAccuracy: random() < 0.25 ? null : Math.floor(random() * 101),
    attemptsUsed: Math.floor(random() * 4),
    skipped: random() < 0.3,
    at: pick(random, TIMES),
  };
}

function aProgress(random: () => number): ProgressState {
  return {
    slug: "fr",
    entries: Array.from({ length: Math.floor(random() * 4) }, () => anEntry(random)),
  };
}

function aSkill(random: () => number): Skill {
  return {
    grapheme: pick(random, GRAPHEMES),
    samples: Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
      at: pick(random, TIMES),
      accuracy: Math.floor(random() * 101),
    })),
  };
}

function aSkillState(random: () => number): SkillState {
  return { slug: "fr", skills: Array.from({ length: Math.floor(random() * 3) }, () => aSkill(random)) };
}

/**
 * Days drawn from a five-day pool, so a union of any number of these states
 * stays well inside MAX_DAYS. The behaviour *above* that boundary is a
 * separate, named case at the end of this file — it does not hold, and mixing
 * it into the generated laws would turn a real finding into an intermittent
 * failure nobody could reproduce.
 */
function aStreak(random: () => number): StreakState {
  return {
    days: [...new Set(Array.from({ length: Math.floor(random() * 4) }, () => pick(random, DAYS)))].sort(),
    longest: Math.floor(random() * 3),
  };
}

/** Every ordering of `items`, so "some ordering" is never left to chance. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i] as T, ...tail]);
  }
  return out;
}

/** How the store applies pushes: a left fold onto accumulating stored state. */
function fold<S>(merge: (a: S, b: S) => S, empty: S, pushes: S[]): S {
  return pushes.reduce((stored, push) => merge(stored, push), empty);
}

/** Seeds, listed rather than derived, so a failure is replayable by hand. */
const SEEDS = [1, 2, 3, 7, 11, 19, 23, 42, 97, 1234, 31337, 65535];

/* ── the laws, one domain at a time ─────────────────────────────────────── */

describe("mergeEntry obeys the laws one activity's outcome is built on", () => {
  it.each(SEEDS)("commutes, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 40; i += 1) {
      // Same activity on both sides: that is the only case mergeEntry is ever
      // called with, because mergeProgress keys on the id before calling it.
      const id = pick(random, ACTIVITY_IDS);
      const mine = { ...anEntry(random), activityId: id };
      const theirs = { ...anEntry(random), activityId: id };

      expect(mergeEntry(mine, theirs)).toEqual(mergeEntry(theirs, mine));
    }
  });

  it.each(SEEDS)("associates, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 40; i += 1) {
      const id = pick(random, ACTIVITY_IDS);
      const [a, b, c] = [1, 2, 3].map(() => ({ ...anEntry(random), activityId: id })) as [
        ProgressEntry,
        ProgressEntry,
        ProgressEntry,
      ];

      expect(mergeEntry(mergeEntry(a, b), c)).toEqual(mergeEntry(a, mergeEntry(b, c)));
    }
  });

  it.each(SEEDS)("re-applying the same outcome changes nothing, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 40; i += 1) {
      const id = pick(random, ACTIVITY_IDS);
      const stored = { ...anEntry(random), activityId: id };
      const push = { ...anEntry(random), activityId: id };
      const once = mergeEntry(stored, push);

      expect(mergeEntry(once, push)).toEqual(once);
    }
  });
});

describe("mergeProgress obeys them for a whole language", () => {
  it.each(SEEDS)("commutes, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 30; i += 1) {
      const [a, b] = [aProgress(random), aProgress(random)];

      expect(mergeProgress(a, b)).toEqual(mergeProgress(b, a));
    }
  });

  it.each(SEEDS)("associates, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 30; i += 1) {
      const [a, b, c] = [aProgress(random), aProgress(random), aProgress(random)];

      expect(mergeProgress(mergeProgress(a, b), c)).toEqual(mergeProgress(a, mergeProgress(b, c)));
    }
  });

  it.each(SEEDS)("re-applying a push that already landed is a no-op, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 30; i += 1) {
      const stored = aProgress(random);
      const push = aProgress(random);
      const once = mergeProgress(stored, push);

      // Exactly what mergeAndSave does on a retry, and what a client does
      // after a timed-out push: merge the same state in again.
      expect(mergeProgress(once, push)).toEqual(once);
    }
  });

  it("folds a repeated activity id on either side, not just the incoming one", () => {
    /**
     * The finding the generated cases above turned up on the first seed, and
     * the one that actually loses a learner's work.
     *
     * Both merges loaded `mine` with a plain assignment and only combined on
     * the `theirs` pass, so a repeated key was folded on one side and
     * last-write-wins on the other. Two entries for one activity therefore
     * produced `attemptsUsed: 2, bestAccuracy: 94` merging one way round and
     * `0, 53` the other — a real attempt count and a real best score
     * disappearing on nothing but which device's push arrived first.
     *
     * Nothing excludes the input: `readProgressState` maps, filters and
     * slices, and never deduplicates `entries` by `activityId`.
     */
    const duplicated: ProgressState = {
      slug: "fr",
      entries: [
        { activityId: 1, passed: false, bestAccuracy: 53, attemptsUsed: 0, skipped: false, at: TIMES[0] },
        { activityId: 1, passed: true, bestAccuracy: 94, attemptsUsed: 2, skipped: false, at: TIMES[1] },
      ],
    };
    const other: ProgressState = { slug: "fr", entries: [] };

    expect(mergeProgress(duplicated, other)).toEqual(mergeProgress(other, duplicated));
    // And the fold keeps the best of both rather than whichever came last.
    expect(mergeProgress(duplicated, other).entries).toEqual([
      { activityId: 1, passed: true, bestAccuracy: 94, attemptsUsed: 2, skipped: false, at: TIMES[1] },
    ]);
  });

  it.each(SEEDS)("reaches the same state whatever order the devices pushed in, seed %i", (seed) => {
    const random = rng(seed);
    const empty: ProgressState = { slug: "fr", entries: [] };
    const pushes = [aProgress(random), aProgress(random), aProgress(random), aProgress(random)];

    const results = permutations(pushes).map((order) => JSON.stringify(fold(mergeProgress, empty, order)));

    // 24 orderings, one answer. This is the property the whole sync design
    // rests on: there is no conflict to resolve because there is no ordering
    // that produces a different record.
    expect(new Set(results).size).toBe(1);
  });
});

describe("mergeSkill obeys them for one syllable's history", () => {
  it.each(SEEDS)("commutes, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 40; i += 1) {
      const grapheme = pick(random, GRAPHEMES);
      const mine = { ...aSkill(random), grapheme };
      const theirs = { ...aSkill(random), grapheme };

      expect(mergeSkill(mine, theirs)).toEqual(mergeSkill(theirs, mine));
    }
  });

  it.each(SEEDS)("associates, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 40; i += 1) {
      const grapheme = pick(random, GRAPHEMES);
      const [a, b, c] = [1, 2, 3].map(() => ({ ...aSkill(random), grapheme })) as [Skill, Skill, Skill];

      expect(mergeSkill(mergeSkill(a, b), c)).toEqual(mergeSkill(a, mergeSkill(b, c)));
    }
  });

  it("resolves a timestamp collision by the values, not by which side it is", () => {
    /**
     * The finding this file was written to catch.
     *
     * `mergeSkill` deduplicates on `at`, and its comment used to claim that
     * keeping the first writer's value "is what keeps the merge commutative".
     * It does not: for the pair below it kept 10 one way round and 90 the
     * other, so the accuracy stored for a sound depended on which device's
     * push happened to reach the server first — with no lost race, no error,
     * and nothing in the data to say a choice had been made at all.
     */
    const mine: Skill = { grapheme: "bon", samples: [{ at: TIMES[0], accuracy: 10 }] };
    const theirs: Skill = { grapheme: "bon", samples: [{ at: TIMES[0], accuracy: 90 }] };

    expect(mergeSkill(mine, theirs)).toEqual(mergeSkill(theirs, mine));
    // A maximum, matching bestAccuracy: two reports of one take, and the
    // choice is a fact about the pair rather than about the arrival order.
    expect(mergeSkill(mine, theirs).samples).toEqual([{ at: TIMES[0], accuracy: 90 }]);
  });

  it("still counts one take once when both devices report it identically", () => {
    // The reason the dedup exists, and it must survive the fix above.
    const sample = { at: TIMES[0], accuracy: 61 };

    expect(mergeSkill({ grapheme: "bon", samples: [sample] }, { grapheme: "bon", samples: [sample] }).samples)
      .toEqual([sample]);
  });
});

describe("mergeSkills obeys them for a whole language", () => {
  it.each(SEEDS)("commutes, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 30; i += 1) {
      const [a, b] = [aSkillState(random), aSkillState(random)];

      expect(mergeSkills(a, b)).toEqual(mergeSkills(b, a));
    }
  });

  it.each(SEEDS)("associates, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 30; i += 1) {
      const [a, b, c] = [aSkillState(random), aSkillState(random), aSkillState(random)];

      expect(mergeSkills(mergeSkills(a, b), c)).toEqual(mergeSkills(a, mergeSkills(b, c)));
    }
  });

  it.each(SEEDS)("re-applying a push that already landed is a no-op, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 30; i += 1) {
      const once = mergeSkills(aSkillState(random), aSkillState(random));
      const push = aSkillState(random);
      const twice = mergeSkills(once, push);

      expect(mergeSkills(twice, push)).toEqual(twice);
    }
  });

  it("normalises a grapheme that appears on only one side", () => {
    /**
     * The subtler half of the same finding. A grapheme present on just one
     * side never reached `mergeSkill` at all, so its samples were copied into
     * the stored document exactly as they arrived — two samples for one
     * timestamp included. `readSkill` permits that: it maps, filters and
     * trims `samples`, and never deduplicates them by `at`.
     *
     * The consequence was a merge that was not idempotent. Storing the state
     * kept both samples; re-applying the very same push collapsed them, so a
     * retry — which `mergeAndSave` performs by design after a version race —
     * changed the record it was supposed to leave alone, and the sound's mean
     * moved because a take had been counted twice until something happened to
     * touch it.
     */
    const collided: SkillState = {
      slug: "fr",
      skills: [{ grapheme: "ment", samples: [{ at: TIMES[0], accuracy: 64 }, { at: TIMES[0], accuracy: 92 }] }],
    };
    const once = mergeSkills({ slug: "fr", skills: [] }, collided);

    expect(once.skills[0]?.samples).toEqual([{ at: TIMES[0], accuracy: 92 }]);
    // A fixpoint: pushing the same thing again leaves the record alone.
    expect(mergeSkills(once, collided)).toEqual(once);
  });

  it.each(SEEDS)("reaches the same history whatever order the devices pushed in, seed %i", (seed) => {
    const random = rng(seed);
    const empty: SkillState = { slug: "fr", skills: [] };
    const pushes = [aSkillState(random), aSkillState(random), aSkillState(random), aSkillState(random)];

    const results = permutations(pushes).map((order) => JSON.stringify(fold(mergeSkills, empty, order)));

    expect(new Set(results).size).toBe(1);
  });
});

describe("mergeStreaks obeys them for a learner's practice days", () => {
  it.each(SEEDS)("commutes, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 30; i += 1) {
      const [a, b] = [aStreak(random), aStreak(random)];

      expect(mergeStreaks(a, b)).toEqual(mergeStreaks(b, a));
    }
  });

  it.each(SEEDS)("associates below the day cap, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 30; i += 1) {
      const [a, b, c] = [aStreak(random), aStreak(random), aStreak(random)];

      expect(mergeStreaks(mergeStreaks(a, b), c)).toEqual(mergeStreaks(a, mergeStreaks(b, c)));
    }
  });

  it.each(SEEDS)("re-applying a push that already landed is a no-op, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 30; i += 1) {
      const once = mergeStreaks(aStreak(random), aStreak(random));
      const push = aStreak(random);
      const twice = mergeStreaks(once, push);

      expect(mergeStreaks(twice, push)).toEqual(twice);
    }
  });

  it.each(SEEDS)("reaches the same record whatever order the devices pushed in, seed %i", (seed) => {
    const random = rng(seed);
    const empty: StreakState = { days: [], longest: 0 };
    const pushes = [aStreak(random), aStreak(random), aStreak(random), aStreak(random)];

    const results = permutations(pushes).map((order) => JSON.stringify(fold(mergeStreaks, empty, order)));

    // The union is the rule that must not be got wrong: a day a learner
    // actually practised may not depend on which device synced first.
    expect(new Set(results).size).toBe(1);
  });

  it.each(SEEDS)("never lets a merge shorten the record, for seed %i", (seed) => {
    const random = rng(seed);
    for (let i = 0; i < 30; i += 1) {
      const [a, b] = [aStreak(random), aStreak(random)];
      const merged = mergeStreaks(a, b);

      // Monotone in `longest`, whatever the day cap does: a lapse, a trim and
      // a device with a shorter memory must all be unable to erase a record.
      expect(merged.longest).toBeGreaterThanOrEqual(Math.max(a.longest, b.longest));
      expect(merged.longest).toBeGreaterThanOrEqual(longestRun(merged.days));
    }
  });
});

/* ── where the algebra genuinely stops holding ──────────────────────────── */

describe("mergeStreaks: `longest` is not associative across the 60-day trim", () => {
  /** `count` consecutive days starting `from` days after 2026-01-01. */
  function run(from: number, count: number): string[] {
    return Array.from({ length: count }, (_, i) =>
      new Date(Date.UTC(2026, 0, from + i)).toISOString().slice(0, 10),
    );
  }

  it("under-reports a run that spans the boundary, depending on merge order", () => {
    /**
     * A real defect, left failing-as-documented rather than papered over.
     *
     * `mergeStreaks` caps `days` at 60 and computes `longest` over the
     * *untrimmed* union — "trimming must not shorten a record", as the comment
     * says. That holds for one merge. It does not hold across two, because the
     * second merge's union is already missing whatever the first one trimmed,
     * so a day arriving later can no longer be seen to join a run whose middle
     * has been dropped.
     *
     * Below: A is a single day, B is the 61 consecutive days that follow it,
     * and C is an unrelated later day. A ∪ B ∪ C contains one run of 62 — the
     * learner really did practise 62 days straight — and:
     *
     *   (A ∪ B) ∪ C  →  longest 62, the truth
     *   (B ∪ C) ∪ A  →  longest 61, one day short
     *
     * Both orderings agree on `days`; only the record differs. It needs more
     * than 60 days of history and a device holding an older day than the
     * others, which is ordinary use rather than an attack, and it is silent —
     * the learner just finds their best run recorded as shorter than it was.
     *
     * Not fixable inside this function: recovering the bridge needs
     * information the trim has already thrown away, so the fix is a schema
     * change (an uncapped day list, or a stored run that survives the trim)
     * and a decision about what `days` costs. Pinned here so the limitation is
     * a known, named, measured one rather than a surprise.
     */
    const a: StreakState = { days: run(1, 1), longest: 0 };
    const b: StreakState = { days: run(2, 61), longest: 0 };
    const c: StreakState = { days: run(64, 1), longest: 0 };

    const abThenC = mergeStreaks(mergeStreaks(a, b), c);
    const bcThenA = mergeStreaks(mergeStreaks(b, c), a);

    // The days are order-independent, as designed. Only the record is not.
    expect(bcThenA.days).toEqual(abThenC.days);

    expect(abThenC.longest).toBe(62);
    expect(bcThenA.longest).toBe(61);
  });

  it("is exact whenever the whole history still fits under the cap", () => {
    // The boundary of the defect above, so a future fix has something to
    // widen rather than a bare number to guess at.
    const a: StreakState = { days: run(1, 1), longest: 0 };
    const b: StreakState = { days: run(2, 59), longest: 0 };
    const c: StreakState = { days: run(64, 1), longest: 0 };

    expect(mergeStreaks(mergeStreaks(a, b), c).longest).toBe(60);
    expect(mergeStreaks(mergeStreaks(b, c), a).longest).toBe(60);
  });
});

/* ── the bounds the stored document depends on ──────────────────────────── */

describe("a merged document stays bounded however many times it is pushed to", () => {
  it("caps progress entries, not just one push's worth", () => {
    /**
     * The second finding. `readProgressState` trims a push to 200 entries and
     * its comment says "bounded so one push cannot store an unbounded
     * document" — but the union is what gets stored, and `mergeProgress` did
     * not trim at all. Five pushes of 200 fresh activity ids produced a
     * 1000-entry document, and nothing stopped that at any size: the ceiling
     * was Mongo's 16MB document limit, at which point the learner's progress
     * would simply stop saving.
     *
     * `mergeSkills` below was already bounded this way. Progress was the
     * outlier.
     */
    let state: ProgressState = { slug: "fr", entries: [] };
    for (let round = 0; round < 5; round += 1) {
      state = mergeProgress(state, {
        slug: "fr",
        entries: Array.from({ length: 200 }, (_, i) => ({
          activityId: round * 200 + i,
          passed: false,
          bestAccuracy: 1,
          attemptsUsed: 0,
          skipped: false,
          at: TIMES[0],
        })),
      });
    }

    expect(state.entries).toHaveLength(200);
    // The lowest ids survive — the activities a learner is actually working
    // through, rather than whichever batch arrived last.
    expect(state.entries[0]?.activityId).toBe(0);
    expect(state.entries[199]?.activityId).toBe(199);
  });

  it("caps skill graphemes", () => {
    let state: SkillState = { slug: "fr", skills: [] };
    for (let round = 0; round < 5; round += 1) {
      state = mergeSkills(state, {
        slug: "fr",
        skills: Array.from({ length: 200 }, (_, i) => ({
          grapheme: `g${String(round * 200 + i).padStart(4, "0")}`,
          samples: [{ at: TIMES[0], accuracy: 50 }],
        })),
      });
    }

    expect(state.skills).toHaveLength(400);
  });

  it("caps samples per grapheme", () => {
    let skill: Skill = { grapheme: "bon", samples: [] };
    for (let round = 0; round < 4; round += 1) {
      skill = mergeSkill(skill, {
        grapheme: "bon",
        samples: Array.from({ length: 15 }, (_, i) => ({
          at: `2026-09-${String(round * 15 + i + 1).padStart(2, "0")}T10:00:00.000Z`,
          accuracy: 50,
        })),
      });
    }

    expect(skill.samples).toHaveLength(20);
    // Trimmed from the front, so what survives is the most recent evidence.
    expect(skill.samples[19]?.at).toBe("2026-09-60T10:00:00.000Z");
  });
});

/* ── the slug, which is the document's own identity ─────────────────────── */

describe("the language a merged state belongs to", () => {
  it("survives a stored document written before the field existed", () => {
    /**
     * The third finding, and the one that reached the database. Both stores'
     * `fromDocument` yields `slug: ""` for a document written before the
     * field existed — on purpose, so an old shape does not throw — and
     * `mergeProgress` took `mine.slug` unconditionally, so merging a real
     * push into that stored state produced `slug: ""`. `toFields` then wrote
     * the blank straight back into a document whose `_id` still said
     * `{learner}:fr`, permanently, and a pull handed the client a language
     * with no name.
     */
    const stored: ProgressState = { slug: "", entries: [] };
    const push: ProgressState = {
      slug: "fr",
      entries: [{ activityId: 1, passed: true, bestAccuracy: 88, attemptsUsed: 1, skipped: false, at: TIMES[0] }],
    };

    expect(mergeProgress(stored, push).slug).toBe("fr");
    expect(mergeProgress(push, stored).slug).toBe("fr");
    expect(mergeSkills({ slug: "", skills: [] }, { slug: "fr", skills: [] }).slug).toBe("fr");
    expect(mergeSkills({ slug: "fr", skills: [] }, { slug: "", skills: [] }).slug).toBe("fr");
  });
});
