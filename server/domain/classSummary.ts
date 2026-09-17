/**
 * What a class view is given: counts, and nothing a count can be unpicked
 * into.
 *
 * Lives on the server because that is where the accuracies are, and the whole
 * point of this module is to be the last place they exist. `src/teacher/
 * classSummary.ts` mirrors the *types* so the screens can render the result —
 * the same deliberate duplication the content types have across this boundary
 * (PRD §6), and for a stronger reason here: the server build has `rootDir:
 * server`, so importing the client copy does not compile.
 *
 * The Teacher board states the constraint this file exists to hold, and states
 * it as stronger than "no leaderboard": **no pronunciation figure about an
 * identified pupil appears anywhere in this view** — "which means there is no
 * column to sort, no average to compute, and no ranking to build out of what
 * the teacher is given". The reason is named too: a number attached to a
 * child's accent, shown to the adult who grades them, is the one use of this
 * scorer that could do real harm, and the accent fairness needed to rule that
 * out has not been measured.
 *
 * So the boundary is drawn here rather than at a screen. A view that merely
 * chooses not to render a figure is one `console.log` or one API response away
 * from leaking it; a summary that never contains one cannot.
 *
 * ── the threshold is applied before the boundary, not after ─────────────────
 *
 * Deciding whether a pupil is still working on a sound needs their accuracy.
 * That decision therefore happens where the accuracy already lives — per
 * learner, server-side — and only the *verdict* crosses into this module.
 * `PupilPractice` carries graphemes and days, never a number about a take.
 * Handing this function accuracies and asking it to be careful would make
 * every future edit a chance to be careless.
 *
 * ── why a count alone is not enough ────────────────────────────────────────
 *
 * The board's claim is that a count "cannot be turned back into anybody's
 * number". That is true of the class it draws, which has 28 pupils. It is
 * false of a small one: "2 of 2 pupils are still working on ʁ", shown to a
 * teacher who knows which two joined, is a statement about both of them by
 * name. The board never meets this case, so this adds the floor its own rule
 * requires — below `MIN_REPORTABLE_CLASS` joined pupils the counts are
 * withheld and the view is told why, rather than shown figures that describe
 * individuals.
 *
 * This is small-cell suppression, the same rule school reporting has used for
 * decades, and it is the one place this file goes beyond the board.
 */

/**
 * The smallest class whose counts describe a group rather than its members.
 *
 * Five. Not a tuned number — the property that matters is that no count can be
 * read as "this named pupil", and at five a "3 of 5" leaves eight ways the
 * three could be chosen. Below it the arithmetic gets thin fast: at two, every
 * possible count identifies somebody.
 */
export const MIN_REPORTABLE_CLASS = 5;

/**
 * Where a pupil stands on one sound — the board's three named buckets.
 *
 * Named rather than numbered on purpose. A 1–3 scale is a score with a short
 * range, and the board's sound detail exists to show a *shape* a teacher reads
 * as "reteach or move on", not a number they could average.
 */
export const SOUND_STANDINGS = ["just-started", "getting-there", "holding"] as const;

export type SoundStanding = (typeof SOUND_STANDINGS)[number];

/**
 * One pupil's practice, as it crosses into the class boundary.
 *
 * Note what is absent and cannot be added without failing `promise.test.ts`:
 * any accuracy, best, score or rank. `strugglingWith` is the verdict already
 * reached elsewhere.
 */
export interface PupilPractice {
  /**
   * Opaque and per-class. Used to count distinct pupils and **never** returned
   * in a summary — see the tests, which assert no identifier survives.
   */
  pupilId: string;
  /**
   * Where this pupil stands on each sound they have reached, keyed by
   * grapheme. A sound absent from this map is one they have not reached.
   *
   * A standing, not a score. The three values are the board's own buckets, and
   * which one a pupil falls in is decided where their accuracy already lives —
   * so no figure crosses into this module and none can leak out of it.
   */
  standing: Readonly<Record<string, SoundStanding>>;
  /**
   * How many takes this pupil has made on each sound, keyed by grapheme.
   *
   * A count of attempts, not a judgement of them — the same kind of fact as
   * "the days you practised", which the promise already shares. It is summed
   * across the class and the per-pupil figures never leave this function.
   */
  takes?: Readonly<Record<string, number>>;
  /** ISO days (`YYYY-MM-DD`) this pupil practised. */
  days: readonly string[];
}

/**
 * How hard one sound is for the group.
 *
 * Three buckets, named rather than numbered, because the board's sound-detail
 * screen shows a distribution whose shape tells a teacher whether to reteach
 * or move on — and a numbered scale would be a score by another name.
 */
