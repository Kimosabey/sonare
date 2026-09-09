/**
 * The comparison that decides whether a token is real.
 *
 * identity.test.ts covers forgery — a swapped id, a lifted signature, extra
 * dots, a backdated clock. This file covers the narrower thing that file does
 * not: that the comparison itself gives nothing away.
 *
 * A `===` on two HMACs returns as soon as it finds a differing byte, so the
 * time it takes to fail is a measurement of how many leading bytes matched.
 * Repeated across a network that is otherwise stable, that recovers a valid
 * signature one byte at a time — no brute force, one guess per byte. The fix
 * is `timingSafeEqual`, which is in identity.ts:139.
 *
 * Three properties are pinned here, because each one is a different way to
 * lose it while every other test in the repo still passes:
 *
 *  1. **The whole digest is compared.** A prefix comparison — `slice(0, 8)`,
 *     `startsWith`, an early `return` inside a loop — is invisible to a test
 *     that only tries one wrong signature. So every byte position is tried.
 *  2. **The constant-time comparator is the one deciding.** Swapping
 *     `timingSafeEqual` for `===` or `Buffer.equals` changes no observable
 *     answer at all: every existing test stays green and the leak is back. So
 *     the comparator is spied on, and it has to be called, with the full
 *     digest, and its verdict has to be the one that is returned.
 *  3. **A length mismatch leaks nothing and throws nothing.** `timingSafeEqual`
 *     throws on differing lengths rather than returning false, so it has to be
 *     guarded — and the guard must report the same refusal as a same-length
 *     mismatch, or the shape of a signature becomes an oracle. It also must
 *     not become a crash in the authentication path.
 *
 * The secret is read at module load, so every case imports a fresh module with
 * the secret already in place — never the other way round.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `node:crypto` is passed through in full, with one function wrapped.
 *
 * `importActual` rather than a hand-written stub: `createHmac` has to keep
 * producing real digests, or the signature under test would not be one.
 */
const timingSafeEqualCalls: Array<[number, number]> = [];
let comparatorVerdict: boolean | null = null;

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      timingSafeEqualCalls.push([a.byteLength, b.byteLength]);
      const verdict = actual.timingSafeEqual(a, b);
      comparatorVerdict = verdict;
      return verdict;
    },
  };
});

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const B = "11111111-2222-4333-8444-555555555555";
const SECRET = "timing-suite-secret-not-a-real-one";

/** A fresh module with the secret already set — never set afterwards. */
async function load(): Promise<typeof import("./identity.js")> {
  vi.resetModules();
  process.env.LEARNER_TOKEN_SECRET = SECRET;
  return import("./identity.js");
}

/** The three parts of a real token, so a case can rebuild it byte by byte. */
async function parts(): Promise<{ id: string; issuedAt: string; signature: string; identity: typeof import("./identity.js") }> {
  const identity = await load();
  const [id, issuedAt, signature] = identity.issueToken(A).split(".") as [string, string, string];
  return { id, issuedAt, signature, identity };
}

