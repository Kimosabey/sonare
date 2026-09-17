/**
 * What a class view is given: counts, and nothing a count can be unpicked
 * into.
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
export const SOUND_STANDINGS = ["just-started", "getting-there", "holding"];
/**
 * Builds the summary a class view receives.
 *
 * Pure, and takes the roll as a list rather than reading a store, so the
 * privacy properties can be swept over generated classes in a test rather
 * than argued about.
 */
/** Adds a pupil to the set filed under `key`, creating the set if needed. */
function note(index, key, pupilId) {
    const existing = index.get(key);
    if (existing === undefined)
        index.set(key, new Set([pupilId]));
    else
        existing.add(pupilId);
}
export function summariseClass(pupils) {
    // Distinct pupils, because two records for one pupil would count them twice
    // and make a class look larger — and larger is the direction that wrongly
    // unlocks reporting.
    const joined = new Set(pupils.map((pupil) => pupil.pupilId));
    const joinedCount = joined.size;
    if (joinedCount < MIN_REPORTABLE_CLASS) {
        return { reportable: false, joinedCount, reason: "class-too-small" };
    }
    /** One set of pupil ids per bucket, per grapheme. */
    const byStanding = new Map(SOUND_STANDINGS.map((standing) => [standing, new Map()]));
    for (const pupil of pupils) {
        for (const [grapheme, standing] of Object.entries(pupil.standing)) {
            const index = byStanding.get(standing);
            // A standing this code does not know is dropped rather than guessed. It
            // can only arrive from a newer writer, and inventing a bucket for it
            // would put a pupil in a column that does not describe them.
            if (index === undefined)
                continue;
            note(index, grapheme, pupil.pupilId);
        }
    }
    const graphemes = [
        ...new Set(SOUND_STANDINGS.flatMap((s) => [...(byStanding.get(s)?.keys() ?? [])])),
    ];
    const sounds = graphemes
        .map((grapheme) => {
        const count = (standing) => byStanding.get(standing)?.get(grapheme)?.size ?? 0;
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
        .sort((a, b) => b.working - a.working ||
        (a.grapheme < b.grapheme ? -1 : a.grapheme > b.grapheme ? 1 : 0));
    const byDay = new Map();
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
