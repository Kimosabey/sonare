/**
 * Ten Kannada activities, mirroring the other sets' structure and
 * progression. Reference text is in the Kannada script, matching what kn-IN
 * expects for pronunciation assessment — not transliteration.
 *
 * ## Written without a Kannada speaker — read this before shipping it further
 *
 * These phrases were authored on 2026-09-22 by somebody who does not speak
 * Kannada, and **nobody who does has checked them**. That is a real caveat and
 * not a formality: a learner imitates this audio and is then scored against
 * this text, so an unnatural phrase teaches an unnatural habit *and* marks
 * them down for the habit it taught. The two failures compound and point in
 * opposite directions.
 *
 * It is stated here rather than tracked elsewhere because this file is what
 * somebody will open when they come to check. `node scripts/voice-check.mjs`
 * puts every generated clip beside the phrase it is meant to be saying, which
 * is the surface a reviewer should use.
 *
 * The same caveat already applies to the Spanish set and to the German
 * difficulty advice. This is not a lower standard for Kannada — it is the
 * standard this project has been running at, written down.
 *
 * ## What the scorer can and cannot do here
 *
 * Azure accepts `kn-IN` and segments words correctly, and it names **no
 * syllables at all** — measured 0 of 0 across the probe's phrases. So this set
 * declares no `soundTargets`, exactly as Hindi does, and a Kannada learner
 * gets a score with positional feedback rather than a named sound. Nothing
 * here claims otherwise.
 *
 * `focus` therefore describes what the phrase is *for* in a teacher's words,
 * and is never rendered as a claim about what the scorer measured.
 *
 * ## What each phrase carries
 *
 * Kannada's difficulty for an English speaker is mostly two contrasts that
 * English does not make: **retroflex against dental** (ಟ/ಡ/ಣ/ಳ against
 * ತ/ದ/ನ/ಲ), and **aspirated against unaspirated** stops. Both are phonemic —
 * they change the word — and both are inaudible to most English speakers until
 * pointed out.
 */

import type { LanguageActivitySet } from "../types.js";

export const KANNADA: LanguageActivitySet = {
  code: "kn-IN",
  slug: "kn",
  label: "Kannada",
  activities: [
    {
      id: 1,
      title: "Greetings",
      kind: "repeat",
      prompt: "Say hello politely.",
      gloss: "Hello, how are you?",
      target: "ನಮಸ್ಕಾರ, ನೀವು ಹೇಗಿದ್ದೀರಿ",
      focus:
        "The ಸ್ಕಾ cluster in ನಮಸ್ಕಾರ, which stays one beat rather than growing a vowel between the two consonants, and the long ೀ in ಹೇಗಿದ್ದೀರಿ — vowel length changes the word here, where in English it rarely does",
    },
    {
      id: 2,
      title: "Introducing yourself",
      kind: "repeat",
      prompt: "Say your name and where you live.",
      gloss: "My name is Meera and I live in Bengaluru.",
      target: "ನನ್ನ ಹೆಸರು ಮೀರಾ, ನಾನು ಬೆಂಗಳೂರಿನಲ್ಲಿ ವಾಸಿಸುತ್ತೇನೆ",
      focus:
        "The retroflex ಳ in ಬೆಂಗಳೂರು, which English speakers reliably flatten into an ordinary l, and the doubled ನ್ನ",
    },
    {
      id: 3,
      title: "Ordering",
      kind: "repeat",
      prompt: "Order a coffee and something to eat.",
      gloss: "I would like a coffee and a dosa, please.",
      target: "ನನಗೆ ಒಂದು ಕಾಫಿ ಮತ್ತು ದೋಸೆ ಬೇಕು, ದಯವಿಟ್ಟು",
      focus:
        "The doubled retroflex ಟ್ಟ in ದಯವಿಟ್ಟು against the dental ತ್ತ in ಮತ್ತು — the same phrase carries both, which is what makes it worth drilling",
    },
    {
      id: 4,
      title: "Numbers",
      kind: "respond",
      prompt: "How many people are at the meeting?",
      gloss: "There are forty-two people at the meeting.",
      target: "ಸಭೆಯಲ್ಲಿ ನಲವತ್ತೆರಡು ಜನರಿದ್ದಾರೆ",
      focus:
        "The dental ತ್ತ in ನಲವತ್ತೆರಡು and the retroflex ಡ that follows it, two syllables apart",
    },
    {
      id: 5,
      title: "Asking directions",
      kind: "respond",
      prompt: "Ask where the nearest pharmacy is.",
      gloss: "Where is the nearest pharmacy?",
      target: "ಹತ್ತಿರದ ಔಷಧಿ ಅಂಗಡಿ ಎಲ್ಲಿದೆ",
      focus:
        "The aspirated ಧ in ಔಷಧಿ against the unaspirated ದ in ಹತ್ತಿರದ — a distinction English does not make and a learner has to be told is there",
    },
    {
      id: 6,
      title: "Weather",
      kind: "repeat",
      prompt: "Say what the weather is doing.",
      gloss: "It is very cold today and it is raining.",
      target: "ಇಂದು ತುಂಬಾ ಚಳಿ ಇದೆ ಮತ್ತು ಮಳೆ ಬರುತ್ತಿದೆ",
      focus:
        "Two retroflex ಳ sounds, in ಚಳಿ and ಮಳೆ, with an ordinary dental ಲ nowhere in the phrase to lean on",
    },
    {
      id: 7,
      title: "Telling the time",
      kind: "respond",
      prompt: "Say when the film starts.",
      gloss: "The film starts at nine o'clock.",
      target: "ಚಲನಚಿತ್ರ ಒಂಬತ್ತು ಗಂಟೆಗೆ ಪ್ರಾರಂಭವಾಗುತ್ತದೆ",
      focus:
        "The retroflex ಟೆ in ಗಂಟೆ against the dental ತ್ತು in ಒಂಬತ್ತು, and the anusvara nasal in ಗಂ and ರಂ",
    },
    {
      id: 8,
      title: "Asking a price",
      kind: "respond",
      prompt: "Ask how much the sandals cost.",
      gloss: "How much do these sandals cost?",
      target: "ಈ ಚಪ್ಪಲಿಗಳ ಬೆಲೆ ಎಷ್ಟು",
      focus:
        "The doubled ಪ್ಪ in ಚಪ್ಪಲಿ, and the retroflex ಷ್ಟು in ಎಷ್ಟು — a cluster English has no equivalent for",
    },
    {
      id: 9,
      title: "Paying",
      kind: "repeat",
      prompt: "Ask for the bill and say the meal was good.",
      gloss: "The bill, please. The meal was very good.",
      target: "ಬಿಲ್ ಕೊಡಿ ದಯವಿಟ್ಟು, ಊಟ ತುಂಬಾ ಚೆನ್ನಾಗಿತ್ತು",
      focus:
        "The retroflex ಟ in ಊಟ with a long vowel before it, and the doubled ನ್ನ in ಚೆನ್ನಾಗಿತ್ತು",
    },
    {
      id: 10,
      title: "Saying goodbye",
      kind: "repeat",
      prompt: "Say goodbye and tell them to take care.",
      gloss: "I will go and come back. Take care.",
      target: "ಹೋಗಿ ಬರುತ್ತೇನೆ, ಜಾಗ್ರತೆ",
      focus:
        "The ಗ್ರ cluster in ಜಾಗ್ರತೆ, and the long ೇ in ಬರುತ್ತೇನೆ. The phrase is the ordinary Kannada farewell — a literal “goodbye” is not what is said",
    },
  ],
};
