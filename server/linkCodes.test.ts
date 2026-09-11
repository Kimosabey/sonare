/**
 * Device link codes — the mechanism, at the level where the credential lives.
 *
 * Written as an attacker rather than as a caller. The interesting questions
 * are not "does a good code work" but: can the same code work twice, can two
 * devices racing one code both win, does an expired code still work, does a
 * refusal say whether the code existed, and is anything recoverable from the
 * database on its own.
 *
 * Two things this file is careful about, both of which have produced false
 * passes in this project before.
 *
 * The secret and the TTL are read at module load, so every configuration
 * imports a *fresh* module and the tests only ever touch that instance. A
 * variable set after the import configures a different module than the one
 * under test, and four assertions once passed against the wrong instance that
 * way.
 *
 * And the database mock mutates synchronously inside each operation, because
 * that is what Mongo promises for a single-document update and it is the
 * property the single-use guarantee rests on. A mock that read, awaited, and
 * then wrote would let a read-then-write implementation pass the concurrency
 * test — which is the one test in this file that cannot be allowed to be
 * decorative.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";

type Doc = Record<string, unknown> & { _id: string };

/** collection -> id -> document. */
let store: Map<string, Map<string, Doc>>;

function col(name: string): Map<string, Doc> {
  const existing = store.get(name);
  if (existing !== undefined) return existing;
  const created = new Map<string, Doc>();
  store.set(name, created);
  return created;
}

/**
 * Whether a stored document satisfies a filter.
 *
 * Strict in both directions, like the end-to-end mock: every condition has to
 * hold, and a condition it does not understand throws rather than being
 * ignored. A silently ignored `$gt` would turn the expiry check in the claim
 * filter into no check at all, and every expiry assertion below would pass
 * against an implementation that had none.
 */
