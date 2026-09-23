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

/**
 * The failure that is not a bug.
 *
 * Eight screens are `lazy()`, so each has a chunk fetched on first open, and
 * two ordinary situations stop it arriving: a deploy changes the hashed names
 * the open document asks for, and being offline on a screen never visited
 * means the service worker has nothing cached to serve. Both used to read as
 * "This screen hit an unexpected error and can't continue", which is the wrong
 * thing to tell somebody in both cases and actively false in one.
 */
describe("when a lazy route's code never arrives", () => {
  const CHROME = "Failed to fetch dynamically imported module: https://x/assets/Journey-a1.js";
  const FIREFOX = "error loading dynamically imported module";
  const SAFARI = "Importing a module script failed.";

  function setOnline(value: boolean): void {
    Object.defineProperty(navigator, "onLine", { configurable: true, value });
  }

  afterEach(() => {
    setOnline(true);
  });

  it.each([CHROME, FIREFOX, SAFARI])("recognises how each engine words it: %s", (message) => {
    /**
     * All three, because there is no error type to match on and the wording is
     * the only signal. A missed engine sends that browser's learners back to
     * the generic crash screen, which is a silent regression — nothing fails,
     * the copy is just wrong again.
     */
    setOnline(true);
    render(
      <ErrorBoundary>
        <Boom message={message} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: /Sonare has been updated/i })).toBeInTheDocument();
    expect(screen.queryByText(/hit an unexpected error/i)).not.toBeInTheDocument();
  });

  it("tells an offline learner the truth, and does not tell them to reload", () => {
    /**
     * The half that was actively false. Reloading cannot fetch a chunk that is
     * not on the device and not on the network, so the old copy's "Reloading
     * should fix it" sent somebody to press a button that returns them to the
     * same screen. The reload button is withheld here rather than relabelled,
     * because there is nothing for it to do.
     */
    setOnline(false);
    render(
      <ErrorBoundary>
        <Boom message={CHROME} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: /needs the network/i })).toBeInTheDocument();
    expect(screen.getByText(/already practised still works offline/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reload/i })).not.toBeInTheDocument();
  });

  it("offers the reload when there is a network, because that is what fixes a deploy", () => {
    setOnline(true);
    render(
      <ErrorBoundary>
        <Boom message={CHROME} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("button", { name: /Reload/i })).toBeInTheDocument();
  });

  it("reports it as its own code, so a deploy is not counted as a crash", async () => {
    /**
     * `REACT_CRASH` would put a spike in the Diagnostics breakdown every time
     * somebody ships, which is the fastest way to make that dashboard
     * unreadable. `network` as the domain because the code never ran — it
     * never arrived.
     */
    const sent = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 204 })),
    );
    vi.stubGlobal("fetch", sent);
    setOnline(true);

    render(
      <ErrorBoundary>
        <Boom message={CHROME} />
      </ErrorBoundary>,
    );

    await vi.waitFor(() => expect(sent).toHaveBeenCalled());
    const body = JSON.parse(String(sent.mock.calls[0]?.[1]?.body)) as {
      code: string;
      domain: string;
    };
    expect(body.code).toBe("CHUNK_LOAD_FAILED");
    expect(body.domain).toBe("network");
  });

  it("still calls an ordinary crash an ordinary crash", () => {
    // The generic path has to survive the new branch, or this trade one
    // wrong message for another.
    render(
      <ErrorBoundary>
        <Boom message="word.syllables is not iterable" />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: /Something went wrong/i })).toBeInTheDocument();
  });
});
