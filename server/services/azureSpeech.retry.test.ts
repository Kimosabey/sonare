/**
 * One retry, and everything it must refuse to retry.
 *
 * Retrying is the easy half. The dangerous half is retrying the wrong thing:
 * a take the provider judged unusable, a request the breaker has already
 * refused, or a configuration error that will be just as wrong 400ms later —
 * each of those turns one wasted call into a doubled bill and a slower failure
 * for the learner.
 *
 * The SDK is mocked at the module boundary so `score()` runs for real: the
 * loop, the breaker's counting, and the backoff are the things under test, and
 * none of them are observable through `toPronunciationResult` alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the fake recognizer does on each successive call. */
let behaviours: Array<"ok" | "nomatch" | "reject" | "hang"> = [];
let calls = 0;
let closed = 0;

const RESULT_REASON = { RecognizedSpeech: 3, NoMatch: 0, Canceled: 1 };

function scoredJson() {
  return JSON.stringify({
    NBest: [
      {
        Display: "Bonjour",
        PronunciationAssessment: { AccuracyScore: 88, FluencyScore: 90, CompletenessScore: 100, PronScore: 89 },
        Words: [
          {
            Word: "bonjour",
            PronunciationAssessment: { AccuracyScore: 88, ErrorType: "None" },
            Syllables: [{ Syllable: "bon", PronunciationAssessment: { AccuracyScore: 88 }, Offset: 0, Duration: 100 }],
            Phonemes: [],
          },
        ],
      },
    ],
  });
}

vi.mock("microsoft-cognitiveservices-speech-sdk", () => {
  class SpeechRecognizer {
    public recognizeOnceAsync(
      resolve: (r: unknown) => void,
      reject: (e: unknown) => void,
    ): void {
      const behaviour = behaviours[calls] ?? "ok";
      calls += 1;

      if (behaviour === "reject") {
        reject(new Error("connection reset by peer"));
        return;
      }
      if (behaviour === "hang") {
        // Never settles, so the recognition timeout is what resolves it.
        return;
      }
      resolve({
        reason: behaviour === "nomatch" ? RESULT_REASON.NoMatch : RESULT_REASON.RecognizedSpeech,
        json: behaviour === "nomatch" ? "" : scoredJson(),
        text: behaviour === "nomatch" ? "" : "Bonjour",
      });
    }

    public close(): void {
      closed += 1;
    }
  }

  return {
    default: {
      SpeechConfig: { fromSubscription: () => ({}) },
      AudioConfig: { fromWavFileInput: () => ({}) },
      PronunciationAssessmentConfig: class {
        public applyTo(): void {
          /* nothing to apply to a fake recognizer */
        }
      },
      PronunciationAssessmentGradingSystem: { HundredMark: 1 },
      PronunciationAssessmentGranularity: { Phoneme: 3 },
      SpeechRecognizer,
      ResultReason: RESULT_REASON,
      CancellationDetails: { fromResult: () => ({ reason: 0, errorDetails: "" }) },
      CancellationReason: { Error: 0 },
    },
  };
});

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WAV = Buffer.from([1, 2, 3]);

async function provider() {
  const { AzureSpeechProvider } = await import("./azureSpeech.js");
  return new AzureSpeechProvider("a-key", "southeastasia");
}

async function score(p: Awaited<ReturnType<typeof provider>>) {
  return p.score(WAV, "Bonjour", "fr-FR");
}

