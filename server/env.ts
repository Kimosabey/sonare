/**
 * Numeric configuration that fails closed.
 *
 * Every numeric setting on this server was read as
 * `Number(process.env.X ?? default)`, which is correct for an unset variable
 * and silently catastrophic for a *malformed* one. `Number("fifteen")` is NaN,
 * and every comparison against NaN is false — so a typo does not raise, it
 * removes the guard:
 *
 *   MAX_DAILY_SCORING_CALLS  ->  `count >= NaN` is false  ->  no spend cap
 *   MAX_AUDIO_SECONDS        ->  duration check passes everything
 *   (upload.ts) fileSize     ->  no byte ceiling on an in-memory upload
 *   RETENTION_DAYS           ->  a TTL index of NaN seconds
 *
 * Three of those are money or memory, on an endpoint with no authentication
 * in front of it. The failure mode is the worst available: the server starts,
 * every request succeeds, and the only signal is the bill.
 *
 * So a value that cannot be read is refused rather than propagated, and the
 * documented default is used instead. Refusing loudly matters as much as
 * refusing — an operator who mistyped a limit needs to be told, or they will
 * believe the limit they wrote is the limit in force.
 */

import { logger } from "./logger.js";

export interface NumberOptions {
  /** Smallest accepted value. Anything below falls back. Default: greater than zero. */
  min?: number;
  /** Largest accepted value, when an absurd setting is as dangerous as a missing one. */
  max?: number;
  /** Accept a non-integer, e.g. MIN_AUDIO_SECONDS = 0.25. Default true. */
  integer?: boolean;
}

/**
 * Reads a positive number from the environment, or returns `fallback`.
 *
 * An unset variable is not a problem and is not logged — that is the normal
 * case, and the default is the documented behaviour. A *present but unusable*
 * value is logged at warn, because someone wrote it on purpose.
 */
export function numberFromEnv(name: string, fallback: number, options: NumberOptions = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  const min = options.min ?? Number.MIN_VALUE;
  const max = options.max ?? Number.POSITIVE_INFINITY;

  const reason =
    !Number.isFinite(parsed)
      ? "not a number"
      : parsed < min
        ? `below the minimum of ${min}`
        : parsed > max
          ? `above the maximum of ${max}`
          : options.integer === true && !Number.isInteger(parsed)
            ? "not a whole number"
            : null;

  if (reason !== null) {
    logger.warn(
      { setting: name, provided: raw, using: fallback, reason },
      `${name} is ${reason} — falling back to ${fallback}. The value you set is NOT in force.`,
    );
    return fallback;
  }

  return parsed;
}

/**
 * Reads an optional rate. Returns null when unset *or* unusable, because
 * spend.ts's own principle is that a wrong number shown as money is worse
 * than no number at all — nobody re-checks a figure that looks authoritative.
 */
export function optionalNumberFromEnv(name: string, options: NumberOptions = {}): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;

  const parsed = Number(raw);
  const min = options.min ?? 0;
  const max = options.max ?? Number.POSITIVE_INFINITY;

  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    logger.warn(
      { setting: name, provided: raw, reason: "not a usable number" },
      `${name} could not be read as a number — reporting usage without cost rather than showing a wrong figure as money.`,
    );
    return null;
  }

  return parsed;
}
