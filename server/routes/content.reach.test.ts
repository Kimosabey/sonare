/**
 * Who a removal reaches, and why this endpoint refuses rather than guesses.
 *
 * The publish diff asks this before an operator removes an activity. The
 * number it returns is the only thing on that screen that can talk an operator
 * out of an irreversible publish, so every property here is about the ways a
 * *wrong* number would read as a safe one.
 *
 * Real Express on an ephemeral port; the store is mocked, because what is
 * under test is the route's handling of the answer rather than the Mongo
 * pipeline that produces it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const countLearnersWithAttempts = vi.fn();

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../rateLimit.js", () => ({
  diagnosticsLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
  scoringLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
}));

vi.mock("../db.js", () => ({ getDb: () => Promise.resolve({}) }));

vi.mock("../store/progress.js", () => ({
  countLearnersWithAttempts: (slug: string, ids: number[]) =>
    countLearnersWithAttempts(slug, ids) as Promise<Map<number, number>>,
}));

const TOKEN = "s3cret-authoring-token";
const ORIGINAL = process.env.DIAGNOSTICS_TOKEN;

let server: Server;
let base: string;

beforeAll(async () => {
  process.env.DIAGNOSTICS_TOKEN = TOKEN;
  const express = (await import("express")).default;
  const { contentRouter } = await import("./content.js");
  const app = express();
  app.use(express.json());
  app.use("/api/v1", contentRouter);
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (ORIGINAL === undefined) delete process.env.DIAGNOSTICS_TOKEN;
  else process.env.DIAGNOSTICS_TOKEN = ORIGINAL;
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  process.env.DIAGNOSTICS_TOKEN = TOKEN;
  countLearnersWithAttempts.mockResolvedValue(new Map<number, number>());
});

afterEach(() => {
  vi.clearAllMocks();
});

const auth = { "x-diagnostics-token": TOKEN };

function reach(query: string, headers: Record<string, string> = auth): Promise<Response> {
  return fetch(`${base}/api/v1/content/fr/reach?${query}`, { headers });
}

describe("the count it reports", () => {
  it("returns a learner count per activity asked about", async () => {
    countLearnersWithAttempts.mockResolvedValue(
      new Map([
        [4, 41],
        [7, 3],
      ]),
    );

    const response = await reach("activities=4,7");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug: "fr", reach: { "4": 41, "7": 3 } });
  });

  /**
   * The distinction the screen is built on. "Nobody has practised this" is a
   * removal an operator can wave through; "this was not asked about" is not an
   * answer at all. A zero defaulted into the gap would turn the second into
   * the first, silently, exactly where it costs most.
   */
  it("omits an activity nobody has attempted rather than reporting it as zero", async () => {
    countLearnersWithAttempts.mockResolvedValue(new Map([[4, 41]]));

    const body = (await (await reach("activities=4,7")).json()) as {
      reach: Record<string, number>;
    };

    expect(body.reach).toEqual({ "4": 41 });
    expect("7" in body.reach).toBe(false);
  });

  it("asks the store about exactly the activities named, once each", async () => {
    await reach("activities=4,7,4");
    expect(countLearnersWithAttempts).toHaveBeenCalledWith("fr", [4, 7]);
  });

  /**
   * An empty diff is the ordinary case — most publishes remove nothing — so
   * this path has to be quiet rather than an error. The route passes the empty
   * list straight down; the store's own early return is what keeps it off the
   * database, and `progress.reach.test.ts` pins that.
   */
  it("answers an empty question with an empty answer", async () => {
    const response = await reach("activities=");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug: "fr", reach: {} });
    expect(countLearnersWithAttempts).toHaveBeenCalledWith("fr", []);
  });
});

describe("what it refuses", () => {
  /**
   * Refused, not skipped. Dropping an id the route could not parse would
   * answer a question nobody asked, and the screen would read the missing key
   * as "nobody has practised that" — the reading that makes a removal look
   * safer than it is.
   */
  it("refuses an unparseable id instead of dropping it from the answer", async () => {
    for (const bad of ["4,abc", "4,-1", "0", "4,1.5", "4,%20"]) {
      const response = await reach(`activities=${bad}`);
      expect(response.status).toBe(400);
      expect(countLearnersWithAttempts).not.toHaveBeenCalled();
    }
  });

  it("refuses more ids than a diff could contain", async () => {
    const many = Array.from({ length: 65 }, (_, i) => i + 1).join(",");
    const response = await reach(`activities=${many}`);

    expect(response.status).toBe(400);
    expect(countLearnersWithAttempts).not.toHaveBeenCalled();
  });

  it("accepts a request at the cap", async () => {
    const atCap = Array.from({ length: 64 }, (_, i) => i + 1).join(",");
    expect((await reach(`activities=${atCap}`)).status).toBe(200);
  });

  /**
   * The same fail-closed posture as every other authoring endpoint: with no
   * token configured, this is off rather than open. It reports which
   * activities a learner population has practised, which is not a public fact.
   */
  it("is closed without a token", async () => {
    expect((await reach("activities=4", {})).status).toBe(401);
    expect(countLearnersWithAttempts).not.toHaveBeenCalled();
  });

  it("is closed when the server has no token configured at all", async () => {
    delete process.env.DIAGNOSTICS_TOKEN;
    expect((await reach("activities=4")).status).toBe(401);
    expect(countLearnersWithAttempts).not.toHaveBeenCalled();
  });

  it("refuses a slug that is not one", async () => {
    const response = await fetch(`${base}/api/v1/content/NOT%20A%20SLUG/reach?activities=4`, {
      headers: auth,
    });
    expect(response.status).toBe(400);
  });
});

describe("when the database is unreachable", () => {
  /**
   * 503 and no body, never an empty `reach`. An empty map is indistinguishable
   * from "this removal affects nobody", which is the single most dangerous
   * thing this endpoint could say when it in fact knows nothing.
   */
  it("says it could not check, rather than that nobody is affected", async () => {
    countLearnersWithAttempts.mockRejectedValue(new Error("no connection"));

    const response = await reach("activities=4");

    expect(response.status).toBe(503);
    const body = (await response.json()) as { reach?: unknown };
    expect(body.reach).toBeUndefined();
  });
});
