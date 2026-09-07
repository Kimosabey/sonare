/**
 * The conversion either side of the wire, and the one thing it must not do.
 *
 * The server holds a *summary* per activity; the local record holds every
 * attempt's full provider result. So folding a server reply back in has to
 * keep the local attempts — the server has no copy of them, and a naive
 * overwrite deletes a learner's own take history from the device that recorded
 * it. Nothing on any screen would look broken; the playback of their own audio
 * would simply be gone.
 */

import { describe, expect, it } from "vitest";
import {
  progressFromWire,
  progressToWire,
  readSnapshot,
  skillsFromWire,
  skillsToWire,
  streakToWire,
  type WireProgress,
} from "./wire.js";
import type { ActivityProgress, ActivityAttempt } from "../activities/types.js";
import type { PersistedProgress } from "../hooks/useProgressPersistence.js";

function attempt(at: string, accuracy: number): ActivityAttempt {
  return { activityId: 1, result: {} as never, accuracy, at };
}

function local(entries: ActivityProgress[], index = 0): PersistedProgress {
  return { index, progress: entries, finished: false };
}

function entry(over: Partial<ActivityProgress> = {}): ActivityProgress {
  return {
    activityId: 1,
    attempts: [attempt("2026-09-07T10:00:00.000Z", 70)],
    best: 70,
    passed: false,
    skipped: false,
    ...over,
  };
}

function wire(entries: WireProgress["entries"], slug = "fr"): WireProgress {
  return { slug, entries };
}

function wireEntry(over: Partial<WireProgress["entries"][number]> = {}) {
  return {
    activityId: 1,
    passed: false,
    bestAccuracy: null,
    attemptsUsed: 0,
    skipped: false,
    at: "2026-09-07T10:00:00.000Z",
    ...over,
  };
}

describe("progress on the way out", () => {
  it("sends a summary, not every attempt's provider result", () => {
    /**
     * The stored attempts carry the full scored words and phonemes, which the
     * attempts collection already has. Syncing them would move kilobytes per
     * activity to tell the server what it was told at scoring time.
     */
    const out = progressToWire(
      "fr",
      local([
        entry({
          activityId: 3,
          attempts: [attempt("2026-09-01T10:00:00.000Z", 40), attempt("2026-09-07T10:00:00.000Z", 82)],
          best: 82,
          passed: true,
        }),
      ]),
    );

    expect(out.entries).toEqual([
      {
        activityId: 3,
        passed: true,
        bestAccuracy: 82,
        attemptsUsed: 2,
        skipped: false,
        at: "2026-09-07T10:00:00.000Z",
      },
    ]);
  });

  it("takes the latest attempt time, not the last in the array", () => {
    // Attempts are appended per activity, so the newest is not necessarily
    // last once an activity has been revisited.
    const out = progressToWire(
      "fr",
      local([
        entry({
          attempts: [attempt("2026-09-07T10:00:00.000Z", 80), attempt("2026-09-01T10:00:00.000Z", 40)],
        }),
      ]),
    );

    expect(out.entries[0]?.at).toBe("2026-09-07T10:00:00.000Z");
  });

  it("drops activities that were never touched", () => {
    // An entry saying "not passed, no attempts" is indistinguishable from no
    // entry, and sending them pushes four languages of untouched activities
    // on a learner's first sync.
    const out = progressToWire("fr", local([entry({ attempts: [], best: null })]));

    expect(out.entries).toEqual([]);
  });

  it("keeps a skipped activity even with no attempts", () => {
    // Skipping is a decision the learner made; it is not the absence of one.
    const out = progressToWire("fr", local([entry({ attempts: [], best: null, skipped: true })]));

    expect(out.entries).toHaveLength(1);
  });

  it("sorts by activity, so identical facts give an identical request", () => {
    const out = progressToWire(
      "fr",
      local([entry({ activityId: 9 }), entry({ activityId: 2 }), entry({ activityId: 5 })]),
    );

    expect(out.entries.map((e) => e.activityId)).toEqual([2, 5, 9]);
  });
});

