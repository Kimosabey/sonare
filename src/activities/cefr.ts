/**
 * What each activity lets a learner *do*, in the vocabulary schools buy in.
 *
 * This product's content is chosen for the **sounds** it drills, which is
 * pedagogically right and commercially invisible. A head of department does
 * not justify a purchase by saying it covers the uvular r; they justify it
 * against a syllabus, and in Europe that means CEFR levels and can-do
 * statements. Sonare had no such mapping at all, so the answer to "what does
 * this cover" was a list of phrases.
 *
 * ## Keyed by activity id, across every language
 *
 * The content is parallel on purpose: activity 3 is ordering a drink in
 * French, Spanish and German alike. So one entry describes the same function
 * in all of them, and `cefr.test.ts` asserts that parallelism rather than
 * trusting it — the day a language diverges, the map has to grow a per-
 * language shape and this comment stops being true.
 *
 * ## What this is not
 *
 * Not a scoring input, and not a gate. Nothing here changes a number, unlocks
 * an activity or orders a sitting. It is a description of coverage, and the
 * only thing that reads it is a page that answers "what is in this course".
 *
 * ## Authored, and not by a language teacher
 *
 * The levels below are the obvious ones for functional A1/A2 material and the
 * can-do statements are written in the CEFR descriptors' own voice, but
 * nobody who teaches to the framework has checked them. Completeness is
 * machine-checked — every shipped activity is covered exactly once, and every
 * id referenced exists. Correctness is not, and that distinction is the same
 * one `difficulty.ts` carries for the same reason.
 */

/** The levels this content reaches. Nothing here is above A2, and saying so is the point. */
export type CefrLevel = "A1" | "A2";

export interface CefrEntry {
  /** Activity ids, shared across languages because the content is parallel. */
  ids: number[];
  level: CefrLevel;
  /**
   * A can-do statement, phrased as the framework phrases them: what the
   * learner can do, not what the activity contains.
   */
  canDo: string;
  /** Whether this is production or perception — CEFR separates them. */
  skill: "speaking" | "listening";
}

export const CEFR_MAP: readonly CefrEntry[] = [
  { ids: [1], level: "A1", skill: "speaking", canDo: "Can greet someone and ask how they are." },
  {
    ids: [2],
    level: "A1",
    skill: "speaking",
    canDo: "Can introduce themselves and say where they live.",
  },
  { ids: [3], level: "A1", skill: "speaking", canDo: "Can order food and drink." },
  {
    ids: [4],
    level: "A1",
    skill: "speaking",
    canDo: "Can say and understand numbers and quantities.",
  },
  {
    ids: [5],
    level: "A1",
    skill: "speaking",
    canDo: "Can ask where a place is.",
  },
  { ids: [6], level: "A1", skill: "speaking", canDo: "Can describe the weather." },
  {
    ids: [7],
    level: "A1",
    skill: "speaking",
    canDo: "Can tell the time and say when something begins.",
  },
  { ids: [8], level: "A1", skill: "speaking", canDo: "Can ask how much something costs." },
  {
    ids: [9],
    level: "A2",
    skill: "speaking",
    canDo: "Can ask for the bill and give a simple opinion of a meal.",
  },
  {
    ids: [10],
    level: "A2",
    skill: "speaking",
    canDo: "Can close a conversation politely and wish someone well.",
  },
  {
    ids: [11],
    level: "A1",
    skill: "speaking",
    canDo: "Can use the set phrase for being introduced to someone.",
  },
  { ids: [12], level: "A1", skill: "speaking", canDo: "Can thank someone and wish them well." },
  { ids: [13], level: "A1", skill: "speaking", canDo: "Can arrange to meet again." },
  {
    ids: [14],
    level: "A2",
    skill: "speaking",
    canDo: "Can make a simple request in a restaurant.",
  },
  { ids: [15], level: "A2", skill: "speaking", canDo: "Can ask how they may pay." },
  {
    ids: [16],
    level: "A2",
    skill: "speaking",
    canDo: "Can say where a place is using words of position.",
  },
  { ids: [17], level: "A1", skill: "speaking", canDo: "Can ask how far away something is." },
  {
    ids: [18],
    level: "A2",
    skill: "speaking",
    canDo: "Can understand and give departure times.",
  },
  /**
   * Perception, and listed separately because the framework separates them.
   * These reuse phrases the course already teaches — the point of a `locate`
   * is hearing a sound in something already met, not meeting new material —
   * so the *function* repeats while the skill does not.
   */
  {
    ids: [19, 20, 21],
    level: "A1",
    skill: "listening",
    canDo: "Can recognise individual sounds inside a familiar spoken phrase.",
  },
];

/** The entry covering an activity, or null when nothing does. */
export function cefrFor(id: number): CefrEntry | null {
  return CEFR_MAP.find((entry) => entry.ids.includes(id)) ?? null;
}

/**
 * The levels a set of activities reaches, lowest first.
 *
 * Returns what is *covered*, never a level the learner has reached — this
 * describes content, and a claim about a person is the thing the rest of the
 * product is careful not to make from material like this.
 */
export function levelsCovered(ids: readonly number[]): CefrLevel[] {
  const found = new Set<CefrLevel>();
  for (const id of ids) {
    const entry = cefrFor(id);
    if (entry !== null) found.add(entry.level);
  }
  return (["A1", "A2"] as const).filter((level) => found.has(level));
}
