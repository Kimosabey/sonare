// @vitest-environment jsdom

/**
 * What a learner is actually shown when a new version is waiting.
 *
 * The gates and the handshake are register.test.ts's subject; this file is
 * about the surface. Three things matter and none of them is visible to the
 * type system:
 *
 * - it is **pinned**. A learner mid-take needs to be able to ignore this, and
 *   a toast that auto-dismisses at 2.6s while they are still talking is the
 *   same as never having shown it.
 * - it goes through the app's existing `aria-live` region, so a learner who is
 *   looking at the prompt rather than the corner of the screen hears it.
 * - it is **non-blocking**. No modal, nothing that moves the layout, and
 *   nothing happens until the button is pressed.
 *
 * `registerServiceWorker` is mocked because `import.meta.env.PROD` is false
 * under vitest, so the real one correctly does nothing — see the first test in
 * register.test.ts, which is where that gate is proved.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ToastProvider.js";
import { UpdatePrompt } from "./UpdatePrompt.js";
import { registerServiceWorker } from "./register.js";

vi.mock("./register.js", () => ({
  registerServiceWorker: vi.fn(() => () => undefined),
}));

const mocked = vi.mocked(registerServiceWorker);

/** The `onUpdateReady` the component handed to the registration. */
function announce(apply: () => void): void {
  const options = mocked.mock.calls[0]?.[0];
  if (options === undefined) throw new Error("UpdatePrompt never registered");
  act(() => options.onUpdateReady(apply));
}

beforeEach(() => {
  mocked.mockClear();
  mocked.mockReturnValue(() => undefined);
});

afterEach(cleanup);

describe("registering", () => {
  it("registers once on mount", () => {
    render(
      <ToastProvider>
        <UpdatePrompt />
      </ToastProvider>,
    );

    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("passes no platform of its own, so it cannot bypass the gates", () => {
    /**
     * `registerServiceWorker` takes an optional second argument that overrides
     * the production / secure-context / support checks — it exists so a test
     * can reach the logic behind them. A component passing one would disable
     * every gate in the real app, and the symptom would be a service worker
     * fighting Vite's HMR in development.
     */
    render(
      <ToastProvider>
        <UpdatePrompt />
      </ToastProvider>,
    );

    expect(mocked.mock.calls[0]).toHaveLength(1);
  });

  it("detaches on unmount", () => {
    const dispose = vi.fn();
    mocked.mockReturnValue(dispose);

    const view = render(
      <ToastProvider>
        <UpdatePrompt />
      </ToastProvider>,
    );
    view.unmount();

    expect(dispose).toHaveBeenCalled();
  });

  it("renders nothing", () => {
    // It is a side effect with a toast, not a screen. Anything rendered here
    // would land above the app's own header.
    const { container } = render(
      <ToastProvider>
        <UpdatePrompt />
      </ToastProvider>,
    );

    expect(container.querySelector(".wrap")).toBeNull();
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });
});

describe("what the learner sees", () => {
  beforeEach(() => {
    render(
      <ToastProvider>
        <UpdatePrompt />
      </ToastProvider>,
    );
  });

  it("announces through the app's live region rather than a new surface", () => {
    announce(() => undefined);

    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent("New version ready");
    expect(toast.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
  });

  it("says what pressing it will do", () => {
    // A learner who has just recorded something needs to know a reload is
    // coming, and that the session is not what is being risked.
    announce(() => undefined);

    expect(screen.getByRole("status").textContent).toMatch(/reload/i);
    expect(screen.getByRole("status").textContent).toMatch(/progress/i);
  });

  it("stays until it is answered", () => {
    /**
     * Pinned, i.e. `duration: 0`. The default for an info toast is 2.6
     * seconds, which a learner mid-take would never see — and the update
     * would then never be offered again until the next page load.
     */
    vi.useFakeTimers();
    announce(() => undefined);

    act(() => void vi.advanceTimersByTime(120_000));

    expect(screen.getByText("New version ready")).toBeInTheDocument();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does not interrupt a screen reader", () => {
    // An update is not an emergency. `role="alert"` with `aria-live="assertive"`
    // is reserved for capture failures, which carry an instruction the learner
    // has to act on now.
    announce(() => undefined);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("applies the update only when the button is pressed", () => {
    const apply = vi.fn();
    announce(apply);

    expect(apply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("can be dismissed without updating", () => {
    // Ignoring it is a valid answer. The next page load offers it again.
    const apply = vi.fn();
    announce(apply);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    expect(screen.queryByText("New version ready")).not.toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
  });

  it("shows one toast however many times it is announced", () => {
    // A worker can be found waiting at load and then announce again from
    // `updatefound`. Two identical "New version ready" toasts stacked in the
    // corner is how that would otherwise read.
    announce(() => undefined);
    announce(() => undefined);
    announce(() => undefined);

    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