describe("progress on the way back", () => {
  it("never replaces the local attempts", () => {
    /**
     * The failure this file exists to prevent. The server cannot return
     * attempts, so anything other than keeping the local ones deletes the
     * learner's own take history — silently, and only on the device that had
     * it.
     */
    const stored = local([
      entry({ attempts: [attempt("2026-09-01T10:00:00.000Z", 40), attempt("2026-09-02T10:00:00.000Z", 55)] }),
    ]);

    const merged = progressFromWire(stored, wire([wireEntry({ passed: true, bestAccuracy: 90 })]));

    expect(merged.progress[0]?.attempts).toHaveLength(2);
    expect(merged.progress[0]?.attempts[0]?.accuracy).toBe(40);
  });

  it("applies the same monotonic merge the server does", () => {
    // Locally as well, so the UI updates from one sync instead of waiting for
    // another round trip to tell it what it could already work out.
    const stored = local([entry({ passed: false, best: 70, skipped: true })]);

    const merged = progressFromWire(stored, wire([wireEntry({ passed: true, bestAccuracy: 55, skipped: false })]));

    expect(merged.progress[0]).toMatchObject({ passed: true, best: 70, skipped: false });
  });

  it("does not let the server un-pass a locally passed activity", () => {
    const stored = local([entry({ passed: true, best: 88 })]);

    const merged = progressFromWire(stored, wire([wireEntry({ passed: false, bestAccuracy: 20 })]));

    expect(merged.progress[0]).toMatchObject({ passed: true, best: 88 });
  });

  it("treats a null best as no claim rather than zero", () => {
    const stored = local([entry({ best: null })]);

    expect(progressFromWire(stored, wire([wireEntry({ bestAccuracy: 62 })])).progress[0]?.best).toBe(62);
    expect(
      progressFromWire(local([entry({ best: 62 })]), wire([wireEntry({ bestAccuracy: null })])).progress[0]?.best,
    ).toBe(62);
  });

  it("adds an activity this device has never seen, with an empty attempt list", () => {
    // Genuinely empty here rather than lost: the takes happened elsewhere.
    const merged = progressFromWire(local([]), wire([wireEntry({ activityId: 4, passed: true, bestAccuracy: 91 })]));

    expect(merged.progress).toEqual([
      { activityId: 4, attempts: [], best: 91, passed: true, skipped: false },
    ]);
  });

  it("keeps local activities the server has not heard of", () => {
    const merged = progressFromWire(local([entry({ activityId: 7, passed: true })]), wire([]));

    expect(merged.progress.map((p) => p.activityId)).toEqual([7]);
  });

  it("does not sync where this device left off", () => {
    /**
     * The stored index is this device's position. A second device being on
     * activity nine does not mean this one is, and moving it would jump a
     * learner mid-session on the device they are holding.
     */
    const merged = progressFromWire(local([entry()], 2), wire([wireEntry({ activityId: 9, passed: true })]));

    expect(merged.index).toBe(2);
  });

  it("is idempotent", () => {
    const stored = local([entry({ passed: true, best: 80 })]);
    const once = progressFromWire(stored, wire([wireEntry({ passed: true, bestAccuracy: 80 })]));

    expect(progressFromWire(once, wire([wireEntry({ passed: true, bestAccuracy: 80 })]))).toEqual(once);
  });
});

describe("skills across the wire", () => {
  it("round-trips a store", () => {
    const store = {
      ment: { grapheme: "ment", samples: [{ at: "2026-09-01T10:00:00.000Z", accuracy: 48 }] },
    };

    expect(skillsFromWire(skillsToWire("fr", store))).toEqual(store);
  });

  it("overwrites on the way back, because the server's samples are a superset", () => {
    /**
     * Unlike progress. The server's history is the union of every device's
     * including this one's, so it can only ever have more samples — which is
     * what makes replacing correct here and wrong there.
     */
    const incoming = {
      slug: "fr",
      skills: [
        { grapheme: "ment", samples: [{ at: "2026-09-01T10:00:00.000Z", accuracy: 48 }, { at: "2026-09-05T10:00:00.000Z", accuracy: 61 }] },
      ],
    };

    expect(skillsFromWire(incoming)["ment"]?.samples).toHaveLength(2);
  });

  it("drops an unnamed syllable", () => {
    // The same rule as everywhere else: pooled, they become one "" bucket
    // shown to the learner as their weakest sound.
    const store = skillsFromWire({ slug: "fr", skills: [{ grapheme: "", samples: [] }] });

    expect(Object.keys(store)).toEqual([]);
  });
});

describe("the streak on the way out", () => {
  it("sends the days and the record, and no current run", () => {
    // The current run depends on the learner's own clock, which the server
    // does not know.
    const out = streakToWire({ days: ["2026-09-07"], current: 1, longest: 5 });

    expect(out).toEqual({ days: ["2026-09-07"], longest: 5 });
    expect("current" in out).toBe(false);
  });
});

describe("reading a response", () => {
  it("accepts a well-formed snapshot", () => {
    const snapshot = readSnapshot({
      progress: [{ slug: "fr", entries: [] }],
      skills: [{ slug: "fr", skills: [] }],
      streak: { days: ["2026-09-07"], longest: 3 },
    });

    expect(snapshot).toEqual({
      progress: [{ slug: "fr", entries: [] }],
      skills: [{ slug: "fr", skills: [] }],
      streak: { days: ["2026-09-07"], longest: 3 },
    });
  });

  it.each([
    ["null", null],
    ["a string", "ok"],
    ["an html error page shape", { error: "not found" }],
    ["progress missing", { skills: [], streak: { days: [] } }],
    ["skills not an array", { progress: [], skills: {}, streak: { days: [] } }],
    ["streak missing", { progress: [], skills: [] }],
    ["days not an array", { progress: [], skills: [], streak: { days: "many" } }],
  ])("refuses %s", (_label, body) => {
    /**
     * This is about to be written over a learner's local record, and a proxy,
     * a captive portal or a stale service worker can all return something
     * shaped like JSON.
     */
    expect(readSnapshot(body)).toBeNull();
  });

  it("drops a malformed language without failing the whole snapshot", () => {
    const snapshot = readSnapshot({
      progress: [{ slug: "fr", entries: [] }, { entries: [] }, null],
      skills: [{ slug: 7, skills: [] }, { slug: "es", skills: [] }],
      streak: { days: ["2026-09-07", 5, null], longest: "many" },
    });

    expect(snapshot?.progress.map((p) => p.slug)).toEqual(["fr"]);
    expect(snapshot?.skills.map((s) => s.slug)).toEqual(["es"]);
    expect(snapshot?.streak).toEqual({ days: ["2026-09-07"], longest: 0 });
  });
});
