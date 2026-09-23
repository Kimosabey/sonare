/**
 * The last resort — nothing upstream of this catches a render-time throw.
 * Without it, any unexpected error (an unguarded null, a response shape a
 * component didn't expect) blanks the whole page to white with no way back
 * except knowing to hit reload yourself. React only offers this as a class
 * component — there's no hook equivalent for getDerivedStateFromError.
 */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Whether a throw is a route's code failing to arrive, rather than failing to
 * run.
 *
 * Eight screens are `lazy()` in App.tsx, each for a stated reason, and the
 * chunk behind one is fetched the first time somebody opens it. Two ordinary
 * situations make that fetch fail, and until this existed both surfaced as
 * "This screen hit an unexpected error and can't continue":
 *
 * - **A deploy.** The document a learner already has open names chunks by
 *   content hash. A new build emits new hashes and the old files stop being
 *   served, so every lazy route in that tab breaks until it is reloaded. The
 *   product's own pitch is that "a fix reaches every user the day it is
 *   deployed", which is precisely when this happens.
 * - **Offline, on a screen never opened before.** The service worker caches
 *   `/assets/` on demand rather than precaching, so a chunk nobody has fetched
 *   is not there to serve.
 *
 * Matched on the message because there is no error type to match on: the three
 * engines word it differently and none of them subclasses anything. A missed
 * match costs the old generic copy, which is what this replaces — so the
 * failure mode of being too narrow is the status quo, not a worse one.
 */
function isRouteCodeMissing(error: Error): boolean {
  return /dynamically imported module|importing a module script failed|failed to fetch dynamically/i.test(
    error.message,
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
    /**
     * Fire-and-forget, same endpoint every other client error already reports
     * to (see useCaptureToasts.ts) — so a crash shows up in the Diagnostics
     * dashboard's error-code breakdown instead of only a browser console
     * nobody's watching.
     *
     * Wrapped, and not only for the rejected promise. A *synchronous* throw in
     * here is thrown during React's error handling and takes the boundary down
     * with it — which lands the learner back at the white screen this
     * component exists to prevent, for the sake of a report. The whole job of
     * a last resort is to hold when something unexpected is missing, so its
     * own reporting must not be able to defeat it.
     */
    try {
      void fetch("/api/v1/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          /**
           * Separated from `REACT_CRASH` deliberately. A deploy is not a bug,
           * and counting one as a crash puts a spike in the Diagnostics
           * breakdown every time somebody ships — which is the fastest way to
           * make that dashboard unreadable. `network`, because the code never
           * ran; it never arrived.
           */
          ...(isRouteCodeMissing(error)
            ? { code: "CHUNK_LOAD_FAILED", domain: "network" }
            : { code: "REACT_CRASH", domain: "client" }),
          message: error.message,
          context: { componentStack: info.componentStack, userAgent: navigator.userAgent },
        }),
      }).catch(() => undefined);
    } catch {
      // Nothing left to do — the fallback UI is what matters from here.
    }
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    if (isRouteCodeMissing(this.state.error)) return this.renderMissingCode();

    return (
      <div className="wrap">
        <section>
          <h2>Something went wrong</h2>
          <div className="verdict v-fail">
            <div className="tag">ERROR</div>
            <div>
              This screen hit an unexpected error and can&rsquo;t continue. Reloading should fix it.
              <details className="error-details">
                <summary>Technical details</summary>
                <div className="hint">{this.state.error.message}</div>
              </details>
            </div>
          </div>
          <div className="row">
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </section>
      </div>
    );
  }

  /**
   * The screen for a route whose code never arrived.
   *
   * Two different situations and two different true sentences, because the
   * same advice is wrong for one of them: reloading genuinely fixes a deploy
   * and cannot fix being offline. The old copy said "Reloading should fix it"
   * to both, and to an offline learner that is simply false — they reload,
   * get the same screen, and learn that the app lies.
   *
   * No automatic reload. It would fix the online case unprompted, and it would
   * also be a page that reloads itself on a failure it cannot see the cause
   * of — one bad deploy and every open tab is in a loop. The button is there
   * and the sentence says when to press it.
   */
  private renderMissingCode(): ReactNode {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    /**
     * The strings are computed rather than branched inside the markup, and
     * that is a size decision rather than a style one. Two parallel JSX trees
     * cost about 350 bytes of the initial payload, which put the raw ceiling
     * in `scripts/perf-budgets.test.ts` over — and that file says plainly that
     * raising a ceiling to fit what arrived is the thing it exists to prevent.
     * One tree and three constants say the same two sentences and fit.
     */
    const heading = offline ? "This part needs the network" : "Sonare has been updated";
    const body = offline
      ? "This screen is not on your device yet and there is no connection to fetch it. What you have already practised still works offline."
      : "A newer version is available. Reload to get this screen — nothing you have done is lost.";

    return (
      <div className="wrap">
        <section>
          <h2>{heading}</h2>
          <div className="verdict v-warn">
            <div className="tag">{offline ? "OFFLINE" : "NEW VERSION"}</div>
            {/*
              No technical details here, unlike the generic crash above. There
              the message is the only clue anybody has; here the cause is known
              and the message is a chunk URL, which tells a learner nothing.
              `componentDidCatch` has already reported it either way.
            */}
            <div>{body}</div>
          </div>
          {!offline && (
            <div className="row">
              <button type="button" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          )}
        </section>
      </div>
    );
  }
}
