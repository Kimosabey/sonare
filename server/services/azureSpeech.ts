/**
 * The ONLY file in the repo that imports the Azure SDK (R12). Everything above
 * this line sees `ScoringProvider` and `PronunciationResult`, nothing else.
 *
 * R9 / FR-15: per-phoneme detail comes from JSON.parse(result.json).NBest[0].
 * The typed PronunciationAssessmentResult carries only the four top-level
 * scores — reading it would silently cost us the data the POC exists to get.
 */

import sdk from "microsoft-cognitiveservices-speech-sdk";
import { z } from "zod";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import type { PronunciationResult, ScoredWord, ScoringProvider } from "./types.js";

/**
 * Azure's raw JSON, validated at the trust boundary rather than just cast.
 * `JSON.parse(result.json)` used to be trusted with a bare `as RawResult` —
 * this is the one real external-shape boundary in the scoring path, and a
 * provider-side schema change would otherwise surface as a confusing
 * downstream crash instead of a clean `indeterminate` result.
 *
 * `.passthrough()` throughout: this only validates the fields we read.
 * Azure adding new fields we don't model must never fail the parse — only a
 * field we depend on being the wrong *type* should.
 */
const RawAssessmentSchema = z.looseObject({
  PronScore: z.number().optional(),
  AccuracyScore: z.number().optional(),
  FluencyScore: z.number().optional(),
  CompletenessScore: z.number().optional(),
  ProsodyScore: z.number().optional(),
  ErrorType: z.string().optional(),
});

const RawPhonemeSchema = z.looseObject({
  Phoneme: z.string().optional(),
  PronunciationAssessment: RawAssessmentSchema.optional(),
});

const RawWordSchema = z.looseObject({
  Word: z.string().optional(),
  PronunciationAssessment: RawAssessmentSchema.optional(),
  Phonemes: z.array(RawPhonemeSchema).optional(),
});

const RawNBestSchema = z.looseObject({
  Display: z.string().optional(),
  PronunciationAssessment: RawAssessmentSchema.optional(),
  Words: z.array(RawWordSchema).optional(),
});

const RawResultSchema = z.looseObject({
  NBest: z.array(RawNBestSchema).optional(),
  ModelVersion: z.string().optional(),
});

type RawResult = z.infer<typeof RawResultSchema>;

const PROVIDER = "azure";

/**
 * Azure occasionally hangs rather than erroring. NFR-02 targets 2.5s total,
 * so waiting a full 20s before giving up made every request in a degraded
 * window pay the maximum possible latency, one at a time. 8s is generous
 * against the ~1.4s a healthy call actually takes (see README's verification
 * evidence) while capping the worst case to something a learner will read as
 * "failed", not "frozen".
 */
const RECOGNITION_TIMEOUT_MS = 8_000;

/**
 * A minimal circuit breaker. Without one, an Azure outage means every
 * concurrent request independently waits out the full timeout before
 * failing — no faster, and no cheaper, than just trying again. After a run
 * of consecutive failures, short-circuit new calls for a cooldown window
 * instead: fail fast, and stop spending timeout budget (and, if the failure
 * mode is throttling rather than an outage, Azure quota) on calls likely to
 * fail anyway.
 */
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;

export class AzureSpeechProvider implements ScoringProvider {
  readonly name = PROVIDER;

  private readonly key: string;
  private readonly region: string;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(key: string | undefined, region: string | undefined) {
    if (!key || !region) {
      throw new AppError({
        code: "MISCONFIGURED",
        domain: "server",
        message: "AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must both be set",
        userMessage: "Scoring is not available right now.",
      });
    }
    // Lowercase, no spaces — the single most common cause of a failing call.
    if (region !== region.trim().toLowerCase()) {
      throw new AppError({
        code: "MISCONFIGURED",
        domain: "server",
        message: `AZURE_SPEECH_REGION must be lowercase without spaces, got ${JSON.stringify(region)}`,
        userMessage: "Scoring is not available right now.",
      });
    }
    this.key = key;
    this.region = region;
  }

