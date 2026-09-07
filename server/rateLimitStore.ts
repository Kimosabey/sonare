/**
 * A rate-limit store that survives a restart and is shared between instances.
 *
 * `express-rate-limit` with no store configured uses its in-memory default,
 * which means the ceiling this project relies on to protect a metered Azure
 * API has three holes: a restart hands out a fresh budget, a second instance
 * doubles the effective limit, and neither is visible until a bill arrives.
 * rateLimit.ts's own comment calls the endpoint "an open proxy to a metered
 * Azure API with no auth in front of it", which is exactly why the limiter
 * needs to be real.
 *
 * Layered the same way the spend ceiling is (services/index.ts): Mongo is
 * authoritative, and an in-process map sits underneath for when it is not
 * reachable. A database outage must not become a total product outage, and a
 * per-process limit still bounds abuse — it does not vanish, it just becomes
 * as good as what shipped before this file existed.
 *
 * Written against the driver rather than adding a package. The Store contract
 * is three methods, and a dependency for three methods is a poor trade.
 */

import type { Store, ClientRateLimitInfo, Options } from "express-rate-limit";
import { getDb } from "./db.js";
import { logger } from "./logger.js";

interface WindowDocument {
  _id: string;
  hits: number;
  expiresAt: Date;
}

/** One process's own view, used only while Mongo is unreachable. */
interface LocalWindow {
  hits: number;
  resetAt: number;
}

export class MongoRateLimitStore implements Store {
  /**
   * Distinguishes one limiter's keys from another's in a shared collection.
   * Without it the scoring limiter and the diagnostics limiter would share a
   * budget, and the tighter one would starve the looser.
   */
  private readonly namespace: string;

  private windowMs = 60_000;

  private readonly local = new Map<string, LocalWindow>();

  /**
   * express-rate-limit reads this to decide whether it may trust per-process
   * bookkeeping. False, because the whole point is that the count is shared.
   */
  public localKeys = false;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  /** Called by express-rate-limit with the resolved options. */
  public init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  /**
   * Fixed windows, floored to the interval — the same shape as the in-memory
   * store this replaces, so the limits keep their existing meaning. It also
   * makes the document id self-expiring: a new window is a new id, so an old
   * one is never read again and only has to be swept, never reset.
   */
  private windowStart(now: number): number {
    return Math.floor(now / this.windowMs) * this.windowMs;
  }

  private documentId(key: string, windowStart: number): string {
    return `${this.namespace}:${key}:${windowStart}`;
  }

  public async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = Date.now();
    const start = this.windowStart(now);
    const resetAt = start + this.windowMs;

    try {
      const db = await getDb();
      const updated = await db.collection<WindowDocument>("ratelimits").findOneAndUpdate(
        { _id: this.documentId(key, start) },
        {
          $inc: { hits: 1 },
          // Two windows past the end, so a clock skew between instances
          // cannot expire a window that another one is still counting in.
          $setOnInsert: { expiresAt: new Date(resetAt + this.windowMs * 2) },
        },
        { upsert: true, returnDocument: "after" },
      );

      if (updated !== null) {
        return { totalHits: updated.hits, resetTime: new Date(resetAt) };
      }
      // No document and no error should not happen, but guessing "one hit"
      // would be the permissive guess — fall through to the local count.
      logger.warn({ key: this.namespace }, "[ratelimit] upsert returned nothing — counting locally");
    } catch (err) {
      logger.error({ err, limiter: this.namespace }, "[ratelimit] shared store unavailable — counting locally");
    }

    return this.incrementLocally(key, now, resetAt);
  }

  /**
   * The fallback. Deliberately not merged with the shared count: mixing a
   * partial local figure into a shared one produces a number that describes
   * neither, and the useful property here is that the limit still exists at
   * all rather than that it is exact.
   */
  private incrementLocally(key: string, now: number, resetAt: number): ClientRateLimitInfo {
    const existing = this.local.get(key);
    if (existing === undefined || existing.resetAt <= now) {
      this.local.set(key, { hits: 1, resetAt });
      this.sweepLocal(now);
      return { totalHits: 1, resetTime: new Date(resetAt) };
    }
    existing.hits += 1;
    return { totalHits: existing.hits, resetTime: new Date(existing.resetAt) };
  }

  /**
   * Bounded, because this map is keyed by client IP and would otherwise grow
   * for as long as an outage lasts — a slow leak that only appears when the
   * system is already unhealthy.
   */
  private sweepLocal(now: number): void {
    if (this.local.size < 10_000) return;
    for (const [key, window] of this.local) {
      if (window.resetAt <= now) this.local.delete(key);
    }
  }

  public async decrement(key: string): Promise<void> {
    const start = this.windowStart(Date.now());
    const local = this.local.get(key);
    if (local !== undefined && local.hits > 0) local.hits -= 1;

    try {
      const db = await getDb();
      await db
        .collection<WindowDocument>("ratelimits")
        .updateOne({ _id: this.documentId(key, start), hits: { $gt: 0 } }, { $inc: { hits: -1 } });
    } catch (err) {
      // Only reached with skipSuccessfulRequests/skipFailedRequests, neither
      // of which this project sets. A missed decrement is one request's worth
      // of over-counting, never an under-count.
      logger.error({ err, limiter: this.namespace }, "[ratelimit] failed to decrement");
    }
  }

  public async resetKey(key: string): Promise<void> {
    const start = this.windowStart(Date.now());
    this.local.delete(key);

    try {
      const db = await getDb();
      await db.collection<WindowDocument>("ratelimits").deleteOne({ _id: this.documentId(key, start) });
    } catch (err) {
      logger.error({ err, limiter: this.namespace }, "[ratelimit] failed to reset a key");
    }
  }
}

/**
 * Erases a learner's rate-limit windows. Part of a deletion request.
 *
 * Needed the moment a limiter started keying on the learner rather than the
 * address: the document ids then contain the learner id, so a deletion that
 * skipped this collection would leave them behind. Caught by the end-to-end
 * deletion test, which asserts that *no* stored document mentions the learner
 * — written that way precisely so a collection added later gets swept into the
 * same assertion instead of being quietly missed.
 *
 * They expire on their own within minutes, so this is a small thing. It is
 * also the difference between a deletion promise that is absolute and one that
 * is absolute-with-an-asterisk, and the asterisk is not worth keeping.
 *
 * A scan over `_id`, which is fine here: a deletion request is rare and this
 * collection is swept continuously by its TTL, so it is never large.
 */
export async function deleteRateLimitsFor(learnerId: string): Promise<number> {
  try {
    const db = await getDb();
    const result = await db.collection<WindowDocument>("ratelimits").deleteMany({
      // Anchored on the separator so a learner id can only match its own key
      // segment, never a namespace or a window boundary that happens to
      // contain the same characters.
      _id: { $regex: `:${escapeForRegex(learnerId)}:` },
    });
    return result.deletedCount;
  } catch (err) {
    logger.error({ err }, "[ratelimit] failed to clear a learner's windows");
    return 0;
  }
}

/** So an id can never be read as a pattern. */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
