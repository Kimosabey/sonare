/**
 * Play back one syllable of the take the learner just recorded.
 *
 * The gap this closes is the second-largest in the product: a learner is told
 * `ment` scored 77 and has no way to hear their own `ment`. The difference
 * between what you think you said and what you actually said is the most
 * useful feedback available, and it was being thrown away microseconds after
 * capture.
 *
 * Every syllable already arrives with `offsetTicks` and `durationTicks`
 * precisely for this — Azure's 100-nanosecond units, passed through the
 * contract unconverted. It works even where the written form does not: all
 * 108 Hindi syllables measured are timed while none are named, so a Hindi
 * learner can hear the syllable they cannot be shown.
 *
 * **The audio is never persisted.** It lives in the recorder's own state for
 * the length of the attempt and is replaced by the next take. attempts.ts is
 * explicit that storing learner voice recordings is a data-protection
 * decision rather than a build one, and nothing here changes that: no
 * localStorage, no upload, no object URL that outlives the component.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Azure reports offsets and durations in 100-nanosecond ticks. */
const TICKS_PER_SECOND = 10_000_000;

/**
 * A syllable is often only 150–250ms long, which is short enough to register
 * as a click rather than a sound. Padding both ends gives the ear its onset
 * and release — the part of a syllable a learner most needs to hear — without
 * bleeding meaningfully into its neighbours.
 */
const PAD_SECONDS = 0.06;

export interface SyllablePlayback {
  /** Offset of the syllable currently sounding, or null. */
  playingOffsetTicks: number | null;
  play: (offsetTicks: number, durationTicks: number) => void;
  /** False when there is no take to play — the chips stay static rather than lying. */
  available: boolean;
}

export function useSyllablePlayback(wav: Blob | null): SyllablePlayback {
  const contextRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  /** The take that bufferRef was decoded from, so a new one invalidates it. */
  const decodedFromRef = useRef<Blob | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const [playingOffsetTicks, setPlayingOffsetTicks] = useState<number | null>(null);

  const stop = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.onended = null;
      try {
        sourceRef.current.stop();
      } catch {
        // Already stopped, or never started. Nothing to do.
      }
      sourceRef.current = null;
    }
    setPlayingOffsetTicks(null);
  }, []);

  // A new take makes the decoded buffer wrong, not merely stale.
  useEffect(() => {
    bufferRef.current = null;
    decodedFromRef.current = null;
    stop();
  }, [wav, stop]);

  useEffect(
    () => () => {
      stop();
      // Closing releases the hardware audio session, which on iOS otherwise
      // stays claimed and can interfere with the next capture.
      void contextRef.current?.close().catch(() => undefined);
      contextRef.current = null;
    },
    [stop],
  );

  const play = useCallback(
    (offsetTicks: number, durationTicks: number) => {
      if (!wav) return;

      void (async () => {
        try {
          // Created on first play, which is inside a click — the only moment
          // an AudioContext is reliably allowed to start on iOS.
          contextRef.current ??= new (window.AudioContext ??
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
          const context = contextRef.current;
          if (context.state === "suspended") await context.resume();

          if (bufferRef.current === null || decodedFromRef.current !== wav) {
            // decodeAudioData detaches the ArrayBuffer it is given, so the
            // Blob is re-read rather than a shared buffer being reused.
            bufferRef.current = await context.decodeAudioData(await wav.arrayBuffer());
            decodedFromRef.current = wav;
          }
          const buffer = bufferRef.current;

          stop();

          const rawStart = offsetTicks / TICKS_PER_SECOND - PAD_SECONDS;
          const start = Math.max(0, Math.min(rawStart, buffer.duration));
          const rawDuration = durationTicks / TICKS_PER_SECOND + PAD_SECONDS * 2;
          const duration = Math.max(0.02, Math.min(rawDuration, buffer.duration - start));

          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          source.onended = () => {
            // Guard against a stale source clearing a newer one's highlight.
            if (sourceRef.current === source) {
              sourceRef.current = null;
              setPlayingOffsetTicks(null);
            }
          };
          sourceRef.current = source;
          setPlayingOffsetTicks(offsetTicks);
          source.start(0, start, duration);
        } catch {
          // Playback is an aid, not the product. A decode failure or a denied
          // audio session must never surface as an error over a real score.
          stop();
        }
      })();
    },
    [wav, stop],
  );

  return { playingOffsetTicks, play, available: wav !== null };
}
