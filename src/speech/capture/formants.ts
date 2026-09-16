/**
 * Where a vowel actually landed: F1 and F2, estimated from the learner's own
 * audio.
 *
 * ## Why this exists rather than another score
 *
 * Every other number in this product is a grade handed back by a provider,
 * and R3 forbids deriving one from recognition confidence for a reason that
 * applies just as well to the rest: whether the scorer is fair across accents
 * is unmeasured. A formant pair sidesteps the whole question, because it makes
 * no claim about how *good* the sound was. It says where the sound *was* —
 * a measurement of the learner's vocal tract, in Hz, that anybody with a
 * spectrogram can check. Nothing here can call a learner wrong.
 *
 * It is also the one piece of per-sound detail this product can compute for
 * every locale it ships. The provider returns empty phoneme labels for all of
 * them (measured: 0 of 14, 0 of 23 and 0 of 28 across three real French
 * takes), so an IPA strip is an empty row. The audio, on the other hand, is
 * already in hand.
 *
 * ## Method
 *
 * Textbook LPC formant analysis, no dependency:
 *
 *  1. Pre-emphasis, to flatten the -6 dB/octave glottal+radiation tilt that
 *     would otherwise let the LPC fit spend its poles on the spectral slope
 *     instead of on the resonances.
 *  2. Frame at 25 ms / 10 ms hop, Hamming-windowed.
 *  3. Keep only frames that are plausibly a voiced vowel — enough energy
 *     relative to the loudest frame of the slice, and a low enough
 *     zero-crossing rate to rule out fricatives and noise.
 *  4. Autocorrelation -> Levinson-Durbin -> an all-pole filter A(z).
 *  5. Evaluate 1/|A| on a frequency grid, pick its peaks, refine each by
 *     parabolic interpolation, and take the lowest admissible pair.
 *  6. Median across the frames, with the median absolute deviation kept as
 *     the measured spread.
 *
 * Root-solving A(z) would give bandwidths as well, and was not done: it needs
 * a complex polynomial root finder that can fail to converge, and the failure
 * mode is a wrong number rather than no number. Peak-picking on the envelope
 * always terminates and its resolution is bounded by the grid, which is a
 * quantity this file gets to choose.
 *
 * ## What it refuses to do
 *
 * Return a point it cannot stand behind. `FormantRefusal` is not an error
 * path — it is roughly as common as a measurement, because syllables contain
 * plosives and fricatives and because people trail off. An unusable recording
 * is never a score (R8), and by the same argument it is never a chart point:
 * there is nothing to plot, so nothing is plotted and the screen says why.
 *
 * Framework-free, no storage, no `any` — this directory ports to React Native
 * and is enforced by path (NFR-05, R11). Do not reorganise it.
 */

/** The two formants a vowel chart plots, in Hz. */
export interface FormantPoint {
  f1Hz: number;
  f2Hz: number;
}

export interface FormantMeasurement extends FormantPoint {
  kind: "measured";
  /**
   * Median absolute deviation of the per-frame estimates, in Hz — so half the
   * frames that produced this landed within it. The honest width of the
   * answer, and the reason the chart draws an area rather than a dot: an
   * estimate presented as a point is presented as exact.
   */
  f1SpreadHz: number;
  f2SpreadHz: number;
  /** How many analysis frames produced a pair, and how many were looked at. */
  framesMeasured: number;
  framesTotal: number;
}

/**
 * Why there is no point to plot. Each is a different thing to tell a learner,
 * which is the whole reason they are not one "failed" value:
 *
 * - `too-short` — the slice is shorter than the analysis needs. Says nothing
 *   about the learner.
 * - `no-signal` — effectively silence. The microphone, not the mouth.
 * - `not-voiced` — there is sound, but no voiced stretch long enough to
 *   measure. A syllable can be all consonant.
 * - `no-resonance` — voiced, but the fit found no admissible formant pair.
 * - `unstable` — found a pair, and it moved too much across the slice for one
 *   point to represent it. A diphthong or a glide does this legitimately.
 */
export type FormantRefusalReason =
  | "too-short"
  | "no-signal"
  | "not-voiced"
  | "no-resonance"
  | "unstable";

export interface FormantRefusal {
  kind: "refused";
  reason: FormantRefusalReason;
}

export type FormantOutcome = FormantMeasurement | FormantRefusal;

/** 25 ms at 16 kHz is 400 samples — two to three pitch periods of a male voice. */
const FRAME_MS = 25;
const HOP_MS = 10;

/**
 * Three frames is the floor for a median with a spread beside it. Two would
 * give a median that is really a mean of two and a deviation that is half
 * their distance, which reads as precision where there is none.
 */
