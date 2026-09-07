/**
 * Spoken numbers, so "trente-deux" and "32" stop looking like a mistake.
 *
 * Azure transcribes numbers as digits. Running the alignment over the 139 real
 * attempts showed a learner say "Il y a trente-deux étudiants" perfectly and
 * be told they had dropped a word and substituted another, because the
 * transcript came back "Il y a 32 étudiants". Three of the forty shipped
 * activities contain a cardinal number — "quarante-deux personnes",
 * "siebenundvierzig Gäste", "cuarenta y cuatro invitados" — so this is live
 * content, not an edge case.
 *
 * The alignment's previous answer was to mark such a pair `numeric` and say we
 * could not check. That was honest and it is not good enough when the content
 * ships numbers: a learner gets no verdict on a word they said correctly.
 *
 * **Scope is 0–100, deliberately.** That is what language-learning content
 * uses, and the ranges above it need scale words whose composition differs
 * again per language for no gain here. Anything this cannot parse falls back
 * to the old "could not check", so the worst case is exactly today's
 * behaviour.
 *
 * **Times are out of scope, also deliberately.** "Huit heures et quart"
 * against "08h15" is not a number comparison — "et quart" means fifteen
 * minutes, which is semantics about clocks. Two of the real takes are that
 * case and they stay unchecked rather than guessed at.
 */

/** Number words per language, as they arrive from `tokenise` (folded, lower-case). */
interface NumberWords {
  /** 0–19, indexed by value. Gaps are allowed where a language builds them. */
  units: Record<string, number>;
  /** Multiples of ten, 20–90. */
  tens: Record<string, number>;
  /** Words joining parts of one number: "et", "y", "und". */
  connectors: ReadonlySet<string>;
  /**
   * Words that multiply what precedes them rather than adding — French
   * "quatre-vingt" is four twenties. Absent for languages that do not.
   */
  multipliers?: Record<string, number>;
  /** Hundred, as a multiplier on what precedes it. */
  hundred?: ReadonlySet<string>;
  /**
   * Inner joiner for a language that writes a whole number as one word:
   * German "siebenundvierzig" is sieben-und-vierzig. Split on it before
   * looking anything up.
   */
  compoundJoiner?: string;
}

/**
 * Accents are already folded by the caller's normalisation, so these are
 * written folded too — "zero" not "zéro", "seize" not "seizè".
 */
const FRENCH: NumberWords = {
  units: {
    zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7,
    huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14,
    quinze: 15, seize: 16,
  },
  tens: { vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 },
  connectors: new Set(["et", "-"]),
  // "quatre" before "vingt" is eighty, and "dix-sept" is ten plus seven — the
  // additive pass below handles the second, this handles the first.
  multipliers: { vingt: 20, vingts: 20 },
  hundred: new Set(["cent", "cents"]),
};

const SPANISH: NumberWords = {
  units: {
    cero: 0, uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
    siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
    catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
    diecinueve: 19,
    // The twenties are written as one word in Spanish.
    veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
    veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  },
  tens: {
    veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
    setenta: 70, ochenta: 80, noventa: 90,
  },
  connectors: new Set(["y"]),
  hundred: new Set(["cien", "ciento", "cientos"]),
};

const GERMAN: NumberWords = {
  units: {
    null: 0, eins: 1, ein: 1, eine: 1, einen: 1, zwei: 2, drei: 3, vier: 4, funf: 5,
    sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwolf: 12,
    dreizehn: 13, vierzehn: 14, funfzehn: 15, sechzehn: 16, siebzehn: 17,
    achtzehn: 18, neunzehn: 19,
  },
  tens: {
    zwanzig: 20, dreissig: 30, dreizig: 30, vierzig: 40, funfzig: 50,
    sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90,
  },
  connectors: new Set(["und"]),
  hundred: new Set(["hundert"]),
  // "siebenundvierzig" arrives as a single token and has to be taken apart.
  compoundJoiner: "und",
};

const ENGLISH: NumberWords = {
  units: {
    zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19,
  },
  tens: {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
    eighty: 80, ninety: 90,
  },
  connectors: new Set(["and"]),
  hundred: new Set(["hundred"]),
};

/**
 * Hindi 0–20 plus the tens that appear in teaching content.
 *
 * Every number in Hindi is its own irregular word, so there is no composition
 * to exploit and no shortcut: this is a list, and a deliberately partial one.
 * Content currently uses एक. Anything absent falls back to "could not check",
 * which is the same answer Hindi got before this file existed.
 */
const HINDI: NumberWords = {
  units: {
    "शून्य": 0, "एक": 1, "दो": 2, "तीन": 3, "चार": 4, "पाँच": 5, "पांच": 5,
    "छह": 6, "छः": 6, "सात": 7, "आठ": 8, "नौ": 9, "दस": 10, "ग्यारह": 11,
    "बारह": 12, "तेरह": 13, "चौदह": 14, "पंद्रह": 15, "सोलह": 16, "सत्रह": 17,
    "अठारह": 18, "उन्नीस": 19,
  },
  tens: { "बीस": 20, "तीस": 30, "चालीस": 40, "पचास": 50, "साठ": 60, "सत्तर": 70, "अस्सी": 80, "नब्बे": 90 },
  connectors: new Set([]),
  hundred: new Set(["सौ"]),
};

/** Keyed on the base language, so fr-FR and fr-CA share one table. */
const BY_LANGUAGE: Record<string, NumberWords> = {
  fr: FRENCH,
  es: SPANISH,
  de: GERMAN,
  en: ENGLISH,
  hi: HINDI,
};

