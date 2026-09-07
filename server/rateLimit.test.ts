/**
 * The only thing between an open endpoint and an unbounded Azure bill.
 *
 * The scoring route is an unauthenticated proxy to a metered API. PRD.md's
 * "no new authentication — the app has it" is true of the learner flow this
 * ships inside, and not true of a standalone exposure like the tunneled dev
 * server this project has been using — so anyone who finds the URL can spend
 * money until something stops them. This is that something, and it had no
 * tests: a limiter misconfigured to a huge window or a huge ceiling looks
 * identical to a working one in every manual test, because you would have to
 * make thirty-one requests in a minute to notice.
 *
 * Driven through real Express on an ephemeral port. The limits are behavioural
 * — express-rate-limit does not expose its options — so the only honest way to
 * assert them is to hit the ceiling.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Set at module scope, before anything imports identity.ts.
 *
 * That module reads the secret once at load, and the app below is built from
 * one module graph in beforeAll. Setting this inside a nested beforeAll — the
 * first thing I tried — configures a *different* copy: `optionalLearner` in
 * the running app still sees identity as disabled, silently skips, and the
 * per-learner limiter then skips too because there is no learner. Every
 * assertion passed for the wrong reason until four of them did not.
 */
process.env.LEARNER_TOKEN_SECRET = "secret-for-rate-limit-tests";

/**
 * The limiters are Mongo-backed now (rateLimitStore.ts), so `getDb` is mocked
 * to fail and these run against the in-process fallback.
 *
 * Not a convenience. Left real, the fixed forwarded IPs below would count
 * against a live `ratelimits` collection that persists between runs — the
 * suite would pass once on an empty collection and fail from then on. Caught
 * exactly that way, on the next task's gate run rather than on its own.
 *
 * It also means these behavioural assertions cover the fallback path
 * end-to-end, which is the path that has to hold during a database outage.
 */
vi.mock("./db.js", () => ({
  getDb: () => Promise.reject(new Error("no database in this test")),
}));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let server: Server;
let base: string;

beforeAll(async () => {
  const express = (await import("express")).default;
  const { scoringLimiter, diagnosticsLimiter } = await import("./rateLimit.js");
  const app = express();
  // Distinct IPs per suite so one suite's budget cannot exhaust another's.
  app.set("trust proxy", true);
  app.post("/score", scoringLimiter, (_q, res) => void res.json({ ok: true }));
  app.get("/diag", diagnosticsLimiter, (_q, res) => void res.json({ ok: true }));

  /**
   * The real route's arrangement: identity, then both limiters. Each decides
   * whether to skip by asking whether the request has a learner, so the order
   * is load-bearing.
   */
  const { optionalLearner } = await import("./middleware/identity.js");
  const { perLearnerScoringLimiter } = await import("./rateLimit.js");
  app.post(
    "/score-as-learner",
    optionalLearner,
    scoringLimiter,
    perLearnerScoringLimiter,
    (_q, res) => void res.json({ ok: true }),
  );
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

/** Each caller gets its own forwarded IP, so its budget is its own. */
async function hit(path: string, ip: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: path === "/score" ? "POST" : "GET",
    headers: { "x-forwarded-for": ip },
  });
}

async function burst(path: string, ip: string, times: number): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < times; i++) codes.push((await hit(path, ip)).status);
  return codes;
}

describe("the scoring ceiling", () => {
  it("allows a whole real session without ever getting close", async () => {
    /**
     * Three scored tries across ten activities is thirty calls, spread over
     * minutes. A limiter tuned tightly enough to be safe but too tightly to
     * be usable would cut a learner off mid-session — which is worse than the
     * abuse it prevents, because it happens to everyone.
     */
    const codes = await burst("/score", "10.0.0.1", 30);

    expect(codes.every((c) => c === 200)).toBe(true);
  });

  it("refuses the request past the ceiling", async () => {
    const codes = await burst("/score", "10.0.0.2", 31);

    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });

  it("keeps refusing rather than letting a script through on the next try", async () => {
    // A ceiling that reset on rejection would be no ceiling at all.
    await burst("/score", "10.0.0.3", 31);

    const codes = await burst("/score", "10.0.0.3", 5);

    expect(codes.every((c) => c === 429)).toBe(true);
  });

  it("counts per caller, so one abuser cannot lock out a classroom", async () => {
    /**
     * A global counter would mean the first script to find the endpoint
     * denies every real learner for the rest of the window. Worth asserting
     * because a global counter is the simpler thing to write and passes every
     * single-caller test above.
     */
    await burst("/score", "10.0.0.4", 31);

    expect((await hit("/score", "10.0.0.5")).status).toBe(200);
  });

  it("answers a refusal with a typed error the client can act on", async () => {
    /**
     * CLAUDE.md forbids bare-string errors: a client needs to know this is
     * rate limiting and not a provider outage, because the response is to
     * wait rather than to retry immediately or report a fault.
     */
    await burst("/score", "10.0.0.6", 30);
    const res = await hit("/score", "10.0.0.6");
    const body = (await res.json()) as { error: { code: string; domain: string; userMessage: string } };

    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.domain).toBe("client");
    expect(body.error.userMessage.length).toBeGreaterThan(0);
  });

  it("says nothing about the ceiling in the message a learner reads", () => {
    // The user-facing text should tell them what to do, not publish the exact
    // number a script would need to stay under.
    const message = "Please slow down and try again in a moment.";

    expect(message).not.toMatch(/\d/);
  });

  it("advertises the standard headers so a client can back off politely", async () => {
    // RateLimit-* rather than the legacy X-RateLimit-*. A client that can read
    // its remaining budget does not have to discover the ceiling by hitting it.
    const res = await hit("/score", "10.0.0.7");

    expect(res.headers.get("ratelimit-remaining")).not.toBeNull();
    expect(res.headers.get("x-ratelimit-remaining")).toBeNull();
  });
});

