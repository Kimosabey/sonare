/**
 * Ten French activities, ordered so each one adds a difficulty rather than
 * repeating the last. Every target carries at least one sound that English
 * speakers reliably get wrong — nasal vowels, the uvular /ʁ/, the /u/–/y/
 * contrast, and liaison — so a scorer that discriminates has something to
 * discriminate on.
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
    },
    {
      id: 2,
      title: "Introducing yourself",
      kind: "repeat",
      prompt: "Introduce yourself and say where you live.",
      gloss: "My name is Marie and I live in Paris.",
      target: "Je m'appelle Marie et j'habite à Paris",
      focus: "The /ʒ/ in je, and the silent h in habite",
    },
    {
      id: 3,
      title: "Ordering in a café",
      kind: "repeat",
      prompt: "Order a coffee and a croissant.",
      gloss: "I would like a coffee and a croissant, please.",
      target: "Je voudrais un café et un croissant s'il vous plaît",
      focus: "Uvular /ʁ/ in voudrais and croissant",
    },
    {
      id: 4,
      title: "Numbers",
      kind: "respond",
      prompt: "Combien d'étudiants y a-t-il ? (Answer: thirty-two)",
      gloss: "There are thirty-two students in the class.",
      target: "Il y a trente-deux étudiants dans la classe",
      focus: "Nasal /ɑ̃/ in dans, and the /ø/ in deux",
    },
    {
      id: 5,
      title: "Asking directions",
      kind: "respond",
      prompt: "Ask where the nearest station is.",
      gloss: "Where is the nearest station?",
      target: "Où se trouve la gare la plus proche",
      focus: "The /u/–/y/ contrast — où versus plus",
    },
    {
      id: 6,
      title: "Talking about weather",
      kind: "repeat",
      prompt: "Describe cold, rainy weather.",
      gloss: "It is very cold and it is raining a lot today.",
      target: "Il fait très froid et il pleut beaucoup aujourd'hui",
      focus: "Consonant clusters with /ʁ/ — très, froid",
    },
    {
      id: 7,
      title: "Telling the time",
      kind: "respond",
      prompt: "À quelle heure part le train ? (Answer: quarter past eight)",
      gloss: "The train leaves at a quarter past eight.",
      target: "Le train part à huit heures et quart",
      focus: "The /ɥi/ glide in huit, and liaison into heures",
    },
    {
      id: 8,
      title: "Shopping",
      kind: "respond",
      prompt: "Ask how much the blue shirt costs.",
      gloss: "How much does this blue shirt cost?",
      target: "Combien coûte cette chemise bleue",
      focus: "/ʃ/ in chemise, and the rounded /ø/ in bleue",
    },
    {
      id: 9,
      title: "At the restaurant",
      kind: "repeat",
      prompt: "Ask for the bill and say the meal was delicious.",
      gloss: "The bill, please. It was delicious.",
      target: "L'addition s'il vous plaît c'était délicieux",
      focus: "The /sj/ sequence in addition and délicieux",
    },
    {
      id: 10,
      title: "Saying goodbye",
      kind: "repeat",
      prompt: "Say goodbye warmly.",
      gloss: "Goodbye, see you soon, and have a good day.",
      target: "Au revoir à bientôt et bonne journée",
      focus: "/ʁ/ in revoir, nasal /jɛ̃/ in bientôt",
    },
  ],
};
