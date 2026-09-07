/**
 * Keeps the screen awake for the duration of an active session, so a learner
 * reading a prompt (or the "what this activity is testing" detail) doesn't
 * get locked out mid-read and have to unlock and re-tap.
 *
 * Lives outside src/speech/ for the same reason useCaptureToasts.ts does:
 * this is presentation, not capture.
 */

import { useEffect, useRef } from "react";

export function useWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;

    let cancelled = false;

    const acquire = async () => {
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void sentinel.release();
          return;
        }
        sentinelRef.current = sentinel;
      } catch {
        // Not fatal — the session just risks the screen sleeping. iOS <16.4
        // has no Wake Lock API at all, which lands here too via the guard above.
      }
    };

    void acquire();

    /**
     * The Wake Lock API releases automatically when the tab backgrounds (app
     * switch, screen lock), so the lock has to be re-requested on the way
     * back while the session is still active.
     *
     * The platform's release does not clear our reference — it flips the
     * sentinel's own `released` flag and leaves the object in place. Guarding
     * on the reference alone therefore never re-acquires after the first
     * successful request, and the whole re-request path is dead: a learner who
     * checks a message mid-session comes back to a screen that sleeps again
     * shortly after, which reads as the feature simply not working. The flag
     * is what has to be consulted.
     */
    const onVisibilityChange = () => {
      const held = sentinelRef.current;
      if (document.visibilityState === "visible" && (!held || held.released)) {
        void acquire();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void sentinelRef.current?.release();
      sentinelRef.current = null;
    };
  }, [active]);
}
