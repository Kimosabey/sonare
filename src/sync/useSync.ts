/**
 * When a sync happens.
 *
 * Never while the learner is doing something. Three moments, each chosen
 * because it is a point at which the learner is definitionally not mid-take:
 *
 * **On mount**, once, which pulls whatever this device is missing — the case
 * that matters most is a fresh install or a cleared cache, where the local
 * record is empty and the server's is not.
 *
 * **When the tab is hidden**, which is the only reliable "leaving" signal a
 * browser gives. `beforeunload` and `pagehide` are unreliable on mobile —
 * iOS in particular frequently never fires them — and `visibilitychange` to
 * hidden is what does fire when an app is backgrounded or the phone is
 * locked. That is exactly the moment a learner has finished and put the
 * phone down.
 *
 * **When the network comes back**, because a learner who practised offline has
 * work waiting and the `online` event is the first moment it can leave.
 *
 * Deliberately *not* on a timer. A poll spends battery and requests to
 * discover nothing has changed, and there is no second writer whose changes
 * this device needs to see promptly — the only other writer is the same
 * learner on another device, and they are not using both at once.
 */

import { useEffect, useRef } from "react";
import { syncNow, type SyncOutcome } from "./engine.js";

export interface UseSyncOptions {
  learnerName: string | null;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Called after each attempt, for a screen that wants to refresh. */
  onSynced?: (outcome: SyncOutcome) => void;
}

export function useSync(options: UseSyncOptions): void {
  const { learnerName } = options;

  /**
   * Held in a ref so a changing callback identity does not re-run the effect
   * and fire an extra sync on every render of the parent.
   */
  const latest = useRef(options);
  latest.current = options;

  /**
   * Guards against overlapping requests. Two syncs in flight would both read
   * the dirty flags, and the second would clear what the first had already
   * cleared — harmless, but it also doubles the read-modify-write contention
   * the server has to retry through, for no benefit.
   */
  const running = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      if (running.current) return;
      running.current = true;
      try {
        const outcome = await syncNow({
          learnerName,
          ...(latest.current.fetchImpl !== undefined ? { fetchImpl: latest.current.fetchImpl } : {}),
        });
        // Unmounted while the request was in flight: the local stores are
        // already updated by the engine, so there is nothing to do but not
        // call back into a component that has gone.
        if (!cancelled) latest.current.onSynced?.(outcome);
      } finally {
        running.current = false;
      }
    }

    void run();

    function onHidden(): void {
      // Only on the way out. Coming back is covered by the next mount or the
      // online handler, and syncing on every tab focus is a poll with extra
      // steps.
      if (document.visibilityState === "hidden") void run();
    }

    function onOnline(): void {
      void run();
    }

    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("online", onOnline);

    // Both named, so both come off. An inline closure here would be a leak
    // that only appears if this ever mounts per screen rather than once for
    // the app — which is exactly the kind of thing that gets moved later.
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("online", onOnline);
    };
  }, [learnerName]);
}