/** A character that is definitely not the one at `index`, within base64url. */
function differentCharAt(value: string, index: number): string {
  const original = value[index] ?? "A";
  const replacement = original === "A" ? "B" : "A";
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

beforeEach(() => {
  timingSafeEqualCalls.length = 0;
  comparatorVerdict = null;
});

describe("the whole digest is compared", () => {
  it("rejects a signature that differs at any single position", async () => {
    const { id, issuedAt, signature, identity } = await parts();

    // Every position, not a sample. A comparison that stopped at eight bytes,
    // or at the first `-`/`_`, would pass a spot check and fail here.
    const reasons = new Set<string>();
    for (let index = 0; index < signature.length; index += 1) {
      const tampered = differentCharAt(signature, index);
      expect(tampered).not.toBe(signature);
      const result = identity.verifyToken(`${id}.${issuedAt}.${tampered}`);
      expect(result.ok).toBe(false);
      if (!result.ok) reasons.add(result.reason);
    }

    expect(signature.length).toBeGreaterThan(40);
    // One reason across every position: where the mismatch is must not change
    // the answer, or the position itself becomes the oracle.
    expect([...reasons]).toEqual(["bad-signature"]);
  });

  it("hands the comparator the entire digest, not a prefix of it", async () => {
    const { id, issuedAt, signature, identity } = await parts();

    identity.verifyToken(`${id}.${issuedAt}.${differentCharAt(signature, 0)}`);

    // Both buffers, full length, equal to each other. A prefix comparison
    // would show up as a pair of short lengths.
    expect(timingSafeEqualCalls).toEqual([[signature.length, signature.length]]);
  });

  it("accepts a signature only when the comparator says so", async () => {
    const { identity } = await parts();

    const result = identity.verifyToken(identity.issueToken(A));

    // The verdict returned is the comparator's, rather than a second opinion
    // computed beside it.
    expect(comparatorVerdict).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("goes through the constant-time comparator at all", async () => {
    // The whole point. Swap `timingSafeEqual` for `===` and every other
    // assertion in this repo stays green; this one does not.
    const { identity } = await parts();

    identity.verifyToken(identity.issueToken(A));

    expect(timingSafeEqualCalls).toHaveLength(1);
  });
});

describe("a length mismatch is refused, not thrown and not distinguished", () => {
  it.each([
    ["one byte short", (s: string) => s.slice(0, -1)],
    ["one byte long", (s: string) => `${s}A`],
    ["empty", () => ""],
    ["twice as long", (s: string) => `${s}${s}`],
    ["a single character", () => "A"],
  ])("refuses a signature that is %s", async (_label, mangle) => {
    const { id, issuedAt, signature, identity } = await parts();

    const result = identity.verifyToken(`${id}.${issuedAt}.${mangle(signature)}`);

    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("never reaches the comparator with mismatched lengths", async () => {
    // timingSafeEqual throws on a length mismatch, so reaching it with two
    // different lengths would be a crash in the authentication path rather
    // than a refusal. The lengths are compared first, which is safe because
    // the digest length is fixed and public.
    const { id, issuedAt, signature, identity } = await parts();

    identity.verifyToken(`${id}.${issuedAt}.${signature.slice(0, -1)}`);

    expect(timingSafeEqualCalls).toEqual([]);
  });

  it("answers a wrong length exactly as it answers a wrong byte", async () => {
    const { id, issuedAt, signature, identity } = await parts();

    const wrongByte = identity.verifyToken(`${id}.${issuedAt}.${differentCharAt(signature, 3)}`);
    const wrongLength = identity.verifyToken(`${id}.${issuedAt}.${signature.slice(0, -3)}`);

    // Identical results, so the shape of a guess tells the caller nothing
    // about how close it was.
    expect(wrongLength).toEqual(wrongByte);
  });
});

describe("the digest gives away nothing about what it covers", () => {
  it("is the same length whatever it signs", async () => {
    const { identity } = await parts();

    const lengths = new Set(
      [A, B, "ffffffff-ffff-4fff-bfff-ffffffffffff"].flatMap((id) => [
        identity.issueToken(id, 1).split(".")[2]?.length,
        identity.issueToken(id, 1_999_999_999_999).split(".")[2]?.length,
      ]),
    );

    // A fixed-width digest is what makes the length pre-check above harmless.
    // A variable-length one would turn it into a real oracle.
    expect(lengths.size).toBe(1);
  });

  it("checks the signature before the age, so an unsigned token learns nothing about the clock", async () => {
    const { id, signature, identity } = await parts();

    // A payload far outside the age window, carrying a signature for a
    // different payload. "Expired" here would confirm the issue time was
    // parsed and judged — an oracle on a token that was never signed.
    const result = identity.verifyToken(`${id}.1.${signature}`);

    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a signature lifted from another learner without saying it belongs to one", async () => {
    const { issuedAt, identity } = await parts();
    const theirs = identity.issueToken(B).split(".")[2] ?? "";

    const result = identity.verifyToken(`${A}.${issuedAt}.${theirs}`);

    expect(result).toEqual({ ok: false, reason: "bad-signature" });
    // Same length, so this is the case the constant-time comparison exists for.
    expect(timingSafeEqualCalls).toEqual([[theirs.length, theirs.length]]);
  });
});
