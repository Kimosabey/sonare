/**
 * The one shape everything downstream depends on (PRD.md §6).
 *
 * Mirrored on the client in src/speech/scoring/types.ts. If you change one,
 * change both AND update PRD.md §6 — that file is the contract of record.
 *
 * R12: providers are swappable. Nothing outside server/services/ may know
 * which vendor produced this.
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
      /**
       * Deliberately optional. Prosody's language coverage is narrower than the
       * other scores — handle it missing, never assume it is present.
       */
      prosody?: number;
      words: ScoredWord[];
    };

export interface ScoredWord {
  word: string;
  accuracy: number;
  errorType: "None" | "Omission" | "Insertion" | "Mispronunciation" | string;
  phonemes: ScoredPhoneme[];
}

export interface ScoredPhoneme {
  phoneme: string;
  accuracy: number;
}

/**
 * T2: the whole vendor surface. Adding SpeechAce means adding one file that
 * implements this, not touching anything else.
 */
export interface ScoringProvider {
  readonly name: string;
  score(wav: Buffer, referenceText: string, language: string): Promise<PronunciationResult>;
}
