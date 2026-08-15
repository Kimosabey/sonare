/**
 * Preloaded drill phrases, grouped by language.
 *
 * Chosen for phonetic coverage rather than usefulness as sentences: each one
 * carries sounds that are known to separate learners from native speakers, so a
 * scorer that discriminates has something to discriminate on. The `focus` note
 * is shown in the UI so whoever runs the fixture knows what a low score on that
 * phrase would mean.
 *
 * Reference text is still free-entry — these are a starting point, not a
 * closed list.
 */

export interface Phrase {
  text: string;
  /** What this phrase is designed to expose. */
  focus: string;
}

export const PHRASES: Record<string, Phrase[]> = {
  "en-US": [
    { text: "Would you like something to drink", focus: "th, consonant clusters" },
    { text: "She thinks the weather is thirty degrees", focus: "θ/ð fronting — th → s/t" },
    { text: "He very rarely eats fresh vegetables", focus: "v/w confusion" },
    { text: "The children walked through the world", focus: "final consonant deletion" },
    { text: "I would prefer a glass of water", focus: "consonant clusters, /w/" },
  ],
  "en-GB": [
    { text: "Could you pass me the bottle of water", focus: "glottal t, non-rhotic vowels" },
    { text: "The weather turned rather cold this Thursday", focus: "θ/ð, /ɜː/" },
    { text: "I thought about it thoroughly", focus: "θ in sequence" },
  ],
  "en-IN": [
    { text: "Would you like something to drink", focus: "th, clusters" },
    { text: "The train to the station leaves at three", focus: "retroflex t/d, θ" },
  ],
  "fr-FR": [
    { text: "Je voudrais un verre d'eau s'il vous plaît", focus: "nasal vowels, /ʁ/" },
    { text: "Bonjour, comment allez-vous aujourd'hui", focus: "nasals, liaison" },
    { text: "Où se trouve la gare la plus proche", focus: "/u/ vs /y/, uvular r" },
    { text: "Il fait très beau ce matin", focus: "/ɛ/ vs /e/, final consonant silence" },
    { text: "Elle a acheté deux nouvelles chemises", focus: "/ø/, /ʃ/, liaison" },
  ],
  "es-ES": [
    { text: "Me gustaría un vaso de agua por favor", focus: "tapped r, /β/ fricative b" },
    { text: "¿Dónde está la estación de tren más cercana?", focus: "trilled rr, /θ/ in Castilian" },
    { text: "Buenos días, ¿cómo está usted?", focus: "diphthongs, /d/ fricative" },
    { text: "El perro corre rápido por el parque", focus: "trilled rr vs tapped r" },
    { text: "Necesito reservar una habitación", focus: "silent h, /θ/, stress placement" },
  ],
  "de-DE": [
    { text: "Ich möchte bitte ein Glas Wasser", focus: "ich-Laut /ç/, /ø/" },
    { text: "Wo ist der nächste Bahnhof", focus: "ach-Laut /x/, final devoicing" },
  ],
  "hi-IN": [{ text: "क्या आप मुझे पानी दे सकते हैं", focus: "aspirated stops, retroflex" }],
  "ta-IN": [{ text: "எனக்கு தண்ணீர் வேண்டும்", focus: "retroflex series" }],
  "te-IN": [{ text: "నాకు మంచి నీళ్ళు కావాలి", focus: "retroflex, aspiration" }],
};

/** Languages that have at least one preloaded phrase, in display order. */
export const LANGUAGES = Object.keys(PHRASES);

export const LANGUAGE_LABELS: Record<string, string> = {
  "en-US": "English (US)",
  "en-GB": "English (UK)",
  "en-IN": "English (India)",
  "fr-FR": "French",
  "es-ES": "Spanish",
  "de-DE": "German",
  "hi-IN": "Hindi",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
};

export function phrasesFor(language: string): Phrase[] {
  return PHRASES[language] ?? [];
}

export function firstPhraseFor(language: string): string {
  return phrasesFor(language)[0]?.text ?? "";
}
