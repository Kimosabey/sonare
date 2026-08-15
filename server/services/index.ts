/**
 * Provider selection. The one place that knows a vendor name (R12) — when
 * SpeechAce arrives, it is a case in this switch plus one new file.
 */

import { AppError } from "../errors.js";
import { AzureSpeechProvider } from "./azureSpeech.js";
import type { ScoringProvider } from "./types.js";

let cached: ScoringProvider | null = null;

export function getScoringProvider(): ScoringProvider {
  if (cached) return cached;

  const name = process.env.PRONUNCIATION_PROVIDER ?? "azure";

  switch (name) {
    case "azure":
      cached = new AzureSpeechProvider(process.env.AZURE_SPEECH_KEY, process.env.AZURE_SPEECH_REGION);
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
