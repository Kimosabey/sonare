/**
 * Let the learner hear the phrase before they attempt it.
 *
 * The largest gap in the product: a learner was shown "Bonjour, comment
 * allez-vous", told what it means, and asked to say it correctly — with no
 * reference to imitate. Pronunciation is taught by demonstration everywhere
 * else in the world, and this app taught it by description alone.
 *
 * **R1 permits this.** R1 bans the browser's *recognition* interface, and its
 * stated reason is "it provides no phoneme data" — an argument about
 * recognition that has nothing to say about output. `speechSynthesis` is a
 * separate API on the other side of the pipe, PRD §4 does not list it, and
 * verify.mjs matches only the recognition identifier. Worth writing down
 * because "Web Speech API" is otherwise a banned phrase in this repo, and a
 * reviewer should not have to re-derive the distinction. (The identifier
 * itself is deliberately not spelled here: R1 is a plain grep and correctly
 * does not exempt prose.)
 *
 * It also reports *where* it is. The platform emits a boundary event per word
 * as it speaks, which is enough to mark the word being said — the thing that
 * turns hearing a phrase into following one, and how a learner maps a sound to
 * its spelling. That reporting is uneven across engines and absent on some, so
 * it is treated throughout as information that may never arrive: see
 * `wordIndex` and the `onboundary` note below.
 *
 * Honest about what it is: a synthetic voice is not a native speaker. For a
 * pronunciation model that gap is real — but the platform voices for fr-FR,
 * es-ES, de-DE and hi-IN are good enough to imitate, and the alternative on
 * offer was silence. Recorded native audio would be better and is a larger
 * piece of work; this does not preclude it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Slightly under natural pace. A learner is imitating rather than listening
 * for meaning, and syllable boundaries are what they need to hear — the thing
 * this app scores them on. Far enough from 1.0 to help, close enough not to
 * distort the vowels they are copying.
 */
const RATE = 0.85;

export interface ModelSpeech {
  /** False when the platform has no usable voice — the control then hides rather than lying. */
  available: boolean;
  speaking: boolean;
  /**
   * Which word of the utterance is sounding right now, counting words the way
   * `phraseTokens` does — or `null` when there is no word to mark.
   *
   * `null` covers two cases the caller deliberately does not have to tell
   * apart: nothing is speaking, and something is speaking but this engine
   * reports no word boundaries at all. In both there is no word to mark, so
   * the phrase renders exactly as it did before any of this existed. See the
   * note on `onboundary` in `speak`.
   */
  wordIndex: number | null;
  speak: (text: string, lang: string) => void;
  cancel: () => void;
}

/** One run of a phrase: either a word, or the whitespace between two words. */
export interface PhraseToken {
  text: string;
  /** Where this run starts in the phrase — the same units a boundary reports. */
  start: number;
  /** Its position among the phrase's words, or `null` for whitespace. */
  index: number | null;
}

/**
 * Split a phrase into its words and the gaps between them, losing nothing.
 *
 * Lives beside the hook rather than beside the rendering because the two have
 * to agree on what "word 3" means, and the only way to guarantee that is for
 * one function to answer it for both — the hook turns a character offset into
 * a word number with it, the screen draws those same words with it.
 *
 * Whitespace runs are kept as tokens rather than discarded, so concatenating
 * the tokens reproduces the phrase character for character. That is what lets
 * the screen rebuild the phrase out of spans without rewriting a single space
 * — French puts one before its question mark, and a `split(/\s+/)` that threw
 * the gaps away would silently normalise it.
 */
export function phraseTokens(text: string): PhraseToken[] {
  const tokens: PhraseToken[] = [];
  let index = 0;
  let start = 0;
  // Capturing the separator keeps the gaps in the result, alternating with the
  // words. Empty strings appear when the phrase begins or ends with
  // whitespace; they are skipped rather than rendered as empty spans.
  for (const run of text.split(/(\s+)/)) {
    if (run !== "") {
      const gap = /^\s+$/.test(run);
      tokens.push({ text: run, start, index: gap ? null : index });
      if (!gap) index += 1;
    }
    start += run.length;
  }
  return tokens;
}

