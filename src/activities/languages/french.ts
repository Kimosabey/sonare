/**
 * Ten French activities, ordered so each one adds a difficulty rather than
 * repeating the last. Every target carries at least one sound that English
 * speakers reliably get wrong — nasal vowels, the uvular /ʁ/, the /u/–/y/
 * contrast, and liaison — so a scorer that discriminates has something to
 * discriminate on.
 *
 * Deliberately still a flat ten with no `units`. This is the **floor**: what a
 * learner who has never been online, or whose storage is blocked, practises.
 * The course spine is a published version, seeded from src/activities/courses/,
 * which is what lets an old client keep working on this shape.
 *
 * `soundTargets` is the one thing added here since the spine work. It is
 * additive — no activity changed, none was added — and it is what makes the
 * shipped ten schedulable by sound rather than only by array index.
 */

import type { LanguageActivitySet } from "../types.js";

export const FRENCH: LanguageActivitySet = {
  code: "fr-FR",
  slug: "fr",
  label: "French",
  activities: [
    {
      id: 1,
      title: "Greetings",
      kind: "repeat",
      prompt: "Say hello politely.",
      gloss: "Hello, how are you?",
      target: "Bonjour, comment allez-vous",
      focus: "Nasal vowels /ɔ̃/ and /ɑ̃/, and the liaison in allez-vous",
      soundTargets: ["bon", "jour", "ment", "allez"],
    },
    {
      id: 2,
      title: "Introducing yourself",
      kind: "repeat",
      prompt: "Introduce yourself and say where you live.",
      gloss: "My name is Marie and I live in Paris.",
      target: "Je m'appelle Marie et j'habite à Paris",
      focus: "The /ʒ/ in je, and the silent h in habite",
      soundTargets: ["je", "ha", "ris"],
    },
    {
      id: 3,
      title: "Ordering in a café",
      kind: "repeat",
      prompt: "Order a coffee and a croissant.",
      gloss: "I would like a coffee and a croissant, please.",
      target: "Je voudrais un café et un croissant s'il vous plaît",
      focus: "Uvular /ʁ/ in voudrais and croissant",
      soundTargets: ["vou", "drais", "crois", "sant"],
    },
    {
      id: 4,
      title: "Numbers",
      kind: "respond",
      prompt: "Combien de personnes y a-t-il à la réunion ? (Answer: forty-two)",
      gloss: "There are forty-two people at the meeting.",
      target: "Il y a quarante-deux personnes à la réunion",
      focus: "Nasal /ɑ̃/ in quarante and réunion, and the /ø/ in deux",
      soundTargets: ["qua", "rante", "deux", "nion"],
    },
    {
      id: 5,
      title: "Asking directions",
      kind: "respond",
      prompt: "Ask where the nearest pharmacy is.",
      gloss: "Where is the nearest pharmacy?",
      target: "Où se trouve la pharmacie la plus proche",
      focus: "The /u/–/y/ contrast — où versus plus",
      soundTargets: ["où", "trouve", "plus", "proche"],
    },
    {
      id: 6,
      title: "Talking about weather",
      kind: "repeat",
      prompt: "Describe cold, rainy weather.",
      gloss: "It is very cold and it is raining a lot today.",
      target: "Il fait très froid et il pleut beaucoup aujourd'hui",
      focus: "Consonant clusters with /ʁ/ — très, froid",
      soundTargets: ["très", "froid", "pleut", "coup"],
    },
    {
      id: 7,
      title: "Telling the time",
      kind: "respond",
      prompt: "À quelle heure commence le film ? (Answer: quarter to nine)",
      gloss: "The film starts at a quarter to nine.",
      target: "Le film commence à neuf heures moins le quart",
      focus: "Nasal /wɛ̃/ in moins, and liaison between neuf and heures",
      soundTargets: ["mence", "neuf", "moins", "quart"],
    },
    {
      id: 8,
      title: "Shopping",
      kind: "respond",
      prompt: "Ask how much the brown shoes cost.",
      gloss: "How much do these brown shoes cost?",
      target: "Combien coûtent ces chaussures marron",
      focus: "/ʃ/ in chaussures, and nasal /ɔ̃/ in marron",
      soundTargets: ["bien", "coû", "chaus", "ron"],
    },
    {
      id: 9,
      title: "At the restaurant",
      kind: "repeat",
      prompt: "Ask for the bill and compliment the service.",
      gloss: "The bill, please. The service was excellent.",
      target: "L'addition s'il vous plaît le service était excellent",
      focus: "The /sj/ sequence in s'il vous plaît, and nasal /ɑ̃/ in excellent",
      soundTargets: ["ddi", "tion", "vice", "lent"],
    },
    {
      id: 10,
      title: "Saying goodbye",
      kind: "repeat",
      prompt: "Say goodbye warmly, wishing a good evening.",
      gloss: "Have a good evening, until next time, and take care of yourself.",
      target: "Bonne soirée à la prochaine et prenez soin de vous",
      focus: "The /wa/ diphthong in soirée, and nasal /wɛ̃/ in soin",
      soundTargets: ["soi", "rée", "chaine", "soin"],
    },
  ],
};
