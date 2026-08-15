/**
 * T6/FR-03 — resample to 16 kHz.
 *
 * Anti-alias BEFORE decimating. Skipping the filter folds everything above
 * 8 kHz back down into the speech band as alias energy, which lands directly on
 * the fricatives (/s/, /ʃ/, /f/) that phoneme scoring most depends on — it
 * would look like a working pipeline while quietly corrupting the measurement.
 *
 * Ported from reference/scorer-harness.html rather than reinvented: a moving
 * average, then linear interpolation. A moving average is a crude low-pass with
 * a soft rolloff, so some aliasing survives.
 *
 * PRD OQ-4 tracks whether this is good enough or needs a windowed-sinc kernel.
 * The signature here is deliberately stable so swapping the interior is a
 * one-file change if fixture scores come back uniformly low.
 */

export const TARGET_SAMPLE_RATE = 16000;

export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input;
  if (inputRate < TARGET_SAMPLE_RATE) {
    // Upsampling is not a case we should ever hit: every browser AudioContext
    // runs at 44.1 kHz or above. Pass through rather than fabricate detail.
    return input;
  }

  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const smoothed = movingAverage(input, Math.max(1, Math.floor(ratio)));

  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = smoothed[i0] ?? 0;
    const b = smoothed[i0 + 1] ?? a;
    out[i] = a * (1 - frac) + b * frac;
  }

  return out;
}

/** Symmetric moving average of half-width `halfWidth`. */
function movingAverage(input: Float32Array, halfWidth: number): Float32Array {
  if (halfWidth <= 0) return input;

  const out = new Float32Array(input.length);

  // Running sum — the naive nested loop is O(n·width) and shows up as a stall
  // on a phone for a 15-second recording at 48 kHz.
  let sum = 0;
  for (let i = 0; i < Math.min(halfWidth + 1, input.length); i++) sum += input[i] ?? 0;

  for (let i = 0; i < input.length; i++) {
    const entering = i + halfWidth;
    const leaving = i - halfWidth - 1;
    if (i > 0) {
      if (entering < input.length) sum += input[entering] ?? 0;
      if (leaving >= 0) sum -= input[leaving] ?? 0;
    }
    const lo = Math.max(0, i - halfWidth);
    const hi = Math.min(input.length - 1, i + halfWidth);
    out[i] = sum / (hi - lo + 1);
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