function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [field, condition] of Object.entries(filter)) {
    const value = doc[field];

    if (typeof condition === "object" && condition !== null && !(condition instanceof Date)) {
      const ops = condition as { $gt?: unknown; $lt?: unknown };
      if (ops.$gt instanceof Date) {
        if (!(value instanceof Date) || value.getTime() <= ops.$gt.getTime()) return false;
        continue;
      }
      if (ops.$lt instanceof Date) {
        if (!(value instanceof Date) || value.getTime() >= ops.$lt.getTime()) return false;
        continue;
      }
      throw new Error(`link-code mock: filter on ${field} uses an operator it does not implement`);
    }

    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

let dbFails = false;

vi.mock("./db.js", () => ({
  getDb: () => {
    if (dbFails) return Promise.reject(new Error("no database"));
    return Promise.resolve({
      collection: (name: string) => ({
        /**
         * Mutates synchronously and only then resolves, which is Mongo's own
         * guarantee for one document and the reason the concurrency test
         * below means anything.
         */
        updateOne: async (filter: Record<string, unknown> & { _id: string }, update: Record<string, Record<string, unknown>>) => {
          const existing = col(name).get(filter._id);
          // No document and no upsert is no write, as the driver behaves.
          if (existing === undefined) return { matchedCount: 0, acknowledged: true };
          if (!matches(existing, filter)) return { matchedCount: 0, acknowledged: true };
          col(name).set(filter._id, { ...existing, ...(update["$set"] ?? {}) } as Doc);
          return { matchedCount: 1, acknowledged: true };
        },
        insertOne: async (doc: Doc) => {
          if (col(name).has(doc._id)) {
            const err = new Error("E11000 duplicate key") as Error & { code: number };
            err.code = 11000;
            throw err;
          }
          col(name).set(doc._id, { ...doc });
          return { acknowledged: true, insertedId: doc._id };
        },
        /**
         * Honours the whole filter, not only `_id`.
         *
         * The permissive version — look the id up and hand it back — is the
         * mock mistake this project has been bitten by before: it makes any
         * extra condition on a read invisible, so an implementation that
         * checked expiry in its query rather than in its update would pass
         * every expiry test here while checking nothing.
         */
        findOne: async (filter: Record<string, unknown> & { _id: string }) => {
          const doc = col(name).get(filter._id);
          if (doc === undefined) return null;
          return matches(doc, filter) ? doc : null;
        },
        find: (filter: Record<string, unknown>) => ({
          toArray: async () => [...col(name).values()].filter((doc) => matches(doc, filter)),
        }),
        deleteMany: async (filter: Record<string, unknown>) => {
          // deletedCount, as the driver returns it. Without it the route's
          // reported figures vanish from the JSON.
          let deletedCount = 0;
          for (const [id, doc] of col(name)) {
            if (matches(doc, filter)) {
              col(name).delete(id);
              deletedCount += 1;
            }
          }
          return { acknowledged: true, deletedCount };
        },
        createIndex: async () => "ok",
      }),
    });
  },
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const B = "11111111-2222-4333-8444-555555555555";
const SECRET = "link-code-test-secret-not-a-real-one";

type LinkCodes = typeof import("./linkCodes.js");

/** A fresh module, because the secret and the TTL are read at load. */
async function load(options: { secret?: string | null; ttl?: string | null } = {}): Promise<LinkCodes> {
  const secret = options.secret === undefined ? SECRET : options.secret;
  if (secret === null) delete process.env.LEARNER_TOKEN_SECRET;
  else process.env.LEARNER_TOKEN_SECRET = secret;

  if (options.ttl === undefined || options.ttl === null) delete process.env.LINK_CODE_TTL_SECONDS;
  else process.env.LINK_CODE_TTL_SECONDS = options.ttl;

  vi.resetModules();
  return import("./linkCodes.js");
}

beforeEach(() => {
  store = new Map();
  dbFails = false;
});

afterEach(() => {
  delete process.env.LEARNER_TOKEN_SECRET;
  delete process.env.LINK_CODE_TTL_SECONDS;
  vi.clearAllMocks();
});

/** Every stored link-code document, whatever its id. */
function stored(): Doc[] {
  return [...col("linkcodes").values()];
}

describe("the code a person has to read off one screen and type into another", () => {
  it("contains no character that can be misread as another character in it", async () => {
    const { CODE_ALPHABET } = await load();

    // The pairs people actually confuse when copying a code, with both halves
    // of each gone rather than one: folding O to 0 on input only helps if one
    // of them is valid, and keeping neither makes a misread a wrong character
    // rather than a wrong learner.
    for (const confusable of ["0", "O", "1", "I", "L", "U"]) {
      expect(CODE_ALPHABET, `${confusable} is confusable and must not be in the alphabet`).not.toContain(confusable);
    }
  });

  it("lists each character once, so the keyspace is the size the arithmetic uses", async () => {
    const { CODE_ALPHABET } = await load();

    // A duplicated character would make one of them twice as likely and the
    // real keyspace smaller than 30^10, silently.
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
    expect(CODE_ALPHABET.length).toBe(30);
  });

  it("is ten characters from that alphabet, shown as two groups of five", async () => {
    const { mintLinkCode, CODE_ALPHABET } = await load();

    const { code } = await mintLinkCode(A);

    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    for (const character of code.replace("-", "")) expect(CODE_ALPHABET).toContain(character);
  });

  it("keeps a keyspace of 30^10, which is what the brute-force budget is measured against", async () => {
    const { CODE_ALPHABET, CODE_LENGTH } = await load();

    // Stated as the number rather than as a formula, because the whole
    // security argument is a division by it: about 5.9e14, or 2^49.1.
    expect(CODE_ALPHABET.length ** CODE_LENGTH).toBe(590_490_000_000_000);
  });

  it("does not hand out the same code twice", async () => {
    const { mintLinkCode } = await load();

    // Not a randomness proof — a proof that the generator is not a constant,
    // a counter, or seeded per process, each of which would pass every other
    // test in this file.
    const codes = new Set<string>();
    for (let i = 0; i < 500; i += 1) codes.add((await mintLinkCode(A)).code);

    expect(codes.size).toBe(500);
  });

  it("draws on the whole alphabet, rather than a biased slice of it", async () => {
    const { mintLinkCode, CODE_ALPHABET } = await load();

    // `bytes[i] % 30` is the obvious way to write the generator and it is
    // biased: 256 is not a multiple of 30. This will not catch a 5/6 skew,
    // but it does catch an alphabet truncated to a power of two — which is
    // the version of that mistake that loses real keyspace.
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      for (const character of (await mintLinkCode(A)).code.replace("-", "")) seen.add(character);
    }

    expect(seen.size).toBe(CODE_ALPHABET.length);
  });
});

describe("what a claimer is allowed to have typed", () => {
  it.each([
    ["exactly as it was shown", (code: string) => code],
    ["in lower case, which is what a phone keyboard gives", (code: string) => code.toLowerCase()],
    ["without the grouping hyphen", (code: string) => code.replace("-", "")],
    ["with the hyphen replaced by a space", (code: string) => code.replace("-", " ")],
    ["with stray whitespace around it", (code: string) => `  ${code}\n`],
    ["in mixed case, half typed before the caps lock was noticed", (code: string) => code.slice(0, 3) + code.slice(3).toLowerCase()],
  ])("accepts the code typed %s", async (_label, retype) => {
    const { mintLinkCode, claimLinkCode } = await load();
    const { code } = await mintLinkCode(A);

    expect(await claimLinkCode(retype(code))).toEqual({ ok: true, learnerId: A });
  });

  it.each([
    ["not a string", 42],
    ["missing", undefined],
    ["a mongo operator", { $ne: null }],
    ["empty", ""],
    ["too short", "ABCDE-FGH"],
    ["too long", "ABCDE-FGHJK-M"],
    ["a character the alphabet excludes", "ABCDE-FGHJ0"],
    ["enormous", "A".repeat(100_000)],
  ])("refuses a code that is %s, without touching the database", async (_label, value) => {
    const { mintLinkCode, claimLinkCode } = await load();
    await mintLinkCode(A);

    expect(await claimLinkCode(value)).toEqual({ ok: false, reason: "malformed" });
  });

  it("does not accept a code made valid by stripping characters out of it", async () => {
    const { mintLinkCode, claimLinkCode } = await load();
    const { code } = await mintLinkCode(A);
    const bare = code.replace("-", "");

    // Stripping *unknown* characters rather than only separators is the
    // tempting way to be forgiving, and it would make this work.
    const salted = [...bare].join("!");

    expect(await claimLinkCode(salted)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("the database holds no code", () => {
  it("stores a digest and nothing that resembles the code", async () => {
    const { mintLinkCode } = await load();

    const { code } = await mintLinkCode(A);
    const bare = code.replace("-", "");
    const dump = JSON.stringify(stored());

    // Every presentation of it, because a leak is usually the formatted one.
    for (const form of [code, bare, code.toLowerCase(), bare.toLowerCase()]) {
      expect(dump).not.toContain(form);
    }
    expect(stored()).toHaveLength(1);
  });

  it("keyes the digest on the secret, so a stolen table cannot be enumerated", async () => {
    const { mintLinkCode } = await load();

    const { code } = await mintLinkCode(A);
    const bare = code.replace("-", "");
    const id = stored()[0]?._id;

    /**
     * The property that matters if the database is copied out. A link code
     * has a keyspace an attacker can enumerate offline in hours against a
     * plain digest, so the stored value must not be one — under any of the
     * obvious unkeyed constructions.
     */
    expect(id).toBeDefined();
    for (const guess of [
      createHash("sha256").update(bare).digest("base64url"),
      createHash("sha256").update(bare).digest("hex"),
      createHash("sha256").update(code).digest("base64url"),
      createHash("sha512").update(bare).digest("base64url"),
      createHmac("sha256", "").update(bare).digest("base64url"),
    ]) {
      expect(id).not.toBe(guess);
    }
  });

  it("makes a code minted under one secret worthless under another", async () => {
    // The same claim, keyed on a different secret. If the digest were
    // unkeyed, the row would still be found and the code would still work —
    // which is exactly what "a leaked database hands out identities" means.
    const first = await load({ secret: "the-first-secret" });
    const { code } = await first.mintLinkCode(A);

    const second = await load({ secret: "a-completely-different-secret" });

    expect(await second.claimLinkCode(code)).toEqual({ ok: false, reason: "not-claimable" });
    // And the row is still sitting there, so this is about the digest rather
    // than about an empty collection.
    expect(stored()).toHaveLength(1);
  });

  it("exports a learner's codes without the digest", async () => {
    const { mintLinkCode, listLinkCodesFor } = await load();
    await mintLinkCode(A);

    const summaries = await listLinkCodesFor(A);

    expect(summaries).toHaveLength(1);
    expect(Object.keys(summaries[0] ?? {}).sort()).toEqual(["claimedAt", "createdAt", "expiresAt"]);
    expect(JSON.stringify(summaries)).not.toContain(stored()[0]?._id ?? "unreachable");
  });

  it("returns nobody else's codes", async () => {
    const { mintLinkCode, listLinkCodesFor } = await load();
    await mintLinkCode(A);
    await mintLinkCode(B);

    expect(await listLinkCodesFor(A)).toHaveLength(1);
    expect(await listLinkCodesFor(B)).toHaveLength(1);
  });
});

describe("a code works once", () => {
  it("links the device it was minted for", async () => {
    const { mintLinkCode, claimLinkCode } = await load();

    const { code } = await mintLinkCode(A);

    expect(await claimLinkCode(code)).toEqual({ ok: true, learnerId: A });
  });

  it("refuses the second claim of the same code", async () => {
    const { mintLinkCode, claimLinkCode } = await load();
    const { code } = await mintLinkCode(A);

    const first = await claimLinkCode(code);
    const second = await claimLinkCode(code);

    expect(first).toEqual({ ok: true, learnerId: A });
    expect(second).toEqual({ ok: false, reason: "not-claimable" });
  });

  it("lets exactly one of two devices racing the same code win", async () => {
    /**
     * The race the conditional update exists for. A read-then-write — read
     * "unclaimed", then write — has a window in which both callers read
     * "unclaimed" and both proceed, and for a credential that means two
     * devices adopting one learner off a code meant to link one.
     *
     * The mock mutates synchronously inside `updateOne`, which is Mongo's
     * guarantee for a single document, so the only way both can win here is
     * if the implementation decides on a separate read.
     */
    const { mintLinkCode, claimLinkCode } = await load();
    const { code } = await mintLinkCode(A);

    const outcomes = await Promise.all([claimLinkCode(code), claimLinkCode(code)]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
  });

  it("lets exactly one of ten win, not one per turn of the loop", async () => {
    // Two can be got right by accident; ten cannot.
    const { mintLinkCode, claimLinkCode } = await load();
    const { code } = await mintLinkCode(A);

    const outcomes = await Promise.all(Array.from({ length: 10 }, () => claimLinkCode(code)));

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  });

  it("keeps the consumed row, so a deletion request can still find it", async () => {
    const { mintLinkCode, claimLinkCode } = await load();
    const { code } = await mintLinkCode(A);
    await claimLinkCode(code);

    // Deleting the row on claim would be single-use too, and would leave the
    // reuse invisible in the data and the learner attributable for the rest
    // of the TTL with nothing to sweep. Keeping it stamped is the choice.
    expect(stored()).toHaveLength(1);
    expect(stored()[0]?.["claimedAt"]).toBeInstanceOf(Date);
    expect(stored()[0]?.["learnerId"]).toBe(A);
  });
});

describe("a code stops working", () => {
  it("expires, and an expired code links nothing", async () => {
    const { mintLinkCode, claimLinkCode, LINK_CODE_TTL_SECONDS } = await load();
    const minted = new Date("2026-09-11T10:00:00.000Z");
    const { code } = await mintLinkCode(A, minted);

    const oneSecondLate = new Date(minted.getTime() + (LINK_CODE_TTL_SECONDS + 1) * 1000);

    expect(await claimLinkCode(code, oneSecondLate)).toEqual({ ok: false, reason: "not-claimable" });
  });

  it("still works one second before it expires, so the expiry is a real boundary", async () => {
    // Without this, an expiry check that refused everything would pass the
    // test above and nobody could ever link a device.
    const { mintLinkCode, claimLinkCode, LINK_CODE_TTL_SECONDS } = await load();
    const minted = new Date("2026-09-11T10:00:00.000Z");
    const { code } = await mintLinkCode(A, minted);

    const justInTime = new Date(minted.getTime() + (LINK_CODE_TTL_SECONDS - 1) * 1000);

    expect(await claimLinkCode(code, justInTime)).toEqual({ ok: true, learnerId: A });
  });

  it("is dead on the instant it expires, not a moment after", async () => {
    const { mintLinkCode, claimLinkCode } = await load();
    const minted = new Date("2026-09-11T10:00:00.000Z");
    const { code, expiresAt } = await mintLinkCode(A, minted);

    expect(await claimLinkCode(code, expiresAt)).toEqual({ ok: false, reason: "not-claimable" });
  });

  it("lives for ten minutes by default — minutes, not hours", async () => {
    const { mintLinkCode, LINK_CODE_TTL_SECONDS } = await load();
    const minted = new Date("2026-09-11T10:00:00.000Z");

    const { expiresAt, expiresInSeconds } = await mintLinkCode(A, minted);

    expect(LINK_CODE_TTL_SECONDS).toBe(600);
    expect(expiresInSeconds).toBe(600);
    expect(expiresAt.toISOString()).toBe("2026-09-11T10:10:00.000Z");
  });

  it("takes a configured life, within bounds", async () => {
    const { LINK_CODE_TTL_SECONDS } = await load({ ttl: "120" });

    expect(LINK_CODE_TTL_SECONDS).toBe(120);
  });

  it.each([
    ["unreadable", "ten minutes"],
    ["below the floor", "5"],
    ["above the ceiling", "86400"],
    ["not whole", "90.5"],
  ])("falls back to the default when the configured life is %s", async (_label, raw) => {
    // env.ts's rule: a value that cannot be used is refused loudly rather
    // than propagated. `Number("ten minutes")` is NaN, and every comparison
    // against NaN is false — so an expiry of NaN is no expiry at all.
    const { LINK_CODE_TTL_SECONDS } = await load({ ttl: raw });

    expect(LINK_CODE_TTL_SECONDS).toBe(600);
  });

  it("is retired the moment the learner mints another", async () => {
    /**
     * One live code per learner, which is the last term in the brute-force
     * arithmetic: an attacker's chance of hitting *some* live code scales
     * with how many are live, so a learner able to accumulate them would
     * multiply the only number in that budget they get for free.
     */
    const { mintLinkCode, claimLinkCode } = await load();
    const first = await mintLinkCode(A);

    const second = await mintLinkCode(A);

    expect(stored()).toHaveLength(1);
    expect(await claimLinkCode(first.code)).toEqual({ ok: false, reason: "not-claimable" });
    expect(await claimLinkCode(second.code)).toEqual({ ok: true, learnerId: A });
  });

  it("retires only that learner's own code", async () => {
    const { mintLinkCode, claimLinkCode } = await load();
    const theirs = await mintLinkCode(B);

    await mintLinkCode(A);

    expect(await claimLinkCode(theirs.code)).toEqual({ ok: true, learnerId: B });
  });
});

describe("a refusal says nothing about what exists", () => {
  it("answers a never-issued code exactly as it answers a used one and an expired one", async () => {
    /**
     * The three refusals a guesser could learn from, and they have to be the
     * same value. "Expired" versus "unknown" tells an attacker a code exists
     * — a fact about somebody else's account — and the client does the same
     * thing in every case: ask the other device for a new code.
     */
    const { mintLinkCode, claimLinkCode } = await load();

    const used = await mintLinkCode(A);
    await claimLinkCode(used.code);

    const expiredAt = new Date("2026-09-11T10:00:00.000Z");
    const expired = await mintLinkCode(B, expiredAt);
    const later = new Date(expiredAt.getTime() + 3_600_000);

    const unknown = await claimLinkCode("23456-789AB", later);
    const alreadyUsed = await claimLinkCode(used.code, later);
    const outOfTime = await claimLinkCode(expired.code, later);

    expect(unknown).toEqual({ ok: false, reason: "not-claimable" });
    expect(alreadyUsed).toEqual(unknown);
    expect(outOfTime).toEqual(unknown);
  });

  it("says it could not check, rather than that the code was wrong, when the database is down", async () => {
    // A learner told "wrong code" on an outage goes and generates another
    // one, and that one fails too.
    const { claimLinkCode } = await load();
    dbFails = true;

    expect(await claimLinkCode("23456-789AB")).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("with no secret configured", () => {
  it("mints nothing rather than storing a digest keyed on the empty string", async () => {
    const { mintLinkCode } = await load({ secret: null });

    await expect(mintLinkCode(A)).rejects.toMatchObject({ code: "MISCONFIGURED", status: 503 });
    expect(stored()).toHaveLength(0);
  });

  it("refuses to check a claim rather than checking it against an unkeyed digest", async () => {
    const { claimLinkCode } = await load({ secret: null });

    await expect(claimLinkCode("23456-789AB")).rejects.toMatchObject({ code: "MISCONFIGURED" });
  });

  it("still recognises a malformed code as malformed, which needs no secret", async () => {
    const { claimLinkCode } = await load({ secret: null });

    expect(await claimLinkCode("nope")).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("erasing a learner erases their codes", () => {
  it("removes every one of them, claimed or not", async () => {
    const { mintLinkCode, claimLinkCode, deleteLinkCodesFor } = await load();
    const { code } = await mintLinkCode(A);
    await claimLinkCode(code);

    const removed = await deleteLinkCodesFor(A);

    expect(removed).toBe(1);
    expect(stored()).toHaveLength(0);
  });

  it("removes nobody else's", async () => {
    const { mintLinkCode, deleteLinkCodesFor, claimLinkCode } = await load();
    await mintLinkCode(A);
    const theirs = await mintLinkCode(B);

    await deleteLinkCodesFor(A);

    expect(await claimLinkCode(theirs.code)).toEqual({ ok: true, learnerId: B });
  });

  it("fails the deletion rather than leaving a live credential behind", async () => {
    /**
     * Unlike the rate-limit sweep next to it, which swallows. A stale abuse
     * counter left behind expires on its own within minutes; a link code left
     * behind is a live credential for a record that has just been erased, and
     * somebody holding it could re-establish the identity the learner asked
     * us to destroy. So this one is allowed to fail and make them retry.
     */
    const { deleteLinkCodesFor } = await load();
    dbFails = true;

    await expect(deleteLinkCodesFor(A)).rejects.toThrow();
  });
});

describe("nothing that could reconstruct a code is logged", () => {
  it("logs no code and no digest, on the way out or on failure", async () => {
    const { mintLinkCode, claimLinkCode } = await load();
    const { logger } = await import("./logger.js");

    const { code } = await mintLinkCode(A);
    const id = stored()[0]?._id ?? "unreachable";
    await claimLinkCode(code);
    await claimLinkCode(code);
    dbFails = true;
    await claimLinkCode(code);

    const written = JSON.stringify(
      [logger.info, logger.warn, logger.error, logger.debug].map((fn) => vi.mocked(fn).mock.calls),
    );

    // The code, however presented, and the digest — because a digest plus
    // this server's secret is the code, and logs travel further than
    // databases do.
    for (const secretish of [code, code.replace("-", ""), code.toLowerCase(), id]) {
      expect(written).not.toContain(secretish);
    }
  });
});
