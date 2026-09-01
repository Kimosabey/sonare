/**
 * T6/FR-03 — resample to 16 kHz.
 *
 * Anti-alias BEFORE decimating. Skipping the filter folds everything above
 * 8 kHz back down into the speech band as alias energy, which lands directly on
 * the fricatives (/s/, /ʃ/, /f/) that phoneme scoring most depends on — it
 * would look like a working pipeline while quietly corrupting the measurement.
 *
 * PRD OQ-4 resolved: this was a moving average + linear interpolation
 * (ported from reference/scorer-harness.html), a crude low-pass with a soft
 * rolloff that lets real aliasing through. Replaced with a windowed-sinc
 * kernel — bandlimited interpolation, the standard correct approach for
 * arbitrary-ratio resampling — precomputed into a polyphase table so the
 * expensive trig math happens once per sample rate, not once per output
 * sample. Verified with scripts/resample-bench.ts: alias rejection of a
 * 10kHz tone at 48kHz input goes from ~1.0 (unfiltered) to ~0.01, passband
 * content stays at ~1.0 gain, and a full 15s take resamples in ~25ms — a
 * naive (non-table) version of the same kernel measured ~460ms, over
 * NFR-02's budget on its own before upload even starts.
 *
 * The exported signature is unchanged from before, by design — this was
 * meant to be a one-file swap.
 */

export const TARGET_SAMPLE_RATE = 16000;

/**
 * Zero-crossings of the sinc kept on each side, in *output*-sample units.
 * More taps = closer to an ideal brick-wall filter (better stopband
 * rejection) at the cost of a bigger (but still one-time) table build. 8
 * gives a Blackman-windowed sinc roughly -70dB in the stopband, well past
 * what phoneme-scoring-grade audio needs.
 */
const ZERO_CROSSINGS = 8;

/** How finely the fractional sample position is quantized for the
    precomputed table. 512 steps is far below audible/measurable error. */
const PHASE_RESOLUTION = 512;

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Blackman window over x ∈ [-1, 1]; 0 outside that range. */
function blackman(x: number): number {
  if (x <= -1 || x >= 1) return 0;
  return 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
}

interface PolyphaseKernel {
  /** Flattened [phase][tapIndex], length PHASE_RESOLUTION * numTaps. */
  table: Float64Array;
  numTaps: number;
  /** Tap 0 in a row corresponds to input index floor(pos) + tapOffsetStart. */
  tapOffsetStart: number;
}

// Keyed by input sample rate — every take in a session shares the same
// AudioContext rate, so this is built once per session, not once per take.
const kernelCache = new Map<number, PolyphaseKernel>();

function buildKernel(inputRate: number): PolyphaseKernel {
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  // Cutoff at the *target's* Nyquist, expressed in cycles per input sample —
  // this is what actually removes the energy that would otherwise alias
  // once decimated to 16 kHz.
  const cutoff = 0.5 / ratio;
  // Kernel span scales with ratio so it always covers ZERO_CROSSINGS full
  // periods of the sinc at the target rate, not the input rate.
  const halfWidth = ZERO_CROSSINGS * ratio;
  const tapsPerSide = Math.ceil(halfWidth);
  const numTaps = 2 * tapsPerSide;
  const tapOffsetStart = -tapsPerSide + 1;

  const table = new Float64Array(PHASE_RESOLUTION * numTaps);
  const row = new Float64Array(numTaps);

  for (let p = 0; p < PHASE_RESOLUTION; p++) {
    const frac = p / PHASE_RESOLUTION;
    let weightSum = 0;
    for (let idx = 0; idx < numTaps; idx++) {
      const t = tapOffsetStart + idx - frac;
      const weight = 2 * cutoff * sinc(2 * cutoff * t) * blackman(t / halfWidth);
      row[idx] = weight;
      weightSum += weight;
    }
    // Normalizing here (once, per phase) rather than per output sample keeps
    // unity gain without adding any per-sample cost. It assumes the full tap
    // range is available, which is true everywhere except the first/last
    // tapsPerSide output samples of a take — a few dozen samples of
    // negligible, inaudible edge error against a multi-thousand-sample take.
    const rowOffset = p * numTaps;
    for (let idx = 0; idx < numTaps; idx++) {
      table[rowOffset + idx] = weightSum !== 0 ? (row[idx] ?? 0) / weightSum : 0;
    }
  }

  return { table, numTaps, tapOffsetStart };
}

export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input;
  if (inputRate < TARGET_SAMPLE_RATE) {
    // Upsampling is not a case we should ever hit: every browser AudioContext
    // runs at 44.1 kHz or above. Pass through rather than fabricate detail.
    return input;
  }

  let kernel = kernelCache.get(inputRate);
  if (!kernel) {
    kernel = buildKernel(inputRate);
    kernelCache.set(inputRate, kernel);
  }
  const { table, numTaps, tapOffsetStart } = kernel;

  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const base = Math.floor(pos);
    const frac = pos - base;
    const phase = Math.round(frac * PHASE_RESOLUTION) % PHASE_RESOLUTION;
    const rowOffset = phase * numTaps;

    let sum = 0;
    for (let idx = 0; idx < numTaps; idx++) {
      const n = base + tapOffsetStart + idx;
      if (n >= 0 && n < input.length) sum += (input[n] ?? 0) * (table[rowOffset + idx] ?? 0);
    }
    out[i] = sum;
  }

  return out;
}

/** Flattens the worklet's frame list into one contiguous buffer. */
export function concatFrames(frames: Float32Array[]): Float32Array {
  let total = 0;
  for (const f of frames) total += f.length;

  const out = new Float32Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}
