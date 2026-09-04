/**
 * The spend ceiling that survives a caller changing IP, and the one file that
 * knows a vendor name.
 *
 * The per-IP rate limiter bounds abuse from a single caller. This one bounds
 * total spend regardless of how many addresses a caller spreads across, which
 * is the only ceiling that actually caps a bill. It is in-process state, so
 * nothing about it is observable from outside — the count, the window and the
 * reset are all invisible until the day the cap either fires or fails to.
 *
 * Two off-by-one questions decide whether it works: whether the Nth call is
 * allowed, and whether the count is incremented before or after the provider
 * is called. Getting the second wrong means a provider that always throws
 * never advances the counter, so a broken provider can be called forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const score = vi.fn(() => Promise.resolve({ accuracy: 88 }));

vi.mock("./azureSpeech.js", () => ({
  AzureSpeechProvider: class {
    name = "azure";
    score(...args: unknown[]) {
      return score(...(args as []));
    }
  },
}));
vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const SAVED = {
  provider: process.env.PRONUNCIATION_PROVIDER,
  cap: process.env.MAX_DAILY_SCORING_CALLS,
};

function restore(key: string, value: string | undefined): void {
  // Deleted, never assigned undefined — that stores the string "undefined".
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** A fresh module, since the cap and the cache are both module-scoped. */
async function load(env: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(env)) restore(k, v);
  vi.resetModules();
  return import("./index.js");
}

const WAV = Buffer.from([1, 2, 3]);

async function call(provider: { score: (w: Buffer, r: string, l: string) => Promise<unknown> }) {
  return provider.score(WAV, "Bonjour", "fr-FR");
}

beforeEach(() => {
  vi.clearAllMocks();
  score.mockResolvedValue({ accuracy: 88 });
});

afterEach(() => {
  restore("PRONUNCIATION_PROVIDER", SAVED.provider);
  restore("MAX_DAILY_SCORING_CALLS", SAVED.cap);
  vi.useRealTimers();
});

describe("provider selection — R12", () => {
  it("returns the Azure provider by default", async () => {
    const { getScoringProvider } = await load({ PRONUNCIATION_PROVIDER: undefined });

    expect(getScoringProvider().name).toBe("azure");
  });

  it("caches the provider rather than rebuilding it per request", async () => {
    /**
     * Not a micro-optimisation: the cap's counter lives in the closure
     * `withDailyCap` creates. A new provider per request means a new counter
     * per request, and the ceiling would never be reached no matter how many
     * calls arrived.
     */
    const { getScoringProvider } = await load();

    expect(getScoringProvider()).toBe(getScoringProvider());
  });

  it("refuses an unknown provider with a typed, misconfiguration error", async () => {
    // Blaming the server rather than the client, because that is who can fix
    // it — and a learner gets told scoring is unavailable, not why.
    const { getScoringProvider } = await load({ PRONUNCIATION_PROVIDER: "speechace" });

    expect(() => getScoringProvider()).toThrowError(
      expect.objectContaining({ code: "MISCONFIGURED", domain: "server" }) as Error,
    );
  });

  it("does not leak the provider name into the learner-facing message", async () => {
    // The internal message carries it for logs; the user message must not.
    const { getScoringProvider } = await load({ PRONUNCIATION_PROVIDER: "nonsense" });

    try {
      getScoringProvider();
      throw new Error("expected a throw");
    } catch (err) {
      const typed = err as { message: string; userMessage: string };
      expect(typed.message).toContain("nonsense");
      expect(typed.userMessage).not.toContain("nonsense");
    }
  });

  it("wraps the provider rather than replacing it", async () => {
    // The cap belongs outside the vendor file: it caps "scoring calls", not
    // Azure specifically, so it stays correct when a second provider arrives.
    const { getScoringProvider } = await load();

    await call(getScoringProvider());

    expect(score).toHaveBeenCalledWith(WAV, "Bonjour", "fr-FR");
  });
});

