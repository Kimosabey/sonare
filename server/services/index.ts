/**
 * Provider selection. The one place that knows a vendor name (R12) — when
 * SpeechAce arrives, it is a case in this switch plus one new file.
 */

import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import { AzureSpeechProvider } from "./azureSpeech.js";
import type { PronunciationResult, ScoringProvider } from "./types.js";
import { numberFromEnv } from "../env.js";
import { releaseScoringCall, reserveScoringCall } from "../counters.js";
import { increment } from "../infra/metrics.js";

let cached: ScoringProvider | null = null;

export function getScoringProvider(): ScoringProvider {
  if (cached) return cached;

  const name = process.env.PRONUNCIATION_PROVIDER ?? "azure";

  switch (name) {
    case "azure":
      cached = withDailyCap(new AzureSpeechProvider(process.env.AZURE_SPEECH_KEY, process.env.AZURE_SPEECH_REGION));
      return cached;
    default:
      throw new AppError({
        code: "MISCONFIGURED",
        domain: "server",
        message: `unknown PRONUNCIATION_PROVIDER: ${name}`,
        userMessage: "Scoring is not available right now.",
      });
  }
}

// The cap this file exists to enforce, so it must not be readable as NaN:
// `count >= NaN` is false and the ceiling disappears entirely. See env.ts.
const MAX_DAILY_SCORING_CALLS = numberFromEnv("MAX_DAILY_SCORING_CALLS", 2000, { integer: true });

/**
 * A ceiling independent of and beneath the per-IP rate limit
 * (rateLimit.ts): that one bounds abuse from a single caller, this one
 * bounds total spend regardless of how many IPs a caller spreads across.
 * Wraps whichever provider is active rather than living inside
 * AzureSpeechProvider — the cap applies to "scoring calls," not to Azure
 * specifically, so it stays correct if SpeechAce arrives (R12).
 *
 * Two layers, and the order matters.
 *
 * The shared counter (counters.ts) is authoritative. It is one document
 * updated atomically, so the ceiling now survives a restart and is not
 * multiplied by running a second instance — the hole this commit closes.
 *
 * The in-process count remains underneath it as the **outage** ceiling, and
 * only that. When the counter is unreachable the local figure applies, which
 * bounds spend at instances × cap rather than leaving it unbounded, and keeps
 * learners scoring through a database outage.
 *
 * That second layer is a deliberate departure from "fail closed", which is
 * what env.ts does for numeric config and what this file's plan originally
 * called for. Refusing outright would convert a database outage into a total
 * product outage, and the cap exists to bound *cost*, not to gate access — a
 * local ceiling still bounds cost. Fail-closed is right when the alternative
 * is unbounded; here the alternative is bounded and the learner keeps working.
 */
function withDailyCap(provider: ScoringProvider): ScoringProvider {
  let localCount = 0;
  let localWindow = startOfUtcDay();

  /** The outage path: enforce this process's own share and say so loudly. */
  function reserveLocally(): boolean {
    const currentWindow = startOfUtcDay();
    if (currentWindow !== localWindow) {
      localWindow = currentWindow;
      localCount = 0;
    }
    if (localCount >= MAX_DAILY_SCORING_CALLS) return false;
    localCount += 1;
    return true;
  }

  function atCap(): AppError {
    increment("scoring.refused.cap");
    logger.warn({ limit: MAX_DAILY_SCORING_CALLS }, "[services] daily scoring cap reached");
    return new AppError({
      code: "PROVIDER_UNAVAILABLE",
      domain: "server",
      message: `daily scoring cap of ${MAX_DAILY_SCORING_CALLS} reached`,
      userMessage: "Scoring has reached its daily limit. Please try again tomorrow.",
    });
  }

  return {
    name: provider.name,
    async score(wav: Buffer, referenceText: string, language: string): Promise<PronunciationResult> {
      const reservation = await reserveScoringCall(MAX_DAILY_SCORING_CALLS);

      if (reservation.allowed) {
        // Keep the local figure in step, so a mid-day outage does not hand out
        // a second full allowance on top of what has already been spent.
        localCount = Math.max(localCount, reservation.calls);
        try {
          return await provider.score(wav, referenceText, language);
        } catch (err) {
          /**
           * Give the reservation back when nothing was spent.
           *
           * The reservation has to come first — reserving after the call would
           * let N concurrent requests each pass an un-incremented check and
           * overshoot the cap by N. But the provider can refuse without
           * spending anything: an open breaker declines at the top of
           * `score()`, before the SDK is touched.
           *
           * Measured before this: **203 reservations for 6 provider calls and
           * 0 billable seconds.** A sustained outage burnt the whole day and
           * then told every learner scoring had hit its daily limit, having
           * spent nothing. The ceiling was bounding availability rather than a
           * bill.
           *
           * Keyed on the error's own `providerNotCalled` and never on the
           * code: `PROVIDER_UNAVAILABLE` is raised from a dozen places, some
           * of them after a call that was genuinely paid for. Anything that
           * cannot prove it was free stays counted, which errs toward
           * spending less than the cap allows — the safe direction here.
           */
          if (err instanceof AppError && err.providerNotCalled) {
            await releaseScoringCall();
            localCount = Math.max(0, localCount - 1);
          }
          throw err;
        }
      }

      if (reservation.reason === "at-cap") throw atCap();

      // Unavailable. Fall back to this process's own ceiling.
      logger.error(
        { limit: MAX_DAILY_SCORING_CALLS, localCount },
        "[services] shared scoring counter unavailable — falling back to the in-process ceiling",
      );
      if (!reserveLocally()) throw atCap();
      return provider.score(wav, referenceText, language);
    },
  };
}

function startOfUtcDay(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
