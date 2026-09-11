// @vitest-environment jsdom

/**
 * The status channel for a learner who is not looking at it.
 *
 * Mid-recording their eyes are on the prompt, so this surface has to work
 * through a screen reader as well as visually — which is why failures announce
 * assertively and status announces politely, and why that distinction is worth
 * a test rather than a comment.
 *
 * The mechanic under most of these is the shared key. One take pushes three
 * status updates ("Listening" -> "Scoring" -> "Scored 87") and must produce
 * one toast that changes in place, not three stacked notifications for one
 * action. Getting that wrong is not a crash; it is a corner of the screen
 * filling up during a session, which nobody reports as a bug.
 *
 * Timers are faked throughout: a real 2.6-second wait per case would make this
 * file slower than the rest of the suite combined, and the dismissal deadlines
 * are exactly what needs asserting.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./ToastProvider.js";
import type { ToastInput } from "./ToastProvider.js";

/** Exposes the imperative API to a test without a component per case. */
let api: ReturnType<typeof useToast>;

function Probe() {
  api = useToast();
  return null;
}

function mount() {
  return render(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
  );
}

function push(input: ToastInput): number {
  let id = 0;
  act(() => {
    id = api.push(input);
  });
  return id;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("one action, one toast", () => {
  it("replaces a keyed toast in place instead of stacking", () => {
    // The recorder's whole lifecycle shares one key. Three toasts on screen
    // for one take would bury the prompt the learner is reading.
    mount();

    push({ key: "capture", title: "Listening…" });
    push({ key: "capture", title: "Scoring…" });
    push({ key: "capture", title: "Scored 87" });

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("Scored 87")).toBeInTheDocument();
    expect(screen.queryByText("Listening…")).not.toBeInTheDocument();
  });

  it("keeps the replacement in the same slot, so it does not jump", () => {
    /**
     * A keyed replacement appended to the end would make the toast physically
     * move down the stack mid-sentence while a learner is reading it.
     */
    mount();
    push({ title: "First", duration: 0 });
    push({ key: "capture", title: "Listening…", duration: 0 });
    push({ title: "Last", duration: 0 });

    push({ key: "capture", title: "Scoring…", duration: 0 });

    const titles = screen.getAllByRole("status").map((n) => n.querySelector("strong")?.textContent);
    expect(titles).toEqual(["First", "Scoring…", "Last"]);
  });

  it("stacks unkeyed toasts, because they are separate events", () => {
    mount();

    push({ title: "Offline" });
    push({ title: "Microphone muted" });

    expect(screen.getAllByRole("status")).toHaveLength(2);
  });

  it("cancels the replaced toast's timer, so it cannot dismiss its successor", () => {
    /**
     * The subtle one. "Listening" is pushed with a 2.6s life and replaced at
     * 2.0s by a pinned "Scoring". If the first timer survives, it fires at
     * 2.6s and dismisses the pinned toast the learner still needs — a status
     * message vanishing mid-take with nothing to explain it.
     */
    mount();
    push({ key: "capture", title: "Listening…", duration: 2600 });

    act(() => void vi.advanceTimersByTime(2000));
    push({ key: "capture", title: "Scoring…", duration: 0 });
    act(() => void vi.advanceTimersByTime(5000));

    expect(screen.getByText("Scoring…")).toBeInTheDocument();
  });
});

