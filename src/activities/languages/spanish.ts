/**
 * Ten Spanish (Spain) activities, mirroring the French set's structure and
 * progression. Each target carries a sound English speakers reliably get
 * wrong: the tapped vs. trilled r, the Castilian θ/s distinción (es-ES
 * specifically preserves this contrast, unlike most Latin American
 * varieties), the jota /x/, ñ /ɲ/, and silent h.
 */

import type { LanguageActivitySet } from "../types.js";

export const SPANISH: LanguageActivitySet = {
  code: "es-ES",
  slug: "es",
  label: "Spanish",
  activities: [
    {
      id: 1,
      title: "Greetings",
      kind: "repeat",
      prompt: "Say hello politely.",
      gloss: "Hello, how are you?",
      target: "Hola, ¿cómo está usted?",
      focus: "The tapped /ɾ/ in cómo, and the /w/ glide in usted",
    },
    {
      id: 2,
      title: "Introducing yourself",
      kind: "repeat",
      prompt: "Introduce yourself and say where you live.",
      gloss: "My name is María and I live in Madrid.",
      target: "Me llamo María y vivo en Madrid",
      focus: "The palatal /ʎ/ or /j/ in llamo, and final /d/ devoicing in Madrid",
    },
    {
      id: 3,
      title: "Ordering in a café",
      kind: "repeat",
      prompt: "Order a coffee and a croissant.",
      gloss: "I would like a coffee and a croissant, please.",
      target: "Quisiera un café y un cruasán, por favor",
      focus: "The trilled /r/ in cruasán, distinct from the tap in favor",
    },
    {
      id: 4,
      title: "Numbers",
      kind: "respond",
      prompt: "¿Cuántos estudiantes hay? (Answer: thirty-two)",
      gloss: "There are thirty-two students in the class.",
      target: "Hay treinta y dos estudiantes en la clase",
      focus: "The consonant cluster /tɾ/ in treinta, and the silent h in Hay",
    },
    {
      id: 5,
      title: "Asking directions",
      kind: "respond",
      prompt: "Ask where the nearest station is.",
      gloss: "Where is the nearest station?",
      target: "¿Dónde está la estación más cercana?",
      focus: "The Castilian θ in estación and cercana — distinción, not seseo",
    },
    {
      id: 6,
      title: "Talking about weather",
      kind: "repeat",
      prompt: "Describe cold, rainy weather.",
      gloss: "It is very cold and it is raining a lot today.",
      target: "Hace mucho frío y está lloviendo mucho hoy",
      focus: "The jota /x/ in mucho and hoy's silent h",
    },
    {
      id: 7,
      title: "Telling the time",
      kind: "respond",
      prompt: "¿A qué hora sale el tren? (Answer: quarter past eight)",
      gloss: "The train leaves at a quarter past eight.",
      target: "El tren sale a las ocho y cuarto",
      focus: "The /kw/ sequence in cuarto, and trilled /r/ in tren",
    },
    {
      id: 8,
      title: "Shopping",
      kind: "respond",
      prompt: "Ask how much the blue shirt costs.",
      gloss: "How much does this blue camisa cost?",
      target: "¿Cuánto cuesta esta camisa azul?",
      focus: "The θ in cuánto/cuesta, and /θ/ again in azul's neighbor sound",
    },
    {
      id: 9,
      title: "At the restaurant",
      kind: "repeat",
      prompt: "Ask for the bill and say the meal was delicious.",
      gloss: "The bill, please. It was delicious.",
      target: "La cuenta, por favor. Estaba delicioso",
      focus: "The θ in delicioso, and the tap /ɾ/ in por favor",
    },
    {
      id: 10,
      title: "Saying goodbye",
      kind: "repeat",
      prompt: "Say goodbye warmly.",
      gloss: "Goodbye, see you soon, and have a good day.",
      target: "Adiós, hasta pronto, que tengas un buen día",
      focus: "The ñ-adjacent /ŋ/ in tengas, and the silent h in hasta",
    },
  ],
};
