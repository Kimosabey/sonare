/**
 * The thing standing between one learner's progress and another's.
 *
 * A client-minted id is not a credential — anyone can send any id — so the
 * signature is the whole of the protection. These tests are written as an
 * attacker rather than a caller: forge an id, tamper with a payload, swap a
 * signature between learners, smuggle extra dots, backdate, postdate, and try
 * to get a token issued with no secret configured.
 *
 * The secret is read at module load, so each case imports a fresh module.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const B = "11111111-2222-4333-8444-555555555555";
const SECRET = "test-secret-not-a-real-one";

/**
 * A fresh module with a given secret. `null` means unset.
 *
 * Not `undefined` for that: a default parameter is applied when the argument
 * *is* undefined, so `load(undefined)` would silently mean `load()` and the
 * two "no secret configured" cases would have run fully configured — passing
 * for the wrong reason, and reporting that a missing secret is fine.
 */
async function load(secret: string | null = SECRET) {
  vi.resetModules();
  if (secret === null) delete process.env.LEARNER_TOKEN_SECRET;
  else process.env.LEARNER_TOKEN_SECRET = secret;
  return import("./identity.js");
}

afterEach(() => {
  delete process.env.LEARNER_TOKEN_SECRET;
  vi.restoreAllMocks();
});

describe("issuing", () => {
  it("round-trips a valid id", async () => {
    const { issueToken, verifyToken } = await load();

    const result = verifyToken(issueToken(A));

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.learnerId).toBe(A);
  });

  it("carries the id and the issue time, and nothing else", async () => {
    const { issueToken } = await load();

    const parts = issueToken(A, 1_757_000_000_000).split(".");

    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(A);
    expect(parts[1]).toBe("1757000000000");
  });

  it("refuses to sign anything that is not a learner id", async () => {
    /**
     * Otherwise the token becomes a carrier for whatever the caller sent — a
     * path fragment, a Mongo operator, a hundred kilobytes — and every later
     * layer trusts it *because* it came back signed.
     */
    const { issueToken } = await load();

    for (const bad of ["", "marie", "../../etc/passwd", '{"$ne":null}', A.replace("4", "9"), "x".repeat(5000)]) {
      expect(() => issueToken(bad)).toThrow();
    }
  });

  it("gives two learners different signatures for the same moment", async () => {
    const { issueToken } = await load();

    const one = issueToken(A, 1_757_000_000_000).split(".")[2];
    const two = issueToken(B, 1_757_000_000_000).split(".")[2];

    expect(one).not.toBe(two);
  });
});

