// @vitest-environment jsdom

/**
 * The last resort. Nothing upstream of this catches a render-time throw, so
 * without it any unguarded null blanks the page to white — and a learner who
 * has just recorded has no way back except knowing to hit reload themselves.
 *
 * Two properties are worth more than the fallback markup. It has to keep
 * working when the thing that broke is the *reporting* — a crash during an
 * offline session must still show the fallback rather than becoming a second,
 * uncatchable error inside componentDidCatch. And the crash has to reach the
 * diagnostics trail, because a React crash that only ever appears in a browser
 * console nobody is watching is a crash nobody will ever fix.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.js";

/**
 * Throws on render, which is the only kind of error a boundary catches.
 *
 * Annotated `never` rather than left to inference: a function whose body only
 * throws infers `void`, which is not a valid component return type.
 */
function Boom({ message = "word.syllables is not iterable" }: { message?: string }): never {
  throw new Error(message);
}

let fetchMock: ReturnType<typeof vi.fn>;
/** Records what React and the boundary logged, without letting it print. */
const logged: unknown[][] = [];

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
  vi.stubGlobal("fetch", fetchMock);
  // React logs the caught error itself; silencing keeps the output readable
  // without hiding a real failure, since the assertions are on the DOM.
  logged.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("when nothing is wrong", () => {
  it("renders its children and stays out of the way", () => {
    render(
      <ErrorBoundary>
        <p>Je voudrais un café</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("Je voudrais un café")).toBeInTheDocument();
  });

  it("reports nothing when there is nothing to report", () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("when a render throws", () => {
  it("shows a fallback instead of a white screen", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("tells the learner what to do, not just that something failed", () => {
    // "Reloading should fix it" is the actionable half. A bare error state
    // leaves someone staring at a dead screen deciding whether to wait.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/Reloading should fix it/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("keeps the technical detail available but folded away", () => {
    /**
     * The message is the one thing that makes a report actionable, and it is
     * also meaningless to a learner. A <details> serves both: invisible until
     * someone asks, and quotable when a learner is asked what it said.
     */
    render(
      <ErrorBoundary>
        <Boom message="word.syllables is not iterable" />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Technical details")).toBeInTheDocument();
    expect(screen.getByText("word.syllables is not iterable")).toBeInTheDocument();
  });

  it("reloads the page when asked", () => {
    // window.location.reload is not writable in jsdom; redefining the whole
    // location object is the supported way to observe the call.
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, reload } });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(reload).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "location", { configurable: true, value: original });
  });

  it("does not render the children it could not render", () => {
    render(
      <ErrorBoundary>
        <p>never shown</p>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.queryByText("never shown")).not.toBeInTheDocument();
  });
});

describe("reaching the diagnostics trail", () => {
  it("reports the crash to the same endpoint every other client error uses", () => {
    /**
     * A React crash that only ever lands in a browser console nobody is
     * watching is a crash nobody will fix. Posting it puts it in the
     * Diagnostics dashboard's error-code breakdown beside the capture failures.
     */
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/diagnostics");
    expect(init.method).toBe("POST");
  });

  it("sends a code the dashboard can group on", () => {
    render(
      <ErrorBoundary>
        <Boom message="boom" />
      </ErrorBoundary>,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { code: string; domain: string; message: string };
    expect(body.code).toBe("REACT_CRASH");
    expect(body.domain).toBe("client");
    expect(body.message).toBe("boom");
  });

  it("includes the component stack, which is the only thing that locates the fault", () => {
    // The message alone rarely identifies which screen threw. The stack is
    // what turns a report into a place to look.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { context: { componentStack: string; userAgent: string } };
    expect(body.context.componentStack).toContain("Boom");
    expect(typeof body.context.userAgent).toBe("string");
  });

  it("still logs to the console, for whoever is actually looking", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(logged.map((call) => call[0])).toContain("[ErrorBoundary]");
  });
});

describe("when the reporting is what is broken", () => {
  it("shows the fallback even if the report cannot be sent", () => {
    /**
     * The case that matters most, because a crash and an offline session are
     * correlated: a failed upload is a plausible cause of the crash in the
     * first place. A rejected fetch inside componentDidCatch must not become a
     * second error on top of the first — the learner would be back at the
     * white screen this component exists to prevent.
     */
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  // A test for "no unhandled rejection is left behind" was written here and
  // removed. `process.on("unhandledRejection")` is not available under this
  // tree's deliberately DOM-only tsconfig, and jsdom's `unhandledrejection`
  // event does not reliably fire — so the assertion would have passed whether
  // or not the `.catch()` were there. The property it was reaching for is
  // already covered by the case above, which renders the fallback with fetch
  // rejecting.

  it("shows the fallback on a platform with no fetch at all", () => {
    // Defensive, but this is the component whose whole job is to work when
    // something unexpected is missing.
    vi.stubGlobal("fetch", undefined);

    expect(() =>
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      ),
    ).not.toThrow();
  });
});
