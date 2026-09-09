/**
 * The model voice's daily spend ceiling.
 *
 * A second paid provider needs a second cap, and the two properties that make
 * one an actual ceiling rather than a decoration are the same two
 * `reserveScoringCall` is held to: it cannot be exceeded by concurrent
 * callers, and it **refuses** rather than allows when the store is
 * unreachable. A ceiling that disappears when the system is unhealthy is not a
 * ceiling.
 *
 * Two things here are specific to this counter rather than inherited.
 *
 * **It counts characters, not calls.** That is how ElevenLabs bills, and a
 * call count would be the wrong unit by an order of magnitude between a
 * two-word greeting and a fourteen-word sentence. Counting in the provider's
 * unit is what lets the cap mean something in money.
 *
 * **It is a separate document from `spend:`.** Sharing one would let a day of
 * generating audio consume the allowance for scoring learner attempts, which
 * is the thing learners are actually here for. The test for that is at the
 * bottom and it is the one that would fail if somebody "simplified" the two
 * counters into one.
 *
 * `getDb` is a small in-memory stand-in reproducing the two Mongo behaviours
 * the design depends on: a conditional `findOneAndUpdate` with `upsert`, and
 * the duplicate-key collision that happens when the filter matches nothing but
 * the `_id` already exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Doc {
  _id: string;
  day?: string;
  characters?: number;
  phrases?: number;
  calls?: number;
  expiresAt?: Date;
}

let store: Map<string, Doc>;
let failWith: Error | null = null;

function duplicateKeyError(): Error & { code: number } {
  const err = new Error("E11000 duplicate key error") as Error & { code: number };
  err.code = 11000;
  return err;
}

/** Applies a $inc/$setOnInsert update the way Mongo would. */
function applyUpdate(existing: Doc | undefined, id: string, update: Record<string, Record<string, unknown>>): Doc {
  const inc = update["$inc"] ?? {};
  const onInsert = update["$setOnInsert"] ?? {};
  const base: Record<string, unknown> = existing ? { ...existing } : { _id: id, ...onInsert };
  for (const [k, v] of Object.entries(inc)) {
    base[k] = ((base[k] as number) ?? 0) + (v as number);
  }
  return base as unknown as Doc;
}

