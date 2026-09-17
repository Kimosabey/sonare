/**
 * The shape a class view renders — the client's mirror of
 * `server/domain/classSummary.ts`.
 *
 * Types only. `summariseClass` is not here and must not be: it is the function
 * that turns pupil records into counts, and it belongs where the records are.
 * A second implementation on the client would be a second place for "no figure
 * about an identified pupil" to be true in one copy and quietly false in the
 * other.
 *
 * Duplicated rather than imported because the server build sets `rootDir:
 * server` and the client cannot reach into it either — the same boundary the
 * content types already sit either side of. What keeps the two in step is that
 * the server's own route test asserts the exact key set it sends.
 */

/**
 * Where a pupil stands on one sound — the board's three named buckets.
 *
 * A type, not a `const` array. The server's copy needs the runtime list to
 * iterate buckets while aggregating; nothing on the client ever does, and an
 * exported array that no screen reads is bytes every learner downloads to run
 * code that does not exist here.
 */
export type SoundStanding = "just-started" | "getting-there" | "holding";

export interface SoundDifficulty {
  grapheme: string;
  justStarted: number;
  gettingThere: number;
  holding: number;
  /** Takes the class has made on this sound. A volume, not a verdict. */
  takes: number;
  /** just-started plus getting-there — the overview's "22 of 28". */
  working: number;
  /** Joined pupils with no standing on this sound at all. */
  notYet: number;
}

export type ClassSummary =
  | {
      reportable: true;
      joinedCount: number;
      /** Ordered hardest-first, fixed — there is no sort control. */
      sounds: SoundDifficulty[];
      attendance: { day: string; practisedCount: number }[];
    }
  | {
      reportable: false;
      joinedCount: number;
      reason: "class-too-small";
    };
