/**
 * The daily spend counters, shared and durable — one per paid provider.
 *
 * `spend:{day}` bounds scoring calls (Azure). `voice:{day}` bounds model-voice
 * synthesis characters (ElevenLabs) and lives at the bottom of this file. They
 * are separate documents on purpose: a day of generating audio must not be
 * able to consume the allowance for scoring learner attempts.
 *
 * The ceiling in services/index.ts is in-process state: it resets on restart
 * and is not shared between instances. Its own comment says so — "adequate for
 * the current single-process deployment" — which means today a restart loop
 * hands out a fresh allowance of paid provider calls every time, and a second
 * instance doubles the ceiling. That is the hole this closes.
 *
 * Note what this is *not*. spend.ts aggregates the `attempts` collection to
 * report what scoring has cost; it is a report, read by the diagnostics
 * screen, and it is not in the enforcement path. It also under-reports during
 * a Mongo outage, because attempts fall back to a local JSONL file — so it
 * cannot become the enforcement path either. Enforcement needs its own record,
 * written on the way in rather than derived from a side effect on the way out.
 *
 * Keyed on the **UTC** day, because that is how the provider bills. The
 * streak's local day (streakStore.ts) is a deliberate and separate choice: a
 * streak is a claim about the learner's calendar, a bill is a claim about
 * Azure's. Both are right; neither should be "fixed" to match the other.
 */

import { getDb } from "./db.js";
import { logger } from "./logger.js";
import { numberFromEnv } from "./env.js";

/**
 * How long a day's counter is kept.
 *
 * Long enough to answer a billing question, short enough that this collection
 * never becomes a data-retention concern of its own. It holds no learner
 * content — only counts.
 */
const RETENTION_DAYS = numberFromEnv("COUNTER_RETENTION_DAYS", 32, {
  integer: true,
  min: 1,
  max: 400,
});

/** Mongo's duplicate-key error. Meaningful here — see reserveScoringCall. */
const DUPLICATE_KEY = 11000;

export interface CounterDocument {
  _id: string;
  /** `YYYY-MM-DD`, UTC. Denormalised out of `_id` so it is queryable. */
  day: string;
  calls: number;
  audioSeconds: number;
  /** Rounded up per request, matching how the provider bills. */
  billableSeconds: number;
  indeterminateCalls: number;
  indeterminateSeconds: number;
  expiresAt: Date;
}

/**
 * The outcome of asking for permission to make a paid call.
 *
 * Three cases rather than a boolean, because the caller has to tell a learner
 * something different in each: at the cap is "try tomorrow", unavailable is
 * "try again shortly", and only `allowed` may proceed. Making `calls` null in
 * the unavailable case means the type will not let a caller report a count it
 * does not have.
 */
export type Reservation =
  | { allowed: true; calls: number }
  | { allowed: false; reason: "at-cap"; calls: number }
  | { allowed: false; reason: "unavailable"; calls: null };

