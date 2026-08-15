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
