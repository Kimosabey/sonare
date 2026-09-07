// @vitest-environment jsdom

/**
 * The report's job is to be honest about what happened, and it was withholding
 * the one thing a learner most wants to see: that they improved. Every attempt
 * was already stored; only `best` was shown, so 41 → 52 → 68 arrived as "68".
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ActivityReport } from "./ActivityReport.js";
import { buildReport } from "../../activities/report.js";
import type { Activity, ActivityAttempt, ActivityProgress } from "../../activities/types.js";

beforeAll(() => {
  // AnimatedCell's count-up reads prefers-reduced-motion, which jsdom lacks.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(cleanup);

const ACTIVITIES: Activity[] = [
  { id: 1, title: "Greetings", kind: "repeat", prompt: "p", gloss: "g", target: "Bonjour", focus: "f" },
];

function attempt(accuracy: number | null, at: string): ActivityAttempt {
  return {
    activityId: 1,
    accuracy,
    at,
    result:
      accuracy === null
        ? { indeterminate: true, provider: "stub", reason: "no speech found to assess" }
        : {
            indeterminate: false,
            provider: "stub",
            recognized: "Bonjour",
            overall: accuracy,
            accuracy,
            fluency: accuracy,
            completeness: 100,
            words: [],
          },
  };
}

function progressWith(attempts: ActivityAttempt[]): ActivityProgress[] {
  const scored = attempts.map((a) => a.accuracy).filter((x): x is number => x !== null);
  return [
    {
      activityId: 1,
      attempts,
      best: scored.length ? Math.max(...scored) : null,
      passed: scored.some((s) => s >= 60),
      skipped: false,
    },
  ];
}

function renderReport(attempts: ActivityAttempt[]) {
  const progress = progressWith(attempts);
  return render(
    <ActivityReport
      report={buildReport(ACTIVITIES, progress, 60_000)}
      activities={ACTIVITIES}
      progress={progress}
      onRestart={() => undefined}
      onExport={() => undefined}
    />,
  );
}

describe("ActivityReport trajectory", () => {
  it("shows every scored attempt in the order they happened", () => {
    const { container } = renderReport([
      attempt(41, "2026-09-03T10:00:00Z"),
      attempt(52, "2026-09-03T10:01:00Z"),
      attempt(68, "2026-09-03T10:02:00Z"),
    ]);

    const steps = [...container.querySelectorAll(".trajectory-step")].map((e) => e.textContent);
    expect(steps).toEqual(["41", "52", "68"]);
  });

  it("bands each step by its own score, so the climb reads without the digits", () => {
    const { container } = renderReport([
      attempt(41, "2026-09-03T10:00:00Z"),
      attempt(68, "2026-09-03T10:01:00Z"),
      attempt(88, "2026-09-03T10:02:00Z"),
    ]);

    // band() returns hi/mid/lo. Asserting the real names is the point: the
    // first version of the stylesheet used pass/warn/fail and therefore
    // matched nothing at all, which this test is what caught.
    const classes = [...container.querySelectorAll(".trajectory-step")].map((e) => e.className);
    expect(classes[0]).toContain("lo");
    expect(classes[1]).toContain("mid");
    expect(classes[2]).toContain("hi");
  });

  it("keeps an indeterminate attempt in the sequence, with no number", () => {
    // Dropping it would make the sequence disagree with the "Tries" count
    // beside it, and R8 forbids giving it a score.
    const { container } = renderReport([
      attempt(41, "2026-09-03T10:00:00Z"),
      attempt(null, "2026-09-03T10:01:00Z"),
      attempt(68, "2026-09-03T10:02:00Z"),
    ]);

    const steps = [...container.querySelectorAll(".trajectory-step")].map((e) => e.textContent);
    expect(steps).toEqual(["41", "—", "68"]);
  });

  it("counts an activity as improved only when it ended better than it started", () => {
    renderReport([attempt(41, "2026-09-03T10:00:00Z"), attempt(68, "2026-09-03T10:01:00Z")]);

    expect(screen.getByText(/1 activity improved/i)).toBeInTheDocument();
  });

  it("does not claim improvement when the best attempt came first", () => {
    // `best` would still be 68 here, which is exactly why "improved" cannot be
    // derived from it.
    renderReport([attempt(68, "2026-09-03T10:00:00Z"), attempt(41, "2026-09-03T10:01:00Z")]);

    expect(screen.queryByText(/improved/i)).toBeNull();
  });

  it("says nothing about improvement after a single attempt", () => {
    renderReport([attempt(68, "2026-09-03T10:00:00Z")]);

    expect(screen.queryByText(/improved/i)).toBeNull();
  });
});

/**
 * Three outcomes that are not the same thing.
 *
 * "Not reached" is an activity the session ended before. "Not attempted" is
 * one the learner deliberately stepped past without recording — the no-audio
 * exit. "Skipped" is one they tried and did not pass. Collapsing the middle
 * into the last tells someone they failed an activity they never spoke into,
 * in the document they read at the end of a session.
 */