export interface SoundDifficulty {
  grapheme: string;
  justStarted: number;
  gettingThere: number;
  holding: number;
  /**
   * The overview's figure — "still working on it", which is the first two
   * buckets together. Derived here rather than in a view so the table and the
   * sound detail cannot disagree: on the board, 9 just-started plus 13
   * getting-there is exactly the 22 of 28 the overview prints.
   */
  working: number;
  /**
   * Takes the class has made on this sound, summed. A volume, not a verdict:
   * the board puts it beside the difficulty count so a teacher can tell "hard
   * and heavily practised" from "hard and barely attempted", which are
   * different lessons.
   */
  takes: number;
  /**
   * Joined pupils with no standing on this sound at all.
   *
   * Zero in the board's example, which is why its three bars sum to the class.
   * A real class has pupils who have not reached a sound yet, and a screen
   * that drew only three bars over a class where this is non-zero would show a
   * distribution of a group it never names.
   */
  notYet: number;
}

export type ClassSummary =
  | {
      reportable: true;
      /** Joined pupils. The board shows non-joiners only as a count. */
      joinedCount: number;
      /**
       * Ordered by `working` descending, then by grapheme for a stable tie.
       * The order is fixed and there is no sort control, because the only
       * other thing to sort by does not exist here.
       */
      sounds: SoundDifficulty[];
      /** Practice days only. One count per day, oldest first. */
      attendance: { day: string; practisedCount: number }[];
    }
  | {
      reportable: false;
      joinedCount: number;
      /**
       * Why nothing is shown. A view given `reportable: false` renders this
       * rather than an empty table, so a teacher is told the class is too
       * small to describe as a group instead of concluding nobody is
       * struggling.
       */
      reason: "class-too-small";
    };

/**
 * Builds the summary a class view receives.
 *
 * Pure, and takes the roll as a list rather than reading a store, so the
 * privacy properties can be swept over generated classes in a test rather
 * than argued about.
 */
/** Adds a pupil to the set filed under `key`, creating the set if needed. */
function note(index: Map<string, Set<string>>, key: string, pupilId: string): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, new Set([pupilId]));
  else existing.add(pupilId);
}

export function summariseClass(pupils: readonly PupilPractice[]): ClassSummary {
  // Distinct pupils, because two records for one pupil would count them twice
  // and make a class look larger — and larger is the direction that wrongly
  // unlocks reporting.
  const joined = new Set(pupils.map((pupil) => pupil.pupilId));
  const joinedCount = joined.size;

  if (joinedCount < MIN_REPORTABLE_CLASS) {
    return { reportable: false, joinedCount, reason: "class-too-small" };
  }

  /** One set of pupil ids per bucket, per grapheme. */
  const byStanding = new Map<SoundStanding, Map<string, Set<string>>>(
    SOUND_STANDINGS.map((standing) => [standing, new Map<string, Set<string>>()]),
  );

  for (const pupil of pupils) {
    for (const [grapheme, standing] of Object.entries(pupil.standing)) {
      const index = byStanding.get(standing);
      // A standing this code does not know is dropped rather than guessed. It
      // can only arrive from a newer writer, and inventing a bucket for it
      // would put a pupil in a column that does not describe them.
      if (index === undefined) continue;
      note(index, grapheme, pupil.pupilId);
    }
  }

  const graphemes = [
    ...new Set(SOUND_STANDINGS.flatMap((s) => [...(byStanding.get(s)?.keys() ?? [])])),
  ];

  const sounds: SoundDifficulty[] = graphemes
    .map((grapheme) => {
      const count = (standing: SoundStanding): number =>
        byStanding.get(standing)?.get(grapheme)?.size ?? 0;

      // Summed across every record, because two devices are two sets of real
      // takes rather than a duplicate — unlike a pupil, who is one pupil.
      const takes = pupils.reduce((total, pupil) => total + (pupil.takes?.[grapheme] ?? 0), 0);

      const justStarted = count("just-started");
      const gettingThere = count("getting-there");
      const holding = count("holding");

      return {
        grapheme,
        justStarted,
        gettingThere,
        holding,
        takes,
        working: justStarted + gettingThere,
        notYet: Math.max(0, joinedCount - justStarted - gettingThere - holding),
      };
    })
    /**
     * Hardest first, then by code point.
     *
     * The tiebreak is deliberately **not** `localeCompare`. The board requires
     * a fixed order, and `localeCompare` with no locale argument reads the
     * runtime's default — so the same class could come back ordered one way on
     * a developer's machine and another on the server, which is the one thing
     * a "fixed order, no sort control" screen must not do. It also collates by
     * meaning rather than by symbol: it files ʁ next to r, which is right for
     * a dictionary and arbitrary for a list of IPA symbols and written
     * syllables from four languages.
     */
    .sort(
      (a, b) =>
        b.working - a.working ||
        (a.grapheme < b.grapheme ? -1 : a.grapheme > b.grapheme ? 1 : 0),
    );

  const byDay = new Map<string, Set<string>>();
  for (const pupil of pupils) {
    for (const day of pupil.days) {
      note(byDay, day, pupil.pupilId);
    }
  }

  const attendance = [...byDay.entries()]
    .map(([day, who]) => ({ day, practisedCount: who.size }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return { reportable: true, joinedCount, sounds, attendance };
}
