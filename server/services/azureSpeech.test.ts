/**
 * R8/FR-16 is the honesty boundary the whole product depends on: anything
 * short of a complete, usable assessment must become `indeterminate` rather
 * than a fabricated number. toPronunciationResult() is exported (only) so
 * these cases can be asserted directly against hand-built Azure response
 * shapes, without a live Azure call or a full SpeechRecognitionResult mock.
 */

import { describe, expect, it } from "vitest";
import sdk from "microsoft-cognitiveservices-speech-sdk";
import { toPronunciationResult } from "./azureSpeech.js";

function fakeResult(reason: number, json?: unknown, text?: string): sdk.SpeechRecognitionResult {
  return {
    reason,
    json: json === undefined ? "" : JSON.stringify(json),
    text: text ?? "",
  } as unknown as sdk.SpeechRecognitionResult;
}

describe("toPronunciationResult", () => {
  it("is indeterminate when the recognizer found no speech at all", () => {
    const result = toPronunciationResult(fakeResult(sdk.ResultReason.NoMatch));
    expect(result.indeterminate).toBe(true);
    if (result.indeterminate) {
      expect(result.reason).toBe("no speech recognised in the recording");
      expect(result.provider).toBe("azure");
    }
  });

  it("is indeterminate when a score field is the wrong type — a case a bare `as RawResult` cast could not catch", () => {
    const result = toPronunciationResult(
      fakeResult(sdk.ResultReason.RecognizedSpeech, {
        NBest: [
          {
            Display: "hello",
            // A provider-side shape change: PronScore as a string. A bare
            // cast would trust this as `number` and only fail later, deep
            // inside scoring math, with no clue why. Zod catches it here,
            // at the boundary, as the honest `indeterminate` this already
            // is rather than a silently wrong number.
            PronunciationAssessment: { PronScore: "eighty", AccuracyScore: 80, FluencyScore: 80, CompletenessScore: 80 },
            Words: [],
          },
        ],
      }),
    );
    expect(result.indeterminate).toBe(true);
    if (result.indeterminate) {
      expect(result.reason).toBe("provider response did not match the expected shape");
    }
  });

  it("is indeterminate when the response is missing a required top-level score", () => {
    const result = toPronunciationResult(
      fakeResult(sdk.ResultReason.RecognizedSpeech, {
        NBest: [
          {
            Display: "hello",
            // AccuracyScore missing — an incomplete assessment, not a 0.
            PronunciationAssessment: { PronScore: 80, FluencyScore: 80, CompletenessScore: 80 },
            Words: [],
          },
        ],
      }),
    );
    expect(result.indeterminate).toBe(true);
    if (result.indeterminate) {
      expect(result.reason).toBe("no pronunciation assessment in provider response");
    }
  });

  it(
    "is indeterminate for silence disguised as RecognizedSpeech " +
      "(Azure returns PronScore 0 with every word Omission and no phonemes, not NoMatch)",
    () => {
      const result = toPronunciationResult(
        fakeResult(sdk.ResultReason.RecognizedSpeech, {
          NBest: [
            {
              Display: ".",
              PronunciationAssessment: { PronScore: 0, AccuracyScore: 0, FluencyScore: 0, CompletenessScore: 0 },
              Words: [
                { Word: "hello", PronunciationAssessment: { ErrorType: "Omission" }, Phonemes: [] },
                { Word: "world", PronunciationAssessment: { ErrorType: "Omission" }, Phonemes: [] },
              ],
            },
          ],
        }),
      );
      expect(result.indeterminate).toBe(true);
      if (result.indeterminate) {
        expect(result.reason).toBe("no speech found to assess — every word was omitted");
      }
    },
  );

  it("returns real scores for a genuinely bad attempt (still has phonemes, mixed error types)", () => {
    const result = toPronunciationResult(
      fakeResult(
        sdk.ResultReason.RecognizedSpeech,
        {
          NBest: [
            {
              Display: "helo world",
              PronunciationAssessment: { PronScore: 42, AccuracyScore: 40, FluencyScore: 50, CompletenessScore: 90 },
              Words: [
                {
                  Word: "hello",
                  PronunciationAssessment: { AccuracyScore: 35, ErrorType: "Mispronunciation" },
                  Phonemes: [{ Phoneme: "h", PronunciationAssessment: { AccuracyScore: 20 } }],
                },
                {
                  Word: "world",
                  PronunciationAssessment: { AccuracyScore: 45, ErrorType: "None" },
                  Phonemes: [{ Phoneme: "w", PronunciationAssessment: { AccuracyScore: 60 } }],
                },
              ],
            },
          ],
        },
        "helo world",
      ),
    );

    expect(result.indeterminate).toBe(false);
    if (!result.indeterminate) {
      expect(result.overall).toBe(42);
      expect(result.accuracy).toBe(40);
      expect(result.words).toHaveLength(2);
      expect(result.words[0]?.errorType).toBe("Mispronunciation");
      expect(result.prosody).toBeUndefined();
    }
  });

  it("includes prosody only when Azure actually sent one", () => {
    const withProsody = toPronunciationResult(
      fakeResult(sdk.ResultReason.RecognizedSpeech, {
        NBest: [
          {
            Display: "bonjour",
            PronunciationAssessment: { PronScore: 88, AccuracyScore: 88, FluencyScore: 90, CompletenessScore: 100, ProsodyScore: 75 },
            Words: [{ Word: "bonjour", PronunciationAssessment: { AccuracyScore: 88, ErrorType: "None" }, Phonemes: [] }],
          },
        ],
      }),
    );

    expect(withProsody.indeterminate).toBe(false);
    if (!withProsody.indeterminate) expect(withProsody.prosody).toBe(75);
  });
});