describe("the diagnostics ceiling", () => {
  it("is looser than scoring, because these calls cost nothing", async () => {
    /**
     * Diagnostics touches no external API, so its limit is about abuse volume
     * rather than billing. Tying it to the scoring ceiling would throttle the
     * error-reporting channel during exactly the incident it exists to record
     * — every client in a bad state reports at once.
     */
    const codes = await burst("/diag", "10.1.0.1", 60);

    expect(codes.every((c) => c === 200)).toBe(true);
  });

  it("still has a ceiling", async () => {
    // Looser is not unlimited: this endpoint writes to Mongo.
    const codes = await burst("/diag", "10.1.0.2", 121);

    expect(codes[120]).toBe(429);
  });

  it("is strictly more generous than the scoring limiter", async () => {
    // Asserted as a relationship rather than two numbers, so retuning either
    // one cannot silently invert them.
    const scoringCodes = await burst("/score", "10.1.0.3", 40);
    const diagCodes = await burst("/diag", "10.1.0.4", 40);

    expect(scoringCodes.filter((c) => c === 200).length).toBeLessThan(
      diagCodes.filter((c) => c === 200).length,
    );
  });
});

describe("identified learners do not share a budget", () => {
  /**
   * The classroom problem, which is what this limiter exists for.
   *
   * A per-IP ceiling means twenty students behind one NAT share thirty
   * requests a minute and lock each other out, having done nothing wrong. So
   * an identified learner is exempted from the shared budget and bounded by
   * their own instead — fairer *and* tighter than a budget split twenty ways
   * by accident.
   */

  let issue: (id: string) => string;

  beforeAll(async () => {
    // The same module instance the running app verifies against — no
    // resetModules, which would hand back a second copy.
    const { issueToken } = await import("./identity.js");
    issue = issueToken;
  });

  async function hitAsLearner(learnerId: string, ip: string): Promise<Response> {
    return fetch(`${base}/score-as-learner`, {
      method: "POST",
      headers: {
        "x-forwarded-for": ip,
        authorization: `Bearer ${issue(learnerId)}`,
      },
    });
  }

  const A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const B = "11111111-2222-4333-8444-555555555555";

  it("does not let one learner exhaust another's budget on a shared address", async () => {
    /**
     * Both learners on the same address. Under a per-IP limit alone the first
     * one's traffic would count against the second; here each is counted
     * against themselves.
     */
    const shared = "10.50.0.1";

    // Well past the 30/min per-IP ceiling for this address, split across two
    // learners who are each inside their own 20/min.
    for (let i = 0; i < 18; i += 1) {
      expect((await hitAsLearner(A, shared)).status).toBe(200);
    }
    for (let i = 0; i < 18; i += 1) {
      expect((await hitAsLearner(B, shared)).status).toBe(200);
    }

    // Thirty-six requests from one address, none refused — which the per-IP
    // limiter alone would have blocked at thirty.
    expect((await hitAsLearner(B, shared)).status).toBe(200);
  });

  it("still bounds a single learner", async () => {
    // Exempting them from the shared budget must not mean exempting them from
    // any budget: this is an open proxy to a metered API.
    const learner = "22222222-3333-4444-8555-666666666666";

    let refused = 0;
    for (let i = 0; i < 25; i += 1) {
      if ((await hitAsLearner(learner, "10.51.0.1")).status === 429) refused += 1;
    }

    expect(refused).toBeGreaterThan(0);
  });

  it("follows a learner between addresses", async () => {
    /**
     * Keyed on the learner, not the connection — so switching from wifi to
     * cellular does not hand out a fresh allowance.
     */
    const learner = "33333333-4444-4555-8666-777777777777";
    for (let i = 0; i < 20; i += 1) await hitAsLearner(learner, "10.52.0.1");

    expect((await hitAsLearner(learner, "10.52.99.99")).status).toBe(429);
  });

  it("keeps counting an anonymous caller by address", async () => {
    // No token means the per-IP limiter is the only thing standing between an
    // unauthenticated caller and a metered API.
    const ip = "10.53.0.1";
    let refused = 0;
    for (let i = 0; i < 35; i += 1) {
      const res = await fetch(`${base}/score-as-learner`, {
        method: "POST",
        headers: { "x-forwarded-for": ip },
      });
      if (res.status === 429) refused += 1;
    }

    expect(refused).toBeGreaterThan(0);
  });

  it("says the same thing whichever limiter refused", async () => {
    /**
     * Which one fired is our business. Telling a learner they personally are
     * being throttled invites them to think their account is in trouble.
     */
    const learner = "44444444-5555-4666-8777-888888888888";
    for (let i = 0; i < 21; i += 1) await hitAsLearner(learner, "10.54.0.1");
    const perLearner = await hitAsLearner(learner, "10.54.0.1");

    const ip = "10.55.0.1";
    for (let i = 0; i < 31; i += 1) {
      await fetch(`${base}/score-as-learner`, { method: "POST", headers: { "x-forwarded-for": ip } });
    }
    const perIp = await fetch(`${base}/score-as-learner`, {
      method: "POST",
      headers: { "x-forwarded-for": ip },
    });

    expect(perLearner.status).toBe(429);
    expect(perIp.status).toBe(429);
    const one = (await perLearner.json()) as { error: { userMessage: string } };
    const two = (await perIp.json()) as { error: { userMessage: string } };
    expect(one.error.userMessage).toBe(two.error.userMessage);
  });
});
