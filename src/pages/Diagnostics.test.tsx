// @vitest-environment jsdom

/**
 * The internal dashboard, and the numbers a decision gets made on.
 *
 * Everything here is derived from records the learner flow wrote, so an
 * arithmetic mistake does not look like a bug — it looks like a finding. The
 * ones that matter most:
 *
 * An indeterminate attempt must be **excluded from the mean, not counted as
 * zero**. R8 says the take was never measured; averaging it in as zero would
 * pull the mean down in proportion to how often the scorer failed, and the
 * whole point of separating those two facts is that they lead to different
 * work — a low mean says teach differently, a high indeterminate rate says
 * fix capture.
 *
 * And the token: this screen reads every learner's spoken phrase, so a 401
 * has to say what to do rather than present as an outage, or whoever is
 * holding it goes looking for a dead server instead of a missing header.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

interface Attempt {
  at: string;
  language: string;
  referenceText: string;
  result: Record<string, unknown>;
  timings: { providerMs: number; totalMs: number };
  deviceContext?: Record<string, unknown>;
}

function scoredAttempt(accuracy: number, overrides: Partial<Attempt> = {}): Attempt {
  return {
    at: "2026-09-04T10:00:00Z",
    language: "fr-FR",
    referenceText: "Bonjour",
    result: { accuracy, overall: accuracy, indeterminate: false, words: [], provider: "azure" },
    timings: { providerMs: 900, totalMs: 1000 },
    deviceContext: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)" },
    ...overrides,
  };
}

function unclearAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    ...scoredAttempt(0),
    result: { indeterminate: true, reason: "no speech found to assess", words: [], provider: "azure" },
    ...overrides,
  };
}

let attempts: Attempt[] = [];
let diagnostics: Record<string, unknown>[] = [];
let spend: Record<string, unknown> | null = null;
let attemptsStatus = 200;
let spendStatus = 200;
let networkFails = false;

function installFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (networkFails) return Promise.reject(new TypeError("Failed to fetch"));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body =
      url.includes("/attempts") ? { records: attempts }
      : url.includes("/diagnostics") ? { records: diagnostics }
      : spend;
    const status = url.includes("/spend") ? spendStatus : attemptsStatus;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      // Exposed so a test can assert the header travelled.
      _headers: headers,
    } as unknown as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installStorage(seed?: Record<string, string>): Map<string, string> {
  const data = new Map(Object.entries(seed ?? {}));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
  return data;
}

async function open(search = "") {
  const { Diagnostics } = await import("./Diagnostics.js");
  return render(
    <MemoryRouter initialEntries={[`/diagnostics${search}`]}>
      <Diagnostics />
    </MemoryRouter>,
  );
}

/**
 * The number rendered in the stat tile with the given label. Tiles are a
 * `.n` value beside an `.l` label, so the label is found first and its
 * sibling read — matching on structure rather than on document order.
 */
/**
 * The platform breakdown's own bars, scoped rather than matched by text: the
 * user agent also appears in the attempts table below, so a document-wide
 * text query legitimately finds the same platform twice.
 */
function platformBars(): string[] {
  const heading = [...document.querySelectorAll("label")].find((n) =>
    (n.textContent ?? "").toLowerCase().includes("platform"),
  );
  const container = heading?.nextElementSibling?.parentElement ?? document.body;
  return [...container.querySelectorAll(".meter em")].map((n) => (n.textContent ?? "").trim());
}

function statFor(label: string): string {
  const tile = [...document.querySelectorAll(".l")].find(
    (n) => (n.textContent ?? "").trim() === label,
  )?.parentElement;
  return tile?.querySelector(".n")?.textContent?.trim() ?? "";
}

