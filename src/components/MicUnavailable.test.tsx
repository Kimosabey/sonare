// @vitest-environment jsdom

/**
 * "No microphone here", and the distinction between its two causes.
 *
 * They look identical to a learner — the microphone does not work — and the
 * right advice is opposite. Blocked is recoverable in the browser and deserves
 * steps; an insecure address cannot be fixed on the device at all, so steps
 * there are instructions to do something impossible, and a learner who follows
 * them and fails concludes they broke something.
 *
 * The other property is that none of these is a dead end: the listening
 * activities need no microphone and are offered rather than mentioned.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MicUnavailable } from "./MicUnavailable.js";
import type { MicAvailability } from "../speech/capture/micCheck.js";

const retry = vi.fn();

function show(availability: MicAvailability) {
  render(
    <MemoryRouter>
      <MicUnavailable availability={availability} listeningHref="/fr" onRetry={retry} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  retry.mockClear();
  cleanup();
});

describe("a blocked microphone", () => {
  it("gives the browser steps, because they work", () => {
    show({ state: "denied" });

    expect(screen.getByText(/blocked from using your microphone/i)).toBeInTheDocument();
    expect(document.querySelectorAll("ol li")).toHaveLength(3);
  });

  it("offers a retry, because the state can change", () => {
    show({ state: "denied" });
    expect(screen.getByRole("button", { name: /Try the microphone again/i })).toBeInTheDocument();
  });
});

describe("an insecure address", () => {
  it("says nothing is broken, and gives no steps", () => {
    show({ state: "insecure" });

    expect(screen.getByText(/nothing on this screen is broken/i)).toBeInTheDocument();
    expect(document.querySelectorAll("ol")).toHaveLength(0);
  });

  /**
   * The button is absent rather than disabled. Retrying would fail every time
   * however often it is tapped — the fix is a different URL — and a control
   * that cannot work is worse than no control, because it invites the learner
   * to keep trying.
   */
  it("offers no retry, because retrying cannot work", () => {
    show({ state: "insecure" });

    expect(screen.queryByRole("button", { name: /try/i })).not.toBeInTheDocument();
  });
});

describe("no microphone hardware", () => {
  it("says nothing is switched off and nothing is blocked", () => {
    show({ state: "no-hardware" });

    expect(screen.getByText(/Nothing is switched off and nothing is blocked/i)).toBeInTheDocument();
    expect(document.querySelectorAll("ol")).toHaveLength(0);
  });

  /** Recoverable by plugging something in, so looking again is real. */
  it("offers to look again", () => {
    show({ state: "no-hardware" });
    expect(screen.getByRole("button", { name: /Look for a microphone again/i })).toBeInTheDocument();
  });
});

describe("every cause", () => {
  it("offers the listening activities rather than merely mentioning them", () => {
    for (const state of ["denied", "insecure", "no-hardware"] as const) {
      cleanup();
      show({ state });
      // Plain `/fr` under MemoryRouter; the shipped HashRouter renders it as
      // `#/fr`. What matters here is that it points at this language.
      expect(screen.getByRole("link", { name: /Practise listening instead/i })).toHaveAttribute(
        "href",
        "/fr",
      );
    }
  });

  it("renders nothing at all when the microphone is available", () => {
    const { container } = render(
      <MemoryRouter>
        <MicUnavailable
          availability={{ state: "available" }}
          listeningHref="/fr"
          onRetry={retry}
        />
      </MemoryRouter>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