vi.mock("./db.js", () => ({
  getDb: () => {
    if (failWith) return Promise.reject(failWith);
    return Promise.resolve({
      collection: () => ({
        createIndex: () => Promise.resolve("ok"),
        findOne: (filter: { _id: string }) => Promise.resolve(store.get(filter._id) ?? null),
        findOneAndUpdate: (
          filter: { _id: string; characters?: { $lte: number }; calls?: { $lt: number } },
          update: Record<string, Record<string, unknown>>,
          options: { upsert?: boolean },
        ) => {
          const existing = store.get(filter._id);
          const capOk =
            filter.characters === undefined || (existing?.characters ?? 0) <= filter.characters.$lte;

          if (existing !== undefined && !capOk) {
            // The filter matched nothing and `_id` is taken — exactly the
            // collision the real driver raises on an upsert here.
            if (options.upsert === true) return Promise.reject(duplicateKeyError());
            return Promise.resolve(null);
          }
          if (existing === undefined && !capOk && options.upsert !== true) {
            return Promise.resolve(null);
          }

          const next = applyUpdate(existing, filter._id, update);
          store.set(filter._id, next);
          return Promise.resolve(next);
        },
        updateOne: (
          filter: { _id: string },
          update: Record<string, Record<string, unknown>>,
        ) => {
          store.set(filter._id, applyUpdate(store.get(filter._id), filter._id, update));
          return Promise.resolve({ acknowledged: true });
        },
      }),
    });
  },
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const AT = new Date("2026-09-09T13:00:00.000Z");

async function load() {
  vi.resetModules();
  return import("./counters.js");
}

beforeEach(() => {
  store = new Map();
  failWith = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reserving synthesis characters", () => {
  it("allows a reservation inside the cap and reports the running total", async () => {
    const { reserveSynthesisCharacters } = await load();

    const first = await reserveSynthesisCharacters(100, 30, AT);
    const second = await reserveSynthesisCharacters(100, 30, AT);

    expect(first).toEqual({ allowed: true, characters: 30 });
    expect(second).toEqual({ allowed: true, characters: 60 });
  });

  it("refuses the reservation that would cross the cap, not the one that reaches it", async () => {
    /**
     * The boundary is where an off-by-one lives, and here it decides whether
     * the last phrase of a run is generated or silently skipped. Reaching
     * exactly the cap is allowed; the next character is not.
     */
    const { reserveSynthesisCharacters } = await load();

    expect(await reserveSynthesisCharacters(100, 100, AT)).toEqual({ allowed: true, characters: 100 });
    expect(await reserveSynthesisCharacters(100, 1, AT)).toEqual({
      allowed: false,
      reason: "at-cap",
      characters: 100,
    });
  });

  it("cannot be exceeded by concurrent callers", async () => {
    /**
     * Increment-and-check rather than check-then-increment. The second has a
     * race in which two runs both read `cap - 1` and both proceed; the
     * conditional filter plus `$inc` is one operation, so the total can never
     * pass the cap however many callers arrive at once.
     */
    const { reserveSynthesisCharacters } = await load();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveSynthesisCharacters(50, 10, AT)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(store.get("voice:2026-09-09")?.characters).toBe(50);
  });

  it("refuses a phrase larger than the whole cap rather than clamping it", async () => {
    // A partial phrase is not a phrase. Clamping would spend the entire
    // allowance to produce a recording that stops mid-sentence.
    const { reserveSynthesisCharacters } = await load();

    expect(await reserveSynthesisCharacters(10, 500, AT)).toEqual({
      allowed: false,
      reason: "at-cap",
      characters: 10,
    });
    expect(store.size).toBe(0);
  });

  it("refuses everything at a cap of zero", async () => {
    /**
     * Checked before the query, because an upsert against a filter nothing can
     * satisfy would otherwise insert a first reservation and allow it — the
     * exact hole `reserveScoringCall` documents for a cap of zero.
     */
    const { reserveSynthesisCharacters } = await load();

    expect(await reserveSynthesisCharacters(0, 1, AT)).toEqual({
      allowed: false,
      reason: "at-cap",
      characters: 0,
    });
    expect(store.size).toBe(0);
  });

  it("refuses a cap that is not a number", async () => {
    // `characters > NaN` is false, so an unusable cap read straight through
    // would remove the ceiling rather than raise it.
    const { reserveSynthesisCharacters } = await load();

    expect((await reserveSynthesisCharacters(Number.NaN, 10, AT)).allowed).toBe(false);
  });

  it("refuses a request for nothing", async () => {
    const { reserveSynthesisCharacters } = await load();

    expect((await reserveSynthesisCharacters(100, 0, AT)).allowed).toBe(false);
    expect((await reserveSynthesisCharacters(100, -5, AT)).allowed).toBe(false);
    expect(store.size).toBe(0);
  });

  it("fails closed when the counter cannot be reached", async () => {
    /**
     * The whole point. A cap that vanishes during an outage is not a cap, and
     * the cost of being wrong in this direction is a generation run that has
     * to be repeated — while the cost in the other direction is an unbounded
     * bill on a paid API.
     *
     * Note this is deliberately *stricter* than scoring, which keeps an
     * in-process ceiling for outages: refusing to score turns a database
     * outage into a product outage for a learner mid-attempt, and refusing to
     * generate audio costs a background run nobody is waiting on.
     */
    const { reserveSynthesisCharacters } = await load();
    failWith = new Error("no connection");

    expect(await reserveSynthesisCharacters(1000, 10, AT)).toEqual({
      allowed: false,
      reason: "unavailable",
      characters: null,
    });
  });

  it("reads a duplicate key as being at the cap, not as an error", async () => {
    /**
     * The upsert is what makes the collision meaningful: when the document
     * exists but the day's total is already too high, the filter matches
     * nothing, so Mongo tries to *insert* and collides with the `_id` already
     * there. That is "we are at the cap" arriving as an exception.
     */
    const { reserveSynthesisCharacters } = await load();
    store.set("voice:2026-09-09", { _id: "voice:2026-09-09", characters: 999 });

    expect(await reserveSynthesisCharacters(1000, 500, AT)).toEqual({
      allowed: false,
      reason: "at-cap",
      characters: 1000,
    });
  });

  it("rolls at midnight UTC, because that is how the provider bills", async () => {
    const { reserveSynthesisCharacters } = await load();

    await reserveSynthesisCharacters(50, 50, new Date("2026-09-09T23:59:59.000Z"));
    const nextDay = await reserveSynthesisCharacters(50, 50, new Date("2026-09-10T00:00:00.000Z"));

    expect(nextDay.allowed).toBe(true);
    expect(store.has("voice:2026-09-09")).toBe(true);
    expect(store.has("voice:2026-09-10")).toBe(true);
  });

  it("counts phrases alongside characters, so the figure can be read back", async () => {
    const { reserveSynthesisCharacters, readVoiceCounter } = await load();

    await reserveSynthesisCharacters(1000, 30, AT);
    await reserveSynthesisCharacters(1000, 45, AT);

    const counter = await readVoiceCounter(AT);
    expect(counter?.characters).toBe(75);
    expect(counter?.phrases).toBe(2);
    expect(counter?.day).toBe("2026-09-09");
  });

  it("carries a TTL expiry, so the counter is not a growing collection", async () => {
    const { reserveSynthesisCharacters } = await load();

    await reserveSynthesisCharacters(1000, 10, AT);

    expect(store.get("voice:2026-09-09")?.expiresAt).toBeInstanceOf(Date);
  });

  it("returns null rather than throwing when the counter cannot be read", async () => {
    const { readVoiceCounter } = await load();
    failWith = new Error("no connection");

    expect(await readVoiceCounter(AT)).toBeNull();
  });
});

describe("the two providers' ceilings are separate", () => {
  it("does not let synthesis consume the scoring allowance", async () => {
    /**
     * The property that would break if the two counters were "simplified"
     * into one: a day of generating model audio must not be able to stop
     * learners being scored. Different `_id`, different unit, different
     * document.
     */
    const { reserveScoringCall, reserveSynthesisCharacters } = await load();

    // Spend the entire synthesis allowance.
    expect((await reserveSynthesisCharacters(100, 100, AT)).allowed).toBe(true);
    expect((await reserveSynthesisCharacters(100, 1, AT)).allowed).toBe(false);

    // Scoring is untouched.
    expect((await reserveScoringCall(5, AT)).allowed).toBe(true);
    expect(store.has("spend:2026-09-09")).toBe(true);
    expect(store.has("voice:2026-09-09")).toBe(true);
  });
});
