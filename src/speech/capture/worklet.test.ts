/**
 * The unsupported-browser path, which is the one nobody developing this can
 * reach: every machine it is written on has AudioWorklet.
 *
 * It matters because the failure is otherwise silent in the only record that
 * survives — a browser without AudioWorklet throws "Cannot read properties of
 * undefined (reading 'addModule')", the recorder's catch converts that to
 * UNSUPPORTED_BROWSER, and the learner does see the right message. What gets
 * lost is the attempt trail's `message`, which would say TypeError rather than
 * why, on exactly the devices nobody has in front of them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { addCaptureWorklet, WORKLET_PROCESSOR_NAME } from "./worklet.js";
import { CaptureError } from "./errors.js";

function contextWith(audioWorklet: unknown): AudioContext {
  return { audioWorklet } as unknown as AudioContext;
}

afterEach(() => {
  delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  delete (globalThis as { URL?: unknown }).URL;
  vi.restoreAllMocks();
});

/** jsdom-free env: supply just enough for the happy path. */
function stubEnvironment() {
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = class {};
  (globalThis as { URL?: unknown }).URL = {
    createObjectURL: () => "blob:stub",
  };
}

describe("addCaptureWorklet", () => {
  it("raises a typed UNSUPPORTED_BROWSER when the context has no audioWorklet", async () => {
    // Safari before 14.1, and older Android WebViews.
    stubEnvironment();

    await expect(addCaptureWorklet(contextWith(undefined))).rejects.toBeInstanceOf(CaptureError);
    await expect(addCaptureWorklet(contextWith(undefined))).rejects.toMatchObject({
      code: "UNSUPPORTED_BROWSER",
    });
  });

  it("says which capability was missing, not just that something failed", async () => {
    stubEnvironment();

    await expect(addCaptureWorklet(contextWith(undefined))).rejects.toMatchObject({
      message: expect.stringContaining("AudioWorklet"),
    });
  });

  it("also refuses when the node constructor is absent", async () => {
    // A context can expose audioWorklet while the global constructor is
    // missing; the graph would then fail one step later, further from the
    // cause.
    (globalThis as { URL?: unknown }).URL = { createObjectURL: () => "blob:stub" };
    const addModule = vi.fn(() => Promise.resolve());

    await expect(addCaptureWorklet(contextWith({ addModule }))).rejects.toMatchObject({
      code: "UNSUPPORTED_BROWSER",
    });
    expect(addModule).not.toHaveBeenCalled();
  });

  it("registers the module when the browser supports it", async () => {
    stubEnvironment();
    const addModule = vi.fn(() => Promise.resolve());

    await addCaptureWorklet(contextWith({ addModule }));

    expect(addModule).toHaveBeenCalledTimes(1);
  });

  it("names the processor the recorder looks for", () => {
    // The node is constructed by name elsewhere; a rename in one place only
    // fails at runtime.
    expect(WORKLET_PROCESSOR_NAME).toBe("lingotran-capture");
  });
});
