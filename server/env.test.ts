/**
 * The guard that stops a typo from removing a guard.
 *
 * Every numeric setting here used to be `Number(process.env.X ?? default)`,
 * which is right for an unset variable and silently catastrophic for a
 * malformed one, because `Number("fifteen")` is NaN and every comparison
 * against NaN is false. The consequence is not an error — it is the removal of
 * whatever the number was protecting, on a server with no authentication in
 * front of it:
 *
 *   MAX_DAILY_SCORING_CALLS  ->  `count >= NaN` false  ->  no spend cap at all
 *   MAX_AUDIO_SECONDS        ->  duration gate passes anything
 *   (multer) fileSize        ->  no ceiling on an in-memory upload
 *   RETENTION_DAYS           ->  a TTL index of NaN seconds
 *
 * The last group below is the point of the whole file: it drives each of those
 * call sites with a deliberately broken value and asserts the documented
 * default is what is actually in force.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { numberFromEnv, optionalNumberFromEnv } from "./env.js";
import { logger } from "./logger.js";

const KEY = "SONARE_TEST_SETTING";
const ORIGINAL = process.env[KEY];

function set(value: string | undefined): void {
  // Assigned by deletion, never `= undefined`: that stores the *string*
  // "undefined", which is truthy and would poison the next case.
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
}

beforeEach(() => {
  set(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[KEY];
  else process.env[KEY] = ORIGINAL;
  vi.restoreAllMocks();
});

describe("numberFromEnv", () => {
  it("uses a value that is actually a number", () => {
    set("42");

    expect(numberFromEnv(KEY, 15)).toBe(42);
  });

  it("uses the default when unset, which is the normal case", () => {
    expect(numberFromEnv(KEY, 15)).toBe(15);
  });

  it("refuses a value that is not a number, rather than yielding NaN", () => {
    // The whole reason this function exists.
    for (const bad of ["fifteen", "15s", "abc", "1,000", "--5", "Infinity"]) {
      set(bad);

      expect(numberFromEnv(KEY, 15), bad).toBe(15);
    }
  });

  it("refuses an empty or whitespace value", () => {
    // `MAX_AUDIO_SECONDS=` in a .env file. `Number("")` is 0, which under the
    // old code made the byte ceiling 1024 — every upload rejected, which is
    // fail-closed but still broken.
    for (const blank of ["", "   ", "\t"]) {
      set(blank);

      expect(numberFromEnv(KEY, 15), JSON.stringify(blank)).toBe(15);
    }
  });

  it("refuses zero and negatives, since every setting here is a positive bound", () => {
    for (const bad of ["0", "-1", "-0.5"]) {
      set(bad);

      expect(numberFromEnv(KEY, 15), bad).toBe(15);
    }
  });

  it("accepts a fraction where one is meaningful", () => {
    // MIN_AUDIO_SECONDS is 0.25.
    set("0.25");

    expect(numberFromEnv(KEY, 1)).toBe(0.25);
  });

  it("refuses a fraction where a whole number is required", () => {
    // A cap of 2000.5 calls, or a TTL of 90.5 days, is a value somebody
    // mistyped rather than meant.
    set("2000.5");

    expect(numberFromEnv(KEY, 2000, { integer: true })).toBe(2000);
  });

  it("refuses a value above an explicit ceiling", () => {
    /**
     * An absurd setting is as dangerous as a missing one: MAX_AUDIO_SECONDS of
     * 999999 makes the derived byte limit ~32 GB, which is not a ceiling on an
     * in-memory upload in any useful sense.
     */
    set("999999");

    expect(numberFromEnv(KEY, 15, { max: 600 })).toBe(15);
  });

  it("accepts a value exactly on the boundaries", () => {
    // Off-by-one at a documented limit would make the documented limit
    // unusable.
    set("600");
    expect(numberFromEnv(KEY, 15, { max: 600 })).toBe(600);
    set("1");
    expect(numberFromEnv(KEY, 15, { min: 1, max: 600 })).toBe(1);
  });

  it("warns when it rejects something an operator wrote on purpose", () => {
    /**
     * Refusing quietly would be its own trap: an operator who mistyped a limit
     * would go on believing the limit they wrote is the limit in force, and
     * the only later signal is the bill. So the warning has to name the
     * setting, echo what was provided, and say what is actually being used.
     */
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    set("fifteen");

    numberFromEnv(KEY, 15);

    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(context).toMatchObject({ setting: KEY, provided: "fifteen", using: 15 });
    expect(message).toContain("NOT in force");
  });

  it("does not warn for an unset variable", () => {
    // That is the documented default path, not a mistake, and warning on it
    // would train operators to ignore the warning that matters.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    numberFromEnv(KEY, 15);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("optionalNumberFromEnv", () => {
  it("returns the rate when it is readable", () => {
    set("1.30");

    expect(optionalNumberFromEnv(KEY)).toBe(1.3);
  });

  it("returns null when unset", () => {
    expect(optionalNumberFromEnv(KEY)).toBeNull();
  });

  it("returns null rather than NaN for an unreadable rate", () => {
    /**
     * spend.ts's own stated principle: a wrong rate shown as money is worse
     * than no money, because nobody re-checks a number that looks
     * authoritative. NaN would render as a cost — arithmetic on it produces
     * NaN all the way to the dashboard.
     */
    for (const bad of ["one dollar", "$1.00", "1.00USD", ""]) {
      set(bad);

      expect(optionalNumberFromEnv(KEY), bad).toBeNull();
    }
  });

  it("accepts a rate of zero, which is a real answer", () => {
    // A committed tier can genuinely make marginal cost zero. Distinct from
    // "unknown", so it must not be coerced to null.
    set("0");

    expect(optionalNumberFromEnv(KEY)).toBe(0);
  });

  it("returns null for a negative rate", () => {
    set("-1");

    expect(optionalNumberFromEnv(KEY)).toBeNull();
  });
});

