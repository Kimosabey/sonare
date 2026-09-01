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
      prompt: "Order a coffee and churros.",
      gloss: "I would like a coffee and churros, please.",
      target: "Quisiera un café y churros, por favor",
      focus: "The trilled /r/ in churros, distinct from the tap in favor",
    },
    {
      id: 4,
      title: "Numbers",
      kind: "respond",
      prompt: "¿Cuántos invitados hay en la boda? (Answer: forty-four)",
      gloss: "There are forty-four guests at the wedding.",
      target: "Hay cuarenta y cuatro invitados en la boda",
      focus: "The /kw/ cluster in cuarenta and cuatro, and the silent h in Hay",
    },
    {
      id: 5,
      title: "Asking directions",
      kind: "respond",
      prompt: "Ask where the nearest pharmacy is.",
      gloss: "Where is the nearest pharmacy?",
      target: "¿Dónde está la farmacia más cercana?",
      focus: "The Castilian θ in cercana — distinción, not seseo",
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
      prompt: "¿A qué hora empieza el concierto? (Answer: half past nine)",
      gloss: "The concert starts at half past nine.",
      target: "El concierto empieza a las nueve y media",
      focus: "The θ in empieza, and the soft /ð/ in media",
    },
    {
      id: 8,
      title: "Shopping",
      kind: "respond",
      prompt: "Ask how much the black shoes cost.",
      gloss: "How much do these black shoes cost?",
      target: "¿Cuánto cuestan estos zapatos negros?",
      focus: "The θ in cuánto and cuestan",
    },
    {
      id: 9,
      title: "At the restaurant",
      kind: "repeat",
      prompt: "Ask for the bill and say the meal was exquisite.",
      gloss: "The bill, please. It was exquisite.",
      target: "La cuenta, por favor. Estaba exquisito",
      focus: "The /ks/ cluster in exquisito, and the tap /ɾ/ in por favor",
    },
    {
      id: 10,
      title: "Saying goodbye",
      kind: "repeat",
      prompt: "Say goodbye warmly, wishing a good night.",
      gloss: "Goodbye, see you soon, and have a good night.",
      target: "Adiós, nos vemos pronto, que tengas una buena noche",
      focus: "The soft /β/ in vemos and buena, and the diphthong /we/ in buena",
    },
  ],
};
