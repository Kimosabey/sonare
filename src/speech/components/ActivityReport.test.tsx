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
