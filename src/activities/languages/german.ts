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
      prompt: "Wie viele Gäste sind auf der Party? (Answer: forty-seven)",
      gloss: "There are forty-seven guests at the party.",
      target: "Es sind siebenundvierzig Gäste auf der Party",
      focus: "The affricate /ts/ and ich-laut /ç/ both in vierzig, and the umlaut /ɛː/ in Gäste",
    },
    {
      id: 5,
      title: "Asking directions",
      kind: "respond",
      prompt: "Ask where the nearest pharmacy is.",
      gloss: "Where is the nearest pharmacy?",
      target: "Wo ist die nächste Apotheke?",
      focus: "The ich-laut /ç/ in nächste",
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
      prompt: "Wann beginnt die Besprechung? (Answer: quarter past nine)",
      gloss: "The meeting starts at a quarter past nine.",
      target: "Die Besprechung beginnt um Viertel nach neun",
      focus: "The /ʃp/ cluster in Besprechung, and the diphthong in neun",
    },
    {
      id: 8,
      title: "Shopping",
      kind: "respond",
      prompt: "Ask how much the green trousers cost.",
      gloss: "How much do these green trousers cost?",
      target: "Wie viel kostet diese grüne Hose?",
      focus: "The umlaut /yː/ in grüne",
    },
    {
      id: 9,
      title: "At the restaurant",
      kind: "repeat",
      prompt: "Ask for the bill and say the food was excellent.",
      gloss: "The bill, please. The food was excellent.",
      target: "Die Rechnung, bitte. Das Essen war ausgezeichnet",
      focus: "The ich-laut /ç/ in both Rechnung and ausgezeichnet",
    },
    {
      id: 10,
      title: "Saying goodbye",
      kind: "repeat",
      prompt: "Say goodbye warmly, wishing a pleasant evening.",
      gloss: "Have a pleasant evening, see you then, and take care of yourself.",
      target: "Einen schönen Abend noch, bis dann, und pass auf dich auf",
      focus: "The umlaut /øː/ in schönen, and the separable verb split in pass ... auf",
    },
  ],
};
