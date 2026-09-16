// @vitest-environment jsdom

/**
 * The check's eight states, and the three distinctions a learner is harmed by
 * losing.
 *
 * **Nobody's fault has to read that way.** An insecure address and a device
 * with no input are not things the learner did, so neither screen may give
 * instructions to follow — there is nothing to undo, and a list of steps
 * implies otherwise.
 *
 * **A refusal is recoverable and the page cannot ask again.** So that screen
 * is a route through settings, not a retry button that would silently do
 * nothing.
 *
 * **Silence is not a low score.** Muted and wrongly-routed are the two causes,
 * and neither is fixed by the "speak up, move closer" advice a quiet verdict
 * gives.
 *
 * The promise that nothing is uploaded is asserted the only way it can be
 * meaningfully asserted from here: the check does not use `useRecorder`, which
 * is the thing that uploads. That is checked as a source fact, not a mock.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { MicAvailability } from "../speech/capture/micCheck.js";

let availability: MicAvailability = { state: "available" };
let inputs: { deviceId: string; label: string }[] = [
  { deviceId: "default", label: "Built-in Microphone" },
];
const recheck = vi.fn();

vi.mock("../hooks/useMicEnvironment.js", () => ({
  useMicEnvironment: () => ({
    availability,
    inputCount: inputs.length,
    // Added when the check gained a device picker; a mock that omits it
    // crashes the component rather than failing an assertion.
    inputs,
    origin: "http://192.168.1.24:5180",
    recheck,
  }),
}));

async function open() {
  const { MicCheck } = await import("./MicCheck.js");
  render(
    <MemoryRouter>
      <MicCheck />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  availability = { state: "available" };
  inputs = [{ deviceId: "default", label: "Built-in Microphone" }];
  recheck.mockClear();
});

afterEach(cleanup);

describe("an address that cannot have a microphone", () => {
  beforeEach(() => {
    availability = { state: "insecure" };
  });

  it("names the address as the problem, not the device", async () => {
    await open();

    expect(screen.getByRole("heading", { name: /address cannot use a microphone/i })).toBeInTheDocument();
    expect(screen.getByText(/192\.168\.1\.24/)).toBeInTheDocument();
  });

  /**
   * Nobody's fault. A numbered list of steps would tell a learner there is
   * something they did and can undo, and there is not — the fix is a different
   * URL, which no amount of tapping in settings reaches.
   */
  it("gives no steps to follow, because there are none", async () => {
    await open();

    expect(document.querySelectorAll("ol")).toHaveLength(0);
  });

  it("leaves the listening activities open", async () => {
    await open();
    expect(screen.getByRole("link", { name: /Practise listening/i })).toBeInTheDocument();
  });
});

describe("a device with no microphone", () => {
  beforeEach(() => {
    availability = { state: "no-hardware" };
  });

  it("says nothing is switched off and nothing is blocked", async () => {
    await open();

    expect(screen.getByRole("heading", { name: /no microphone/i })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is switched off and nothing is blocked/i)).toBeInTheDocument();
  });

  it("gives no steps to follow here either", async () => {
    await open();
    expect(document.querySelectorAll("ol")).toHaveLength(0);
  });

  /**
   * Recoverable without a reload — plugging in a headset — so the page offers
   * to look again rather than telling the learner to restart it.
   */
  it("offers to look again, rather than asking for a reload", async () => {
    await open();
    expect(screen.getByRole("button", { name: /Look for a microphone again/i })).toBeInTheDocument();
  });

  it("says what still works in full", async () => {
    await open();
    expect(screen.getByText(/Every listening activity/i)).toBeInTheDocument();
  });
});

describe("a refused microphone", () => {
  beforeEach(() => {
    availability = { state: "denied" };
  });

  /**
   * The one blocked state that *is* recoverable, and the page genuinely cannot
   * ask again — so steps are right here, where they were wrong on the two
   * above.
   */
  it("routes through settings, because the page cannot ask again", async () => {
    await open();

    expect(screen.getByText(/only asks once/i)).toBeInTheDocument();
    expect(document.querySelectorAll("ol li").length).toBeGreaterThanOrEqual(3);
  });

  it("names Safari's steps and offers Chrome's separately", async () => {
    await open();

    expect(screen.getByText("Safari")).toBeInTheDocument();
    expect(screen.getByText(/On Android Chrome instead/i)).toBeInTheDocument();
  });

  it("treats declining as a fine answer rather than a failure", async () => {
    await open();

    expect(screen.getByText(/that is a fine answer/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /listening only/i })).toBeInTheDocument();
  });
});