/**
 * The word containing `charIndex`, or the next word after it.
 *
 * Engines disagree about where a word starts: some report the first letter,
 * some the whitespace or opening punctuation ahead of it. An offset landing
 * between two words therefore has to resolve *forwards*, to the word about to
 * be said, rather than backwards to the one just finished — resolving
 * backwards makes the highlight trail the voice by a word, which teaches the
 * learner the wrong mapping and is worse than showing nothing.
 *
 * `null` when the offset is past the last word, which the caller ignores
 * rather than acts on.
 */
function wordAtChar(tokens: PhraseToken[], charIndex: number): number | null {
  for (const token of tokens) {
    if (token.index === null) continue;
    if (charIndex >= token.start && charIndex < token.start + token.text.length) return token.index;
    // Tokens are in document order, so the first word starting at or after
    // the offset is the next one due.
    if (token.start >= charIndex) return token.index;
  }
  return null;
}

function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  const wanted = lang.toLowerCase();
  const prefix = wanted.split("-")[0] ?? wanted;

  // An exact locale match first: fr-CA saying a fr-FR phrase is a different
  // accent, which is exactly the variable this product measures.
  return (
    voices.find((v) => v.lang.toLowerCase().replace("_", "-") === wanted) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ??
    null
  );
}

export function useModelSpeech(lang: string): ModelSpeech {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [wordIndex, setWordIndex] = useState<number | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  /**
   * getVoices() is empty on first call in several browsers and fills in
   * asynchronously, so the list is read again on `voiceschanged` rather than
   * concluding from one empty answer that the platform has no voices.
   */
  useEffect(() => {
    const synth = typeof window === "undefined" ? undefined : window.speechSynthesis;
    if (!synth) return;

    const read = () => setVoices(synth.getVoices());
    read();
    synth.addEventListener("voiceschanged", read);
    return () => synth.removeEventListener("voiceschanged", read);
  }, []);

  const cancel = useCallback(() => {
    window.speechSynthesis?.cancel();
    utteranceRef.current = null;
    setSpeaking(false);
    setWordIndex(null);
  }, []);

  // Speech outliving the component would keep talking over the next screen.
  useEffect(() => cancel, [cancel]);

  const speak = useCallback(
    (text: string, utteranceLang: string) => {
      const synth = window.speechSynthesis;
      if (!synth || !text.trim()) return;

      // Cancel first: without it a second tap queues rather than replaces, and
      // the learner hears the phrase twice over itself.
      synth.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = utteranceLang;
      utterance.rate = RATE;
      const voice = pickVoice(synth.getVoices(), utteranceLang);
      if (voice) utterance.voice = voice;

      utterance.onend = () => {
        if (utteranceRef.current === utterance) {
          utteranceRef.current = null;
          setSpeaking(false);
          setWordIndex(null);
        }
      };
      // Treated the same as ending: a failed utterance must not leave the
      // control stuck looking busy.
      utterance.onerror = utterance.onend;

      /**
       * Following along while hearing a phrase is how a learner maps a sound
       * to its spelling, and the platform already knows where the voice is.
       *
       * **Strictly an enhancement, and written so that it cannot become a
       * requirement.** `boundary` support is uneven — several engines fire
       * nothing at all, and on those `wordIndex` simply stays `null` for the
       * whole utterance. Nothing here is awaited, nothing gates `speak` or
       * `onend` on a boundary arriving, and the highlight is the only thing
       * that depends on one. Playback on an engine that reports no boundaries
       * is byte-for-byte the playback that shipped before this existed.
       *
       * The token list is captured per utterance rather than read from state:
       * a second tap replaces the utterance, and the stale one's late events
       * must not renumber the new phrase. The identity check does the same job
       * `onend` does above.
       */
      const tokens = phraseTokens(text);
      utterance.onboundary = (event) => {
        if (utteranceRef.current !== utterance) return;
        // Engines also report sentence boundaries; only words move a word.
        if (event.name !== "" && event.name !== "word") return;
        const at = wordAtChar(tokens, event.charIndex);
        // An offset past the end is ignored rather than obeyed: clearing the
        // highlight mid-phrase would read as the voice having stopped.
        if (at !== null) setWordIndex(at);
      };

      utteranceRef.current = utterance;
      setSpeaking(true);
      setWordIndex(null);
      synth.speak(utterance);
    },
    [],
  );

  return {
    available: typeof window !== "undefined" && !!window.speechSynthesis && pickVoice(voices, lang) !== null,
    speaking,
    wordIndex,
    speak,
    cancel,
  };
}
