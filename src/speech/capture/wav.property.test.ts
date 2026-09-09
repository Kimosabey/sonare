/**
 * T33 — the WAV container, swept.
 *
 * `wav.test.ts` next door checks the header a normal take produces. This file
 * asks whether the header stays *truthful* for hostile input, because the
 * container's whole job is to describe the bytes that follow it: a declared
 * size that disagrees with the real one is the misread the server's parser
 * then has to catch, and a sample that wraps polarity on the way to 16-bit is
 * a click in a recording the learner will be scored on.
 *
 * The header-*parsing* half of T33 — truncated, misdeclared and hostile
 * headers, which must be rejected rather than misread — lives in
 * scripts/wav-header.property.test.ts, because the only parser in the
 * repository is the server's and reaching it needs Node's `Buffer`, which
 * src/ deliberately cannot see. That file also round-trips this encoder
 * through that parser, which is the property that actually matters end to end.
 *
 * R7 runs through all of it: 16 kHz mono 16-bit PCM, whatever it is handed.
 */

import { describe, expect, it } from "vitest";
import { encodeWav } from "./wav.js";
import { TARGET_SAMPLE_RATE } from "./resample.js";
import { chance, floatBetween, intBetween, makeRng, pickFrom } from "../../testing/rng.js";

const SEED_SAMPLES = 0x5eed_0a44;
const FUZZ_CASES = 400;

const HEADER_BYTES = 44;

/** Byte offsets, named so the assertions read as the format rather than as arithmetic. */
const OFF = {
  riffId: 0,
  riffSize: 4,
  waveId: 8,
  fmtId: 12,
  fmtSize: 16,
  audioFormat: 20,
  channels: 22,
  sampleRate: 24,
  byteRate: 28,
  blockAlign: 32,
  bitsPerSample: 34,
  dataId: 36,
  dataSize: 40,
} as const;

async function view(samples: Float32Array, rate = TARGET_SAMPLE_RATE): Promise<DataView> {
  return new DataView(await encodeWav(samples, rate).arrayBuffer());
}

function ascii(v: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(v.getUint8(offset + i));
  return out;
}

/** The 16-bit samples the encoder actually wrote. */
function pcmOf(v: DataView): Int16Array {
  const count = (v.byteLength - HEADER_BYTES) / 2;
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = v.getInt16(HEADER_BYTES + i * 2, true);
  return out;
}

/** What the encoder's clamp should have produced for one input sample. */
function clamped(sample: number): number {
  // NaN survives both Math.min and Math.max, so it reaches the multiply as
  // NaN and lands in the Int16Array as 0 — see the assertions below.
  if (Number.isNaN(sample)) return Number.NaN;
  return Math.max(-1, Math.min(1, sample));
}

/**
 * Samples worth generating: ordinary speech-shaped values, the clamp's own
 * edges, and the values that break a naive scale-and-cast.
 */
const NASTY_SAMPLES: readonly number[] = [
  0,
  -0,
  1,
  -1,
  0.9999999,
  -0.9999999,
  1.0000001,
  -1.0000001,
  2,
  -2,
  1e6,
  -1e6,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NaN,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  Number.EPSILON,
  1 / 32768,
  -1 / 32768,
  0.5,
  -0.5,
];

function generateSamples(rng: () => number, index: number): Float32Array {
  // Lengths chosen to include the degenerate ones: empty, one sample, and an
  // odd count (which is where a 16-bit stride is easiest to get wrong).
  const length = index < 4 ? index : intBetween(rng, 0, 400);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = chance(rng, 0.35) ? pickFrom(rng, NASTY_SAMPLES) : floatBetween(rng, -1.3, 1.3);
  }
  return out;
}