describe("the promise that nothing is uploaded", () => {
  /**
   * The screen tells a learner, while they are speaking, that nothing here is
   * uploaded or scored. That is a claim about behaviour, and the only thing
   * that could make it false is reaching for the layer that uploads.
   *
   * Asserted against the source rather than by mocking, deliberately: a mock
   * proves the import is absent from the *test's* module graph, which is
   * exactly what a mock arranges. Reading the file proves it is absent from
   * the shipped one.
   */
  const sources = import.meta.glob("./MicCheck.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  const source = sources["./MicCheck.tsx"] ?? "";

  it("has the source under test, so the assertions below are not vacuous", () => {
    expect(source.length).toBeGreaterThan(1000);
  });

  /**
   * Imports rather than mentions. The file's own comment explains *why* it
   * does not use `useRecorder`, and a naive substring search reads that
   * explanation as the violation it is describing — which would leave only two
   * ways out, deleting the reasoning or weakening the check.
   */
  const imports = source
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line) || /\bawait import\(/.test(line))
    .join("\n");

  it("has imports to look at, so the assertions below are not vacuous", () => {
    expect(imports).toContain("react");
  });

  it("never reaches for the layer that uploads for scoring", () => {
    expect(imports).not.toContain("useRecorder");
    expect(imports).not.toContain("scoring");
  });

  it("sends nothing anywhere itself", () => {
    // Calls, not comments: `fetch(` cannot appear in prose the way a bare
    // identifier can.
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("XMLHttpRequest");
    expect(source).not.toContain("sendBeacon");
  });

  /**
   * Nor keeps anything. "Nothing here is scored or kept" is two promises, and
   * this is the second one — no storage of the levels, the verdict or the
   * audio.
   */
  it("keeps nothing", () => {
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("indexedDB");
  });
});

describe("the check itself", () => {
  it("opens idle, with the promise a learner is about to rely on", async () => {
    await open();

    expect(screen.getByRole("heading", { name: /Say anything/i })).toBeInTheDocument();
    expect(screen.getByText(/never leaves the device/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start the check/i })).toBeInTheDocument();
  });

  it("says it is checking the microphone rather than the learner", async () => {
    await open();
    expect(screen.getByText(/checking the microphone, not you/i)).toBeInTheDocument();
  });

  /**
   * The meter is the one place live movement carries information, so the
   * reading is printed too — and the meter itself is hidden from assistive
   * technology, which would otherwise announce a bar count changing sixty
   * times a second.
   */
  it("hides the meter from screen readers and prints the reading instead", async () => {
    await open();

    expect(document.querySelector(".check-meter")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("lets a learner skip it", async () => {
    await open();
    expect(screen.getByRole("link", { name: /Skip the check/i })).toBeInTheDocument();
  });
});

describe("choosing an input", () => {
  /**
   * Board 1p. The commonest cause of a check coming back **silent** is not a
   * broken microphone but the wrong one selected — a headset left connected, a
   * virtual device from a meeting app. So the picker is the fix for the state
   * the check most often lands in.
   */
  it("offers a picker when there is more than one input", async () => {
    inputs = [
      { deviceId: "a", label: "MacBook Pro Microphone" },
      { deviceId: "b", label: "AirPods Pro" },
    ];
    await open();

    const picker = screen.getByLabelText("Input");
    expect(picker).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "AirPods Pro" })).toBeInTheDocument();
  });

  /**
   * One input is not a choice. A control that can only confirm what already
   * happened is a decision a learner has to make for no reason.
   */
  it("offers none when there is only one", async () => {
    inputs = [{ deviceId: "a", label: "Built-in Microphone" }];
    await open();

    expect(screen.queryByLabelText("Input")).not.toBeInTheDocument();
  });

  /**
   * Labels are empty until permission is granted — the browser withholds them
   * against fingerprinting. A numbered fallback still works: trying each in
   * turn finds the one that moves the meter, which is the whole job.
   */
  it("names unlabelled inputs so they can still be told apart", async () => {
    inputs = [
      { deviceId: "a", label: "" },
      { deviceId: "b", label: "" },
    ];
    await open();

    expect(screen.getByRole("option", { name: "Input 1" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Input 2" })).toBeInTheDocument();
  });

  it("says why the choice matters", async () => {
    inputs = [
      { deviceId: "a", label: "One" },
      { deviceId: "b", label: "Two" },
    ];
    await open();

    expect(screen.getByText(/commonest reason a check comes back silent/i)).toBeInTheDocument();
  });
});
