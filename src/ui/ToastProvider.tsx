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

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  /** Milliseconds on screen. 0 pins it until dismissed. */
  duration: number;
}

export interface ToastInput {
  kind?: ToastKind;
  title: string;
  detail?: string;
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