beforeEach(() => {
  attempts = [];
  diagnostics = [];
  spend = null;
  attemptsStatus = 200;
  spendStatus = 200;
  networkFails = false;
  installStorage();
  installFetch();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("R8 in the aggregates", () => {
  it("excludes an indeterminate attempt from the mean rather than scoring it zero", async () => {
    /**
     * The mistake that would turn a capture problem into a teaching problem.
     * Three takes at 90 with one unscoreable is a mean of 90 — not 67.5. At
     * the 9.4% indeterminate rate measured on this project, counting them as
     * zero would understate every mean by roughly nine points, permanently
     * and invisibly.
     */
    attempts = [scoredAttempt(90), scoredAttempt(90), scoredAttempt(90), unclearAttempt()];
    await open("?token=t");

    await waitFor(() => expect(statFor("mean score")).not.toBe(""));
    expect(statFor("mean score")).toContain("90");
  });

  it("says on the chart itself how many were excluded", async () => {
    /**
     * Excluded from the mean is not the same as ignored, and the label is
     * where that is made honest: a score-band chart that silently dropped a
     * third of the session would read as a complete picture of it.
     */
    attempts = [scoredAttempt(90), unclearAttempt(), unclearAttempt()];
    await open("?token=t");

    await waitFor(() => expect(statFor("attempts")).toBe("3"));
    expect(screen.getByText(/2 indeterminate excluded/)).toBeInTheDocument();
  });

  it("reports no mean at all when nothing was scored", async () => {
    /**
     * A session of entirely unscoreable takes has no mean. Rendering 0 would
     * claim every learner scored zero, which is precisely the fabricated
     * number R8 exists to prevent — with a chart around it.
     */
    attempts = [unclearAttempt(), unclearAttempt()];
    await open("?token=t");

    await waitFor(() => expect(statFor("attempts")).toBe("2"));
    expect(statFor("mean score")).toBe("—");
  });

  it("bands scored attempts by the shared thresholds", async () => {
    // The same band() the learner's word chips use, so the dashboard and the
    // learner cannot disagree about what 60 means.
    attempts = [scoredAttempt(92), scoredAttempt(71), scoredAttempt(40)];
    await open("?token=t");

    await waitFor(() => expect(statFor("attempts")).toBe("3"));
  });
});

describe("the token", () => {
  it("sends it as a header, never as a query string", async () => {
    /**
     * A token in a query string ends up in server logs, proxy logs and
     * browser history — and this one is the only thing standing in front of
     * every learner's spoken phrases. It arrives in the URL once, by
     * necessity, and must not be forwarded that way.
     */
    const fetchMock = installFetch();
    await open("?token=s3cret");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    for (const [url, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(url).not.toContain("s3cret");
      expect((init.headers as Record<string, string>)["x-diagnostics-token"]).toBe("s3cret");
    }
  });

  it("remembers it, so it is not retyped every visit", async () => {
    const data = installStorage();
    await open("?token=s3cret");

    await waitFor(() => expect(data.size).toBeGreaterThan(0));
    expect([...data.values()]).toContain("s3cret");
  });

  it("reuses a remembered token when the URL has none", async () => {
    const fetchMock = installFetch();
    installStorage({ "sonare.diagnosticsToken": "remembered" });

    await open();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-diagnostics-token"]).toBe("remembered");
  });

  it("prefers a token in the URL over the remembered one", async () => {
    // Pasting a fresh link is how a rotated token gets in.
    const fetchMock = installFetch();
    installStorage({ "sonare.diagnosticsToken": "stale" });

    await open("?token=fresh");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-diagnostics-token"]).toBe("fresh");
  });

  it("says what to do on a 401 rather than presenting it as an outage", async () => {
    /**
     * The difference between a thirty-second fix and an hour spent checking
     * whether Mongo is up. A 401 has exactly one remedy and the message names
     * it.
     */
    attemptsStatus = 401;
    await open();

    expect(await screen.findByText(/requires a diagnostics token/)).toBeInTheDocument();
    expect(screen.getByText(/\?token=/)).toBeInTheDocument();
  });

  it("still loads when storage is unavailable", async () => {
    // Private browsing. The token in the URL has to keep working for this
    // visit even though it cannot be saved for the next one.
    const fetchMock = installFetch();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new DOMException("denied", "SecurityError");
        },
        setItem: () => {
          throw new DOMException("denied", "SecurityError");
        },
      },
    });

    await open("?token=s3cret");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-diagnostics-token"]).toBe("s3cret");
  });
});

describe("when something is down", () => {
  it("names the two things worth checking", async () => {
    // "Something went wrong" would send whoever is reading this nowhere. The
    // server and Mongo are the two processes that have to be up.
    networkFails = true;
    await open("?token=t");

    expect(await screen.findByText(/is the server \(and MongoDB\) up\?/)).toBeInTheDocument();
  });

  it("keeps the screen alive when only the spend aggregation fails", async () => {
    /**
     * Spend is an extra. A Mongo aggregation failing should not blank the
     * error trail and the attempt list — which are the reason someone opened
     * this screen during an incident.
     */
    attempts = [scoredAttempt(88)];
    spendStatus = 500;

    await open("?token=t");

    await waitFor(() => expect(statFor("attempts")).toBe("1"));
    expect(screen.queryByText(/is the server \(and MongoDB\) up\?/)).not.toBeInTheDocument();
  });

  it("clears a stale error once a poll succeeds", async () => {
    // A dashboard that keeps showing an outage after recovery is a dashboard
    // nobody trusts.
    networkFails = true;
    await open("?token=t");
    await screen.findByText(/is the server \(and MongoDB\) up\?/);

    networkFails = false;
    attempts = [scoredAttempt(88)];
    await vi.advanceTimersByTimeAsync(6000);

    await waitFor(() =>
      expect(screen.queryByText(/is the server \(and MongoDB\) up\?/)).not.toBeInTheDocument(),
    );
  });
});

