// @vitest-environment jsdom

/**
 * When a sync happens, and — mostly — when it does not.
 *
 * Every property here is about restraint. The hook's own header argues each
 * one against an obvious alternative, and none of them was held by anything:
 *
 *  - **Never on a timer.** A poll spends battery and requests discovering that
 *    nothing changed, and there is no second writer whose changes this device
 *    needs promptly — the only other writer is the same learner on another
 *    device, and they are not using both at once.
 *  - **On the way out, not on the way in.** `visibilitychange` to *hidden* is
 *    the only reliable "leaving" signal a browser gives; `beforeunload` and
 *    `pagehide` frequently never fire on iOS. Syncing on every tab focus is a
 *    poll with extra steps.
 *  - **Never overlapping.** Two syncs in flight both read the dirty flags and
 *    the second clears what the first already cleared — harmless in itself,
 *    and it doubles the read-modify-write contention the server retries
 *    through for no benefit.
 *  - **Never into a component that has gone.**
 *  - **Both listeners come off.** An inline closure would be a leak that only
 *    appears once this mounts per screen rather than once for the app, which
 *    is exactly the kind of thing that gets moved later.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Outcome {
  pushed: number;
  pulled: number;
}

const syncNow = vi.fn<(options: unknown) => Promise<Outcome>>(async () => ({ pushed: 0, pulled: 0 }));
vi.mock("./engine.js", () => ({ syncNow: (options: unknown) => syncNow(options) }));

const { useSync } = await import("./useSync.js");

function Harness({ learnerName = "maya", onSynced }: { learnerName?: string | null; onSynced?: (o: unknown) => void }) {
  useSync({ learnerName, ...(onSynced ? { onSynced } : {}) });
  return null;
}

/** Drives `visibilitychange` with the state the hook actually reads. */
function setVisibility(state: "hidden" | "visible"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.clearAllMocks();
  setVisibility("visible");
});

afterEach(cleanup);

describe("when it syncs", () => {
  it("pulls once on mount, because a fresh install has an empty local record", async () => {
    render(<Harness />);

    await waitFor(() => {
      expect(syncNow).toHaveBeenCalledTimes(1);
    });
  });

  it("syncs when the tab is hidden, which is the only reliable leaving signal", async () => {
    render(<Harness />);
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));

    setVisibility("hidden");

    await waitFor(() => {
      expect(syncNow).toHaveBeenCalledTimes(2);
    });
  });

  it("syncs when the network comes back, because offline work is waiting", async () => {
    render(<Harness />);
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("online"));

    await waitFor(() => {
      expect(syncNow).toHaveBeenCalledTimes(2);
    });
  });
});

describe("when it does not", () => {
  /**
   * Coming back is covered by the next mount and by the online handler.
   * Syncing on every tab focus is a poll with extra steps.
   */
  it("does not sync when the tab becomes visible again", async () => {
    render(<Harness />);
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));

    setVisibility("visible");

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  /**
   * No timer, asserted by waiting. The alternative — a poll — is invisible to
   * every other test here, because it would look exactly like a correct sync
   * arriving slightly later.
   */
  it("never syncs on a timer", async () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(syncNow).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Overlap. The mount sync is still in flight when the tab hides, and the
   * second must not start — both would read the same dirty flags.
   */
  it("does not start a second sync while one is in flight", async () => {
    let release: () => void = () => undefined;
    syncNow.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          release = () => resolve({ pushed: 0, pulled: 0 });
        }),
    );

    render(<Harness />);
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));

    setVisibility("hidden");
    window.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(syncNow).toHaveBeenCalledTimes(1);

    // And once it finishes, the next signal is honoured — the guard is a
    // latch, not an off switch.
    release();
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(2));
  });
});

describe("unmounting", () => {
  it("does not call back into a component that has gone", async () => {
    let release: (value: Outcome) => void = () => undefined;
    syncNow.mockImplementationOnce(
      async () =>
        new Promise<Outcome>((resolve) => {
          release = resolve;
        }),
    );
    const onSynced = vi.fn();

    const { unmount } = render(<Harness onSynced={onSynced} />);
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));

    unmount();
    release({ pushed: 0, pulled: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onSynced).not.toHaveBeenCalled();
  });

  /**
   * Both listeners come off. Asserted by firing them after unmount rather than
   * by counting removeEventListener calls, because what matters is that
   * nothing still responds.
   */
  it("leaves no listener behind on either target", async () => {
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));

    unmount();
    setVisibility("hidden");
    window.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(syncNow).toHaveBeenCalledTimes(1);
  });
});
