/**
 * Provider selection. The one place that knows a vendor name (R12) — when
 * SpeechAce arrives, it is a case in this switch plus one new file.
 */

import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import { AzureSpeechProvider } from "./azureSpeech.js";
import type { PronunciationResult, ScoringProvider } from "./types.js";
import { numberFromEnv } from "../env.js";

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
 * In-process state, same as the per-IP limiter and the circuit breaker in
 * azureSpeech.ts — resets on restart, doesn't share state across multiple
 * instances. Adequate for the current single-process deployment; a real
 * multi-instance rollout would need this backed by Mongo or similar.
 */
function withDailyCap(provider: ScoringProvider): ScoringProvider {
  let count = 0;
  let windowStart = startOfUtcDay();

  return {
    name: provider.name,
    score(wav: Buffer, referenceText: string, language: string): Promise<PronunciationResult> {
      const currentWindow = startOfUtcDay();
      if (currentWindow !== windowStart) {
        windowStart = currentWindow;
        count = 0;
      }

      if (count >= MAX_DAILY_SCORING_CALLS) {
        logger.warn({ limit: MAX_DAILY_SCORING_CALLS }, "[services] daily scoring cap reached");
        throw new AppError({
          code: "PROVIDER_UNAVAILABLE",
          domain: "server",
          message: `daily scoring cap of ${MAX_DAILY_SCORING_CALLS} reached`,
          userMessage: "Scoring has reached its daily limit. Please try again tomorrow.",
        });
      }

      count += 1;
      return provider.score(wav, referenceText, language);
    },
  };
}

function startOfUtcDay(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
