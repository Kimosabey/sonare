// @vitest-environment jsdom

/**
 * A screen that sleeps mid-activity costs a learner their place: they unlock,
 * the take is gone, and they re-tap. So the hook matters — but the reason it
 * needs tests is that all three of its interesting paths are invisible in
 * normal use.
 *
 * The sentinel is a real OS resource. Acquiring one and dropping the reference
 * leaves a phone unable to sleep, which is a battery bug a learner would blame
 * on the browser. Two ways to do that here: never releasing on unmount, and
 * losing the race where the async request resolves *after* unmount. The second
 * has no symptom in any manual test, because you have to leave the screen
 * within the few milliseconds the request takes.
 *
 * The third is iOS. Wake Lock does not exist before 16.4, so the feature
 * detection has to hold or the activity page throws on mount for a
 * convenience.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWakeLock } from "./useWakeLock.js";

interface Sentinel {
  release: () => Promise<void>;
  released: boolean;
}

function sentinel(): Sentinel {
  const s: Sentinel = {
    released: false,
    release: () => {
      s.released = true;
      return Promise.resolve();
    },
  };
  return s;
}

/** Installs a wakeLock whose request resolves when `settle` is called. */
function stubWakeLock(options: { deferred?: boolean } = {}) {
  const requests: Sentinel[] = [];
  let settle: (() => void) | null = null;

  const request = vi.fn(() => {
    const s = sentinel();
    requests.push(s);
    if (!options.deferred) return Promise.resolve(s);
    return new Promise<Sentinel>((resolve) => {
      settle = () => resolve(s);
    });
  });

  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
  return { request, requests, settle: () => settle?.() };
}

function stubVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
}

afterEach(() => {
  delete (navigator as { wakeLock?: unknown }).wakeLock;
  stubVisibility("visible");
  vi.restoreAllMocks();
});

describe("acquiring and releasing", () => {
  it("takes a screen lock while a session is active", async () => {
    const { request } = stubWakeLock();

    renderHook(() => useWakeLock(true));

    await waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
  });

  it("takes nothing when no session is active", () => {
    // The activity page mounts before Start is tapped. Holding a lock through
    // the intro screen would drain a phone for no reason.
    const { request } = stubWakeLock();

    renderHook(() => useWakeLock(false));

    expect(request).not.toHaveBeenCalled();
  });

  it("releases on unmount", async () => {
    // Leaving the activity page for the report must give the lock back.
    const { requests } = stubWakeLock();
    const view = renderHook(() => useWakeLock(true));
    await waitFor(() => expect(requests).toHaveLength(1));

    view.unmount();

    expect(requests[0]?.released).toBe(true);
  });

  it("releases when the session ends without the component unmounting", async () => {
    // The real transition at the end of a session: same page, active goes
    // false. A lock held past this point is held until the tab closes.
    const { requests } = stubWakeLock();
    const view = renderHook(({ active }) => useWakeLock(active), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(requests).toHaveLength(1));

    view.rerender({ active: false });

    expect(requests[0]?.released).toBe(true);
  });
});

describe("the race with no symptom", () => {
  it("releases a lock that arrives after unmount", async () => {
    /**
     * The leak that manual testing cannot find. `request` is async; if the
     * component unmounts while it is in flight, the cleanup has already run
     * and there is nothing in the ref to release — so the resolved sentinel
     * would be dropped on the floor and the screen would stay awake for the
     * rest of the tab's life.
     */
    const { requests, settle } = stubWakeLock({ deferred: true });
    const view = renderHook(() => useWakeLock(true));

    view.unmount();
    settle();
    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.released).toBe(true);
  });
});

describe("coming back to the foreground", () => {
  it("re-requests after the platform revoked the lock on backgrounding", async () => {
    /**
     * The Wake Lock API releases automatically when a tab backgrounds — an app
     * switch or a manual screen lock. Without the re-request, a learner who
     * checked a message mid-session comes back to a screen that sleeps again
     * ten seconds later, which reads as the feature simply not working.
     */
    const { request, requests } = stubWakeLock();
    renderHook(() => useWakeLock(true));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    // Simulate the platform's own revocation, then a return to foreground.
    requests[0]!.released = true;
    stubVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it("does not re-request while the tab is still hidden", async () => {
    // Requesting a screen lock for a background tab is a request the platform
    // will reject; asking anyway is noise in the console on every app switch.
    const { request } = stubWakeLock();
    renderHook(() => useWakeLock(true));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    stubVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stops listening for visibility changes after unmount", async () => {
    // A listener that outlives the page would re-acquire a lock for a session
    // that has ended.
    const { request } = stubWakeLock();
    const view = renderHook(() => useWakeLock(true));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    view.unmount();
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("platforms without the API", () => {
  it("does nothing at all on iOS below 16.4", () => {
    /**
     * There is no wakeLock on navigator at all there. The `in` guard is the
     * only thing between that and a TypeError on mount — and this hook runs on
     * the activity page, so throwing would take down recording itself for the
     * sake of keeping a screen on.
     */
    delete (navigator as { wakeLock?: unknown }).wakeLock;

    expect(() => renderHook(() => useWakeLock(true))).not.toThrow();
  });

  it("survives a platform that has the API and refuses the request", async () => {
    // Some browsers expose it and reject — a low-battery mode, or a
    // permissions policy. A rejected promise here must not become an
    // unhandled rejection on the recording screen.
    const request = vi.fn(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });

    const view = renderHook(() => useWakeLock(true));
    await waitFor(() => expect(request).toHaveBeenCalled());

    expect(() => view.unmount()).not.toThrow();
  });
});
