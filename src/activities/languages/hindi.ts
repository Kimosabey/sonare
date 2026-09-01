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
      prompt: "पार्टी में कितने मेहमान हैं? (Answer: forty)",
      gloss: "There are forty guests at the party.",
      target: "पार्टी में चालीस मेहमान हैं",
      focus: "The retroflex ट in पार्टी (a loanword using retroflex for English 't'), and the unaspirated च in चालीस",
    },
    {
      id: 5,
      title: "Asking directions",
      kind: "respond",
      prompt: "Ask where the nearest market is.",
      gloss: "Where is the nearest market?",
      target: "सबसे नज़दीकी बाज़ार कहाँ है?",
      focus: "The flap ज़ (za) in नज़दीकी and बाज़ार, distinct from ज, and nasalized आँ in कहाँ",
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
      prompt: "फ़िल्म कब शुरू होती है? (Answer: half past six)",
      gloss: "The movie starts at half past six.",
      target: "फ़िल्म साढ़े छह बजे शुरू होती है",
      focus: "The aspirated छ in छह, and the flap ढ़ in साढ़े",
    },
    {
      id: 8,
      title: "Shopping",
      kind: "respond",
      prompt: "Ask how much the red kurta costs.",
      gloss: "How much is this red kurta?",
      target: "यह लाल कुर्ता कितने का है?",
      focus: "The consonant cluster र्त in कुर्ता, and the long vowel ा in लाल",
    },
    {
      id: 9,
      title: "At a restaurant",
      kind: "repeat",
      prompt: "Ask for the bill and say the food was very tasty.",
      gloss: "Bring the bill, please. The food was very tasty.",
      target: "बिल लाइए, कृपया। खाना बहुत लज़ीज़ था",
      focus: "The flap ज़ in लज़ीज़, and the conjunct कृ (kr) in कृपया",
    },
    {
      id: 10,
      title: "Saying goodbye",
      kind: "repeat",
      prompt: "Say goodbye warmly, and tell them to take care.",
      gloss: "Goodbye, take care of yourself, see you soon.",
      target: "अलविदा, अपना ख़याल रखिए, जल्दी मिलेंगे",
      focus: "The fricative ख़ (distinct from aspirated ख) in ख़याल, and the conjunct ल्द in जल्दी",
    },
  ],
};
