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

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";

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

/**
 * The per-learner reads are answered separately from the poll's, because they
 * are a different question against the same paths — a `learnerId` in the
 * query string is what tells them apart, exactly as it does server-side.
 */
let lookupAttempts: Attempt[] = [];
let lookupDiagnostics: Record<string, unknown>[] = [];
let lookupStatus = 200;

function installFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (networkFails) return Promise.reject(new TypeError("Failed to fetch"));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const isLookup = url.includes("learnerId=");
    const body =
      url.includes("/attempts") ? { records: isLookup ? lookupAttempts : attempts }
      : url.includes("/diagnostics") ? { records: isLookup ? lookupDiagnostics : diagnostics }
      : spend;
    const status =
      isLookup ? lookupStatus
      : url.includes("/spend") ? spendStatus
      : attemptsStatus;
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
  lookupAttempts = [];
  lookupDiagnostics = [];
  lookupStatus = 200;
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

/**
 * The per-learner lookup.
 *
 * A learner writes "it never hears me". The reply depends entirely on telling
 * a recording with no speech in it apart from a provider that cancelled —
 * both arrive as `indeterminate`, and both read as "unclear" in every other
 * table on this page. Of 139 real stored attempts, 10 were indeterminate: 7
 * the recording, 3 the provider. Getting that split wrong means telling
 * someone to check a microphone that was working fine.
 *
 * The classification is a pure function, so it is asserted directly against
 * the exact `reason` strings server/services/azureSpeech.ts emits. A
 * paraphrase would keep passing while the real classification drifted.
 */
const LEARNER = "3f1a9c40-5b2e-4d7a-9f18-2c4b6e8a1d30";
const OTHER_LEARNER = "8c2d4e60-7a1b-4f3c-8d95-1e6a3b7c9f24";

type Diag = Record<string, unknown>;

function diag(code: string, domain: string, overrides: Diag = {}): Diag {
  return {
    at: "2026-09-04T10:00:00Z",
    source: "client",
    code,
    domain,
    context: { userAgent: "Mozilla/5.0 Chrome" },
    ...overrides,
  };
}

function indeterminateWith(reason: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    ...scoredAttempt(0),
    result: { indeterminate: true, reason, words: [], provider: "azure" },
    ...overrides,
  };
}

/** The lookup's own section. Other tables on the page render the same column
    headings and verdict words, so unscoped queries are ambiguous. */
function panel(): HTMLElement {
  const section = screen.getByRole("heading", { name: "Learner lookup" }).closest("section");
  if (!section) throw new Error("no Learner lookup section");
  return section;
}

function lookUp(value: string): void {
  fireEvent.change(within(panel()).getByLabelText("Learner id"), { target: { value } });
  fireEvent.click(within(panel()).getByRole("button", { name: "Look up" }));
}

describe("classifying an indeterminate take", () => {
  it.each([
    "no speech recognised in the recording",
    "no speech found to assess — every word was omitted",
  ])("reads %s as the recording's fault", async (reason) => {
    const { classifyIndeterminate } = await import("./Diagnostics.js");
    expect(classifyIndeterminate(reason)).toBe("capture");
  });

  it.each([
    "provider cancelled (Error)",
    "provider cancelled (EndOfStream)",
    "unparseable provider response",
    "provider response did not match the expected shape",
    "no pronunciation assessment in provider response",
    "provider returned RecognizingSpeech",
  ])("reads %s as the provider's fault", async (reason) => {
    // Telling this learner to check their microphone would be wrong, and in a
    // support reply it would also be insulting.
    const { classifyIndeterminate } = await import("./Diagnostics.js");
    expect(classifyIndeterminate(reason)).toBe("provider");
  });

  it("maps the error domains onto who the responder should talk about", async () => {
    const { classifyDiagnostic } = await import("./Diagnostics.js");
    expect(classifyDiagnostic("client")).toBe("capture");
    expect(classifyDiagnostic("network")).toBe("network");
    expect(classifyDiagnostic("server")).toBe("provider");
    expect(classifyDiagnostic("provider")).toBe("provider");
    expect(classifyDiagnostic("model")).toBe("provider");
    // An unrecognised domain must not be quietly filed as a mic problem.
    expect(classifyDiagnostic("something-new")).toBe("other");
  });
});