/** `YYYY-MM-DD` in UTC. */
export function utcDay(when: Date = new Date()): string {
  const year = when.getUTCFullYear();
  const month = String(when.getUTCMonth() + 1).padStart(2, "0");
  const day = String(when.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function counterId(day: string): string {
  return `spend:${day}`;
}

function expiryFor(day: string): Date {
  const base = new Date(`${day}T00:00:00.000Z`);
  return new Date(base.getTime() + RETENTION_DAYS * 86_400_000);
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === DUPLICATE_KEY;
}

/**
 * Claims one call against today's cap, atomically.
 *
 * Increment-and-check rather than check-then-increment: the second has a race
 * in which two concurrent requests both read `cap - 1` and both proceed. The
 * conditional filter (`calls < cap`) plus `$inc` is one operation, so the
 * count can never exceed the cap however many requests arrive at once.
 *
 * The upsert is what makes the duplicate-key error meaningful. When the
 * document exists but `calls` has reached the cap, the filter matches nothing,
 * so Mongo tries to *insert* — and collides with the `_id` already there.
 * That collision is precisely "we are at the cap", not an error to log.
 *
 * **Fails closed.** If the counter cannot be read or written, no call is
 * allowed. This is the same choice env.ts makes for numeric config, and for
 * the same reason: a ceiling that disappears when the system is unhealthy is
 * not a ceiling. The cost of being wrong in this direction is a learner told
 * to try again shortly; in the other direction it is an unbounded bill.
 */
export async function reserveScoringCall(cap: number, when: Date = new Date()): Promise<Reservation> {
  // A cap of zero means no scoring, matching the existing `count >= cap`
  // behaviour. Checked before the query because an upsert against a filter
  // nothing can satisfy would otherwise insert a first call and allow it.
  if (!Number.isFinite(cap) || cap <= 0) return { allowed: false, reason: "at-cap", calls: 0 };

  const day = utcDay(when);
  try {
    const db = await getDb();
    const updated = await db.collection<CounterDocument>("counters").findOneAndUpdate(
      { _id: counterId(day), calls: { $lt: cap } },
      {
        $inc: { calls: 1 },
        $setOnInsert: {
          day,
          audioSeconds: 0,
          billableSeconds: 0,
          indeterminateCalls: 0,
          indeterminateSeconds: 0,
          expiresAt: expiryFor(day),
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    // No document and no collision means the filter matched nothing and the
    // upsert did not fire — treat as at the cap rather than assuming room.
    if (updated === null) return { allowed: false, reason: "at-cap", calls: cap };
    return { allowed: true, calls: updated.calls };
  } catch (err) {
    if (isDuplicateKey(err)) return { allowed: false, reason: "at-cap", calls: cap };
    logger.error({ err, day }, "[counters] could not reserve a scoring call — refusing");
    return { allowed: false, reason: "unavailable", calls: null };
  }
}

/**
 * ── the model voice's own ceiling ────────────────────────────────────────────
 *
 * A second paid provider needs a second cap, and it needs to be a *separate*
 * one. Sharing `spend:` would let a day of generating model audio eat the
 * allowance for scoring learner attempts, which is the thing learners are
 * actually here for — one provider's budget must not be able to starve the
 * other.
 *
 * Counted in **characters**, because that is how ElevenLabs bills. A call
 * count would be the wrong unit by an order of magnitude between a two-word
 * greeting and a fourteen-word sentence.
 */
export interface VoiceCounterDocument {
  /** `voice:{YYYY-MM-DD}`, UTC — the same calendar the bill uses. */
  _id: string;
  day: string;
  characters: number;
  phrases: number;
  expiresAt: Date;
}

/**
 * Mirrors `Reservation`, in characters. Separate type rather than a reused one
 * so a caller cannot read a character figure as a call count.
 */
export type CharacterReservation =
  | { allowed: true; characters: number }
  | { allowed: false; reason: "at-cap"; characters: number }
  | { allowed: false; reason: "unavailable"; characters: null };

function voiceCounterId(day: string): string {
  return `voice:${day}`;
}

/**
 * Claims `characters` against today's synthesis cap, atomically.
 *
 * The same increment-and-check shape `reserveScoringCall` uses, and for the
 * same reason: check-then-increment lets two concurrent runs both read
 * `cap - 1` and both proceed. `{ characters: { $lte: cap - characters } }`
 * plus `$inc` is one operation, so the total can never pass the cap however
 * many callers arrive at once.
 *
 * **Fails closed.** An unreadable counter allows nothing. There is no
 * in-process fallback of the kind services/index.ts keeps for scoring, and the
 * difference is deliberate: refusing to score turns a database outage into a
 * product outage for a learner mid-attempt, while refusing to *generate* audio
 * costs a background run that can simply be re-run — and the fallback voice is
 * still there in the meantime. Nothing a learner is waiting on passes through
 * here.
 *
 * A request larger than the whole cap is refused rather than clamped: a
 * partial phrase is not a phrase.
 */
export async function reserveSynthesisCharacters(
  cap: number,
  characters: number,
  when: Date = new Date(),
): Promise<CharacterReservation> {
  if (!Number.isFinite(cap) || cap <= 0) return { allowed: false, reason: "at-cap", characters: 0 };
  if (!Number.isFinite(characters) || characters < 1) {
    return { allowed: false, reason: "at-cap", characters: 0 };
  }
  // Checked before the query: an upsert against a filter nothing can satisfy
  // would otherwise insert a first reservation and allow it.
  if (characters > cap) return { allowed: false, reason: "at-cap", characters: cap };

  const day = utcDay(when);
  try {
    const db = await getDb();
    const updated = await db.collection<VoiceCounterDocument>("counters").findOneAndUpdate(
      { _id: voiceCounterId(day), characters: { $lte: cap - characters } },
      {
        $inc: { characters, phrases: 1 },
        $setOnInsert: { day, expiresAt: expiryFor(day) },
      },
      { upsert: true, returnDocument: "after" },
    );

    if (updated === null) return { allowed: false, reason: "at-cap", characters: cap };
    return { allowed: true, characters: updated.characters };
  } catch (err) {
    // The upsert colliding on `_id` *is* "we are at the cap": the filter
    // matched nothing because the day's total is already too high, so Mongo
    // tried to insert over a document that exists.
    if (isDuplicateKey(err)) return { allowed: false, reason: "at-cap", characters: cap };
    logger.error({ err, day }, "[counters] could not reserve synthesis characters — refusing");
    return { allowed: false, reason: "unavailable", characters: null };
  }
}

/** Today's synthesis counter, or null when there is none or it cannot be read. */
export async function readVoiceCounter(when: Date = new Date()): Promise<VoiceCounterDocument | null> {
  const day = utcDay(when);
  try {
    const db = await getDb();
    return await db.collection<VoiceCounterDocument>("counters").findOne({ _id: voiceCounterId(day) });
  } catch (err) {
    logger.error({ err, day }, "[counters] failed to read the synthesis counter");
    return null;
  }
}

export interface CallOutcome {
  seconds: number;
  indeterminate: boolean;
}

/**
 * Records what a call actually consumed, after the fact.
 *
 * Separate from the reservation because the duration is only known once the
 * audio has been parsed, and because these figures are for reporting rather
 * than enforcement — so unlike the reservation, a failure here is swallowed.
 * Losing a second of accounting must never cost a learner their score.
 *
 * `billableSeconds` rounds up per call, matching the provider's per-request
 * rounding. Summing raw durations understates the bill, worst on the short
 * clips this product is mostly made of.
 */
export async function recordCallOutcome(outcome: CallOutcome, when: Date = new Date()): Promise<void> {
  const seconds = Number.isFinite(outcome.seconds) && outcome.seconds > 0 ? outcome.seconds : 0;
  const billable = Math.ceil(seconds);
  const day = utcDay(when);

  try {
    const db = await getDb();
    await db.collection<CounterDocument>("counters").updateOne(
      { _id: counterId(day) },
      {
        $inc: {
          audioSeconds: seconds,
          billableSeconds: billable,
          indeterminateCalls: outcome.indeterminate ? 1 : 0,
          indeterminateSeconds: outcome.indeterminate ? billable : 0,
        },
        $setOnInsert: { day, calls: 0, expiresAt: expiryFor(day) },
      },
      { upsert: true },
    );
  } catch (err) {
    // Accounting only. The learner already has their score.
    logger.error({ err, day }, "[counters] failed to record call outcome");
  }
}

/** Today's counter, or null when there is none or it cannot be read. */
export async function readCounter(when: Date = new Date()): Promise<CounterDocument | null> {
  const day = utcDay(when);
  try {
    const db = await getDb();
    return await db.collection<CounterDocument>("counters").findOne({ _id: counterId(day) });
  } catch (err) {
    logger.error({ err, day }, "[counters] failed to read counter");
    return null;
  }
}