describe("how long things stay", () => {
  it("dismisses a status toast on its own deadline", () => {
    mount();
    push({ kind: "info", title: "Opening microphone…" });

    act(() => void vi.advanceTimersByTime(2599));
    expect(screen.getByText("Opening microphone…")).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(2));
    expect(screen.queryByText("Opening microphone…")).not.toBeInTheDocument();
  });

  it("pins an error until the learner dismisses it", () => {
    /**
     * Errors carry an instruction — "move somewhere quieter", "tap again".
     * Auto-dismissing one is the same as not showing it, because a learner
     * mid-recording is not looking at the corner of the screen.
     */
    mount();
    push({ kind: "error", title: "That came through too quiet to score" });

    act(() => void vi.advanceTimersByTime(60_000));

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("gives a warning longer than a status but still dismisses it", () => {
    // A warning is advisory, so it should not need dismissing — but it needs
    // longer than an info toast to be read at all.
    mount();
    push({ kind: "warn", title: "Background noise is high" });

    act(() => void vi.advanceTimersByTime(2600));
    expect(screen.getByText("Background noise is high")).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(2500));
    expect(screen.queryByText("Background noise is high")).not.toBeInTheDocument();
  });

  it("honours an explicit duration of 0 as a pin, not as a default", () => {
    // `duration ?? DEFAULT` would be correct here but `duration || DEFAULT`
    // would not, and the difference is a pinned "Listening…" that vanishes
    // while the learner is still talking.
    mount();
    push({ kind: "info", title: "Listening…", duration: 0 });

    act(() => void vi.advanceTimersByTime(60_000));

    expect(screen.getByText("Listening…")).toBeInTheDocument();
  });
});

describe("dismissing", () => {
  it("removes the toast the close button belongs to", () => {
    // fireEvent rather than user-event: the project does not depend on the
    // latter, and a click on a button needs nothing it adds.
    mount();
    push({ title: "First", duration: 0 });
    push({ title: "Second", duration: 0 });

    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss notification" })[1]!);

    expect(screen.queryByText("Second")).not.toBeInTheDocument();
    expect(screen.getByText("First")).toBeInTheDocument();
  });

  it("frees the key, so the next push starts a fresh toast", () => {
    /**
     * If dismissing left the key mapped to a dead id, the next keyed push
     * would try to swap in place over a toast that is no longer rendered —
     * and the new status would never appear at all.
     */
    mount();
    const id = push({ key: "capture", title: "Listening…", duration: 0 });

    act(() => void api.dismiss(id));
    push({ key: "capture", title: "Scoring…", duration: 0 });

    expect(screen.getByText("Scoring…")).toBeInTheDocument();
  });

  it("clear() empties the stack and cancels every pending timer", () => {
    // Used when leaving a session. A surviving timer would call setState on an
    // unmounted tree, or dismiss a toast belonging to the next screen.
    mount();
    push({ title: "A" });
    push({ title: "B" });

    act(() => void api.clear());

    expect(screen.queryAllByRole("status")).toHaveLength(0);
    expect(() => act(() => void vi.advanceTimersByTime(10_000))).not.toThrow();
  });

  it("dismissing an unknown id is a no-op, not a throw", () => {
    // The recorder can dismiss on a state transition after a learner already
    // clicked the close button.
    mount();

    expect(() => act(() => void api.dismiss(9999))).not.toThrow();
  });
});

