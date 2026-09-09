/**
 * Your syllable, then the model's word — the gap between what a learner
 * thinks they said and what they actually said.
 *
 * The advice already names one weakest syllable and the learner can already
 * tap it to hear themselves, and there is already a Listen button for the
 * whole phrase. What was missing is the *comparison*: hearing the two back to
 * back is what makes a difference audible, where hearing either alone leaves
 * a learner comparing a sound to their memory of a sound.
 *
 * Nothing new is captured or synthesised. This sequences two things that
 * already exist, which is why it is a dozen lines rather than a feature.
 *
 * **The model here is the platform voice, not a served recording.** The
 * served recordings cover whole reference phrases, and this asks for a single
 * word — so there is nothing cached to play and the platform synthesiser is
 * what speaks. That is why availability below reads `canSpeakAnyText`: see the
 * note on `ModelHandle`.
 *
 * **The model speaks the whole word, not the syllable.** Handing a fragment
 * like "ment" to speech synthesis does not produce that syllable as it sounds
 * inside "comment" — it produces a reading of the letters, with its own
 * stress and its own vowel. That would be a worse reference than none, since
 * the learner would be matching themselves against an artefact. The word is
 * the smallest unit a synthetic voice pronounces the way the language does.
 */

import { useCallback, useEffect, useRef } from "react";

/** Azure reports offsets and durations in 100-nanosecond ticks. */
const TICKS_PER_SECOND = 10_000_000;

/**
 * Matches the padding useSyllablePlayback adds either side of a slice, so the
 * model does not start while the learner's own audio is still sounding.
 */
const PAD_SECONDS = 0.06;

/**
 * A beat between the two, so they are heard as a comparison rather than as one
 * run-together sound. Short enough that nobody thinks it has stopped.
 */
const GAP_MS = 320;

export interface ComparisonTarget {
  /** The weakest syllable's position in the take. */
  offsetTicks: number;
  durationTicks: number;
  /** The word it belongs to — what the model will say. */
  word: string;
}

export interface PlaybackHandle {
  play: (offsetTicks: number, durationTicks: number) => void;
  available: boolean;
}

export interface ModelHandle {
  speak: (text: string, lang: string) => void;
  cancel: () => void;
  /**
   * Whether *arbitrary* text can be spoken — not merely whether a model voice
   * exists at all.
   *
   * This reads `canSpeakAnyText` rather than `available` on purpose, and the
   * difference is load-bearing. Since the model voice gained served
   * recordings, `available` is true wherever a recording of the *phrase*
   * exists — including on a device with no platform voice for the language,
   * which is the ordinary case for Hindi. The comparison asks for one word,
   * which is never a whole phrase and so never has a recording. Reading
   * `available` here would show the button on exactly those devices and then
   * play the learner followed by silence.
   */
  canSpeakAnyText: boolean;
}

export interface CompareToModel {
  /** False when either half is unavailable — the control then hides rather than half-working. */
  available: boolean;
  compare: (target: ComparisonTarget) => void;
}

export function useCompareToModel(
  playback: PlaybackHandle,
  model: ModelHandle,
  lang: string,
): CompareToModel {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * A pending model utterance must not outlive the screen that asked for it.
   * Without this, leaving an activity mid-comparison speaks a French word over
   * whatever the learner opened next — and `model.cancel()` cannot help,
   * because the utterance has not started yet.
   */
  useEffect(() => {
    return () => {
      clearPending();
      model.cancel();
    };
  }, [clearPending, model.cancel]);

  const compare = useCallback(
    (target: ComparisonTarget) => {
      // A second tap replaces the first rather than queueing behind it, which
      // is the same stance the syllable chips and the Listen button take.
      clearPending();
      model.cancel();

      playback.play(target.offsetTicks, target.durationTicks);

      // Scheduled from the slice's own length rather than waiting on a
      // completion event: the playback layer exposes none, and the duration is
      // known exactly. The padding is added because the slice is played with
      // it, so a bare duration would start the model mid-word.
      const sliceMs = (target.durationTicks / TICKS_PER_SECOND + PAD_SECONDS * 2) * 1000;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        model.speak(target.word, lang);
      }, sliceMs + GAP_MS);
    },
    [clearPending, lang, model, playback],
  );

  return {
    // Both halves or neither. Playing only the learner back, under a label
    // that promises a comparison, is worse than not offering it.
    available: playback.available && model.canSpeakAnyText,
    compare,
  };
}
