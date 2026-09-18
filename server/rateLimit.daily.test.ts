/**
 * The daily ceiling exists, is wired in, and is the per-learner one.
 *
 * This is a source-level check on purpose, and the reason is the defect it
 * replaces. `MAX_DAILY_SCORING_CALLS` has existed for a long time: read by
 * `server/spend.ts`, reported by the health endpoint, alerted on by
 * `server/infra/alerts.ts`, and **consulted by no route, ever**. The alert even
 * said "calls keep succeeding until the cap, then they stop". They did not.
 *
 * Nothing caught it because every test asked whether the number was computed
 * correctly, and it was. The thing that was missing was a line in a route, and
 * a line that is absent is invisible to a test of the thing it was supposed to
 * call. So this reads the route.
 *
 * A behavioural test would be better and is not proportionate: the limiter is
 * constructed at import time from the environment, so exercising it means
 * sixty HTTP requests against a live server to prove the sixty-first fails.
 * These assertions are narrower and honest about being narrower.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const limits = readFileSync(new URL("./rateLimit.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("./routes/pronunciation.ts", import.meta.url), "utf8");
const alerts = readFileSync(new URL("./infra/alerts.ts", import.meta.url), "utf8");

describe("the daily scoring ceiling", () => {
  it("is actually mounted on the scoring route, not merely imported", () => {
    /**
     * The whole point, and the first version of this got it wrong: it asserted
     * the name appeared in the file, which the **import** satisfies on its
     * own. Deleting the middleware line left the import behind and the test
     * passed — reproducing, in the test written to catch it, exactly the
     * defect it exists for.
     *
     * So the import is cut away and the rest of the file is what is searched.
     */
    const body = route.slice(route.indexOf('from "../rateLimit.js";'));

    expect(body).toMatch(/perLearnerDailyScoringLimiter,/);
    // And in the chain, ahead of the handler rather than anywhere at all.
    expect(body).toMatch(/perLearnerDailyScoringLimiter,\s*(\/\/[^\n]*\n\s*)*\(req: Request/);
  });

  it("is a day long", () => {
    expect(limits).toMatch(/windowMs:\s*86_400_000/);
  });

  /**
   * Per learner, not global — and this is the assertion that matters most.
   *
   * A global daily gate stops a class mid-lesson: thirty pupils in one period
   * spend it together and the thirty-first take fails for everybody, including
   * learners who had done nothing. Keyed per learner, the worst case is one
   * person who has already practised six times today.
   */
  it("is keyed on the learner and skips anonymous callers", () => {
    const block = limits.slice(limits.indexOf("perLearnerDailyScoringLimiter"));

    expect(block).toMatch(/keyGenerator:.*learnerIdFrom/s);
    expect(block).toMatch(/skip:.*learnerIdFrom\(res\) === null/s);
  });

  /**
   * It must not publish `RateLimit-*` headers. Running last, it would replace
   * the per-minute budget a client paces against with a daily figure that will
   * almost never bite — advertising 59 remaining while the next request is
   * about to be refused for pace.
   */
  it("leaves the rate-limit headers to the per-minute limiter", () => {
    const block = limits.slice(limits.indexOf("perLearnerDailyScoringLimiter"));

    expect(block.slice(0, block.indexOf("});"))).toMatch(/standardHeaders:\s*false/);
  });

  it("has its own namespace, so it shares no count with the per-minute one", () => {
    expect(limits).toMatch(/MongoRateLimitStore\("scoring-learner-daily"\)/);
    expect(limits).toMatch(/MongoRateLimitStore\("scoring-learner"\)/);
  });
});

describe("the global cap", () => {
  /**
   * Still an alarm, and now says so. The old wording promised a gate nobody
   * had built, which is precisely what stops somebody building it.
   */
  it("no longer claims that calls stop on it", () => {
    expect(alerts).not.toMatch(/calls keep succeeding until the cap, then they stop/);
  });

  it("is still watched, so a human sees the bill moving", () => {
    expect(alerts).toMatch(/capUsedFraction/);
    expect(alerts).toMatch(/dailySpend/);
  });
});