describe("each call site now fails closed", () => {
  /**
   * Drives the real modules with a deliberately broken value. Before this
   * change every one of these produced NaN and removed the limit it names.
   */
  const BROKEN = "fifteen";

  async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
      saved.set(k, process.env[k]);
      process.env[k] = v;
    }
    vi.resetModules();
    try {
      return await fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      vi.resetModules();
    }
  }

  // The byte ceiling and the duration gate are proved end to end where a
  // request can actually be refused: upload.test.ts drives a real oversize
  // upload under a broken MAX_AUDIO_SECONDS. Asserting `typeof x ===
  // "function"` here instead would have been a test that cannot fail.

  it("the reported cap is a number rather than NaN", async () => {
    await withEnv({ MAX_DAILY_SCORING_CALLS: BROKEN }, async () => {
      vi.doMock("./db.js", () => ({
        getDb: () =>
          Promise.resolve({
            collection: () => ({ aggregate: () => ({ toArray: () => Promise.resolve([]) }) }),
          }),
      }));
      const { getSpendReport } = await import("./spend.js");

      const report = await getSpendReport();

      expect(report.dailyCallCap).toBe(2000);
      expect(Number.isNaN(report.dailyCallCap)).toBe(false);
      expect(Number.isNaN(report.capUsedFraction)).toBe(false);
    });
  });

  it("an unreadable rate reports usage without inventing a cost", async () => {
    await withEnv({ AZURE_SPEECH_RATE_PER_AUDIO_HOUR: "one dollar" }, async () => {
      vi.doMock("./db.js", () => ({
        getDb: () =>
          Promise.resolve({
            collection: () => ({
              aggregate: () => ({
                toArray: () =>
                  Promise.resolve([{ allTime: [{ calls: 10, billableSeconds: 40 }], today: [{ calls: 10 }] }]),
              }),
            }),
          }),
      }));
      const { getSpendReport } = await import("./spend.js");

      const report = await getSpendReport();

      expect(report.rate.perAudioHour).toBeNull();
      expect(report.allTime.cost).toBeNull();
      // Usage stays exact — it never depended on knowing the price.
      expect(report.allTime.billableSeconds).toBe(40);
    });
  });
});
