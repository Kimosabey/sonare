/**
 * T10/FR-10 — signal-to-noise estimation.
 *
 * The point is to refuse to send audio that will produce a meaningless score.
 * A learner who records in a noisy classroom and gets 42 back will read that as
 * "my pronunciation is bad" — a false negative created by the room, which is
 * precisely the class of error this POC exists to remove.
 *
 * Method: split into short frames, take frame energies, treat a low percentile
 * as the noise floor and a high percentile as speech. Crude, but it needs only
 * to separate "usable" from "hopeless", not to be accurate.
 */

const FRAME_MS = 20;
const NOISE_PERCENTILE = 0.1;
const SPEECH_PERCENTILE = 0.9;
const SILENCE_FLOOR = 1e-10;

export interface SignalStats {
  snrDb: number;
  peakDbfs: number;
  /** True when the whole recording is effectively silent — FR-09. */
  silent: boolean;
}

export function analyseSignal(samples: Float32Array, sampleRate: number): SignalStats {
  const peak = peakAmplitude(samples);
  const peakDbfs = toDb(peak);

  const frameSize = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const energies: number[] = [];

  for (let start = 0; start + frameSize <= samples.length; start += frameSize) {
    let sum = 0;
    for (let i = start; i < start + frameSize; i++) {
      const s = samples[i] ?? 0;
      sum += s * s;
    }
    energies.push(Math.sqrt(sum / frameSize));
  }

  if (energies.length < 3) {
    return { snrDb: 0, peakDbfs, silent: peak < 1e-4 };
  }

  energies.sort((a, b) => a - b);
  const noise = percentile(energies, NOISE_PERCENTILE);
  const speech = percentile(energies, SPEECH_PERCENTILE);

  const snrDb = toDb(speech) - toDb(Math.max(noise, SILENCE_FLOOR));

  return {
    snrDb: Number.isFinite(snrDb) ? snrDb : 0,
    peakDbfs,
    silent: peak < 1e-4,
  };
}

/** FR-06 — level for the meter, in dBFS. */
export function frameLevelDbfs(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] ?? 0;
    sum += s * s;
  }
  return toDb(Math.sqrt(sum / Math.max(1, frame.length)));
}

function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i] ?? 0);
    if (a > peak) peak = a;
  }
  return peak;
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

function toDb(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, SILENCE_FLOOR));
}