describe("polling", () => {
  it("refreshes on its own, since this is watched during a run", async () => {
    const fetchMock = installFetch();
    await open("?token=t");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const firstRound = fetchMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(6000);

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(firstRound));
  });

  it("stops polling on unmount", async () => {
    /**
     * Three requests per tick, forever, against an endpoint with a rate
     * limit — a leaked interval would eventually 429 the screen it was
     * trying to keep fresh.
     */
    const fetchMock = installFetch();
    const { unmount } = await open("?token=t");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    unmount();
    const afterUnmount = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);

    expect(fetchMock.mock.calls.length).toBe(afterUnmount);
  });
});

describe("what it shows about the records", () => {
  it("groups attempts by platform, which is what T19 compares", async () => {
    attempts = [
      scoredAttempt(88),
      scoredAttempt(80, {
        deviceContext: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/126" },
      }),
    ];
    await open("?token=t");

    await waitFor(() => expect(statFor("attempts")).toBe("2"));
    const bars = platformBars().join(" ");
    expect(bars).toContain("iPhone");
    expect(bars).toContain("Windows");
  });

  it("marks an unknown platform rather than guessing one", async () => {
    // A record with no user agent must group separately, not contaminate a
    // real platform's bucket.
    attempts = [scoredAttempt(88, { deviceContext: {} })];
    await open("?token=t");

    await waitFor(() => expect(statFor("attempts")).toBe("1"));
    expect(platformBars().some((bar) => bar.startsWith("?"))).toBe(true);
  });

  it("survives an empty database without rendering NaN", async () => {
    /**
     * A fresh deployment. Every mean divides by a count, so zero records is
     * the input most likely to produce NaN — and a dashboard of NaNs is worse
     * than an empty one because it looks broken rather than new.
     */
    await open("?token=t");

    await waitFor(() => expect(statFor("attempts")).toBe("0"));
    expect(document.body.textContent).not.toContain("NaN");
  });

  it("does not blank the whole dashboard over one malformed record", async () => {
    /**
     * A real crash this file found. The row did `a.audio.seconds.toFixed(2)`
     * against a type that declared `audio` required — which is a claim about
     * documents this screen did not write: records replayed from the fallback
     * log, or written before the field existed. One of them threw during
     * render and took the entire dashboard with it, which is the screen
     * someone had opened *because* something was wrong.
     *
     * `ScoredWord.syllables` taught this exact lesson once already. A type
     * cannot promise anything about JSON that predates it.
     */
    attempts = [
      scoredAttempt(88),
      { ...scoredAttempt(72), audio: undefined, timings: undefined } as unknown as Attempt,
      scoredAttempt(64),
    ];

    await open("?token=t");

    await waitFor(() => expect(statFor("attempts")).toBe("3"));
    // The good rows are still there, and the bad one shows a dash rather than
    // a fabricated 0.00 — the same distinction R8 draws about scores.
    expect(document.body.textContent).toContain("Bonjour");
    expect(document.body.textContent).not.toContain("NaN");
  });

  it("keeps the latency mean honest when a record has no timings", async () => {
    /**
     * Dividing by every record rather than by the timed ones would drag the
     * mean toward zero in proportion to how many records were malformed —
     * reporting a latency improvement that is really a data problem.
     */
    attempts = [
      scoredAttempt(88, { timings: { providerMs: 2000, totalMs: 2000 } }),
      { ...scoredAttempt(72), timings: undefined } as unknown as Attempt,
    ];

    await open("?token=t");

    await waitFor(() => expect(statFor("attempts")).toBe("2"));
    expect(statFor("mean latency (s)")).toBe("2.00");
  });

  it("survives a record whose optional fields are missing", async () => {
    // These documents were written by older code and by a fallback replay.
    attempts = [
      {
        at: "2026-09-04T10:00:00Z",
        language: "fr-FR",
        referenceText: "Bonjour",
        result: { accuracy: 88, indeterminate: false, words: [], provider: "azure" },
        timings: { providerMs: 900, totalMs: 1000 },
      },
    ];

    await open("?token=t");

    await waitFor(() => expect(statFor("attempts")).toBe("1"));
    expect(document.body.textContent).not.toContain("NaN");
  });
});
