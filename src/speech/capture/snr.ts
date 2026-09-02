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
/**
 * Web Audio Float32 is not clamped to +/-1.0, so an over-driven input arrives
 * above full scale and wav.ts's encoder has to clamp it — which *is* hard
 * clipping. Counting at 0.999 rather than 1.0 catches samples already
 * flattened by an upstream limiter too.
 */
const CLIP_AMPLITUDE = 0.999;
const NOISE_PERCENTILE = 0.1;
const SPEECH_PERCENTILE = 0.9;
const SILENCE_FLOOR = 1e-10;

export interface SignalStats {
  snrDb: number;
  peakDbfs: number;
  /** True when the whole recording is effectively silent — FR-09. */
  silent: boolean;
  /**
   * Fraction of samples at or beyond full scale.
   *
   * SNR is completely blind to clipping: a hard-clipped take has a *superb*
   * noise ratio (measured 37.8 dB on a real one) because clipping raises the
   * speech percentile while leaving the noise floor alone. So the SNR gate
   * waves through the worst possible audio. Azure then returns NoMatch —
   * "no speech recognised" — on a recording where the learner spoke clearly
   * and loudly, which is the most confusing failure the app can produce.
   */
  clippedFraction: number;
}

export function analyseSignal(samples: Float32Array, sampleRate: number): SignalStats {
  const peak = peakAmplitude(samples);
  const peakDbfs = toDb(peak);
  const clippedFraction = clippedProportion(samples);

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
    return { snrDb: 0, peakDbfs, silent: peak < 1e-4, clippedFraction };
  }

  energies.sort((a, b) => a - b);
  const noise = percentile(energies, NOISE_PERCENTILE);
  const speech = percentile(energies, SPEECH_PERCENTILE);

  const snrDb = toDb(speech) - toDb(Math.max(noise, SILENCE_FLOOR));

  return {
    snrDb: Number.isFinite(snrDb) ? snrDb : 0,
    peakDbfs,
    silent: peak < 1e-4,
    clippedFraction,
  };
}

/**
 * Proportion, not peak. A single transient touching full scale — a table
 * knock, a plosive — is harmless and must not reject an otherwise good take;
 * sustained clipping across a meaningful share of the take is what destroys
 * the spectral detail phoneme scoring reads.
 */
function clippedProportion(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] ?? 0) >= CLIP_AMPLITUDE) clipped += 1;
  }
  return clipped / samples.length;
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

/**
 * Peak level for one frame, in dBFS.
 *
 * Deliberately separate from frameLevelDbfs(), which is RMS and drives the
 * meter. RMS cannot see clipping: audio peaking at +7.9 dBFS still reads
 * around -8 dBFS RMS, so the meter looks healthy while every loud syllable is
 * being flattened. Warning the learner in time needs the peak.
 */
export function framePeakDbfs(frame: Float32Array): number {
  return toDb(peakAmplitude(frame));
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