describe("forgery", () => {
  it("rejects a token signed with a different secret", async () => {
    const attacker = await load("some-other-secret");
    const forged = attacker.issueToken(A);

    const real = await load(SECRET);

    expect(real.verifyToken(forged)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects an id with no signature at all", async () => {
    // The shape the client holds. It must authorise nothing on its own.
    const { verifyToken } = await load();

    expect(verifyToken(A).ok).toBe(false);
  });

  it("rejects a tampered learner id", async () => {
    /**
     * The attack that matters: take your own valid token and change the id to
     * someone else's. The payload is signed, so this must fail.
     */
    const { issueToken, verifyToken } = await load();
    const parts = issueToken(A).split(".");

    const swapped = [B, parts[1], parts[2]].join(".");

    expect(verifyToken(swapped)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a signature lifted from another learner's token", async () => {
    const { issueToken, verifyToken } = await load();
    const mine = issueToken(A, 1_757_000_000_000).split(".");
    const theirs = issueToken(B, 1_757_000_000_000).split(".");

    expect(verifyToken([B, mine[1], mine[2]].join(".")).ok).toBe(false);
    expect(verifyToken([A, theirs[1], theirs[2]].join(".")).ok).toBe(false);
  });

  it("rejects a backdated issue time", async () => {
    // The age is inside the signed payload, so re-dating breaks the signature
    // rather than extending the token's life.
    const { issueToken, verifyToken } = await load();
    const parts = issueToken(A, 1_757_000_000_000).split(".");

    expect(verifyToken([parts[0], "1", parts[2]].join(".")).ok).toBe(false);
  });

  it("does not let extra dots smuggle a payload past the signature", async () => {
    /**
     * A split-and-take-the-last implementation would treat everything before
     * the final dot as the payload, so an attacker could append their own
     * segment. Exactly three parts are required.
     */
    const { issueToken, verifyToken } = await load();
    const token = issueToken(A);

    expect(verifyToken(`${token}.extra`)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyToken(`prefix.${token}`)).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    ["empty", ""],
    ["one part", "just-a-string"],
    ["two parts", `${A}.1757000000000`],
    ["not a string", 12345],
    ["null", null],
    ["an object", { learnerId: A }],
    ["an array", [A, "1", "sig"]],
  ])("rejects %s as malformed", async (_label, token) => {
    const { verifyToken } = await load();

    expect(verifyToken(token as unknown).ok).toBe(false);
  });

  it("rejects a non-numeric or exotic issue time", async () => {
    /**
     * `Number("1e999")` is Infinity and `Number(" 1")` is 1, either of which
     * would make the age check meaningless. Digits only, so the parse cannot
     * be argued with.
     */
    const { verifyToken } = await load();

    for (const stamp of ["1e999", " 1757000000000", "-1", "0x10", "1757000000000.5", ""]) {
      expect(verifyToken(`${A}.${stamp}.anything`)).toEqual({ ok: false, reason: "malformed" });
    }
  });
});

describe("expiry", () => {
  it("accepts a token issued now", async () => {
    const { issueToken, verifyToken } = await load();

    expect(verifyToken(issueToken(A, 1_757_000_000_000), 1_757_000_000_000).ok).toBe(true);
  });

  it("rejects one past its maximum age", async () => {
    const { issueToken, verifyToken } = await load();
    const issued = 1_700_000_000_000;
    const tooLate = issued + 401 * 24 * 60 * 60 * 1000;

    expect(verifyToken(issueToken(A, issued), tooLate)).toEqual({ ok: false, reason: "expired" });
  });

  it("still accepts one just inside the window", async () => {
    const { issueToken, verifyToken } = await load();
    const issued = 1_700_000_000_000;
    const justInside = issued + 399 * 24 * 60 * 60 * 1000;

    expect(verifyToken(issueToken(A, issued), justInside).ok).toBe(true);
  });

  it("checks the signature before the age", async () => {
    // So an unsigned token never reaches a branch that reports anything about
    // it — "expired" would confirm the payload was otherwise well-formed.
    const { verifyToken } = await load();
    const ancient = `${A}.1.not-a-signature`;

    expect(verifyToken(ancient, Date.now())).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a token from further in the future than clock skew explains", async () => {
    // A token dated ahead is not a clock to trust; a minute of skew between
    // instances is, though.
    const { issueToken, verifyToken } = await load();
    const now = 1_757_000_000_000;

    expect(verifyToken(issueToken(A, now + 30_000), now).ok).toBe(true);
    expect(verifyToken(issueToken(A, now + 600_000), now).ok).toBe(false);
  });
});

describe("with no secret configured", () => {
  it("reports itself unconfigured", async () => {
    const { identityConfigured } = await load(null);

    expect(identityConfigured()).toBe(false);
  });

  it("issues nothing rather than falling back to a built-in secret", async () => {
    /**
     * A default secret is not a weaker version of this — it is none of it,
     * because the value would be in the repository and anyone could forge any
     * learner. DIAGNOSTICS_TOKEN already establishes that there is no "unset
     * means open" here.
     */
    const { issueToken, verifyToken } = await load(null);

    expect(() => issueToken(A)).toThrow(/LEARNER_TOKEN_SECRET/);
    expect(() => verifyToken("anything")).toThrow(/LEARNER_TOKEN_SECRET/);
  });

  it("treats an empty secret as unset, not as a valid key", async () => {
    const { identityConfigured } = await load("");

    expect(identityConfigured()).toBe(false);
  });
});

describe("reading the header", () => {
  it("takes the token out of a Bearer header", async () => {
    const { bearerFrom } = await load();

    expect(bearerFrom(`Bearer ${A}.1.sig`)).toBe(`${A}.1.sig`);
  });

  it("tolerates surrounding whitespace", async () => {
    const { bearerFrom } = await load();

    expect(bearerFrom("  Bearer abc  ")).toBe("abc");
  });

  it.each([
    ["a bare token", `${A}.1.sig`],
    ["the wrong scheme", `Basic ${A}`],
    ["lowercase bearer", `bearer ${A}`],
    ["nothing after the scheme", "Bearer "],
    ["not a string", undefined],
  ])("returns null for %s", async (_label, header) => {
    const { bearerFrom } = await load();

    expect(bearerFrom(header as unknown)).toBeNull();
  });
});