/** Runs a call to completion, driving the backoff timer as it waits. */
async function runWithTimers<T>(work: Promise<T>): Promise<T> {
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  // Enough to clear the 400ms backoff and any 8s recognition timeout.
  await vi.advanceTimersByTimeAsync(30_000);
  const outcome = await settled;
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

beforeEach(async () => {
  vi.resetModules();
  behaviours = [];
  calls = 0;
  closed = 0;
  const { resetMetrics } = await import("../infra/metrics.js");
  resetMetrics();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("retrying a transient failure", () => {
  it("succeeds on the second attempt", async () => {
    behaviours = ["reject", "ok"];
    const p = await provider();

    const result = await runWithTimers(score(p));

    expect(calls).toBe(2);
    expect(result.indeterminate).toBe(false);
  });

  it("retries a recognition timeout", async () => {
    // The other transient shape: the SDK never calls back at all.
    behaviours = ["hang", "ok"];
    const p = await provider();

    const result = await runWithTimers(score(p));

    expect(calls).toBe(2);
    expect(result.indeterminate).toBe(false);
  });

  it("gives up after the second attempt rather than looping", async () => {
    behaviours = ["reject", "reject", "reject"];
    const p = await provider();

    await expect(runWithTimers(score(p))).rejects.toThrow();

    expect(calls).toBe(2);
  });

  it("counts the retry, so a flaky provider is visible", async () => {
    behaviours = ["reject", "ok"];
    const p = await provider();
    await runWithTimers(score(p));

    const { snapshot } = await import("../infra/metrics.js");
    expect(snapshot().counters["scoring.provider.retried"]).toBe(1);
  });

  it("closes the recognizer on every attempt", async () => {
    // One leaked recognizer per retry would be a slow resource leak that only
    // appears while the provider is already unhealthy.
    behaviours = ["reject", "ok"];
    const p = await provider();
    await runWithTimers(score(p));

    expect(closed).toBe(2);
  });

  it("does not retry a call that succeeded first time", async () => {
    behaviours = ["ok"];
    const p = await provider();

    await runWithTimers(score(p));

    expect(calls).toBe(1);
  });
});

describe("what must never be retried", () => {
  it("does not retry an unusable take", async () => {
    /**
     * The one that would do real harm. Azure returns bad audio as a
     * *successful* call with no match, which becomes an indeterminate score —
     * so it never reaches a catch and can never be retried. Asserted rather
     * than assumed, because a retry here would double the bill on exactly the
     * takes that produce no value, and R8 says the honest answer is already
     * in hand after the first call.
     */
    behaviours = ["nomatch", "ok"];
    const p = await provider();

    const result = await runWithTimers(score(p));

    expect(calls).toBe(1);
    expect(result.indeterminate).toBe(true);
  });

  it("does not retry once the breaker is open", async () => {
    /**
     * Retrying past the breaker would defeat the thing that exists to stop us
     * calling a provider that is down — and would do it at twice the rate.
     */
    behaviours = Array.from({ length: 20 }, () => "reject" as const);
    const p = await provider();

    // Three failed calls trip it.
    for (let i = 0; i < 3; i += 1) {
      await expect(runWithTimers(score(p))).rejects.toThrow();
    }
    const callsBefore = calls;

    await expect(score(p)).rejects.toThrow(/circuit open/i);

    expect(calls).toBe(callsBefore);
  });
});

describe("the breaker counts calls, not attempts", () => {
  it("opens after three failed calls, having made six provider calls", async () => {
    /**
     * The breaker's question is "is the provider usable", and a call that
     * failed after retrying is one unusable outcome. Counting attempts would
     * trip it after a call and a half — twitchy enough to open on a single bad
     * minute.
     *
     * The cost is stated rather than hidden: an outage now spends six provider
     * calls before the breaker opens rather than three. That is the honest
     * price of retrying at all, and it is bounded.
     */
    behaviours = Array.from({ length: 20 }, () => "reject" as const);
    const p = await provider();

    for (let i = 0; i < 3; i += 1) {
      await expect(runWithTimers(score(p))).rejects.toThrow();
    }

    expect(calls).toBe(6);
    await expect(score(p)).rejects.toThrow(/circuit open/i);
  });

  it("does not open after two failed calls", async () => {
    behaviours = Array.from({ length: 20 }, () => "reject" as const);
    const p = await provider();

    for (let i = 0; i < 2; i += 1) {
      await expect(runWithTimers(score(p))).rejects.toThrow();
    }

    // Still trying, rather than short-circuiting.
    await expect(runWithTimers(score(p))).rejects.toThrow(/azure|timed out/i);
  });

  it("forgets past failures after a success", async () => {
    // Otherwise a server up for a week accumulates unrelated failures and
    // eventually trips on three spread across days.
    behaviours = ["reject", "reject", "ok", "reject", "reject", "reject", "reject"];
    const p = await provider();

    await expect(runWithTimers(score(p))).rejects.toThrow();
    await runWithTimers(score(p));
    await expect(runWithTimers(score(p))).rejects.toThrow();

    // One failure since the success, so nowhere near the threshold.
    await expect(runWithTimers(score(p))).rejects.toThrow(/azure|timed out/i);
  });
});
