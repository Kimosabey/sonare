/**
 * Where the learner's vowel actually sat, for one syllable of their take.
 *
 * The estimator (`src/speech/capture/formants.ts`) and the chart
 * (`src/components/VowelChart.tsx`) were both built and tested — twenty cases
 * against Peterson & Barney reference vowels — and then imported by nobody. A
 * component nothing renders breaks no test and passes every gate, so it shipped
 * as dead weight and no learner could reach the corrective it was written for.
 * This is the missing join.
 *
 * It works the same way `useSyllablePlayback` does, and deliberately so: the
 * take is already decoded to an `AudioBuffer` to play a syllable back, and the
 * same buffer is what the estimator needs. Azure gives every syllable an
 * `offsetTicks` and `durationTicks`, so the slice is already described.
 *
 * ── the slice is taken exactly, with no padding ─────────────────────────────
 *
 * `useSyllablePlayback` pads its slice by 60ms either side, because a syllable
 * clipped hard at both ends sounds like a glitch rather than a sound. Padding
 * here would be a measurement error: the pad would pull in the consonants on
 * either side, and their transitions are exactly what moves F1 and F2. The
 * estimator's own `unstable` refusal is what handles a slice that turns out to
 * be a glide rather than one steady vowel.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { estimateFormants, type FormantOutcome } from "../speech/capture/formants.js";

/** Azure reports offsets and durations in 100-nanosecond ticks. */
const TICKS_PER_SECOND = 10_000_000;

export interface VowelEstimate {
  /** The written syllable this is about — "jour", "ment". May be empty. */
  grapheme: string;
  offsetTicks: number;
  outcome: FormantOutcome;
}

export interface VowelEstimator {
  /** The most recent measurement, or null when none has been asked for. */
  estimate: VowelEstimate | null;
  measure: (syllable: {
    offsetTicks: number;
    durationTicks: number;
    grapheme: string;
  }) => void;
  clear: () => void;
  /** False when there is no take to measure, so nothing offers the chart. */
  available: boolean;
}

export function useVowelEstimate(wav: Blob | null): VowelEstimator {
  const contextRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  /** The take `bufferRef` was decoded from, so a new one invalidates it. */
  const decodedFromRef = useRef<Blob | null>(null);
  /** Set on unmount, so a decode that is still in flight cannot set state. */
  const liveRef = useRef(true);

  const [estimate, setEstimate] = useState<VowelEstimate | null>(null);

  const clear = useCallback(() => setEstimate(null), []);

  // A new take makes both the decoded buffer and the measurement wrong, not
  // merely stale — the chart must never show the previous take's vowel beside
  // this take's score.
  useEffect(() => {
    bufferRef.current = null;
    decodedFromRef.current = null;
    setEstimate(null);
  }, [wav]);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      // Closing releases the hardware audio session, which on iOS otherwise
      // stays claimed and can interfere with the next capture.
      void contextRef.current?.close().catch(() => undefined);
      contextRef.current = null;
      bufferRef.current = null;
    };
  }, []);

  const measure = useCallback(
    (syllable: { offsetTicks: number; durationTicks: number; grapheme: string }) => {
      if (wav === null) return;

      void (async () => {
        try {
          // Same resolution as useSyllablePlayback — Safari still needs the
          // prefixed constructor.
          contextRef.current ??= new (window.AudioContext ??
            (window as unknown as { webkitAudioContext: typeof AudioContext })
              .webkitAudioContext)();
          const context = contextRef.current;

          if (bufferRef.current === null || decodedFromRef.current !== wav) {
            // decodeAudioData detaches the ArrayBuffer it is given, so this
            // takes a fresh one rather than reusing a held reference.
            bufferRef.current = await context.decodeAudioData(await wav.arrayBuffer());
            decodedFromRef.current = wav;
          }

          const buffer = bufferRef.current;
          if (buffer === null || !liveRef.current) return;

          const start = Math.max(
            0,
            Math.min(syllable.offsetTicks / TICKS_PER_SECOND, buffer.duration),
          );
          const end = Math.min(
            buffer.duration,
            start + syllable.durationTicks / TICKS_PER_SECOND,
          );

          const from = Math.floor(start * buffer.sampleRate);
          const to = Math.min(buffer.length, Math.ceil(end * buffer.sampleRate));
          // An empty or inverted range is not a measurement of silence — it is
          // no slice at all, and the estimator would refuse it as "too-short",
          // which reads to a learner as a fact about how they spoke.
          if (to <= from) return;

          const slice = buffer.getChannelData(0).slice(from, to);
          const outcome = estimateFormants(slice, buffer.sampleRate);

          if (!liveRef.current) return;
          setEstimate({
            grapheme: syllable.grapheme,
            offsetTicks: syllable.offsetTicks,
            outcome,
          });
        } catch {
          // A take that cannot be decoded is the same situation as no take:
          // the chart is not offered, and nothing is claimed about the sound.
          if (liveRef.current) setEstimate(null);
        }
      })();
    },
    [wav],
  );

  return { estimate, measure, clear, available: wav !== null };
}