  async score(wav: Buffer, referenceText: string, language: string): Promise<PronunciationResult> {
    if (Date.now() < this.circuitOpenUntil) {
      throw new AppError({
        code: "PROVIDER_UNAVAILABLE",
        domain: "provider",
        message: `circuit open after ${this.consecutiveFailures} consecutive Azure failures`,
        userMessage: "Scoring is temporarily unavailable. Please try again in a moment.",
      });
    }

    try {
      const result = await this.recognize(wav, referenceText, language);
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      }
      throw err;
    }
  }

  private async recognize(wav: Buffer, referenceText: string, language: string): Promise<PronunciationResult> {
    const speechConfig = sdk.SpeechConfig.fromSubscription(this.key, this.region);
    speechConfig.speechRecognitionLanguage = language;

    const paConfig = new sdk.PronunciationAssessmentConfig(
      referenceText,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true, // miscue detection — FR-13
    );

    const audioConfig = sdk.AudioConfig.fromWavFileInput(wav);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    paConfig.applyTo(recognizer);

    let result: sdk.SpeechRecognitionResult;
    try {
      result = await withTimeout(
        new Promise<sdk.SpeechRecognitionResult>((resolve, reject) => {
          recognizer.recognizeOnceAsync(resolve, reject);
        }),
        RECOGNITION_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError({
        code: "PROVIDER_REJECTED",
        domain: "provider",
        // String(err) is an SDK message, not a credential.
        message: `azure recognition failed: ${String(err)}`,
        userMessage: "Scoring failed. Please try again.",
      });
    } finally {
      recognizer.close();
    }

    return toPronunciationResult(result);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AppError({
          code: "PROVIDER_TIMEOUT",
          domain: "provider",
          message: `azure did not respond within ${ms} ms`,
          userMessage: "Scoring timed out. Please try again.",
        }),
      );
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * R8/FR-16: anything short of a complete, usable assessment becomes
 * `indeterminate`. We never synthesise a number to fill a gap — "I couldn't get
 * a clear read" is the honest answer and the trustworthy one.
 */
export function toPronunciationResult(result: sdk.SpeechRecognitionResult): PronunciationResult {
  if (result.reason !== sdk.ResultReason.RecognizedSpeech) {
    return {
      indeterminate: true,
      provider: PROVIDER,
      reason: describeReason(result),
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(result.json);
  } catch {
    return { indeterminate: true, provider: PROVIDER, reason: "unparseable provider response" };
  }

  const validated = RawResultSchema.safeParse(parsedJson);
  if (!validated.success) {
    logger.warn({ issues: validated.error.issues }, "[azureSpeech] provider response did not match the expected shape");
    return { indeterminate: true, provider: PROVIDER, reason: "provider response did not match the expected shape" };
  }
  const raw: RawResult = validated.data;

  const nBest = raw.NBest?.[0];
  const pa = nBest?.PronunciationAssessment;

  // The four top-level scores are the minimum viable result. Missing any of
  // them means we cannot honestly report a score.
  if (
    !nBest ||
    !pa ||
    pa.PronScore === undefined ||
    pa.AccuracyScore === undefined ||
    pa.FluencyScore === undefined ||
    pa.CompletenessScore === undefined
  ) {
    return {
      indeterminate: true,
      provider: PROVIDER,
      reason: "no pronunciation assessment in provider response",
      ...(raw.ModelVersion ? { modelVersion: raw.ModelVersion } : {}),
    };
  }

  const words: ScoredWord[] = (nBest.Words ?? []).map((w) => ({
    word: w.Word ?? "",
    accuracy: w.PronunciationAssessment?.AccuracyScore ?? 0,
    errorType: w.PronunciationAssessment?.ErrorType ?? "None",
    phonemes: (w.Phonemes ?? []).map((p) => ({
      phoneme: p.Phoneme ?? "",
      accuracy: p.PronunciationAssessment?.AccuracyScore ?? 0,
    })),
  }));

  /**
   * Azure does NOT report silence as NoMatch. It returns RecognizedSpeech with
   * PronScore 0, Display ".", and every word marked Omission with no phonemes.
   * Taken at face value that becomes "you scored 0" — a fabricated number for a
   * recording we never actually measured, which is precisely what R8 forbids.
   *
   * Every word omitted and not one phoneme anywhere means the scorer found no
   * speech to assess. That is indeterminate, whatever the envelope claims.
   * A genuinely bad attempt still returns phonemes and a mix of error types.
   */
  const nothingAssessed =
    words.length > 0 &&
    words.every((w) => w.errorType === "Omission") &&
    words.every((w) => w.phonemes.length === 0);

  if (nothingAssessed) {
    return {
      indeterminate: true,
      provider: PROVIDER,
      reason: "no speech found to assess — every word was omitted",
      ...(raw.ModelVersion ? { modelVersion: raw.ModelVersion } : {}),
    };
  }

  return {
    indeterminate: false,
    provider: PROVIDER,
    ...(raw.ModelVersion ? { modelVersion: raw.ModelVersion } : {}),
    recognized: result.text ?? nBest.Display ?? "",
    overall: pa.PronScore,
    accuracy: pa.AccuracyScore,
    fluency: pa.FluencyScore,
    completeness: pa.CompletenessScore,
    // Absent for many languages. Only include it when Azure actually sent one.
    ...(pa.ProsodyScore === undefined ? {} : { prosody: pa.ProsodyScore }),
    words,
  };
}

function describeReason(result: sdk.SpeechRecognitionResult): string {
  const name = sdk.ResultReason[result.reason] ?? String(result.reason);
  if (result.reason === sdk.ResultReason.NoMatch) return "no speech recognised in the recording";
  if (result.reason === sdk.ResultReason.Canceled) {
    const details = sdk.CancellationDetails.fromResult(result);
    const cancelName = sdk.CancellationReason[details.reason] ?? String(details.reason);
    return `provider cancelled (${cancelName})`;
  }
  return `provider returned ${name}`;
}
