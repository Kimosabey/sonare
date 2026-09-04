// @vitest-environment jsdom

/**
 * Twenty lines, and the difference between warning a learner before they speak
 * and losing a take they will not repeat.
 *
 * A dropped connection is not a rare case here — the fixture runs on phones,
 * on hotel and venue wifi, over an ngrok tunnel. The cost of getting this
 * wrong is asymmetric and lands entirely on the learner: they record a whole
 * phrase, the upload fails, and the attempt is gone. The warning has to arrive
 * *before* the take, which means the state has to be right at mount and has to
 * update without one.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOnlineStatus } from "./useOnlineStatus.js";

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
}

afterEach(() => {
  setOnline(true);
  vi.restoreAllMocks();
});

describe("the state at mount", () => {
  it("reads the current state rather than assuming online", () => {
    /**
     * The important half. Defaulting to `true` and waiting for an event would
     * mean a learner who opened the app already offline gets no warning at
     * all — no `offline` event fires, because nothing changed.
     */
    setOnline(false);

    const { result } = renderHook(() => useOnlineStatus());

    expect(result.current).toBe(false);
  });

  it("reports online when it is", () => {
    setOnline(true);

    const { result } = renderHook(() => useOnlineStatus());

    expect(result.current).toBe(true);
  });
});

describe("reacting to a change", () => {
  it("goes offline when the connection drops", () => {
    const { result } = renderHook(() => useOnlineStatus());

    act(() => void window.dispatchEvent(new Event("offline")));

    expect(result.current).toBe(false);
  });

  it("comes back online, so a warning does not outlive its cause", () => {
    // A stale "you are offline" banner on a working connection trains a
    // learner to ignore the banner.
    const { result } = renderHook(() => useOnlineStatus());
    act(() => void window.dispatchEvent(new Event("offline")));

    act(() => void window.dispatchEvent(new Event("online")));

    expect(result.current).toBe(true);
  });

  it("survives a flapping connection without getting stuck", () => {
    // Venue wifi. The final state has to match the final event.
    const { result } = renderHook(() => useOnlineStatus());

    for (const event of ["offline", "online", "offline", "online", "offline"]) {
      act(() => void window.dispatchEvent(new Event(event)));
    }

    expect(result.current).toBe(false);
  });

  it("does not depend on navigator.onLine after mount", () => {
    /**
     * The events are the source of truth once mounted. Re-reading the property
     * would be no more correct — `navigator.onLine` reports whether there is a
     * network interface, not whether anything is reachable — and would risk
     * disagreeing with the event that just fired.
     */
    const { result } = renderHook(() => useOnlineStatus());
    setOnline(false);

    act(() => void window.dispatchEvent(new Event("online")));

    expect(result.current).toBe(true);
  });
});

describe("cleanup", () => {
  it("removes both listeners on unmount", () => {
    /**
     * A listener per mount that never comes off is a leak with a visible
     * consequence: the activity page mounts once per activity, so ten
     * activities leave nine dead subscriptions each calling setState on an
     * unmounted component.
     */
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useOnlineStatus());

    unmount();

    const added = add.mock.calls.filter(([e]) => e === "online" || e === "offline");
    const removed = remove.mock.calls.filter(([e]) => e === "online" || e === "offline");
    expect(added).toHaveLength(2);
    expect(removed).toHaveLength(2);
  });

  it("removes the same function references it added", () => {
    // Removing a different closure removes nothing, and the leak above is
    // exactly as bad as never calling removeEventListener.
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useOnlineStatus());

    unmount();

    for (const name of ["online", "offline"]) {
      const addedHandler = add.mock.calls.find(([e]) => e === name)?.[1];
      const removedHandler = remove.mock.calls.find(([e]) => e === name)?.[1];
      expect(removedHandler, name).toBe(addedHandler);
    }
  });

  it("stops responding to events after unmount", () => {
    const { result, unmount } = renderHook(() => useOnlineStatus());
    unmount();

    expect(() => act(() => void window.dispatchEvent(new Event("offline")))).not.toThrow();
    expect(result.current).toBe(true);
  });
});
