/**
 * Spanish as a course: `Language → Unit → Lesson → Activity`.
 *
 * The same shape as the French course and for the same reasons — a spine over
 * the bundled ten rather than a copy of them, built by spreading `SPANISH` so
 * that a phrase is written down once. Those ten already have attempts recorded
 * against their ids, and two files that had to agree about the text a learner
 * is scored against would stop agreeing at the first correction to either.
 *
 * ## The eight this adds
 *
 * Four `read` and four `recall` — the two kinds no Spanish content had ever
 * been written for, which would otherwise have left two of the five kinds
 * unreachable in Spanish however much the screens supported them.
 *
 * They are not restatements of the bundled ten. `target` is unique across the
 * whole set by rule, and a `recall` activity whose answer is a phrase the
 * learner has already read aloud tests reading rather than recall.
 *
 * Each one carries a Spanish difficulty English speakers reliably get wrong:
 * the trilled /r/ against the tap /ɾ/ in one phrase, the Castilian θ, the jota
 * /x/, the ñ /ɲ/, silent h, and /ʝ/.
 *
 * ## The content below is a draft
 *
 * Every phrase, gloss, focus line and can-do statement below is mine, not an
 * author's. Two things are most worth a second pair of eyes:
 *
 *  - **The Spanish itself.** Each target is scored against, so a phrase that
 *    reads oddly to a native speaker is one a learner is marked on.
 *  - **The outcomes.** They are the claim Journey renders beside its evidence,
 *    so they must describe something this product can actually measure —
 *    per-syllable pronunciation and attendance, never comprehension and never
 *    fluency.
 *
 * Every syllable was checked to occur in its own phrase and every target to be
 * unique across the set; what a machine cannot check is whether the Spanish is
 * good Spanish.
 */

import type { LanguageActivitySet } from "../types.js";
import { SPANISH } from "../languages/spanish.js";

/**
 * The eight the spine adds. Ids continue from the bundled ten rather than
 * renumbering anything: `id` is the progress key and the report's join key, so
 * a learner who passed activity 7 must still have passed activity 7 here.
 */
const ADDED: LanguageActivitySet["activities"] = [
  {
    id: 11,
    title: "Thanking someone",
    kind: "read",
    prompt: "Read this aloud. There is no model to hear first — the recording is yours, then you can compare.",
    gloss: "Thank you for everything, see you later.",
    target: "Gracias por todo, hasta luego",
    focus: "The Castilian θ in gracias, and the /we/ diphthong in luego",
    soundTargets: ["gra", "cias", "lue", "go"],
  },
  {
    id: 12,
    title: "The trilled and the tapped r",
    kind: "read",
    prompt: "Read this aloud. No model first — this one is about telling two r sounds apart.",
    gloss: "The dog runs through the park.",
    target: "El perro corre por el parque",
    focus: "Trilled /r/ in perro and corre against the tap /ɾ/ in por — the same letter, two sounds, one phrase",
    soundTargets: ["rro", "rre", "par", "que"],
  },
  {
    id: 13,
    title: "Describing a place",
    kind: "read",
    prompt: "Read this aloud. There is no model to hear first.",
    gloss: "The city is very pretty in May.",
    target: "La ciudad es muy bonita en mayo",
    focus: "The θ in ciudad with its /ju/ glide, and the /ʝ/ in mayo",
    soundTargets: ["ciu", "dad", "ma", "yo"],
  },
  {
    id: 14,
    title: "Talking about family",
    kind: "read",
    prompt: "Read this aloud. No model first — the silent h is the trap.",
    gloss: "My brother works in an office.",
    target: "Mi hermano trabaja en una oficina",
    focus: "Silent h in hermano, the jota /x/ in trabaja, and the θ in oficina",
    soundTargets: ["her", "ma", "ba", "ci"],
  },
  {
    id: 15,
    title: "Meeting someone new",
    kind: "recall",
    prompt: "Say that you are pleased to meet them. The Spanish is hidden — say it from the English.",
    gloss: "Pleased to meet you.",
    target: "Mucho gusto en conocerle",
    focus: "The θ in conocerle, and /g/ before /u/ in gusto rather than the English hard g",
    soundTargets: ["gus", "no", "cer", "le"],
  },
  {
    id: 16,
    title: "Asking someone to slow down",
    kind: "recall",
    prompt: "Ask them to repeat it more slowly. The Spanish is hidden.",
    gloss: "Could you repeat that more slowly?",
    target: "¿Puede repetirlo más despacio?",
    focus: "Tap /ɾ/ in repetirlo, and the θ in despacio",
    soundTargets: ["pue", "pe", "tir", "cio"],
  },
  {
    id: 17,
    title: "Asking for help",
    kind: "recall",
    prompt: "Say that you need help with your luggage. The Spanish is hidden.",
    gloss: "I need help with my luggage.",
    target: "Necesito ayuda con mi equipaje",
    focus: "The θ in necesito, /ʝ/ in ayuda, and the jota /x/ in equipaje",
    soundTargets: ["ce", "yu", "qui", "je"],
  },
  {
    id: 18,
    title: "How long you have studied",
    kind: "recall",
    prompt: "Say that you have been studying Spanish for a year. The Spanish is hidden.",
    gloss: "I have been studying Spanish for a year.",
    target: "Hace un año que estudio español",
    focus: "The ñ /ɲ/ twice — año and español — against the plain /n/ of un",
    soundTargets: ["ha", "ño", "tu", "ñol"],
  },
];

export const SPANISH_COURSE: LanguageActivitySet = {
  ...SPANISH,
  activities: [...SPANISH.activities, ...ADDED],
  /**
   * Three units, two lessons each, three activities each — eighteen, which is
   * every activity in the set exactly once. The publish gate checks that, and
   * it is not a formality: an activity in no lesson is content a learner can
   * never reach, and one in two lessons reports a single take as progress in
   * both.
   */
  units: [
    {
      id: 1,
      title: "Meeting people",
      outcome: "You can greet someone, say who you are, and leave politely — and be understood.",
      lessons: [
        {
          id: 1,
          title: "Hello, and who you are",
          outcome: "You can say hello, give your name and where you live, and greet someone new.",
          activityIds: [1, 2, 15],
        },
        {
          id: 2,
          title: "Leaving politely",
          outcome: "You can thank someone, say goodbye, and say how long you have been learning.",
          activityIds: [10, 11, 18],
        },
      ],
    },
    {
      id: 2,
      title: "Out and about",
      outcome: "You can order, pay, ask where something is and ask for help — and be understood.",
      lessons: [
        {
          id: 3,
          title: "Ordering and paying",
          outcome: "You can order in a café, ask the price of something, and ask for the bill.",
          // The trilled r and the Castilian θ both recur across these three,
          // which is what makes the lesson a sitting rather than three
          // unrelated phrases.
          activityIds: [3, 8, 9],
        },
        {
          id: 4,
          title: "Asking for what you need",
          outcome: "You can ask directions, ask someone to slow down, and ask for help.",
          activityIds: [5, 16, 17],
        },
      ],
    },
    {
      id: 3,
      title: "Saying what things are like",
      outcome: "You can give a number, tell the time, and describe a place — and be understood.",
      lessons: [
        {
          id: 5,
          title: "Numbers, time and places",
          outcome: "You can say a number, tell the time, and describe a place.",
          activityIds: [4, 7, 13],
        },
        {
          id: 6,
          title: "Weather, and the two r sounds",
          outcome: "You can describe the weather, and tell the trilled r from the tapped one.",
          activityIds: [6, 12, 14],
        },
      ],
    },
  ],
};