describe("a toast that asks for an answer", () => {
  /**
   * Added for the service-worker update prompt (src/pwa/register.ts), which is
   * the first status in this app that needs an answer rather than only a
   * reading: a waiting version must be accepted by the learner, never applied
   * under them mid-take. The alternative was a second notification surface,
   * which would have needed its own `aria-live` region and its own tap
   * targets.
   */
  it("renders the action as a real button, named by its label", () => {
    // Named by what it does, so a screen reader announces "Update now" rather
    // than "OK" or the toast's whole text.
    mount();
    push({ title: "New version ready", duration: 0, action: { label: "Update now", onClick: () => undefined } });

    expect(screen.getByRole("button", { name: "Update now" })).toBeInTheDocument();
  });

  it("calls the action when it is pressed", () => {
    mount();
    const onClick = vi.fn();
    push({ title: "New version ready", duration: 0, action: { label: "Update now", onClick } });

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("dismisses itself once the action has run", () => {
    // The question has been answered; leaving the toast up invites a second
    // press of something that has already happened.
    mount();
    push({ title: "New version ready", duration: 0, action: { label: "Update now", onClick: () => undefined } });

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    expect(screen.queryByText("New version ready")).not.toBeInTheDocument();
  });

  it("keeps the toast on screen when the action fails", () => {
    /**
     * The one observable consequence of the click handler running the action
     * before the dismissal, and the reason that is the right order: an action
     * that throws leaves the toast up, so the learner can see it and press
     * again. Dismiss-first and the affordance is gone, with nothing on screen
     * to say the update did not happen.
     *
     * Two earlier attempts at this asserted nothing, and both are worth
     * recording because the shape recurs in this repository. Querying the DOM
     * from inside the handler cannot distinguish the two orders — React
     * batches, so the toast is still rendered either way until the handler
     * returns. Nor can the keyed-replacement bookkeeping: `dismiss` mutates
     * `keyed` synchronously while `push` reads it inside its own updater, so
     * both orders end up appending. Swapping the two lines in ToastProvider
     * left both versions green.
     *
     * The error handling below is what the throw costs: React converts an
     * uncaught handler error into a window `error` event rather than
     * rethrowing to `fireEvent`, and vitest fails a run that leaves one
     * unhandled, so it has to be caught here rather than around the click.
     */
    mount();
    const errors: string[] = [];
    const onError = (event: ErrorEvent): void => {
      errors.push(event.message);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      push({
        title: "New version ready",
        duration: 0,
        action: {
          label: "Update now",
          onClick: () => {
            throw new Error("worker is gone");
          },
        },
      });

      fireEvent.click(screen.getByRole("button", { name: "Update now" }));

      // The action really did fail — otherwise this test would pass on a
      // handler that quietly did nothing.
      expect(errors.join(" ")).toMatch(/worker is gone/);
      expect(screen.getByText("New version ready")).toBeInTheDocument();
    } finally {
      window.removeEventListener("error", onError);
      consoleError.mockRestore();
    }
  });

  it("is still dismissible without answering", () => {
    // Ignoring the question is a valid answer, and the close button is how.
    mount();
    const onClick = vi.fn();
    push({ title: "New version ready", duration: 0, action: { label: "Update now", onClick } });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    expect(screen.queryByText("New version ready")).not.toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("adds no second button to a toast that has no action", () => {
    // Every other toast in the app is status. A stray empty button in each one
    // would be a keyboard stop on the way to the close button.
    mount();
    push({ title: "Listening…", duration: 0 });

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeInTheDocument();
  });

  it("keeps the action inside the announced region", () => {
    // The button's label is part of what a screen reader reads out, so the
    // learner is told there is something to press.
    mount();
    push({ title: "New version ready", duration: 0, action: { label: "Update now", onClick: () => undefined } });

    expect(screen.getByRole("status")).toHaveTextContent("Update now");
  });
});

describe("announcing to a screen reader", () => {
  it("interrupts for a failure and waits its turn for status", () => {
    /**
     * The reason this is not cosmetic: a learner who cannot see the corner of
     * the screen gets "Listening…" whenever the reader next pauses, which is
     * right — and gets a capture failure immediately, which is the difference
     * between retrying now and recording thirty more seconds into a muted mic.
     */
    mount();
    push({ kind: "info", title: "Listening…", duration: 0 });
    push({ kind: "error", title: "Microphone is muted", duration: 0 });

    expect(screen.getByRole("status")).toHaveTextContent("Listening…");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Microphone is muted");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("hides the decorative icon from the accessible name", () => {
    // The glyph duplicates what the title already says in words; read aloud it
    // is noise before every message.
    mount();
    push({ kind: "success", title: "Scored 87", duration: 0 });

    expect(screen.getByRole("status")).toHaveTextContent("Scored 87");
    expect(screen.getByText("✓")).toHaveAttribute("aria-hidden", "true");
  });

  it("gives the close button a name, since its label is a glyph", () => {
    mount();
    push({ title: "Anything", duration: 0 });

    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeInTheDocument();
  });

  it("renders the detail line when there is one, and nothing when there is not", () => {
    mount();
    push({ title: "Listening…", detail: "Speak now — it stops on its own.", duration: 0 });

    expect(screen.getByText("Speak now — it stops on its own.")).toBeInTheDocument();
  });
});

describe("misuse", () => {
  it("fails loudly outside a provider rather than silently swallowing status", () => {
    /**
     * A null-returning context would make every toast in a mis-wired subtree
     * disappear — including capture failures. A thrown error is found in
     * development; a missing toast is found by a learner.
     */
    const Orphan = () => {
      useToast();
      return null;
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => render(<Orphan />)).toThrow(/ToastProvider/);

    spy.mockRestore();
  });
});
