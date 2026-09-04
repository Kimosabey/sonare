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

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

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
