// @vitest-environment jsdom

/**
 * The shape of the sitting, stated before it starts.
 *
 * The point is a bounded commitment. A learner deciding whether they have time
 * was previously offered "Carry on", which answers nothing — so every
 * assertion here is about the screen saying what the next few minutes contain,
 * and saying it honestly.
 *
 * The estimate is deliberately vague, and one test holds it that way: a figure
 * to the minute would be precision the product cannot back, and a learner who
 * found it wrong twice would stop believing the rest of the screen.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TodaysSitting } from "./TodaysSitting.js";
import type { ComposedSession } from "../learning/composeSession.js";
import type { Activity } from "../activities/types.js";

function activity(id: number): Activity {
  return {
    id,
    title: `Activity ${String(id)}`,
    kind: "repeat",
    prompt: "Say it",
    gloss: "gloss",
    target: `Phrase ${String(id)}`,
    focus: "focus",
  };
}

function session(over: Partial<ComposedSession> = {}): ComposedSession {
  return {
    slug: "fr",
    code: "fr-FR",
    label: "French",
    day: "2026-09-15",
    lesson: {
      unitId: 2,
      unitTitle: "Ordering food",
      unitOutcome: "You can order food and be understood.",
      id: 2,
      title: "Ordering a coffee",
      outcome: "Say two café phrases",
    },
    activities: [activity(1), activity(2), activity(3), activity(4)],
    reviews: [],
    // Where the sitting came from — a lesson here, since one is set above.
    source: "lesson",
    opening: null,
    ...over,
  };
}

function show(s: ComposedSession) {
  render(
    <MemoryRouter>
      <TodaysSitting session={s} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("what the next few minutes contain", () => {
  it("names the unit and the lesson", () => {
    show(session());

    expect(screen.getByText("Ordering food")).toBeInTheDocument();
    expect(screen.getByText(/Ordering a coffee/)).toBeInTheDocument();
  });

  it("states the count and roughly how long", () => {
    show(session());
    expect(screen.getByText(/4 activities, about \d+ minutes/i)).toBeInTheDocument();
  });

  /**
   * Vague on purpose. Three takes of up to fifteen seconds plus scoring plus
   * reading time is genuinely an estimate, and a minute-accurate figure would
   * be precision the product cannot back.
   */
  it("keeps the estimate approximate rather than exact", () => {
    show(session());

    expect(screen.getByText(/about/i)).toBeInTheDocument();
    expect(screen.queryByText(/\d+ min \d+ s|exactly/i)).not.toBeInTheDocument();
  });

  /**
   * The blend that makes this a course. New content alone is a list of
   * exercises; due sounds alone is a drill. A learner who cannot see both has
   * no way to tell which they are being given.
   */
  it("shows new content and the sounds that came round, distinctly", () => {
    show(
      session({
        reviews: [
          { grapheme: "voudrais", strength: 41, samples: 11, step: 2, due: "2026-09-08", isDue: true },
        ],
      }),
    );

    expect(screen.getByText("NEW")).toBeInTheDocument();
    expect(screen.getByText("DUE")).toBeInTheDocument();
  });

  /**
   * Named, not counted. "Three sounds due" is a number; "voudrais — 7 days
   * since" is the actual reason to sit down.
   */
  it("names each due sound and how long it has been", () => {
    show(
      session({
        reviews: [
          { grapheme: "voudrais", strength: 41, samples: 11, step: 2, due: "2026-09-08", isDue: true },
          { grapheme: "bonjour", strength: 58, samples: 8, step: 1, due: "2026-09-12", isDue: true },
        ],
      }),
    );

    expect(screen.getByText(/7 days since/)).toBeInTheDocument();
    expect(screen.getByText(/3 days since/)).toBeInTheDocument();
  });

  it("tags each sound with the language it is in", () => {
    show(
      session({
        reviews: [
          { grapheme: "voudrais", strength: 41, samples: 11, step: 2, due: "2026-09-08", isDue: true },
        ],
      }),
    );

    expect(screen.getByText("voudrais")).toHaveAttribute("lang", "fr-FR");
  });

  it("says 'due today' rather than '0 days since'", () => {
    show(
      session({
        reviews: [
          { grapheme: "voudrais", strength: 41, samples: 11, step: 2, due: "2026-09-15", isDue: true },
        ],
      }),
    );

    expect(screen.getByText(/due today/i)).toBeInTheDocument();
  });
});

describe("the routes out", () => {
  it("offers the sitting", () => {
    show(session());
    expect(screen.getByRole("link", { name: /Start the sitting/i })).toBeInTheDocument();
  });

  /**
   * Offered on every arrival rather than only when the microphone is missing.
   * A learner on a quiet carriage has the same problem as one with a dead
   * microphone, and discovering the option by failing first is what this
   * screen exists to avoid.
   */
  it("offers the listening route without being asked", () => {
    show(session());
    expect(screen.getByRole("link", { name: /Just the listening/i })).toBeInTheDocument();
  });
});

describe("nothing to do", () => {
  it("renders nothing rather than an empty panel", () => {
    const { container } = render(
      <MemoryRouter>
        <TodaysSitting session={session({ activities: [], reviews: [], lesson: null })} />
      </MemoryRouter>,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("still works for a language with no lesson spine", () => {
    show(session({ lesson: null }));

    expect(screen.getByText(/4 activities/i)).toBeInTheDocument();
    expect(screen.getByText(/4 phrases to say/i)).toBeInTheDocument();
  });
});