const MIN_FRAMES = 3;

/** y[n] = x[n] - k*x[n-1]. The conventional value for speech at 8-16 kHz. */
const PRE_EMPHASIS = 0.97;

/** Below this peak amplitude the slice is silence, not a quiet vowel. */
const SILENCE_AMPLITUDE = 1e-4;

/**
 * A frame counts as a candidate at or above this fraction of the loudest
 * frame's RMS. Chosen at -12 dB relative: loose enough to keep the whole
 * steady part of a vowel, tight enough to drop the closure and release either
 * side of it.
 */
const ENERGY_FRACTION = 0.25;

/**
 * Zero crossings per second above which a frame is noise or a fricative
 * rather than a vowel. A voiced vowel at a normal F0 crosses roughly
 * 2 x F1 times a second; /s/ and white noise are several times that.
 */
const MAX_VOICED_ZCR_PER_SECOND = 3000;

/** Admissible ranges, wide enough for a child's tract and a deep male one. */
const F1_MIN_HZ = 180;
const F1_MAX_HZ = 1200;
const F2_MIN_HZ = 550;
const F2_MAX_HZ = 3200;
/** Any closer and the two are one resonance the fit happened to split. */
const MIN_SEPARATION_HZ = 150;

/** Grid step for the envelope, in Hz. Parabolic refinement sits inside it. */
const GRID_STEP_HZ = 5;
/** Nothing is sought below this: it is glottal, not a formant. */
const GRID_MIN_HZ = 120;

/**
 * Spread beyond which one point would misrepresent the slice.
 *
 * Set from measurement rather than taste: on the synthesised reference vowels
 * in formants.test.ts a correct estimate has an F1 deviation in the single
 * digits, and the diphthong case there — a glide from /i/ to /a/, which is a
 * real thing a learner says — comes out above 150 Hz. These sit between the
 * two, nearer the diphthong, because a false refusal costs a learner one
 * chart and a false point teaches them the wrong mouth shape.
 */
const MAX_F1_SPREAD_HZ = 90;
const MAX_F2_SPREAD_HZ = 200;

/**
 * LPC order.
 *
 * The rule of thumb is two poles per formant the band can hold plus a few for
 * the overall shape — at 16 kHz, 2 × 8 + 2 = 18. **That rule is wrong here,
 * and measurably so.**
 *
 * At 18 the fit merges F1 and F2 whenever they sit close together, which is
 * exactly what a back rounded vowel is: /ɔ/ is 570 and 840, /u/ is 300 and
 * 870. The two poles become one broad peak, F2 vanishes from the envelope, and
 * the search takes the next admissible peak — F3 — as F2. Measured against
 * Peterson & Barney that put /ɔ/'s F2 out by **1587 Hz**, which is not a bad
 * estimate but a different vowel entirely.
 *
 * Swept against the ten reference vowels (formants.accuracy.test.ts): total
 * absolute error across the four worst goes 4556 Hz at order 18, 1308 at 20,
 * 230 at 22, 184 at 24, **84 at 26**, and stops improving at 28. Twenty-six is
 * where the curve flattens, and overshooting has its own cost — a high enough
 * order splits one formant into two poles, which is the same failure wearing
 * the opposite sign.
 *
 * Fixed rather than derived from the rate because the sweep was run at 16 kHz,
 * which is the rate every take arrives at (R7). A derived number would be
 * extrapolating from one measurement to rates nothing produces.
 */
const LPC_ORDER = 26;

function lpcOrder(_sampleRate: number): number {
  return LPC_ORDER;
}

/**
 * The formant pair for one stretch of audio, or a refusal.
 *
 * `samples` is expected to be the syllable, not the take: the caller slices it
 * from the offsets the provider already returns with every syllable.
 */
