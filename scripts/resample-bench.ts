/**
 * Verifies the OQ-4 resampler fix with numbers, not just a typecheck pass:
 * (1) does it actually reject energy above the target Nyquist instead of
 * letting it alias into the speech band, (2) does it pass legitimate
 * speech-band content through near unity gain, (3) is it fast enough to
 * stay inside NFR-02's 2.5s upload-to-result budget on a full 15s take.
 *
 *   npx tsx scripts/resample-bench.ts
 */

import { resampleTo16k, TARGET_SAMPLE_RATE } from "../src/speech/capture/resample.js";

const INPUT_RATE = 48000;

function tone(freqHz: number, seconds: number, sampleRate: number): Float32Array {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

/** Single-bin DFT (Goertzel-shaped) — amplitude of `freqHz` in `signal`, normalized to ~1.0 for a full-scale sine at that frequency. */
function magnitudeAt(signal: Float32Array, freqHz: number, sampleRate: number): number {
  let i = 0;
  let q = 0;
  for (let n = 0; n < signal.length; n++) {
    const phase = (2 * Math.PI * freqHz * n) / sampleRate;
    i += (signal[n] ?? 0) * Math.cos(phase);
    q += (signal[n] ?? 0) * Math.sin(phase);
  }
  return (2 * Math.sqrt(i * i + q * q)) / signal.length;
}

function pctOrFail(label: string, value: number, check: (v: number) => boolean): boolean {
  const ok = check(value);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${value.toFixed(4)}`);
  return ok;
}

console.log(`Resampling ${INPUT_RATE}Hz -> ${TARGET_SAMPLE_RATE}Hz\n`);

let allPassed = true;

// ── 1. Anti-aliasing: a tone above the target Nyquist (8kHz) must not
//    reappear as energy at its aliased frequency after decimation. ──
{
  const aboveNyquistHz = 10_000; // > 8kHz target Nyquist
  const aliasedHz = TARGET_SAMPLE_RATE - aboveNyquistHz; // where it would fold to if unfiltered = 6000Hz
  const input = tone(aboveNyquistHz, 1, INPUT_RATE);
  const output = resampleTo16k(input, INPUT_RATE);
  const aliasEnergy = magnitudeAt(output, aliasedHz, TARGET_SAMPLE_RATE);
  allPassed = pctOrFail(`10kHz tone's alias at ${aliasedHz}Hz stays below 0.05 (was ~1.0 unfiltered)`, aliasEnergy, (v) => v < 0.05) && allPassed;
}

// ── 2. Passband: real speech-band content (well below target Nyquist)
//    must survive close to unity gain, not get needlessly attenuated. ──
{
  const speechHz = 1000;
  const input = tone(speechHz, 1, INPUT_RATE);
  const output = resampleTo16k(input, INPUT_RATE);
  const passbandGain = magnitudeAt(output, speechHz, TARGET_SAMPLE_RATE);
  allPassed = pctOrFail(`1kHz speech-band tone passes at >=0.95 gain`, passbandGain, (v) => v >= 0.95) && allPassed;
}

// ── 3. Performance: a full 15s take at 48kHz must resample well within
//    NFR-02's 2.5s upload-to-result budget — this is one step in that budget,
//    not the whole thing, so it needs real headroom, not just "under 2.5s". ──
{
  const fifteenSeconds = tone(220, 15, INPUT_RATE); // arbitrary tone, only timing matters here
  resampleTo16k(fifteenSeconds, INPUT_RATE); // warm the polyphase kernel cache first — a real session shares it across takes
  const startedAt = performance.now();
  resampleTo16k(fifteenSeconds, INPUT_RATE);
  const elapsedMs = performance.now() - startedAt;
  allPassed = pctOrFail(`15s@48kHz resample time stays under 100ms (cached kernel)`, elapsedMs, (v) => v < 100) && allPassed;
}

console.log(allPassed ? "\nresample-bench: all checks passed" : "\nresample-bench: FAILED");
process.exit(allPassed ? 0 : 1);
