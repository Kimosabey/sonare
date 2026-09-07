// @vitest-environment jsdom

/**
 * What to offer a learner who opens the app, and the three ways that goes
 * wrong.
 *
 * It can offer the wrong language — anything but "carry on where you were" is
 * a tap the learner did not want. It can offer a finished set, which is
 * offering nothing. And it can offer the activity the learner *stopped* at
 * rather than the one they have not *done*, which are different the moment
 * somebody exhausts three tries and moves on.
 *
 * Seeded through real `LANGUAGES` content rather than fixtures, so the
 * position and total figures are the ones a learner would actually see.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allProgress, nextUp } from "./nextUp.js";
import { LANGUAGES } from "../activities/languages/index.js";
import type { ActivityProgress } from "../activities/types.js";

function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
  return data;
}

const LEARNER = "marie";

/** A language set by display position, so a reorder fails loudly here. */
function set(index: number) {
  const found = LANGUAGES[index];
  if (found === undefined) throw new Error(`no language at ${index}`);
  return found;
}

const FIRST = set(0);
const SECOND = set(1);

/** One stored activity, with a single attempt at `at`. */
function entry(activityId: number, passed: boolean, at: string): ActivityProgress {
  return {
    activityId,
    // `result` is not read by nextUp — only `at` is — so the cast keeps the
    // fixture to the fields under test rather than building a whole
    // PronunciationResult per attempt.
    attempts: [{ activityId, result: {} as never, accuracy: passed ? 80 : 20, at }],
    best: passed ? 80 : 20,
    passed,
    skipped: false,
  };
}

/** Writes progress under the key useProgressPersistence reads. */
function seed(slug: string, progress: ActivityProgress[], index = 0): void {
  localStorage.setItem(
    `sonare.progress.v2.${slug}.${LEARNER}`,
    JSON.stringify({ index, progress, finished: false }),
  );
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a learner who has never practised", () => {
  it("is offered nothing rather than a guess", () => {
    // The home screen has to distinguish "carry on" from "start something",
    // and inventing a language to resume would be the wrong screen entirely.
    expect(nextUp(LEARNER)).toBeNull();
  });

  it("still lists every language as available", () => {
    const all = allProgress(LEARNER);

    expect(all).toHaveLength(LANGUAGES.length);
    expect(all.every((s) => s.lastPractisedAt === null)).toBe(true);
    expect(all.every((s) => s.passed === 0)).toBe(true);
  });
});

describe("choosing the language", () => {
  it("offers the only language that has been started", () => {
    seed(FIRST.slug, [entry(1, true, "2026-09-05T10:00:00.000Z")]);

    expect(nextUp(LEARNER)?.slug).toBe(FIRST.slug);
  });

  it("prefers the most recently practised", () => {
    // Resuming is the tap the learner was going to make anyway.
    seed(FIRST.slug, [entry(1, true, "2026-09-01T10:00:00.000Z")]);
    seed(SECOND.slug, [entry(1, true, "2026-09-06T10:00:00.000Z")]);

    expect(nextUp(LEARNER)?.slug).toBe(SECOND.slug);
  });

  it("reads recency from the latest attempt, not the last stored one", () => {
    /**
     * Attempts are appended per activity, so the newest timestamp is not
     * necessarily last in the array — an activity revisited after moving on
     * puts a recent attempt behind an older entry. Taking the array's tail
     * would pick the wrong language.
     */
    seed(FIRST.slug, [
      entry(1, true, "2026-09-07T10:00:00.000Z"),
      entry(2, true, "2026-09-02T10:00:00.000Z"),
    ]);
    seed(SECOND.slug, [entry(1, true, "2026-09-04T10:00:00.000Z")]);

    expect(nextUp(LEARNER)?.slug).toBe(FIRST.slug);
  });

  it("passes over a finished language for one still in progress", () => {
    // A completed set offered as "next up" is offering nothing, even when it
    // is the thing they touched most recently.
    const done = FIRST.activities.map((a, i) =>
      entry(a.id, true, `2026-09-0${i < 8 ? 7 : 7}T10:00:00.000Z`),
    );
    seed(FIRST.slug, done);
    seed(SECOND.slug, [entry(1, false, "2026-09-01T10:00:00.000Z")]);

    const chosen = nextUp(LEARNER);

    expect(chosen?.slug).toBe(SECOND.slug);
    expect(chosen?.complete).toBe(false);
  });

  it("falls back to a finished language when every started one is done", () => {
    // Better to re-offer completed work than to show a learner who has
    // finished everything an empty screen.
    const done = FIRST.activities.map((a) => entry(a.id, true, "2026-09-07T10:00:00.000Z"));
    seed(FIRST.slug, done);

    const chosen = nextUp(LEARNER);

    expect(chosen?.slug).toBe(FIRST.slug);
    expect(chosen?.complete).toBe(true);
  });

  it("keeps each learner on a shared device separate", () => {
    seed(FIRST.slug, [entry(1, true, "2026-09-05T10:00:00.000Z")]);

    expect(nextUp(LEARNER)?.slug).toBe(FIRST.slug);
    expect(nextUp("someone-else")).toBeNull();
  });
});

