/**
 * French as a course: `Language → Unit → Lesson → Activity`.
 *
 * The **next published version** of French, not a replacement for the bundled
 * set. It is the shipped ten with a spine over them plus eight activities the
 * flat set had no room for — four `read`, four `recall` — arranged into three
 * units of two lessons of three.
 *
 * Why it is built by spreading `FRENCH` rather than restating it: those ten
 * phrases are already in front of learners and already have attempts recorded
 * against their ids. Copying them here would mean two files that have to agree
 * about the text a learner is scored against, and the first correction to one
 * of them would prove they do not. So an activity is written down once, and
 * this file adds a structure over it.
 *
 * Why it is a separate module rather than an edit to french.ts: the bundled
 * set is the offline floor and the old shape, and something has to still be
 * the old shape for "an old client keeps working" to be a fact rather than a
 * hope. It is also what stops this content reaching a learner before the
 * screens for it exist — see the note in scripts/seed-content.ts.
 */

import type { LanguageActivitySet } from "../types.js";
import { FRENCH } from "../languages/french.js";

/**
 * The eight activities the spine adds.
 *
 * Ids continue from the bundled ten rather than renumbering anything: `id` is
 * the progress key and the report's join key, so a learner who passed activity
 * 7 must still have passed activity 7 in the published version.
 *
 * Four `read` and four `recall`, which are the two kinds no French content had
 * ever been written for. They are not variants of the existing phrases —
 * `target` is unique across the whole set by rule, and a recall activity whose
 * answer is a phrase the learner has already read aloud tests reading, not
 * recall.
 */
const ADDED: LanguageActivitySet["activities"] = [
  {
    id: 11,
    title: "Meeting someone new",
    kind: "recall",
    prompt: "Say that you are pleased to meet them. The French is hidden — say it from the English.",
    gloss: "Pleased to meet you.",
    target: "Enchanté de faire votre connaissance",
    focus: "Nasal /ɑ̃/ in enchanté, and the /s/ rather than /z/ in connaissance",
    soundTargets: ["chan", "té", "nai", "sance"],
  },
  {
    id: 12,
    title: "Thanking someone",
    kind: "read",
    prompt: "Read this aloud. There is no model to hear first — the recording is yours, then you can compare.",
    gloss: "Thank you very much, and have a good day.",
    target: "Merci beaucoup et bonne journée",
    focus: "Uvular /ʁ/ in merci, and the /u/ in beaucoup",
    soundTargets: ["mer", "ci", "coup", "née"],
  },
  {
    id: 13,
    title: "Arranging to meet again",
    kind: "recall",
    prompt: "Say that you will see them tomorrow morning. The French is hidden.",
    gloss: "See you tomorrow morning.",
    target: "À demain matin",
    focus: "Nasal /ɛ̃/ in demain against nasal /ɑ̃/ in matin — two nasals, one phrase",
    soundTargets: ["de", "main", "ma", "tin"],
  },
  {
    id: 14,
    title: "Asking for a table",
    kind: "read",
    prompt: "Read this aloud. No model first.",
    gloss: "A table for two people, please.",
    target: "Une table pour deux personnes s'il vous plaît",
    focus: "The /y/ in une against the /u/ in pour, and the /ø/ in deux",
    soundTargets: ["une", "table", "deux", "sonnes"],
  },
  {
    id: 15,
    title: "Paying by card",
    kind: "recall",
    prompt: "Ask whether you can pay by card. The French is hidden.",
    gloss: "Can I pay by card?",
    target: "Est-ce que je peux payer par carte",
    focus: "The /ø/ in peux, and uvular /ʁ/ twice in par carte",
    soundTargets: ["peux", "pa", "yer", "carte"],
  },
  {
    id: 16,
    title: "Reading a direction back",
    kind: "read",
    prompt: "Read this aloud. No model first.",
    gloss: "The station is behind the church.",
    target: "La gare se trouve derrière l'église",
    focus: "Uvular /ʁ/ in gare and derrière, and the /e/ in église",
    soundTargets: ["gare", "rrière", "glise"],
  },
  {
    id: 17,
    title: "Asking how far",
    kind: "recall",
    prompt: "Ask whether it is far from here. The French is hidden.",
    gloss: "Is it far from here?",
    target: "Est-ce que c'est loin d'ici",
    focus: "Nasal /wɛ̃/ in loin, and the /i/ in ici",
    soundTargets: ["loin", "ci"],
  },
  {
    id: 18,
    title: "Reading a departure time",
    kind: "read",
    prompt: "Read this aloud. No model first.",
    gloss: "The train leaves in a quarter of an hour.",
    target: "Le train part dans un quart d'heure",
    focus: "Nasal /ɛ̃/ in train against nasal /ɑ̃/ in dans",
    soundTargets: ["train", "dans", "quart", "heure"],
  },
];

export const FRENCH_COURSE: LanguageActivitySet = {
  ...FRENCH,
  activities: [...FRENCH.activities, ...ADDED],
  /**
   * Three units, two lessons each, three activities each — eighteen, which is
   * every activity in the set exactly once. The publish gate checks that, and
   * it is not a formality: an activity in no lesson is content a learner can
   * never reach, and one in two lessons reports a single take as progress in
   * both.
   *
   * Each lesson mixes the kinds rather than grouping them, so a sitting is not
   * six of the same thing — and so `read` and `recall`, which are the harder
   * asks, arrive beside something already practised.
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
          outcome: "You can say hello, give your name and say where you live.",
          activityIds: [1, 2, 11],
        },
        {
          id: 2,
          title: "Leaving politely",
          outcome: "You can thank someone, say goodbye, and arrange to meet again.",
          activityIds: [10, 12, 13],
        },
      ],
    },
    {
      id: 2,
      title: "Eating out",
      outcome: "You can order food, ask what it costs and pay — and be understood.",
      lessons: [
        {
          id: 3,
          title: "Ordering",
          outcome: "You can ask for a table and order what you want.",
          activityIds: [14, 3, 9],
        },
        {
          id: 4,
          title: "Prices and paying",
          outcome: "You can ask what something costs, say a number back, and pay.",
          activityIds: [8, 4, 15],
        },
      ],
    },
    {
      id: 3,
      title: "Finding your way",
      outcome: "You can ask where something is, when it leaves, and say what the weather is doing — and be understood.",
      lessons: [
        {
          id: 5,
          title: "Asking the way",
          outcome: "You can ask where something is, say a direction back, and ask how far it is.",
          activityIds: [5, 16, 17],
        },
        {
          id: 6,
          title: "Times and weather",
          outcome: "You can ask when something happens and say what the weather is doing.",
          activityIds: [7, 18, 6],
        },
      ],
    },
  ],
};