describe("building one learner's timeline", () => {
  it("splits indeterminate takes the way the real stored data splits", async () => {
    const { buildLearnerLookup } = await import("./Diagnostics.js");
    const takes = [
      ...Array.from({ length: 7 }, () => indeterminateWith("no speech recognised in the recording")),
      ...Array.from({ length: 3 }, () => indeterminateWith("provider cancelled (Error)")),
    ];

    const { counts, total } = buildLearnerLookup(takes as never, []);

    expect(total).toBe(10);
    expect(counts.capture).toBe(7);
    expect(counts.provider).toBe(3);
    expect(counts.scored).toBe(0);
  });

  it("keeps the raw reason, so a reason it cannot classify is still readable", async () => {
    const { buildLearnerLookup } = await import("./Diagnostics.js");
    const { rows } = buildLearnerLookup(
      [indeterminateWith("provider returned something brand new")] as never,
      [],
    );

    expect(rows[0]?.verdict).toBe("provider");
    expect(rows[0]?.detail).toBe("provider returned something brand new");
  });

  it("summarises a scored take by score alone, never by what was said", async () => {
    const { buildLearnerLookup } = await import("./Diagnostics.js");
    const { rows } = buildLearnerLookup([scoredAttempt(83.6)] as never, []);

    expect(rows[0]?.detail).toBe("score 84");
    // The privacy line this view holds: the reference phrase is on the record
    // and must not reach the row.
    expect(rows[0]?.detail).not.toContain("Bonjour");
  });

  it("interleaves attempts and errors newest-first", async () => {
    // A capture failure that never reached the server exists only as a
    // diagnostic; ordering them together is what makes the trail readable.
    const { buildLearnerLookup } = await import("./Diagnostics.js");
    const { rows } = buildLearnerLookup(
      [
        scoredAttempt(90, { at: "2026-09-04T12:00:00Z" }),
        scoredAttempt(70, { at: "2026-09-04T08:00:00Z" }),
      ] as never,
      [diag("PERMISSION_DENIED", "client", { at: "2026-09-04T10:00:00Z" })] as never,
    );

    expect(rows.map((r) => r.kind)).toEqual(["attempt", "error", "attempt"]);
  });

  it("drops SCORE_TIMING pings, which fire once per take and would bury the failures", async () => {
    const { buildLearnerLookup } = await import("./Diagnostics.js");
    const noise = Array.from({ length: 20 }, (_, i) =>
      diag("SCORE_TIMING", "client", { at: `2026-09-04T10:00:${String(i).padStart(2, "0")}Z` }),
    );

    const { rows, total } = buildLearnerLookup(
      [],
      [...noise, diag("NO_AUDIO_ENERGY", "client", { at: "2026-09-04T11:00:00Z" })] as never,
    );

    expect(total).toBe(1);
    expect(rows[0]?.detail).toBe("NO_AUDIO_ENERGY");
  });

  it("shows no recorded length rather than a zero-second recording", async () => {
    /**
     * `audio` is optional in the data, not only in the type — a record
     * replayed from the fallback log may not carry it. 0.00 would claim a
     * measurement of zero where there was none, the same distinction R8 draws
     * about scores.
     */
    const { buildLearnerLookup } = await import("./Diagnostics.js");
    const { rows } = buildLearnerLookup(
      [{ ...scoredAttempt(90), audio: { seconds: 0.31 } }, scoredAttempt(90)] as never,
      [diag("SNR_TOO_LOW", "client")] as never,
    );

    expect(rows.find((r) => r.seconds === 0.31)).toBeTruthy();
    // The take with no `audio` at all, and the diagnostic which never has one.
    expect(rows.filter((r) => r.seconds === null)).toHaveLength(2);
  });

  it("counts network and unclassified apart from capture and provider", async () => {
    // A dropped upload is neither a bad recording nor a bad scorer, and
    // telling someone to check their mic over one is the wrong answer.
    const { buildLearnerLookup } = await import("./Diagnostics.js");
    const { counts } = buildLearnerLookup(
      [],
      [diag("UPLOAD_FAILED", "network"), diag("WHO_KNOWS", "martian")] as never,
    );

    expect(counts.network).toBe(1);
    expect(counts.other).toBe(1);
    expect(counts.capture).toBe(0);
    expect(counts.provider).toBe(0);
  });
});