describe("choosing the activity", () => {
  it("offers the first unpassed activity, not the stored index", () => {
    /**
     * The bug this exists for. A learner who exhausted three tries on the
     * second activity and advanced has a stored index of 2 and an unpassed
     * activity 2 — and sending them to the third would skip the thing they
     * have not done.
     */
    const second = set(0).activities[1];
    if (second === undefined) throw new Error("need two activities");

    seed(
      FIRST.slug,
      [
        entry(FIRST.activities[0]?.id ?? 1, true, "2026-09-07T10:00:00.000Z"),
        { ...entry(second.id, false, "2026-09-07T10:05:00.000Z"), skipped: true },
      ],
      2,
    );

    const chosen = nextUp(LEARNER);

    expect(chosen?.activity.id).toBe(second.id);
    expect(chosen?.position).toBe(2);
  });

  it("offers the first activity to a learner one attempt in", () => {
    const first = FIRST.activities[0];
    if (first === undefined) throw new Error("need one activity");
    seed(FIRST.slug, [entry(first.id, false, "2026-09-07T10:00:00.000Z")]);

    expect(nextUp(LEARNER)?.activity.id).toBe(first.id);
    expect(nextUp(LEARNER)?.position).toBe(1);
  });

  it("stays on the last activity once everything is passed", () => {
    // Rather than running off the end of the list.
    const done = FIRST.activities.map((a) => entry(a.id, true, "2026-09-07T10:00:00.000Z"));
    seed(FIRST.slug, done);

    const chosen = nextUp(LEARNER);

    expect(chosen?.position).toBe(FIRST.activities.length);
    expect(chosen?.passed).toBe(FIRST.activities.length);
  });

  it("reports position against the real activity count", () => {
    seed(FIRST.slug, [entry(FIRST.activities[0]?.id ?? 1, false, "2026-09-07T10:00:00.000Z")]);

    expect(nextUp(LEARNER)?.total).toBe(FIRST.activities.length);
  });

  it("carries the locale so target-language text can be tagged", () => {
    // WCAG 3.1.2 — the phrase is not in the page's language, and a screen
    // reader needs the tag to pronounce it.
    seed(FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]);

    expect(nextUp(LEARNER)?.code).toBe(FIRST.code);
  });
});

describe("surviving bad stored data", () => {
  it("ignores an attempt whose timestamp is not a string", () => {
    const bad: ActivityProgress = {
      activityId: 1,
      attempts: [{ activityId: 1, result: {} as never, accuracy: 50, at: 12345 as never }],
      best: 50,
      passed: false,
      skipped: false,
    };
    seed(FIRST.slug, [bad]);

    // Nothing usable, so the language reads as never practised rather than
    // sorting unpredictably against real ISO strings.
    expect(nextUp(LEARNER)).toBeNull();
  });

  it("costs one language, not the screen, when a record is corrupt", () => {
    localStorage.setItem(`sonare.progress.v2.${FIRST.slug}.${LEARNER}`, "{not json");
    seed(SECOND.slug, [entry(1, true, "2026-09-06T10:00:00.000Z")]);

    expect(nextUp(LEARNER)?.slug).toBe(SECOND.slug);
    expect(allProgress(LEARNER)).toHaveLength(LANGUAGES.length);
  });

  it("reads as a first visit when storage refuses", () => {
    // This runs where a learner first lands, so an escaping error is a blank
    // page before they have done anything at all.
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(() => nextUp(LEARNER)).not.toThrow();
    expect(nextUp(LEARNER)).toBeNull();
  });

  it("treats a progress entry for an unknown activity as absent", () => {
    // Content can be removed between releases; a stored id that no longer
    // exists must not shift the position or hide a real activity.
    seed(FIRST.slug, [entry(9999, true, "2026-09-07T10:00:00.000Z")]);

    const chosen = nextUp(LEARNER);

    expect(chosen?.activity.id).toBe(FIRST.activities[0]?.id);
    expect(chosen?.position).toBe(1);
  });

  it("does not credit a pass for an activity that no longer exists", () => {
    /**
     * A leftover entry for deleted content would otherwise be counted, and the
     * learner would read "1 of 10 passed" with nothing ticked on the screen.
     * The count is taken against the activities that exist, not the rows that
     * happen to be stored.
     */
    seed(FIRST.slug, [entry(9999, true, "2026-09-07T10:00:00.000Z")]);

    expect(nextUp(LEARNER)?.passed).toBe(0);
  });
});

describe("the whole picture, for a home list", () => {
  it("sorts most recently practised first", () => {
    seed(FIRST.slug, [entry(1, true, "2026-09-02T10:00:00.000Z")]);
    seed(SECOND.slug, [entry(1, true, "2026-09-06T10:00:00.000Z")]);

    const all = allProgress(LEARNER);

    expect(all[0]?.slug).toBe(SECOND.slug);
    expect(all[1]?.slug).toBe(FIRST.slug);
  });

  it("counts passed activities per language", () => {
    seed(FIRST.slug, [
      entry(FIRST.activities[0]?.id ?? 1, true, "2026-09-07T10:00:00.000Z"),
      entry(FIRST.activities[1]?.id ?? 2, true, "2026-09-07T10:01:00.000Z"),
      entry(FIRST.activities[2]?.id ?? 3, false, "2026-09-07T10:02:00.000Z"),
    ]);

    const first = allProgress(LEARNER).find((s) => s.slug === FIRST.slug);

    expect(first?.passed).toBe(2);
    expect(first?.complete).toBe(false);
  });

  it("keeps never-practised languages in the list, at the end", () => {
    seed(SECOND.slug, [entry(1, true, "2026-09-06T10:00:00.000Z")]);

    const all = allProgress(LEARNER);

    expect(all[0]?.slug).toBe(SECOND.slug);
    expect(all.filter((s) => s.lastPractisedAt === null)).toHaveLength(LANGUAGES.length - 1);
  });
});
