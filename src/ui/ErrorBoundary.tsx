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
          code: "REACT_CRASH",
          domain: "client",
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
}