describe("the container describes the bytes that follow it", () => {
  const rng = makeRng(SEED_SAMPLES);
  const cases = Array.from({ length: FUZZ_CASES }, (_, i) => generateSamples(rng, i));

  it(`sweeps ${FUZZ_CASES} takes that reach the degenerate shapes`, () => {
    // Stated so a generator change that stopped producing the empty, the
    // one-sample and the odd-length cases is visible.
    expect(cases).toHaveLength(FUZZ_CASES);
    expect(cases[0]?.length).toBe(0);
    expect(cases[1]?.length).toBe(1);
    expect(cases.some((c) => c.length % 2 === 1)).toBe(true);
    expect(cases.some((c) => c.length > 300)).toBe(true);
    expect(cases.flatMap((c) => [...c]).some((s) => Number.isNaN(s))).toBe(true);
    expect(cases.flatMap((c) => [...c]).some((s) => s > 1)).toBe(true);
  });

  it("declares sizes that match the real byte count, every time", async () => {
    for (const [i, samples] of cases.entries()) {
      const v = await view(samples);
      const where = `seed ${SEED_SAMPLES} case ${i} (${samples.length} samples)`;

      // The two size fields are the only thing standing between a reader and
      // a misread. Both are checked against the *actual* length rather than
      // against the formula that produced them.
      expect(v.byteLength, where).toBe(HEADER_BYTES + samples.length * 2);
      expect(v.getUint32(OFF.riffSize, true), where).toBe(v.byteLength - 8);
      expect(v.getUint32(OFF.dataSize, true), where).toBe(v.byteLength - HEADER_BYTES);
    }
  });

  it("keeps the chunk identifiers where a reader looks for them", async () => {
    for (const [i, samples] of cases.entries()) {
      const v = await view(samples);
      const where = `case ${i}`;
      expect(ascii(v, OFF.riffId, 4), where).toBe("RIFF");
      expect(ascii(v, OFF.waveId, 4), where).toBe("WAVE");
      expect(ascii(v, OFF.fmtId, 4), where).toBe("fmt ");
      expect(ascii(v, OFF.dataId, 4), where).toBe("data");
    }
  });

  it("declares 16-bit mono PCM whatever it was handed (R7)", async () => {
    for (const [i, samples] of cases.entries()) {
      const v = await view(samples);
      const where = `case ${i}`;
      expect(v.getUint32(OFF.fmtSize, true), where).toBe(16);
      expect(v.getUint16(OFF.audioFormat, true), where).toBe(1);
      expect(v.getUint16(OFF.channels, true), where).toBe(1);
      expect(v.getUint16(OFF.bitsPerSample, true), where).toBe(16);
      expect(v.getUint16(OFF.blockAlign, true), where).toBe(2);
    }
  });

  it("hands back a blob the upload can name as WAV", async () => {
    expect(encodeWav(new Float32Array(8), TARGET_SAMPLE_RATE).type).toBe("audio/wav");
  });
});