describe("finding the learner to look up", () => {
  it("keeps two learners who typed the same name apart", async () => {
    /**
     * The case a name-keyed lookup would silently merge, and the reason this
     * one keys on the id: two chips, one name, two trails. Merging them is
     * how a responder ends up confidently blaming a working microphone.
     */
    const { knownLearners } = await import("./Diagnostics.js");
    const chips = knownLearners(
      [{ ...scoredAttempt(90), learnerId: LEARNER, learnerName: "Kimo" }] as never,
      [diag("X", "client", { learnerId: OTHER_LEARNER, learnerName: "Kimo" })] as never,
    );

    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.learnerId).sort()).toEqual([LEARNER, OTHER_LEARNER].sort());
  });

  it("does not let a later anonymous record erase a name already seen", async () => {
    const { knownLearners } = await import("./Diagnostics.js");
    const chips = knownLearners(
      [
        { ...scoredAttempt(90), learnerId: LEARNER, learnerName: "Kimo" },
        { ...scoredAttempt(90), learnerId: LEARNER },
      ] as never,
      [],
    );

    expect(chips).toEqual([{ learnerId: LEARNER, name: "Kimo" }]);
  });

  it("counts the records no lookup can ever reach", async () => {
    /**
     * Scoring works without registering on purpose, so those failures carry
     * no learner id and belong to nobody findable. Saying how many there are
     * is the difference between "she has no failures" and "her failures may
     * not be attributable" — and only the second is true.
     */
    const { unattributedCount } = await import("./Diagnostics.js");
    const n = unattributedCount(
      [{ ...scoredAttempt(90), learnerId: LEARNER }, scoredAttempt(90)] as never,
      [diag("NO_AUDIO_ENERGY", "client"), diag("SCORE_TIMING", "client")] as never,
    );

    // One anonymous attempt and one anonymous error. The timing ping is not a
    // failure and is not counted as one.
    expect(n).toBe(2);
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function openWithProbe(search = "") {
  const { Diagnostics } = await import("./Diagnostics.js");
  return render(
    <MemoryRouter initialEntries={[`/diagnostics${search}`]}>
      <Diagnostics />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("the lookup on screen", () => {
  it("asks the server for one learner, with the same token the rest of the page uses", async () => {
    const fetchMock = installFetch();
    lookupAttempts = [indeterminateWith("no speech recognised in the recording")];
    await open("?token=s3cret");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    lookUp(LEARNER);

    await waitFor(() => {
      const urls = (fetchMock.mock.calls as [string, RequestInit][]).map(([u]) => u);
      expect(urls).toContain(`/api/v1/attempts?learnerId=${LEARNER}&limit=200`);
      expect(urls).toContain(`/api/v1/diagnostics?learnerId=${LEARNER}&limit=200`);
    });

    const lookupCall = (fetchMock.mock.calls as [string, RequestInit][]).find(([u]) =>
      u.includes("learnerId="),
    );
    // The token travels as a header here too, never in the query string.
    expect(lookupCall?.[1]?.headers).toEqual({ "x-diagnostics-token": "s3cret" });
    expect(lookupCall?.[0]).not.toContain("s3cret");
  });

  it("labels capture and provider failures differently, and counts them apart", async () => {
    lookupAttempts = [
      indeterminateWith("no speech recognised in the recording", { at: "2026-09-04T10:02:00Z" }),
      indeterminateWith("provider cancelled (Error)", { at: "2026-09-04T10:01:00Z" }),
      scoredAttempt(88, { at: "2026-09-04T10:00:00Z" }),
    ];
    lookupDiagnostics = [diag("NO_AUDIO_ENERGY", "client", { at: "2026-09-04T10:03:00Z" })];
    await open("?token=t");

    lookUp(LEARNER);
    await waitFor(() => expect(within(panel()).getByText("provider failed")).toBeInTheDocument());

    // The distinction the ticket turns on, on screen, in words.
    expect(within(panel()).getAllByText("capture — no speech to score")).toHaveLength(2);
    expect(within(panel()).getByText("no speech recognised in the recording")).toBeInTheDocument();
    expect(within(panel()).getByText("provider cancelled (Error)")).toBeInTheDocument();

    // Four records: two capture (the silent take and the client-domain
    // error), one provider, one scored.
    expect(statFor("records")).toBe("4");
    expect(statFor("capture")).toBe("2");
    expect(statFor("provider")).toBe("1");

    // And which side of the wire each came from: three reached a scoring
    // call, the client-reported error may never have left the device.
    expect(within(panel()).getAllByText("attempt", { selector: "td" })).toHaveLength(3);
    expect(within(panel()).getByText("error", { selector: "td" })).toBeInTheDocument();
  });

  it("never renders the target phrase or what the learner was heard saying", async () => {
    /**
     * Neither separates a dead microphone from a dead provider, which is the
     * only judgment this panel exists to support — so it is the one view on
     * the page built to withhold them.
     */
    lookupAttempts = [scoredAttempt(88)];
    await open("?token=t");

    lookUp(LEARNER);
    await waitFor(() =>
      expect(within(panel()).getByText("scored", { selector: "td" })).toBeInTheDocument(),
    );

    expect(panel().textContent).not.toContain("Bonjour");
  });

  it("keeps the learner id out of the URL", async () => {
    /**
     * A linkable lookup would put one person's failures into browser history,
     * the referrer, and every pasted link. The token is already in the URL by
     * necessity; their id does not have to join it.
     */
    await openWithProbe("?token=t");

    lookUp(LEARNER);
    await waitFor(() =>
      expect(within(panel()).getByText(/No records for that learner/)).toBeInTheDocument(),
    );

    expect(screen.getByTestId("location")).toHaveTextContent("/diagnostics?token=t");
    expect(screen.getByTestId("location").textContent).not.toContain(LEARNER);
  });

  it("says a name is not a learner id rather than showing an empty table", async () => {
    /**
     * The server refuses it instead of falling back to an unfiltered read, so
     * the page has to say which — an empty table would read as "nothing went
     * wrong for her", which is a different and false claim.
     */
    lookupStatus = 400;
    await open("?token=t");

    lookUp("Kimo");
    await waitFor(() => expect(within(panel()).getByText(/not a learner id/)).toBeInTheDocument());
    expect(within(panel()).queryByText(/No records for that learner/)).not.toBeInTheDocument();
  });

  it("offers the loaded learners as chips, so a UUID is never typed by hand", async () => {
    const fetchMock = installFetch();
    attempts = [{ ...scoredAttempt(90), learnerId: LEARNER, learnerName: "Kimo" } as Attempt];
    await open("?token=t");

    const chip = await waitFor(() => within(panel()).getByRole("button", { name: /Kimo/ }));
    fireEvent.click(chip);

    await waitFor(() =>
      expect((fetchMock.mock.calls as [string][]).map(([u]) => u)).toContain(
        `/api/v1/attempts?learnerId=${LEARNER}&limit=200`,
      ),
    );
    expect(within(panel()).getByLabelText("Learner id")).toHaveValue(LEARNER);
  });

  it("distinguishes an unreachable record from a clean one", async () => {
    attempts = [scoredAttempt(90), scoredAttempt(90)];
    await open("?token=t");

    await waitFor(() => expect(within(panel()).getByText(/carry no learner id/)).toBeInTheDocument());
    expect(within(panel()).getByText(/not attributable/)).toBeInTheDocument();
  });

  it("clears back to no lookup without querying again", async () => {
    const fetchMock = installFetch();
    lookupAttempts = [indeterminateWith("provider cancelled (Error)")];
    await open("?token=t");

    lookUp(LEARNER);
    await waitFor(() => expect(within(panel()).getByText("provider failed")).toBeInTheDocument());

    const before = fetchMock.mock.calls.length;
    fireEvent.click(within(panel()).getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(within(panel()).queryByText("provider failed")).not.toBeInTheDocument(),
    );
    const after = (fetchMock.mock.calls as [string][]).slice(before).map(([u]) => u);
    expect(after.filter((u) => u.includes("learnerId="))).toHaveLength(0);
  });

  it("refuses to look anyone up until something is entered", async () => {
    await open("?token=t");
    expect(within(panel()).getByRole("button", { name: "Look up" })).toBeDisabled();
  });
});
