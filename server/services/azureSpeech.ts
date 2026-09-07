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
import { increment } from "../infra/metrics.js";
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

/**
 * Syllables carry what phonemes do not.
 *
 * `Phoneme` and `Syllable` come back as empty strings for every locale this
 * product ships — verified per locale with native TTS, and unchanged by
 * `phonemeAlphabet` (IPA and SAPI alike) or `nbestPhonemeCount`. `Grapheme`
 * is populated: across the ten French activity targets, 91 of 110 syllables
 * (83%) came back named, and 110 of 110 came back scored and timed.
 *
 * The misses are systematic rather than random — they cluster on elision and
 * hyphenation (allez-vous, m'appelle, j'habite, quarante-deux, L'addition),
 * where Azure cannot map a grapheme across the boundary. So a named syllable
 * is the normal case and an unnamed one is a known shape to fall back for,
 * not an anomaly.
 */
const RawSyllableSchema = z.looseObject({
  Syllable: z.string().optional(),
  Grapheme: z.string().optional(),
  PronunciationAssessment: RawAssessmentSchema.optional(),
  Offset: z.number().optional(),
  Duration: z.number().optional(),
});

const RawWordSchema = z.looseObject({
  Word: z.string().optional(),
  PronunciationAssessment: RawAssessmentSchema.optional(),
  Phonemes: z.array(RawPhonemeSchema).optional(),
  Syllables: z.array(RawSyllableSchema).optional(),
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

/**
 * Attempts per scoring call, including the first. Two means one retry.
 *
 * The number is decided by arithmetic, not taste — and the arithmetic needs
 * stating carefully, because the naive version is misleading.
 *
 * The client abandons the whole exchange after UPLOAD_TIMEOUT_MS (25s,
 * src/speech/scoring/client.ts) and one attempt costs up to
 * RECOGNITION_TIMEOUT_MS. Two attempts plus the backoff is 16.4s. *Three* is
 * 24.8s, which looks like it fits — and does not, because that 25s has to
 * cover uploading the WAV, parsing it, and sending the response as well.
 * Three attempts would leave 200ms for all of that, so the client would
 * abandon a request the server was still working on: the learner waits the
 * full 25 seconds and is *then* told it failed, which is strictly worse than
 * failing at 8.
 *
 * T15 in scripts/verify.mjs checks the arithmetic across the two files with an
 * explicit margin for that overhead. Written without the margin first, and it
 * passed at three attempts — which is exactly the change it exists to stop.
 */
export const MAX_PROVIDER_ATTEMPTS = 2;

/**
 * Pause before the retry.
 *
 * Short on purpose: a learner is watching a spinner, and the failures worth
 * retrying are a dropped connection or a single throttled request rather than
 * a queue that needs draining. Anything longer trades a real chance of
 * succeeding for a wait the learner can feel.
 */
export const RETRY_BACKOFF_MS = 400;

/** Exported so the budget check has something to read. */
export const PROVIDER_TIMEOUT_MS = RECOGNITION_TIMEOUT_MS;

/**
 * Whether a failure is worth trying again.
 *
 * `PROVIDER_TIMEOUT` and `PROVIDER_REJECTED` are the transport failures: the
 * SDK rejects for a dropped connection, a throttle, or a service error. Bad
 * audio does *not* arrive here — Azure returns that as a successful result
 * with no match, which becomes an indeterminate score, so it never reaches a
 * catch and can never be retried.
 *
 * `MISCONFIGURED` is never retried: a wrong key or region will be just as
 * wrong 400ms later. `PROVIDER_UNAVAILABLE` is the breaker's own signal, and
 * retrying past it would defeat the thing that exists to stop us calling a
 * provider that is down.
 *
 * One honest imprecision: the SDK collapses an auth failure into the same
 * rejection as a dropped connection, so a bad key costs one wasted retry per
 * call. Bounded by the breaker — three failed calls and it stops trying — and
 * not worth sniffing SDK message strings to avoid.
 */
function isWorthRetrying(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  return err.code === "PROVIDER_TIMEOUT" || err.code === "PROVIDER_REJECTED";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.recognize(wav, referenceText, language);
        this.consecutiveFailures = 0;
        return result;
      } catch (err) {
        lastError = err;
        if (attempt === MAX_PROVIDER_ATTEMPTS || !isWorthRetrying(err)) break;

        increment("scoring.provider.retried");
        logger.warn(
          { attempt, of: MAX_PROVIDER_ATTEMPTS, err },
          "[azure] transient failure — retrying once",
        );
        await delay(RETRY_BACKOFF_MS);
      }
    }

    /**
     * One failure per scoring call, not per attempt.
     *
     * The breaker's question is "is the provider usable", and a call that
     * failed after retrying is one unusable outcome. Counting attempts would
     * trip it after a call and a half, which is twitchy enough to open on a
     * single bad minute.
     *
     * The cost is stated plainly: with a retry, an outage now spends up to six
     * provider calls before the breaker opens rather than three. Bounded, and
     * the honest price of retrying at all.
     */
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    }
    throw lastError;
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
    // Ticks passed through unconverted — the client needs them to slice its
    // own recording, and converting twice is how rounding drift starts.
    syllables: (w.Syllables ?? []).map((sy) => ({
      grapheme: sy.Grapheme ?? "",
      accuracy: sy.PronunciationAssessment?.AccuracyScore ?? 0,
      offsetTicks: sy.Offset ?? 0,
      durationTicks: sy.Duration ?? 0,
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
