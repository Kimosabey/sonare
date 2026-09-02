/**
 * PRD.md §6 — the response contract, client side.
 *
 * Mirrors server/services/types.ts. If you change one, change both AND update
 * PRD.md §6, which is the contract of record.
 *
 * Nothing here names a vendor: `provider` is a string the UI displays, not a
 * value it branches on (R12).
 */

export type PronunciationResult =
  | {
      indeterminate: true;
      reason: string;
      provider: string;
      modelVersion?: string;
    }
  | {
      indeterminate: false;
      provider: string;
      modelVersion?: string;
      recognized: string;
      overall: number;
      accuracy: number;
      fluency: number;
      completeness: number;
      /** Narrower language coverage than the others — handle it missing. */
      prosody?: number;
      words: ScoredWord[];
    };

export interface ScoredWord {
  word: string;
  accuracy: number;
  errorType: "None" | "Omission" | "Insertion" | "Mispronunciation" | string;
  phonemes: ScoredPhoneme[];
  /** Empty when the provider returned none — never assume at least one. */
  syllables: ScoredSyllable[];
}

/**
 * A syllable of a scored word.
 *
 * This is the level at which per-sound feedback is actually available. Azure
 * returns empty `Phoneme` labels for every locale Sonare ships, but syllables
 * come back named via their grapheme — 83% of the time across the French
 * activity set — and always scored and timed.
 *
 * `grapheme` is the written form ("jour", "ment"), not a phonetic symbol, and
 * that is a feature rather than a compromise: most learners cannot read IPA,
 * but they can re-read a piece of the word they just said. It is empty where
 * Azure could not map one, which happens predictably around elision and
 * hyphenation — so treat empty as "show the position instead", never as an
 * error.
 *
 * `offsetTicks`/`durationTicks` are Azure's 100-nanosecond ticks, passed
 * through unconverted so the client can slice the take the learner just
 * recorded and play back exactly this syllable.
 */
export interface ScoredSyllable {
  /** Written form, e.g. "jour". Empty when the provider could not map one. */
  grapheme: string;
  accuracy: number;
  /** 100-nanosecond ticks from the start of the audio. */
  offsetTicks: number;
  durationTicks: number;
}

export interface ScoredPhoneme {
  phoneme: string;
  accuracy: number;
}

/** The typed error envelope the endpoint returns on failure. */
export interface ApiErrorBody {
  error: {
    code: string;
    domain: "client" | "network" | "server" | "provider" | "model";
    message: string;
    userMessage: string;
  };
}