export function estimateFormants(samples: Float32Array, sampleRate: number): FormantOutcome {
  const frameSize = Math.round((sampleRate * FRAME_MS) / 1000);
  const hop = Math.max(1, Math.round((sampleRate * HOP_MS) / 1000));
  const order = lpcOrder(sampleRate);

  // Room for MIN_FRAMES frames, or the median below is a median of fewer.
  if (!Number.isFinite(sampleRate) || sampleRate < 8000) return refuse("too-short");
  if (samples.length < frameSize + hop * (MIN_FRAMES - 1)) return refuse("too-short");
  if (peak(samples) < SILENCE_AMPLITUDE) return refuse("no-signal");

  const emphasised = preEmphasise(samples);
  const window = hamming(frameSize);

  const starts: number[] = [];
  for (let start = 0; start + frameSize <= emphasised.length; start += hop) starts.push(start);

  const rms = starts.map((start) => frameRms(emphasised, start, frameSize));
  const loudest = Math.max(...rms);
  if (loudest <= 0) return refuse("no-signal");

  const voiced = starts.map((start, i) => {
    if ((rms[i] ?? 0) < loudest * ENERGY_FRACTION) return false;
    return zeroCrossingsPerSecond(emphasised, start, frameSize, sampleRate) <= MAX_VOICED_ZCR_PER_SECOND;
  });

  const run = longestRun(voiced);
  if (run === null || run.length < MIN_FRAMES) return refuse("not-voiced");

  /**
   * The middle of the voiced run, not all of it.
   *
   * A syllable is a consonant, a vowel and often another consonant, and the
   * formants at the edges of the vowel are still travelling towards or away
   * from the neighbouring closure. Including them widens the spread — which
   * the instability gate then reads as a diphthong. Three fifths, centred,
   * keeps the target and drops the transitions, and never narrows below the
   * MIN_FRAMES the median needs.
   */
  const keep = Math.max(MIN_FRAMES, Math.round(run.length * 0.6));
  const trim = Math.floor((run.length - keep) / 2);
  const from = run.start + trim;
  const to = Math.min(run.start + run.length, from + keep);

  const f1: number[] = [];
  const f2: number[] = [];
  for (let i = from; i < to; i++) {
    const start = starts[i];
    if (start === undefined) continue;
    const pair = framePair(emphasised, start, frameSize, window, order, sampleRate);
    if (pair === null) continue;
    f1.push(pair.f1Hz);
    f2.push(pair.f2Hz);
  }

  const framesTotal = to - from;
  if (f1.length < MIN_FRAMES) return refuse("no-resonance");

  const f1Hz = median(f1);
  const f2Hz = median(f2);
  const f1SpreadHz = medianAbsoluteDeviation(f1, f1Hz);
  const f2SpreadHz = medianAbsoluteDeviation(f2, f2Hz);

  if (f1SpreadHz > MAX_F1_SPREAD_HZ || f2SpreadHz > MAX_F2_SPREAD_HZ) return refuse("unstable");

  return {
    kind: "measured",
    f1Hz,
    f2Hz,
    f1SpreadHz,
    f2SpreadHz,
    framesMeasured: f1.length,
    framesTotal,
  };
}

function refuse(reason: FormantRefusalReason): FormantRefusal {
  return { kind: "refused", reason };
}

/**
 * One frame's formant pair, or null when the fit yields no admissible one.
 *
 * Separate from the loop above so the two failure kinds stay distinguishable:
 * a frame with no pair is dropped, and it is only when too few frames survive
 * that the slice as a whole has no resonance to report.
 */
function framePair(
  signal: Float64Array,
  start: number,
  frameSize: number,
  window: Float64Array,
  order: number,
  sampleRate: number,
): FormantPoint | null {
  const frame = new Float64Array(frameSize);
  for (let i = 0; i < frameSize; i++) frame[i] = (signal[start + i] ?? 0) * (window[i] ?? 0);

  const r = autocorrelation(frame, order);
  const a = levinsonDurbin(r, order);
  if (a === null) return null;

  const peaks = envelopePeaks(a, order, sampleRate);
  return lowestAdmissiblePair(peaks);
}

/**
 * The lowest pair of peaks that could be F1 and F2.
 *
 * "Lowest admissible" rather than "two tallest": a nasalised or breathy vowel
 * can put a taller peak at F3 than at F2, and ordering by height then reports
 * F3 as F2 and moves the point hundreds of Hz across the chart. Frequency
 * order is what defines a formant number.
 */
function lowestAdmissiblePair(peaks: number[]): FormantPoint | null {
  for (const f1Hz of peaks) {
    if (f1Hz < F1_MIN_HZ) continue;
    if (f1Hz > F1_MAX_HZ) return null;
    for (const f2Hz of peaks) {
      if (f2Hz < Math.max(F2_MIN_HZ, f1Hz + MIN_SEPARATION_HZ)) continue;
      if (f2Hz > F2_MAX_HZ) break;
      return { f1Hz, f2Hz };
    }
    return null;
  }
  return null;
}

/** y[n] = x[n] - k*y'[n-1], returned widened to Float64 for the fit. */
function preEmphasise(samples: Float32Array): Float64Array {
  const out = new Float64Array(samples.length);
  let previous = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    out[i] = s - PRE_EMPHASIS * previous;
    previous = s;
  }
  return out;
}

function hamming(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

function autocorrelation(frame: Float64Array, order: number): Float64Array {
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let sum = 0;
    for (let i = lag; i < frame.length; i++) sum += (frame[i] ?? 0) * (frame[i - lag] ?? 0);
    r[lag] = sum;
  }
  return r;
}

