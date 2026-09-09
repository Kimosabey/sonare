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
 * ── two sources, in that order ───────────────────────────────────────────────
 *
 * There are now two ways this hook can produce a model voice, and the
 * preference between them is the whole design.
 *
 * **A served recording, where one exists.** The server generates a
 * native-quality recording of each reference phrase once and serves it as a
 * static file (server/modelVoice/cache.ts, server/routes/modelVoice.ts). It is
 * preferred because it fixes three failures the platform voice has, all of
 * them documented rather than theoretical:
 *
 *  1. **The platform sometimes has no voice at all.** `pickVoice` returns null
 *     when nothing matches the locale, and `available` used to go false —
 *     which *hid the control*. A device with no `hi-IN` voice gave a Hindi
 *     learner no model voice whatsoever, in an app teaching Hindi
 *     pronunciation. A served recording needs no platform voice, so
 *     `available` is now true whenever *either* source can speak.
 *  2. **`boundary` events are optional and several engines never fire them**,
 *     leaving the phrase to play unmarked. A served recording carries
 *     character-level alignment *as data*, so the highlight is scheduled from
 *     times that are already in hand rather than from an event that may never
 *     arrive.
 *  3. **A synthetic voice is not a native speaker,** and its quality varies
 *     per device — so "hear yours, then mine" was comparing the learner
 *     against whatever voice their laptop shipped with. That gap is real and
 *     this is the honest fix for it; the paragraph that used to concede the
 *     point is now a description of the fallback rather than of the product.
 *
 * **The platform voice, otherwise, and it is not going away.** No network, no
 * generated audio, no API key, a pruned file, a phrase outside the corpus (the
 * single word `useCompareToModel` asks for), a manifest that does not parse:
 * every one of those lands on exactly the code that shipped before any of this
 * existed, with the same locale, voice, rate and boundary handling. This is
 * the offline-first property and it is not negotiable — a learner on a train
 * still gets the model voice they got yesterday.
 *
 * Two consequences worth naming rather than discovering:
 *
 *  - `available` answers "is there a model voice" and `canSpeakAnyText`
 *    answers "can arbitrary text be spoken". They differ exactly where served
 *    audio exists and no platform voice does, and the second is what
 *    `useCompareToModel` needs: served recordings cover whole phrases, and the
 *    comparison asks for one word.
 *  - The highlight is scheduled from the alignment when playback starts, not
 *    polled from `currentTime`. Timers can drift against the audio clock; over
 *    a two-to-four second phrase the drift is imperceptible, and the
 *    alternative is an animation frame loop running for the length of every
 *    phrase to place a mark that moves five times.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  manifestUrl,
  readManifest,
  wordStartSeconds,
  type ServedIndex,
  type ServedPhrase,
} from "../modelVoice/manifest.js";

/**
 * Slightly under natural pace. A learner is imitating rather than listening
 * for meaning, and syllable boundaries are what they need to hear — the thing
 * this app scores them on. Far enough from 1.0 to help, close enough not to
 * distort the vowels they are copying.
 *
 * Applies to the *platform* voice only. A served recording plays at the rate
 * it was generated at: it is a real voice reading the phrase, its alignment
 * describes it at that speed, and slowing an mp3 down would both invalidate
 * every time in the manifest and add artefacts to the one thing on screen a
 * learner is being asked to copy exactly.
 */
const RATE = 0.85;

/** Shared so a "nothing served" state never allocates, and never re-renders. */
const NOTHING_SERVED: ServedIndex = new Map<string, ServedPhrase>();

