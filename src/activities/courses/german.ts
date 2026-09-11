/**
 * German as a course, mirroring the French one — see the long note in
 * french.ts for why this is a separate module built by spreading the bundled
 * set rather than an edit to it.
 *
 * The shipped ten with a spine over them, plus four `read` and four `recall`
 * activities, in three units of two lessons of three.
 */

import type { LanguageActivitySet } from "../types.js";
import { GERMAN } from "../languages/german.js";

const ADDED: LanguageActivitySet["activities"] = [
  {
    id: 11,
    title: "Meeting someone new",
    kind: "recall",
    prompt: "Say that you are pleased to meet them. The German is hidden — say it from the English.",
    gloss: "It is a pleasure to meet you.",
    target: "Es freut mich sehr, Sie kennenzulernen",
    focus: "The diphthong /ɔʏ/ in freut, and the ich-laut /ç/ in mich",
    soundTargets: ["freut", "mich", "ken", "ler"],
  },
  {
    id: 12,
    title: "Thanking someone",
    kind: "read",
    prompt: "Read this aloud. There is no model to hear first — the recording is yours, then you can compare.",
    gloss: "Many thanks, and have a nice day.",
    target: "Vielen Dank und einen schönen Tag",
    focus: "The umlaut /øː/ in schönen, and final devoicing in Tag",
    soundTargets: ["vie", "dank", "schö", "tag"],
  },
  {
    id: 13,
    title: "Arranging to meet again",
    kind: "recall",
    prompt: "Say that you will see them tomorrow morning. The German is hidden.",
    gloss: "See you tomorrow morning.",
    target: "Bis morgen früh",
    focus: "The umlaut /yː/ in früh, and the uvular /ʁ/ in morgen",
    soundTargets: ["mor", "gen", "früh"],
  },
  {
    id: 14,
    title: "Asking for a table",
    kind: "read",
    prompt: "Read this aloud. No model first.",
    gloss: "A table for two people, please.",
    target: "Einen Tisch für zwei Personen, bitte",
    focus: "The /ʃ/ in Tisch, the umlaut /yː/ in für, and the /ts/ in zwei",
    soundTargets: ["tisch", "für", "zwei", "nen"],
  },
  {
    id: 15,
    title: "Paying by card",
    kind: "recall",
    prompt: "Ask whether you can pay by card. The German is hidden.",
    gloss: "Can I pay by card?",
    target: "Kann ich mit Karte bezahlen",
    focus: "The ich-laut /ç/ in ich against the uvular /ʁ/ in Karte",
    soundTargets: ["kann", "ich", "kar", "zah"],
  },
  {
    id: 16,
    title: "Reading a direction back",
    kind: "read",
    prompt: "Read this aloud. No model first.",
    gloss: "The station is behind the church.",
    target: "Der Bahnhof liegt hinter der Kirche",
    focus: "The long /aː/ in Bahnhof, and the ich-laut /ç/ in Kirche",
    soundTargets: ["bahn", "hof", "hin", "kir"],
  },
  {
    id: 17,
    title: "Asking how far",
    kind: "recall",
    prompt: "Ask whether it is far from here. The German is hidden.",
    gloss: "Is it far from here?",
    target: "Ist es weit von hier",
    focus: "The diphthong /aɪ/ in weit, and the /f/ spelled v in von",
    soundTargets: ["weit", "von", "hier"],
  },
  {
    id: 18,
    title: "Reading a departure time",
    kind: "read",
    prompt: "Read this aloud. No model first.",
    gloss: "The train leaves in a quarter of an hour.",
    target: "Der Zug fährt in einer Viertelstunde",
    focus: "The /ts/ in Zug, and the umlaut /ɛː/ in fährt",
    soundTargets: ["zug", "fährt", "vier", "stun"],
  },
];

export const GERMAN_COURSE: LanguageActivitySet = {
  ...GERMAN,
  activities: [...GERMAN.activities, ...ADDED],
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
