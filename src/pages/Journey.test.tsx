// @vitest-environment jsdom

/**
 * The journey screen, and the two things it must not do.
 *
 * **It must not lock anything.** Every unit and every lesson is openable in any
 * order. A hard gate traps a learner on a sound they cannot yet make, and the
 * review ladder brings it back round on its own — so locking the course adds
 * nothing except the feeling of being stuck. Asserted as the absence of any
 * disabled control, on a journey where almost nothing has been done.
 *
 * **It must not claim an outcome without its evidence.** A can-do statement is
 * a claim about a person. Shown as met it needs the receipts beside it, and
 * shown before that it has to read as what the unit is *for* rather than as an
 * achievement.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { LanguageActivitySet } from "../activities/types.js";

const COURSE: LanguageActivitySet = {
  code: "fr-FR",
  slug: "fr",
  label: "French",
  activities: [1, 2, 3, 4].map((id) => ({
    id,
    title: `Activity ${String(id)}`,
    kind: "repeat" as const,
    prompt: "Say it",
    gloss: "gloss",
    target: `Phrase ${String(id)}`,
    focus: "focus",
    soundTargets: id <= 2 ? ["bon"] : ["jour"],
  })),
  units: [
    {
      id: 1,
      title: "Meeting people",
      outcome: "You can greet someone and be understood.",
      lessons: [
        { id: 1, title: "Hello", outcome: "You can say hello.", activityIds: [1, 2] },
        { id: 2, title: "Goodbye", outcome: "You can say goodbye.", activityIds: [3, 4] },
      ],
    },
  ],
};

let served: LanguageActivitySet | undefined = COURSE;

vi.mock("../content/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../content/resolve.js")>(
    "../content/resolve.js",
  );
  return { ...actual, resolveLanguage: () => served };
});

function installStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null,
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => void map.delete(k),
      setItem: (k: string, v: string) => void map.set(k, v),
    },
  });
}

/** Passes activities, and places sounds on the ladder by replaying takes. */
function seed(passedIds: number[], rungs: Record<string, number> = {}): void {
  localStorage.setItem(
    "sonare.progress.v2.fr.anonymous",
    JSON.stringify({
      index: 0,
      finished: false,
      progress: passedIds.map((activityId) => ({
        activityId,
        attempts: [],
        best: 90,
        passed: true,
        skipped: false,
      })),
    }),
  );

  const skills: Record<string, unknown> = {};
  for (const [grapheme, rung] of Object.entries(rungs)) {
    skills[grapheme] = {
      grapheme,
      samples: Array.from({ length: rung }, (_, i) => ({
        at: `2026-0${String(i + 1)}-01T09:00:00.000Z`,
        accuracy: 90,
      })),
    };
  }
  localStorage.setItem("sonare.skills.v1.fr.anonymous", JSON.stringify(skills));
}

async function open() {
  const { Journey } = await import("./Journey.js");
  render(
    <MemoryRouter initialEntries={["/fr/journey"]}>
      <Routes>
        <Route path="/:slug/journey" element={<Journey />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installStorage();
  served = COURSE;
});

afterEach(cleanup);

describe("nothing is locked", () => {
  /**
   * The absence that is the product decision. On a journey where nothing has
   * been done, every lesson is still reachable.
   */
  it("has no disabled control anywhere, even on a fresh start", async () => {
    await open();

    expect(document.querySelectorAll("[disabled]")).toHaveLength(0);
    expect(document.querySelectorAll('[aria-disabled="true"]')).toHaveLength(0);
  });

  it("offers every lesson as a link, whatever its state", async () => {
    seed([1, 2]);
    await open();

    expect(screen.getByRole("link", { name: /Hello/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Goodbye/ })).toBeInTheDocument();
  });

  it("says so, rather than leaving it to be inferred", async () => {
    await open();
    expect(screen.getByText(/No padlocks anywhere/i)).toBeInTheDocument();
  });

  it("tells the learner the units open in any order", async () => {
    await open();
    expect(screen.getByText(/any of them, in any order/i)).toBeInTheDocument();
  });
});

describe("a can-do statement and its receipts", () => {
  it("shows the outcome as met only once the evidence is there", async () => {
    seed([1, 2, 3, 4], { bon: 3, jour: 3 });
    await open();

    expect(screen.getByLabelText("met")).toBeInTheDocument();
  });

  /**
   * Finishing every activity is closer to attendance than ability — the gate
   * is soft, so tries can simply be exhausted. The unit reads as done and the
   * outcome still is not claimed.
   */
  it("does not claim it on finished lessons alone", async () => {
    seed([1, 2, 3, 4], { bon: 0, jour: 0 });
    await open();

    expect(screen.queryByLabelText("met")).not.toBeInTheDocument();
    expect(screen.getByText(/· done/)).toBeInTheDocument();
  });

  it("names the sounds the claim is waiting on", async () => {
    seed([1, 2], { bon: 3 });
    await open();

    expect(screen.getByText(/Checked by/i)).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 sounds holding/)).toBeInTheDocument();
  });

  it("stops naming them once the claim is made", async () => {
    seed([1, 2, 3, 4], { bon: 3, jour: 3 });
    await open();

    expect(screen.queryByText(/Checked by/i)).not.toBeInTheDocument();
  });
});

describe("where the learner is", () => {
  it("marks the unit they are in", async () => {
    seed([1, 2]);
    await open();

    expect(screen.getByText(/you are here/i)).toBeInTheDocument();
  });

  it("counts the lessons finished", async () => {
    seed([1, 2]);
    await open();

    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });
});

describe("a language with no course", () => {
  /**
   * Flat, and it says so. Wrapping the phrases in an invented unit would mean
   * inventing a can-do statement, which is exactly the claim this screen may
   * not make.
   */
  it("says there is nothing to map rather than inventing a unit", async () => {
    served = { code: COURSE.code, slug: COURSE.slug, label: COURSE.label, activities: COURSE.activities };
    await open();

    expect(screen.getByText(/no units yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Practise the phrases/i })).toBeInTheDocument();
  });

  it("does not leave a learner without a route on for an unknown language", async () => {
    served = undefined;
    await open();

    expect(screen.getByRole("link", { name: /Pick one that is here/i })).toBeInTheDocument();
  });
});
