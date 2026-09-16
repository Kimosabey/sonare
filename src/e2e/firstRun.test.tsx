// @vitest-environment jsdom

/**
 * The first-run flow, end to end — and the reason this file exists.
 *
 * Every screen in it had its own passing suite, and the flow was still
 * **unreachable**: nothing linked to `#/welcome` and nothing redirected there,
 * so a learner's first visit went Today → picker → straight into an activity.
 * Boards 1a–1d and all eight mic-check states existed only if somebody typed
 * the URL.
 *
 * That is not a cosmetic gap. Board 1d is the screen that explains what happens
 * to a recording *before* the browser's permission prompt fires — and the
 * browser asks once, with iOS unable to be re-asked from the page. Skipping it
 * spends a one-shot question with none of the explanation it was designed to
 * come after.
 *
 * So what is asserted here is not what any screen says — each suite covers that
 * — but that the learner actually arrives at them, in order, and is not sent
 * back through once they have answered.
 */

import { cleanup, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEARNER_NAME_KEY,
  installBrowserGlobals,
  installFetch,
  installStorage,
  makeRecorderStub,
  press,
  renderApp,
} from "./harness.js";

const { useRecorder } = makeRecorderStub();
vi.mock("../speech/react/useRecorder.js", () => ({ useRecorder }));
vi.mock("../hooks/useCaptureToasts.js", () => ({
  useCaptureToasts: () => undefined,
  HEARD_SPEECH_SNR_DB: 10,
}));

let store: Map<string, string>;

beforeEach(() => {
  store = installStorage();
  /**
   * The harness marks a device as onboarded by default, because every other
   * journey suite is about a returning learner. This is the one suite about
   * the first visit, so it takes that back off.
   */
  for (const key of [...store.keys()]) {
    if (key.startsWith("sonare.onboarded.")) store.delete(key);
  }
  installBrowserGlobals();
  installFetch();
});

afterEach(cleanup);

/** The onboarding flag, whatever learner it is filed under. */
function onboardedKeys(): string[] {
  return [...store.keys()].filter((k) => k.startsWith("sonare.onboarded."));
}

describe("a learner's very first visit", () => {
  it("lands on onboarding rather than the picker", async () => {
    await renderApp("#/");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Hear it first/i })).toBeInTheDocument();
    });
  });

  /**
   * The specific failure this replaces: straight to "choose a language", which
   * puts the next tap on an activity and the microphone prompt after it.
   */
  it("does not send them to the picker first", async () => {
    await renderApp("#/");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Hear it first/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: /Choose a language/i })).not.toBeInTheDocument();
  });

  it("reaches the microphone explanation before any prompt could fire", async () => {
    await renderApp("#/");
    await waitFor(() => screen.getByRole("button", { name: /Sounds useful/i }));

    press(/Sounds useful/i);
    press(/^Continue with/i);
    press(/Skip — no name/i);

    expect(screen.getByRole("heading", { name: /your microphone/i })).toBeInTheDocument();
    expect(screen.getByText(/cannot ask again/i)).toBeInTheDocument();
  });
});

describe("once they have answered", () => {
  /**
   * Both exits count as onboarded. A learner who read the explanation and
   * chose "listening only" has answered, and being sent back through would
   * ignore that answer — which is why this is a flag and not "has progress".
   */
  it("remembers, when they ask for the microphone", async () => {
    await renderApp("#/");
    await waitFor(() => screen.getByRole("button", { name: /Sounds useful/i }));

    press(/Sounds useful/i);
    press(/^Continue with/i);
    press(/Skip — no name/i);
    press(/Ask for the microphone/i);

    expect(onboardedKeys()).toHaveLength(1);
  });

  it("remembers, when they decline it", async () => {
    await renderApp("#/");
    await waitFor(() => screen.getByRole("button", { name: /Sounds useful/i }));

    press(/Sounds useful/i);
    press(/^Continue with/i);
    press(/Skip — no name/i);
    press(/start with listening only/i);

    expect(onboardedKeys()).toHaveLength(1);
  });

  it("shows Today rather than onboarding on the next visit", async () => {
    store.set("sonare.onboarded.v1.anonymous", new Date().toISOString());
    await renderApp("#/");

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /Choose a language/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: /Hear it first/i })).not.toBeInTheDocument();
  });

  /**
   * Per learner, because the explanation of what happens to a recording is
   * owed to each person on a shared tablet rather than to the device.
   */
  it("onboards a second learner on the same device", async () => {
    store.set("sonare.onboarded.v1.anonymous", new Date().toISOString());
    store.set(LEARNER_NAME_KEY, "Marie");

    await renderApp("#/");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Hear it first/i })).toBeInTheDocument();
    });
  });
});