function tableFor(language: string): NumberWords | null {
  const base = language.toLowerCase().split(/[-_]/)[0] ?? "";
  return BY_LANGUAGE[base] ?? null;
}

/** Digits, in Latin or Devanagari, with no separators — a bare cardinal. */
const BARE_DIGITS = /^[\d०-९]+$/u;

/** Devanagari digits share the Latin values, offset by U+0966. */
function digitsToValue(token: string): number | null {
  let value = 0;
  for (const char of token) {
    const code = char.codePointAt(0) ?? 0;
    const digit =
      code >= 0x30 && code <= 0x39 ? code - 0x30 : code >= 0x966 && code <= 0x96f ? code - 0x966 : -1;
    if (digit < 0) return null;
    value = value * 10 + digit;
  }
  return value;
}

/** One token's value, taking a single-word compound apart where the language uses them. */
function wordValue(token: string, words: NumberWords): number | null {
  const direct = words.units[token] ?? words.tens[token];
  if (direct !== undefined) return direct;

  // German writes a whole number as one word, unit first: sieben-und-vierzig.
  const joiner = words.compoundJoiner;
  if (joiner !== undefined && token.includes(joiner)) {
    const at = token.indexOf(joiner);
    const unit = words.units[token.slice(0, at)];
    const ten = words.tens[token.slice(at + joiner.length)];
    if (unit !== undefined && ten !== undefined) return ten + unit;
  }
  return null;
}

/** True when this token could be part of a spoken number in this language. */
function isNumberish(token: string, words: NumberWords): boolean {
  return (
    wordValue(token, words) !== null ||
    words.connectors.has(token) ||
    (words.hundred?.has(token) ?? false)
  );
}

/**
 * Reads a run of number tokens into one value.
 *
 * Additive with two exceptions, which is enough for 0–100 across these
 * languages: a multiplier word takes what precedes it ("quatre vingt" is
 * eighty, not twenty-four), and "hundred" multiplies the running total. A
 * connector is skipped. Anything that does not fit returns null and the caller
 * leaves the tokens alone.
 */
function runValue(tokens: string[], words: NumberWords): number | null {
  let total = 0;
  let pending: number | null = null;
  let sawAny = false;

  for (const token of tokens) {
    if (words.connectors.has(token)) continue;

    if (words.hundred?.has(token)) {
      total += (pending ?? 1) * 100;
      pending = null;
      sawAny = true;
      continue;
    }

    const multiplier = words.multipliers?.[token];
    // Only a unit of 2–9 multiplies: "quatre vingt" is eighty, while a bare
    // "vingt" is twenty and "vingt et un" is twenty-one.
    if (multiplier !== undefined && pending !== null && pending >= 2 && pending <= 9) {
      total += pending * multiplier;
      pending = null;
      sawAny = true;
      continue;
    }

    const value = wordValue(token, words);
    if (value === null) return null;

    if (pending === null) {
      pending = value;
    } else {
      // Additive: "soixante dix" is seventy, "dix sept" is seventeen.
      pending += value;
    }
    sawAny = true;
  }

  if (!sawAny) return null;
  const result = total + (pending ?? 0);
  // Above 100 the composition rules diverge per language and nothing here
  // needs them, so refuse rather than return a number nobody checked.
  return result <= 100 ? result : null;
}

/** The canonical form both a digit token and a spelled-out run collapse to. */
export function canonicalNumber(value: number): string {
  return `#${value}`;
}

/** True for a token this module produced. */
export function isCanonicalNumber(token: string): boolean {
  return /^#\d+$/.test(token);
}

/**
 * Collapses every number in a token list to one canonical token per number.
 *
 * "trente deux" and "32" both become "#32", so the aligner compares them as
 * one word and a learner who said the number correctly is told so. Runs that
 * cannot be parsed are returned untouched, which leaves the alignment's
 * existing `numeric` handling to say we could not check.
 *
 * `raw` is carried alongside so display keeps what was written: the chip for a
 * collapsed run shows "trente-deux", not "#32".
 */
export function collapseNumbers(
  tokens: string[],
  raw: string[],
  language: string,
): { tokens: string[]; raw: string[] } {
  const words = tableFor(language);
  if (words === null) return { tokens, raw };

  const outTokens: string[] = [];
  const outRaw: string[] = [];

  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i] ?? "";

    // A bare digit token is already one number.
    if (BARE_DIGITS.test(token)) {
      const value = digitsToValue(token);
      if (value !== null && value <= 100) {
        outTokens.push(canonicalNumber(value));
        outRaw.push(raw[i] ?? token);
        i += 1;
        continue;
      }
    }

    if (isNumberish(token, words) && wordValue(token, words) !== null) {
      // Take the longest run that still parses, so a trailing connector
      // belonging to the sentence ("et" in "et il pleut") is not swallowed.
      let end = i + 1;
      let bestEnd = i + 1;
      let bestValue = runValue(tokens.slice(i, end), words);

      while (end < tokens.length && isNumberish(tokens[end] ?? "", words)) {
        end += 1;
        const value = runValue(tokens.slice(i, end), words);
        if (value !== null) {
          bestEnd = end;
          bestValue = value;
        }
      }

      if (bestValue !== null) {
        outTokens.push(canonicalNumber(bestValue));
        outRaw.push(raw.slice(i, bestEnd).join("-"));
        i = bestEnd;
        continue;
      }
    }

    outTokens.push(token);
    outRaw.push(raw[i] ?? token);
    i += 1;
  }

  return { tokens: outTokens, raw: outRaw };
}