describe("the daily cap", () => {
  it("allows exactly the configured number of calls", async () => {
    // The off-by-one that decides whether a cap of 3 means three calls or two.
    const { getScoringProvider } = await load({ MAX_DAILY_SCORING_CALLS: "3" });
    const provider = getScoringProvider();

    await call(provider);
    await call(provider);
    await call(provider);

    expect(score).toHaveBeenCalledTimes(3);
  });

  it("refuses the call past the ceiling", async () => {
    const { getScoringProvider } = await load({ MAX_DAILY_SCORING_CALLS: "3" });
    const provider = getScoringProvider();
    for (let i = 0; i < 3; i++) await call(provider);

    await expect(call(provider)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      domain: "server",
    });
  });

  it("does not reach the provider once the ceiling is hit", async () => {
    // A cap that refused the caller but still spent the money would be worse
    // than no cap, because it would look like it was working.
    const { getScoringProvider } = await load({ MAX_DAILY_SCORING_CALLS: "2" });
    const provider = getScoringProvider();
    for (let i = 0; i < 2; i++) await call(provider);

    await call(provider).catch(() => undefined);

    expect(score).toHaveBeenCalledTimes(2);
  });

  it("keeps refusing rather than letting the next call through", async () => {
    const { getScoringProvider } = await load({ MAX_DAILY_SCORING_CALLS: "1" });
    const provider = getScoringProvider();
    await call(provider);

    for (let i = 0; i < 5; i++) await expect(call(provider)).rejects.toThrow();

    expect(score).toHaveBeenCalledTimes(1);
  });

  it("tells the learner to come back tomorrow, which is the actual remedy", async () => {
    // Not "try again" — retrying cannot succeed until the window rolls.
    const { getScoringProvider } = await load({ MAX_DAILY_SCORING_CALLS: "1" });
    const provider = getScoringProvider();
    await call(provider);

    await expect(call(provider)).rejects.toMatchObject({
      userMessage: expect.stringContaining("tomorrow") as unknown as string,
    });
  });

  it("counts a call whose provider then failed", async () => {
    /**
     * The increment happens before the provider is called, and it has to: a
     * provider that always throws would otherwise never advance the counter,
     * so a broken vendor could be called an unlimited number of times — and
     * a failed provider call is often still a billable request.
     */
    const { getScoringProvider } = await load({ MAX_DAILY_SCORING_CALLS: "2" });
    const provider = getScoringProvider();
    score.mockRejectedValue(new Error("azure down"));

    await call(provider).catch(() => undefined);
    await call(provider).catch(() => undefined);

    await expect(call(provider)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("defaults to exactly 2000 when unconfigured", async () => {
    /**
     * Unset must not mean unlimited — which is what an env read of NaN used to
     * produce, see server/env.ts. Driven to the actual boundary rather than
     * asserted against a constant restated in the test, because a restated
     * constant proves only that two files agree about a number.
     */
    const { getScoringProvider } = await load({ MAX_DAILY_SCORING_CALLS: undefined });
    const provider = getScoringProvider();

    for (let i = 0; i < 2000; i++) await call(provider);

    expect(score).toHaveBeenCalledTimes(2000);
    await expect(call(provider)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("is not disabled by a malformed setting", async () => {
    // `Number("lots")` is NaN, and `count >= NaN` is false — the ceiling used
    // to vanish entirely on a typo. Driven to the default's boundary, so
    // "the cap still exists" is a demonstration and not a hope.
    const { getScoringProvider } = await load({ MAX_DAILY_SCORING_CALLS: "lots" });
    const provider = getScoringProvider();

    for (let i = 0; i < 2000; i++) await call(provider);

    await expect(call(provider)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("the daily window", () => {
  it("resets when the UTC day rolls over", async () => {
    /**
     * The reset is computed from the clock on each call rather than scheduled,
     * so it survives a process that was asleep across midnight — a timer would
     * not, and the cap would stay closed into the next day.
     */
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T23:59:00Z"));
    const { getScoringProvider } = await load({ MAX_DAILY_SCORING_CALLS: "1" });
    const provider = getScoringProvider();
    await call(provider);
    await expect(call(provider)).rejects.toThrow();

    vi.setSystemTime(new Date("2026-09-05T00:01:00Z"));

    await expect(call(provider)).resolves.toBeDefined();
  });

  it("does not reset merely because hours passed inside one UTC day", async () => {
    // A rolling 24-hour window would let a caller spend twice the cap by
    // straddling the boundary; the day is a fixed bucket on purpose.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T01:00:00Z"));
    const { getScoringProvider } = await load({ MAX_DAILY_SCORING_CALLS: "1" });
    const provider = getScoringProvider();
    await call(provider);

    vi.setSystemTime(new Date("2026-09-04T22:00:00Z"));

    await expect(call(provider)).rejects.toThrow();
  });

  it("uses UTC rather than local time, so the reset is not machine-dependent", async () => {
    /**
     * A local-midnight reset would put the window in a different place on a
     * developer's laptop than on a server, and the spend report reads the same
     * boundary — the dashboard and the enforcement have to agree about which
     * day it is.
     */
    vi.useFakeTimers();
    // 20:00 in Kolkata on the 5th is 14:30 UTC on the 5th; both are the same
    // UTC day, so a call at each must share a bucket.
    vi.setSystemTime(new Date("2026-09-05T14:30:00Z"));
    const { getScoringProvider } = await load({ MAX_DAILY_SCORING_CALLS: "1" });
    const provider = getScoringProvider();
    await call(provider);

    vi.setSystemTime(new Date("2026-09-05T23:30:00Z"));

    await expect(call(provider)).rejects.toThrow();
  });
});