/**
 * Levinson-Durbin: the autocorrelation sequence to the coefficients of
 * A(z) = 1 + a1 z^-1 + ... + ap z^-p, or null when the recursion leaves the
 * stable region.
 *
 * Null rather than a clamped result. A reflection coefficient at or beyond
 * unity means the frame does not admit a stable all-pole model — silence,
 * a DC step, a numerically degenerate window — and the coefficients from that
 * point on describe nothing. Carrying on would still produce a spectrum with
 * peaks in it, and those peaks would be plotted.
 */
function levinsonDurbin(r: Float64Array, order: number): Float64Array | null {
  const r0 = r[0] ?? 0;
  if (!(r0 > 0)) return null;

  const a = new Float64Array(order + 1);
  a[0] = 1;
  let error = r0;

  for (let m = 1; m <= order; m++) {
    let acc = r[m] ?? 0;
    for (let i = 1; i < m; i++) acc += (a[i] ?? 0) * (r[m - i] ?? 0);
    const k = -acc / error;
    if (!Number.isFinite(k) || Math.abs(k) >= 1) return null;

    const previous = a.slice(0, m);
    for (let i = 1; i < m; i++) a[i] = (previous[i] ?? 0) + k * (previous[m - i] ?? 0);
    a[m] = k;

    error *= 1 - k * k;
    if (!(error > 0)) return null;
  }
  return a;
}

/**
 * Frequencies, in ascending order, of the peaks of 1/|A(e^-jw)|.
 *
 * Each is refined by fitting a parabola to the three grid points around it,
 * in dB — the shape of a resonance peak in dB is close enough to parabolic
 * that this recovers well under a grid step of error, which is what makes a
 * 5 Hz grid enough to report a formant to the Hz.
 */
function envelopePeaks(a: Float64Array, order: number, sampleRate: number): number[] {
  const nyquist = sampleRate / 2;
  const top = Math.min(F2_MAX_HZ + 400, nyquist - GRID_STEP_HZ);
  const count = Math.floor((top - GRID_MIN_HZ) / GRID_STEP_HZ) + 1;
  if (count < 3) return [];

  const db = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    const w = (2 * Math.PI * (GRID_MIN_HZ + k * GRID_STEP_HZ)) / sampleRate;
    let re = 0;
    let im = 0;
    for (let i = 0; i <= order; i++) {
      const c = a[i] ?? 0;
      re += c * Math.cos(w * i);
      im -= c * Math.sin(w * i);
    }
    // 1/|A| in dB, i.e. the all-pole envelope.
    db[k] = -10 * Math.log10(Math.max(re * re + im * im, 1e-300));
  }

  const peaks: number[] = [];
  for (let k = 1; k < count - 1; k++) {
    const left = db[k - 1] ?? 0;
    const here = db[k] ?? 0;
    const right = db[k + 1] ?? 0;
    if (!(here > left && here >= right)) continue;
    // Vertex of the parabola through the three points, in grid units.
    const denominator = left - 2 * here + right;
    const shift = denominator === 0 ? 0 : (0.5 * (left - right)) / denominator;
    const bounded = Math.max(-1, Math.min(1, shift));
    peaks.push(GRID_MIN_HZ + (k + bounded) * GRID_STEP_HZ);
  }
  return peaks;
}

function frameRms(signal: Float64Array, start: number, size: number): number {
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const s = signal[start + i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / size);
}

function zeroCrossingsPerSecond(
  signal: Float64Array,
  start: number,
  size: number,
  sampleRate: number,
): number {
  let crossings = 0;
  for (let i = 1; i < size; i++) {
    const previous = signal[start + i - 1] ?? 0;
    const current = signal[start + i] ?? 0;
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1;
  }
  return (crossings * sampleRate) / size;
}

function peak(samples: Float32Array): number {
  let highest = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i] ?? 0);
    if (a > highest) highest = a;
  }
  return highest;
}

/** The longest contiguous run of `true`, or null when there is none. */
function longestRun(flags: boolean[]): { start: number; length: number } | null {
  let best: { start: number; length: number } | null = null;
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (flags[i] === true) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const length = i - start;
      if (best === null || length > best.length) best = { start, length };
      start = -1;
    }
  }
  return best;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Median of |value - centre|. Half the estimates lie within it, which is a
 * statement a caller can put on a screen; a standard deviation over four
 * frames is not, and one outlying frame moves it by more than the answer.
 */
function medianAbsoluteDeviation(values: number[], centre: number): number {
  return median(values.map((v) => Math.abs(v - centre)));
}