describe("the samples survive the trip to 16-bit", () => {
  const rng = makeRng(SEED_SAMPLES + 1);
  const cases = Array.from({ length: 120 }, (_, i) => generateSamples(rng, i));

  it("never wraps polarity, however loud the input", async () => {
    /**
     * The failure the clamp exists to prevent: a sample above 1.0 scaled
     * without clamping overflows the signed 16-bit range and comes out the
     * other side as the opposite polarity — a full-scale positive peak
     * rendered as a full-scale negative one, which is a click on top of the
     * audio a learner is about to be scored on.
     */
    for (const [i, samples] of cases.entries()) {
      const pcm = pcmOf(await view(samples));
      samples.forEach((sample, n) => {
        const out = pcm[n] ?? 0;
        const where = `case ${i} sample ${n} in ${sample} out ${out}`;
        expect(out, where).toBeGreaterThanOrEqual(-32768);
        expect(out, where).toBeLessThanOrEqual(32767);
        if (Number.isNaN(sample)) return;
        if (sample > 0) expect(out, where).toBeGreaterThanOrEqual(0);
        if (sample < 0) expect(out, where).toBeLessThanOrEqual(0);
      });
    }
  });

  it("reaches full scale at the clamp's edges and no further", async () => {
    const edges = new Float32Array([1, -1, 2, -2, 1e9, -1e9, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    const pcm = pcmOf(await view(edges));
    expect([...pcm]).toEqual([32767, -32768, 32767, -32768, 32767, -32768, 32767, -32768]);
  });

  it("writes silence for a sample that is not a number", async () => {
    /**
     * NaN clamps to NaN (it compares false against both bounds), multiplies
     * to NaN, and an Int16Array stores NaN as 0. Silence is the right answer:
     * it is the only value that cannot be mistaken for something the learner
     * said.
     */
    const pcm = pcmOf(await view(new Float32Array([Number.NaN, 0.5, Number.NaN])));
    expect(pcm[0]).toBe(0);
    expect(pcm[2]).toBe(0);
    expect(pcm[1]).toBeGreaterThan(0);
  });

  it("round-trips every finite sample inside one quantisation step", async () => {
    for (const [i, samples] of cases.entries()) {
      const pcm = pcmOf(await view(samples));
      samples.forEach((sample, n) => {
        const target = clamped(sample);
        if (Number.isNaN(target)) return;
        const decoded = (pcm[n] ?? 0) / (target < 0 ? 32768 : 32767);
        // One step of 16-bit quantisation, plus float32's own storage error
        // on the way in. Anything larger is a scaling bug, not rounding.
        expect(Math.abs(decoded - target), `case ${i} sample ${n} (${sample})`).toBeLessThan(
          2 / 32767,
        );
      });
    }
  });

  it("is deterministic — the same take encodes to the same bytes", async () => {
    for (const samples of cases.slice(0, 30)) {
      const a = new Uint8Array(await encodeWav(samples, TARGET_SAMPLE_RATE).arrayBuffer());
      const b = new Uint8Array(await encodeWav(samples, TARGET_SAMPLE_RATE).arrayBuffer());
      expect([...a]).toEqual([...b]);
    }
  });
});

describe("the declared sample rate", () => {
  it("is written verbatim, with a byte rate that agrees with it", async () => {
    // Every rate a browser AudioContext can plausibly report, plus the one
    // the recorder actually passes.
    for (const rate of [8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 192000]) {
      const v = await view(new Float32Array(16), rate);
      expect(v.getUint32(OFF.sampleRate, true), `${rate} Hz`).toBe(rate);
      expect(v.getUint32(OFF.byteRate, true), `${rate} Hz`).toBe(rate * 2);
    }
  });

  it("is the 16 kHz constant on the only path that reaches it", () => {
    // R7 is a claim about what leaves the client, and the recorder resamples
    // to this rate before encoding. Named here so a rate threaded through
    // from an AudioContext instead would have to change this line.
    expect(TARGET_SAMPLE_RATE).toBe(16000);
  });

  it("truncates a fractional rate, which no caller can currently produce", async () => {
    /**
     * A latent inconsistency, recorded rather than blessed.
     *
     * `DataView.setUint32` truncates, so a rate of 44100.5 is *declared* as
     * 44100 while the byte rate is computed from the untruncated value and
     * declared as 88201 — a header that contradicts itself, and the exact
     * shape of misdeclaration the server's parser exists to catch.
     *
     * Unreachable today: `recorder.ts` is the only caller and it passes the
     * `TARGET_SAMPLE_RATE` constant. Pinned here so that if a caller ever
     * threads a raw `AudioContext.sampleRate` through — which is a float —
     * this test is the thing that says so.
     */
    const v = await view(new Float32Array(4), 44100.5);
    expect(v.getUint32(OFF.sampleRate, true)).toBe(44100);
    expect(v.getUint32(OFF.byteRate, true)).toBe(88201);
    expect(v.getUint32(OFF.byteRate, true)).not.toBe(v.getUint32(OFF.sampleRate, true) * 2);
  });
});
