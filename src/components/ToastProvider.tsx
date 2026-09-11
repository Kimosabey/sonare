/**
 * Toasts for transient status and alerts.
 *
 * Deliberately not a dependency: the whole surface is push/dismiss with four
 * kinds, and a toast library would cost more bytes than the feature.
 *
 * Accessibility matters more than usual here — a learner mid-recording is
 * looking at the prompt, not the corner of the screen. Status toasts announce
 * politely; failures announce assertively so a screen reader interrupts.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ToastKind = "info" | "success" | "warn" | "error";

/**
 * One thing a toast offers to do, as a button inside it.
 *
 * Added for the service-worker update prompt, which is the first status in
 * this app that needs an *answer* rather than only a reading: a waiting
 * version must be accepted by the learner, never applied under them mid-take
 * (src/pwa/register.ts). Putting it here rather than building a second
 * notification surface means the announcement comes free — this is already the
 * app's `aria-live` channel.
 */
export interface ToastAction {
  /** Reads as the thing it does: "Update now", not "OK". */
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  action?: ToastAction;
  /** Milliseconds on screen. 0 pins it until dismissed. */
  duration: number;
}

export interface ToastInput {
  kind?: ToastKind;
  title: string;
  detail?: string;
  /**
   * An affordance inside the toast. Pair it with `duration: 0` — a toast that
   * asks for an answer and then leaves before one is given is worse than not
   * asking.
   */
  action?: ToastAction;
  duration?: number;
  /**
   * Replaces any existing toast with the same key instead of stacking. Use for
   * repeated status on one action ("Listening" → "Scoring" → "Scored").
   */
  key?: string;
}

interface ToastApi {
  push: (input: ToastInput) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

const DEFAULT_DURATION: Record<ToastKind, number> = {
  info: 2600,
  success: 3200,
  warn: 5000,
  // Failures stay until the learner dismisses them — they carry an instruction.
  error: 0,
};

const ICONS: Record<ToastKind, string> = {
  info: "●",
  success: "✓",
  warn: "!",
  error: "✕",
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const keyed = useRef(new Map<string, number>());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    for (const [key, value] of keyed.current) {
      if (value === id) keyed.current.delete(key);
    }
  }, []);

  const push = useCallback(
    (input: ToastInput): number => {
      const kind = input.kind ?? "info";
      const duration = input.duration ?? DEFAULT_DURATION[kind];
      const id = nextId.current++;

      const toast: Toast = {
        id,
        kind,
        title: input.title,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        ...(input.action === undefined ? {} : { action: input.action }),
        duration,
      };

      setToasts((prev) => {
        if (!input.key) return [...prev, toast];
        const existing = keyed.current.get(input.key);
        keyed.current.set(input.key, id);
        if (existing === undefined) return [...prev, toast];
        const oldTimer = timers.current.get(existing);
        if (oldTimer) clearTimeout(oldTimer);
        timers.current.delete(existing);
        // Swap in place so the toast does not jump to the end of the stack.
        return prev.map((t) => (t.id === existing ? toast : t));
      });

      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const clear = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    keyed.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ push, dismiss, clear }), [push, dismiss, clear]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-relevant="additions text">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            role={t.kind === "error" ? "alert" : "status"}
            {...(t.kind === "error" ? { "aria-live": "assertive" as const } : {})}
          >
            {/* Decorative: the title already carries the meaning in text. */}
            <span className="toast-icon" aria-hidden="true">
              {ICONS[t.kind]}
            </span>
            <div className="toast-body">
              <strong>{t.title}</strong>
              {t.detail && <div className="toast-detail">{t.detail}</div>}
              {/* Inside the body, below the text, rather than a fourth column
                  in the toast's row: on a narrow phone a button beside a 44px
                  close target leaves the title about 90px to wrap in. */}
              {t.action && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    /**
                     * Act first, dismiss second, and the only case where the
                     * order shows is a failing action: the dismissal never
                     * runs, so the toast stays up and the learner can see it
                     * and press again. Dismiss-first and the affordance is
                     * gone with nothing on screen to say the action did not
                     * happen. (For the update action the question is moot —
                     * it reloads the page.) Pinned by the test of the same
                     * name in ToastProvider.test.tsx, which records the two
                     * earlier attempts at this that asserted nothing.
                     */
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
