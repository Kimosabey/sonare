/**
 * Ten German activities, mirroring the French set's structure and
 * progression. Each target carries a sound English speakers reliably get
 * wrong: umlauts (ü/ö/ä), the ich-laut /ç/ vs. ach-laut /x/ contrast,
 * initial /pf/, uvular /ʁ/, and final-consonant devoicing.
 */

import type { LanguageActivitySet } from "../types.js";

export const GERMAN: LanguageActivitySet = {
  code: "de-DE",
  slug: "de",
  label: "German",
  activities: [
    {
      id: 1,
      title: "Greetings",
      kind: "repeat",
      prompt: "Say hello politely.",
      gloss: "Hello, how are you?",
      target: "Guten Tag, wie geht es Ihnen?",
      focus: "The ich-laut /ç/ in geht/Ihnen, and uvular /ʁ/ in Guten",
    },
    {
      id: 2,
      title: "Introducing yourself",
      kind: "repeat",
      prompt: "Introduce yourself and say where you live.",
      gloss: "My name is Anna and I live in Munich.",
      target: "Ich heiße Anna und wohne in München",
      focus: "The umlaut /ʏ/ in München, and ich-laut /ç/ in Ich",
    },
    {
      id: 3,
      title: "Ordering in a café",
      kind: "repeat",
      prompt: "Order a coffee and a pretzel.",
      gloss: "I would like a coffee and a pretzel, please.",
      target: "Ich hätte gern einen Kaffee und eine Brezel, bitte",
      focus: "The umlaut /ɛ/ in hätte, and initial /pf/-adjacent cluster stress",
    },
    {
      id: 4,
      title: "Numbers",
      kind: "respond",
      prompt: "Wie viele Studenten gibt es? (Answer: thirty-two)",
      gloss: "There are thirty-two students in the class.",
      target: "Es gibt zweiunddreißig Studenten in der Klasse",
      focus: "The affricate /pf/-like /ts/ in zweiunddreißig, and final devoicing in gibt",
    },
    {
      id: 5,
      title: "Asking directions",
      kind: "respond",
      prompt: "Ask where the nearest station is.",
      gloss: "Where is the nearest station?",
      target: "Wo ist der nächste Bahnhof?",
      focus: "The ich-laut /ç/ in nächste, and ach-laut /x/ contrast is absent here — nächste tests the front variant specifically",
    },
    {
      id: 6,
      title: "Talking about weather",
      kind: "repeat",
      prompt: "Describe cold, rainy weather.",
      gloss: "It is very cold and it is raining a lot today.",
      target: "Es ist sehr kalt und es regnet heute viel",
      focus: "The ach-laut /x/ in the -ch of nicht-family sounds, tested via the uvular /ʁ/ in regnet",
    },
    {
      id: 7,
      title: "Telling the time",
      kind: "respond",
      prompt: "Wann fährt der Zug ab? (Answer: quarter past eight)",
      gloss: "The train leaves at a quarter past eight.",
      target: "Der Zug fährt um Viertel nach acht ab",
      focus: "The ach-laut /x/ in nach and acht, and umlaut /ɛː/ in fährt",
    },
    {
      id: 8,
      title: "Shopping",
      kind: "respond",
      prompt: "Ask how much the blue shirt costs.",
      gloss: "How much does this blue shirt cost?",
      target: "Wie viel kostet dieses blaue Hemd?",
      focus: "Final devoicing of /d/ in Hemd, and the diphthong in blaue",
    },
    {
      id: 9,
      title: "At the restaurant",
      kind: "repeat",
      prompt: "Ask for the bill and say the meal was delicious.",
      gloss: "The bill, please. It was delicious.",
      target: "Die Rechnung, bitte. Es war köstlich",
      focus: "The umlaut /œ/ in köstlich, and ich-laut /ç/ in Rechnung",
    },
    {
      id: 10,
      title: "Saying goodbye",
      kind: "repeat",
      prompt: "Say goodbye warmly.",
      gloss: "Goodbye, see you soon, and have a good day.",
      target: "Auf Wiedersehen, bis bald, und einen schönen Tag noch",
      focus: "The umlaut /øː/ in schönen, and uvular /ʁ/ in Wiedersehen",
    },
  ],
};