export interface ModelSpeech {
  /**
   * False only when *neither* source can speak — the control then hides
   * rather than lying.
   *
   * Widened deliberately. This used to mean "the platform has a voice for this
   * language", which hid the Listen button on any device missing the locale;
   * a served recording is a model voice whether or not the platform has one.
   */
  available: boolean;
  /**
   * Whether text outside the served corpus can be spoken — i.e. whether the
   * platform has a voice for this language.
   *
   * Separate from `available` because a served recording covers whole phrases
   * only. `useCompareToModel` asks for a single word, so it must read this
   * one: offering a comparison that plays the learner and then nothing is
   * worse than not offering it.
   */
  canSpeakAnyText: boolean;
  speaking: boolean;
  /**
   * Which word of the utterance is sounding right now, counting words the way
   * `phraseTokens` does — or `null` when there is no word to mark.
   *
   * `null` covers three cases the caller deliberately does not have to tell
   * apart: nothing is speaking; something is speaking but this engine reports
   * no word boundaries at all; and a served recording is playing whose
   * alignment could not be trusted to place a mark. In all three there is no
   * word to mark, so the phrase renders exactly as it did before any of this
   * existed.
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
 * a word number with it, the screen draws those same words with it, and the
 * served alignment is collapsed into word times with it.
 *
 * Whitespace runs are kept as tokens rather than discarded, so concatenating
 * the tokens reproduces the phrase character for character. That is what lets
 * the screen rebuild the phrase out of spans without rewriting a single space
 * — French puts one before its question mark, and a `split(/\s+/)` that threw
 * the gaps away would silently normalise it. It is also what lets a served
 * alignment be checked against the phrase it claims to describe.
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
  const [served, setServed] = useState<ServedIndex>(NOTHING_SERVED);
  const [speaking, setSpeaking] = useState(false);
  const [wordIndex, setWordIndex] = useState<number | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timersRef = useRef<number[]>([]);

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

  /**
   * What has been generated for this language, fetched once per language.
   *
   * **Nothing waits on this**, exactly as nothing waits on `useContentSync`:
   * the platform voice is available from the first render, and a completed
   * fetch only means the *next* render prefers a recording. There is no
   * loading state, because there is no moment at which the app has no model
   * voice to offer.
   *
   * Every failure is silent and leaves the index empty — a 404 means nothing
   * has been generated, a network error means offline, a body that does not
   * validate means a manifest not worth trusting. All three have the same
   * right answer, which is the answer this hook already had.
   */
  useEffect(() => {
    // Cleared first: a language change must not leave the previous language's
    // recordings addressable while the new manifest is in flight.
    setServed(NOTHING_SERVED);
    if (typeof fetch !== "function") return;

    let live = true;
    void (async () => {
      try {
        const response = await fetch(manifestUrl(lang));
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!live) return;
        setServed(readManifest(body, lang));
      } catch {
        // Offline, or nothing generated. The platform voice is the answer.
      }
    })();

    return () => {
      live = false;
    };
  }, [lang]);

  const clearWordTimers = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  }, []);

  /**
   * Detaches the served recording, if any, without touching the state a
   * caller reads.
   *
   * The handlers are nulled *before* pausing so that nothing this element has
   * queued can fire against a screen that has moved on — the same identity
   * discipline the platform path applies to a replaced utterance, expressed
   * the way a media element allows.
   */
  const stopServedAudio = useCallback(() => {
    clearWordTimers();
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio === null) return;
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
    } catch {
      // An element that never began loading cannot pause, and does not need to.
    }
  }, [clearWordTimers]);

  const cancel = useCallback(() => {
    window.speechSynthesis?.cancel();
    utteranceRef.current = null;
    stopServedAudio();
    setSpeaking(false);
    setWordIndex(null);
  }, [stopServedAudio]);

  // Speech outliving the component would keep talking over the next screen.
  useEffect(() => cancel, [cancel]);

  /**
   * The platform voice — byte for byte the path that shipped before served
   * audio existed, and the fallback every failure above lands on.
   */
  const speakOnPlatform = useCallback((text: string, utteranceLang: string) => {
    const synth = window.speechSynthesis;
    if (!synth) return;

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
  }, []);

  /**
   * Plays a served recording, marking words from the alignment that came with
   * it. Returns false only when a media element cannot be constructed at all.
   *
   * **Every way this can fail falls back rather than going quiet.** A pruned
   * or undecodable file raises `error`, a browser refusing autoplay rejects
   * `play()`, and both hand the phrase to the platform voice mid-tap. The
   * learner hears *something* in every case, which is the property the whole
   * feature is judged on.
   */
  const playServed = useCallback(
    (phrase: ServedPhrase, text: string, utteranceLang: string): boolean => {
      let audio: HTMLAudioElement;
      try {
        audio = new Audio(phrase.url);
      } catch {
        return false;
      }
      audio.preload = "auto";

      /**
       * Word times, or null when the alignment cannot be trusted to place a
       * mark — a normalised phrase, a missing time, times that run backwards.
       * Null means the recording still plays and no word is marked, which is
       * the same floor the platform path has always had.
       */
      const starts = wordStartSeconds(phraseTokens(text), phrase);

      const fallBack = (): void => {
        stopServedAudio();
        speakOnPlatform(text, utteranceLang);
      };

      audio.onplaying = () => {
        // A stale element's late event must not renumber the phrase now
        // playing — the same reason the platform path checks utterance
        // identity.
        if (audioRef.current !== audio || starts === null) return;
        clearWordTimers();
        for (const [index, seconds] of starts.entries()) {
          timersRef.current.push(
            window.setTimeout(() => {
              if (audioRef.current === audio) setWordIndex(index);
            }, seconds * 1000),
          );
        }
      };

      audio.onended = () => {
        if (audioRef.current !== audio) return;
        stopServedAudio();
        setSpeaking(false);
        setWordIndex(null);
      };

      audio.onerror = () => {
        if (audioRef.current === audio) fallBack();
      };

      audioRef.current = audio;
      setSpeaking(true);
      setWordIndex(null);

      try {
        const started: unknown = audio.play();
        // Older Safari returns undefined here rather than a promise, so the
        // shape is checked rather than assumed — an unguarded `.catch` would
        // throw on exactly the platform this app's build target exists for.
        if (started instanceof Promise) {
          started.catch(() => {
            if (audioRef.current === audio) fallBack();
          });
        }
      } catch {
        fallBack();
      }
      return true;
    },
    [clearWordTimers, speakOnPlatform, stopServedAudio],
  );

  const speak = useCallback(
    (text: string, utteranceLang: string) => {
      if (!text.trim()) return;

      // A second tap replaces rather than queues, whichever source either tap
      // used. Done here, once, so neither path can be the one that forgets.
      window.speechSynthesis?.cancel();
      utteranceRef.current = null;
      stopServedAudio();

      /**
       * Matched on the exact reference text, and only within the language this
       * hook was asked for.
       *
       * Exact rather than trimmed or normalised: the manifest's key is the
       * text the recording actually says, and a near-match is a recording of a
       * different phrase. The publish path already trims what it stores
       * (`readDraft`), so the texts on both sides come from the same place.
       *
       * The locale check matters because `speak` takes its own language:
       * playing a French recording under a Spanish request would be the most
       * damaging thing this feature could do.
       */
      const phrase = utteranceLang === lang ? served.get(text) : undefined;
      if (phrase !== undefined && playServed(phrase, text, utteranceLang)) return;

      speakOnPlatform(text, utteranceLang);
    },
    [lang, playServed, served, speakOnPlatform, stopServedAudio],
  );

  const platformVoice =
    typeof window !== "undefined" && !!window.speechSynthesis && pickVoice(voices, lang) !== null;

  return {
    /**
     * Either source will do. This is the fix for the hidden-control failure:
     * a Hindi learner on a device with no `hi-IN` voice now has a Listen
     * button, because there is a recording behind it.
     */
    available: platformVoice || served.size > 0,
    canSpeakAnyText: platformVoice,
    speaking,
    wordIndex,
    speak,
    cancel,
  };
}