describe("what the result column claims", () => {
  /** Two activities, so "not reached" has somewhere to be. */
  const PAIR: Activity[] = [
    ACTIVITIES[0] as Activity,
    { id: 2, title: "Introductions", kind: "repeat", prompt: "p", gloss: "g", target: "Je m'appelle", focus: "f" },
  ];

  function renderWith(progress: ActivityProgress[]) {
    return render(
      <ActivityReport
        report={buildReport(PAIR, progress, 60_000)}
        activities={PAIR}
        progress={progress}
        onRestart={() => undefined}
        onExport={() => undefined}
      />,
    );
  }

  /** The Result cell for one activity row: #, Activity, Best, Tries, Progress, Result. */
  function resultFor(container: HTMLElement, activityId: number): string {
    const row = [...container.querySelectorAll("tbody tr")].find(
      (tr) => (tr.querySelector("td")?.textContent ?? "") === String(activityId),
    );
    return (row?.querySelectorAll("td")[5]?.textContent ?? "").trim();
  }

  it("separates a deliberate step-past from a genuine failure", () => {
    const { container } = renderWith([
      // Stepped past without recording: zero attempts, skipped.
      { activityId: 1, attempts: [], best: null, passed: false, skipped: true },
      // Tried three times and did not pass.
      {
        activityId: 2,
        attempts: [
          attempt(20, "2026-09-07T10:00:00Z"),
          attempt(24, "2026-09-07T10:01:00Z"),
          attempt(31, "2026-09-07T10:02:00Z"),
        ],
        best: 31,
        passed: false,
        skipped: true,
      },
    ]);

    expect(resultFor(container, 1)).toBe("not attempted");
    expect(resultFor(container, 2)).toBe("skipped");
  });

  it("still calls a passed activity passed", () => {
    const { container } = renderWith([
      {
        activityId: 1,
        attempts: [attempt(88, "2026-09-07T10:00:00Z")],
        best: 88,
        passed: true,
        skipped: false,
      },
    ]);

    expect(resultFor(container, 1)).toBe("passed");
  });

  it("says not reached for an activity the session never got to", () => {
    // Distinct from both: the learner made no decision about it at all.
    const { container } = renderWith([
      {
        activityId: 1,
        attempts: [attempt(88, "2026-09-07T10:00:00Z")],
        best: 88,
        passed: true,
        skipped: false,
      },
    ]);

    expect(resultFor(container, 2)).toBe("not reached");
  });

  it("shows no tries against an activity that was stepped past", () => {
    // The tries column and the result column have to agree — "skipped" beside
    // a try count of 0 is what made the two indistinguishable before.
    const { container } = renderWith([
      { activityId: 1, attempts: [], best: null, passed: false, skipped: true },
    ]);

    const row = [...container.querySelectorAll("tbody tr")][0];
    expect(row?.querySelectorAll("td")[3]?.textContent).toBe("0");
  });
});
