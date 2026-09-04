// @vitest-environment jsdom

/**
 * The paths that matter here are the ones where the API is missing or refuses
 * the descriptor, because one of the target platforms is Safari — and getting
 * those wrong would turn an advisory warning into a crash on the intro screen.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMicrophonePermission } from "./useMicrophonePermission.js";

function stubPermissions(impl: unknown) {
  Object.defineProperty(navigator, "permissions", { configurable: true, value: impl });
}

afterEach(() => {
  delete (navigator as { permissions?: unknown }).permissions;
  vi.restoreAllMocks();
});

describe("useMicrophonePermission", () => {
  it("reports a standing block, which is the whole reason it exists", async () => {
    stubPermissions({
      query: () =>
        Promise.resolve({ state: "denied", addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });

    const { result } = renderHook(() => useMicrophonePermission());

    await waitFor(() => expect(result.current).toBe("denied"));
  });

  it("reports granted and prompt without editorialising", async () => {
    for (const state of ["granted", "prompt"] as const) {
      stubPermissions({
        query: () => Promise.resolve({ state, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
      });

      const { result, unmount } = renderHook(() => useMicrophonePermission());
      await waitFor(() => expect(result.current).toBe(state));
      unmount();
    }
  });

  it("stays unknown when the browser has no Permissions API — Safari", async () => {
    // Not an error state. getUserMedia remains the authority and the app
    // behaves exactly as it did before this hook existed.
    const { result } = renderHook(() => useMicrophonePermission());

    expect(result.current).toBe("unknown");
  });

  it("stays unknown when the microphone descriptor is rejected outright", async () => {
    // Some engines throw a TypeError rather than resolving, which is why the
    // call is wrapped instead of feature-detected on navigator.permissions.
    stubPermissions({
      query: () => Promise.reject(new TypeError("microphone is not a valid permission name")),
    });

    const { result } = renderHook(() => useMicrophonePermission());

    await waitFor(() => expect(result.current).toBe("unknown"));
  });

  it("follows a change made in browser settings without a reload", async () => {
    // The warning has to disappear when the learner unblocks it, or it becomes
    // advice that is wrong and cannot be dismissed.
    let fire: (() => void) | null = null;
    const status = {
      state: "denied",
      addEventListener: (_e: string, cb: () => void) => {
        fire = cb;
      },
      removeEventListener: vi.fn(),
    };
    stubPermissions({ query: () => Promise.resolve(status) });

    const { result } = renderHook(() => useMicrophonePermission());
    await waitFor(() => expect(result.current).toBe("denied"));

    status.state = "granted";
    fire?.();

    await waitFor(() => expect(result.current).toBe("granted"));
  });
});
