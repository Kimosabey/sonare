/**
 * Ten Hindi activities, mirroring the French set's structure and
 * progression. Reference text is in Devanagari, matching what hi-IN expects
 * for pronunciation assessment — not transliteration. Each target carries a
 * sound English speakers reliably get wrong: the aspirated/unaspirated stop
 * contrast (क vs ख, ट vs ठ, त vs थ — phonemic in Hindi, not in English),
 * retroflex vs. dental consonants (ट/ड vs त/द), vowel length, and
 * nasalization (anusvara/candrabindu).
 */

import type { LanguageActivitySet } from "../types.js";

export const HINDI: LanguageActivitySet = {
  code: "hi-IN",
  slug: "hi",
  label: "Hindi",
  activities: [
    {
      id: 1,
      title: "Greetings",
      kind: "repeat",
      prompt: "Say hello politely.",
      gloss: "Hello, how are you?",
      target: "नमस्ते, आप कैसे हैं?",
      focus: "Unaspirated dental त in नमस्ते versus the aspirated थ family, and the diphthong ऐ in कैसे",
    },
    {
      id: 2,
      title: "Introducing yourself",
      kind: "repeat",
      prompt: "Introduce yourself and say where you live.",
      gloss: "My name is Anjali and I live in Delhi.",
      target: "मेरा नाम अंजलि है और मैं दिल्ली में रहती हूं",
      focus: "Nasalization (anusvara) in अंजलि, and the retroflex/dental contrast between दिल्ली and रहती",
    },
    {
      id: 3,
      title: "Ordering at a tea stall",
      kind: "repeat",
      prompt: "Order a tea and a samosa.",
      gloss: "I would like a tea and a samosa.",
      target: "मुझे एक चाय और एक समोसा चाहिए",
      focus: "The aspirated palatal छ-adjacent च in चाय, and long vowel ा in चाहिए",
    },
    {
      id: 4,
      title: "Numbers",
      kind: "respond",
      prompt: "कक्षा में कितने छात्र हैं? (Answer: thirty-two)",
      gloss: "There are thirty-two students in the class.",
      target: "कक्षा में बत्तीस छात्र हैं",
      focus: "The retroflex-adjacent geminate त्त in बत्तीस, and aspirated छ in छात्र",
    },
    {
      id: 5,
      title: "Asking directions",
      kind: "respond",
      prompt: "Ask where the nearest station is.",
      gloss: "Where is the nearest station?",
      target: "सबसे नज़दीकी स्टेशन कहाँ है?",
      focus: "The flap ज़ (za) in नज़दीकी, distinct from ज, and nasalized आँ in कहाँ",
    },
    {
      id: 6,
      title: "Talking about weather",
      kind: "repeat",
      prompt: "Describe cold, rainy weather.",
      gloss: "It is very cold today and it is raining.",
      target: "आज बहुत ठंड है और बारिश हो रही है",
      focus: "The retroflex ठ in ठंड, aspirated and distinct from dental त",
    },
    {
      id: 7,
      title: "Telling the time",
      kind: "respond",
      prompt: "ट्रेन कब जाती है? (Answer: quarter past eight)",
      gloss: "The train leaves at quarter past eight.",
      target: "ट्रेन सवा आठ बजे जाती है",
      focus: "The retroflex ट in ट्रेन and आठ — both retroflex, easy to flatten to English /t/",
    },
    {
      id: 8,
      title: "Shopping",
      kind: "respond",
      prompt: "Ask how much the blue shirt costs.",
      gloss: "How much is this blue shirt?",
      target: "यह नीली कमीज़ कितने की है?",
      focus: "The flap ज़ in कमीज़, and long vowel ी in नीली",
    },
    {
      id: 9,
      title: "At a restaurant",
      kind: "repeat",
      prompt: "Ask for the bill and say the meal was delicious.",
      gloss: "Bring the bill, please. The food was very delicious.",
      target: "बिल लाइए, कृपया। खाना बहुत स्वादिष्ट था",
      focus: "The aspirated ख in खाना versus unaspirated क, and the conjunct ष्ट in स्वादिष्ट",
    },
    {
      id: 10,
      title: "Saying goodbye",
      kind: "repeat",
      prompt: "Say goodbye warmly.",
      gloss: "Goodbye, see you again, have a good day.",
      target: "अलविदा, फिर मिलेंगे, आपका दिन शुभ हो",
      focus: "Aspirated भ in शुभ versus unaspirated ब, and nasalized ें in मिलेंगे",
    },
  ],
};
