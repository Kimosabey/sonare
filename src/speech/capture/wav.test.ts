/**
 * The container every take is delivered in, and the seam between two files
 * written months apart that have to agree byte for byte.
 *
 * R7 fixes the format at 16 kHz mono PCM16 because that is what Azure
 * prescribes *and* what keeps a web capture byte-comparable with a native one
 * — which is the entire point of a fixture that compares platforms. A wrong
 * header field does not fail loudly: the provider reads the audio at the rate
 * the header claims, so a sample-rate field off by a factor of three turns
 * every utterance into a chipmunk the scorer marks down, with no error
 * anywhere.
 *
 * The cross-layer half of this — that server/wav.ts reads back exactly what
 * this writes — lives in server/wav.test.ts, because the server's parser takes
 * a Node Buffer and this side of the tree is deliberately DOM-only.
 */

import { describe, expect, it } from "vitest";
import { encodeWav } from "./wav.js";

const RATE = 16000;

async function bytes(samples: Float32Array, rate = RATE): Promise<DataView> {
  return new DataView(await encodeWav(samples, rate).arrayBuffer());
}

function ascii(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe("the RIFF header", () => {
  it("writes the four chunk identifiers a decoder looks for", async () => {
    const view = await bytes(new Float32Array(160));

    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(ascii(view, 36, 4)).toBe("data");
  });

  it("declares the format R7 requires", async () => {
    // Pinned individually rather than as one snapshot: each of these is a
    // separate way for the provider to read correct audio incorrectly.
    const view = await bytes(new Float32Array(160));

    expect(view.getUint16(20, true)).toBe(1); // PCM, not float or A-law
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // R7's rate
    expect(view.getUint16(34, true)).toBe(16); // 16-bit
  });

  it("keeps byteRate and blockAlign consistent with the rest of the header", async () => {
    /**
     * These two are derived, so they are exactly the fields that rot when the
     * format changes and nobody recomputes them. A decoder that trusts
     * byteRate over the other fields plays the audio at the wrong speed.
     */
    const view = await bytes(new Float32Array(160));
    const channels = view.getUint16(22, true);
    const rate = view.getUint32(24, true);
    const bits = view.getUint16(34, true);

    expect(view.getUint32(28, true)).toBe(rate * channels * (bits / 8));
    expect(view.getUint16(32, true)).toBe(channels * (bits / 8));
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size for plain PCM
  });

  it("states both sizes correctly, so a reader does not run off the end", async () => {
    // RIFF size counts everything after its own 8 bytes; data size counts only
    // the samples. Getting either wrong truncates or over-reads the audio.
    const samples = 4000;
    const view = await bytes(new Float32Array(samples));

    expect(view.getUint32(4, true)).toBe(36 + samples * 2);
    expect(view.getUint32(40, true)).toBe(samples * 2);
    expect(view.byteLength).toBe(44 + samples * 2);
  });

  it("carries the rate it was given, not a hardcoded one", async () => {
    // The recorder passes the post-resample rate. A constant here would look
    // right for every shipped path and silently lie the moment one changed.
    const view = await bytes(new Float32Array(16), 8000);

    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(28, true)).toBe(8000 * 2);
  });

  it("produces a valid empty file for a take with no audio", async () => {
    // A take cancelled before the first frame. A 44-byte WAV is well-formed;
    // a truncated one is a parse error on the server.
    const view = await bytes(new Float32Array(0));

    expect(view.byteLength).toBe(44);
    expect(view.getUint32(40, true)).toBe(0);
    expect(ascii(view, 0, 4)).toBe("RIFF");
  });

  it("is labelled audio/wav, which is what the route matches on", async () => {
    expect(encodeWav(new Float32Array(16), RATE).type).toBe("audio/wav");
  });
});

describe("Float32 to Int16 conversion", () => {
  it("clamps an over-driven sample instead of wrapping its polarity", async () => {
    /**
     * The failure this clamp exists to stop, and the reason it is worth a test
     * of its own: Web Audio Float32 is not bounded to +/-1, so an over-driven
     * input arrives above full scale. Without the clamp, 1.5 * 32767 exceeds
     * Int16 and wraps to a large *negative* value — a full-amplitude polarity
     * inversion mid-word, which reads as a click and scores as a defect in the
     * learner's speech.
     */
    const view = await bytes(new Float32Array([1.5, -1.5, 8, -8]));

    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(32767);
    expect(view.getInt16(50, true)).toBe(-32768);
  });

  it("uses the full asymmetric Int16 range at full scale", async () => {
    // Two's complement is asymmetric: -32768 exists, +32768 does not. Scaling
    // both sides by 0x8000 would overflow the positive peak into a negative.
    const view = await bytes(new Float32Array([1, -1]));

    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it("keeps silence silent and preserves sign", async () => {
    const view = await bytes(new Float32Array([0, 0.5, -0.5]));

    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBeGreaterThan(16000);
    expect(view.getInt16(48, true)).toBeLessThan(-16000);
  });

  it("is monotonic, so relative levels within an utterance survive", async () => {
    /**
     * The property scoring actually depends on. R4 turns AGC off because
     * flattening syllable dynamics destroys the spectral detail phoneme
     * scoring reads — an encoder that was non-monotonic anywhere would undo
     * that in a way no header test would catch.
     */
    const ramp = new Float32Array(201);
    for (let i = 0; i < ramp.length; i++) ramp[i] = -1 + i / 100;
    const view = await bytes(ramp);

    let previous = -Infinity;
    for (let i = 0; i < ramp.length; i++) {
      const value = view.getInt16(44 + i * 2, true);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("turns a NaN into silence rather than an arbitrary sample", async () => {
    // Should be unreachable — resample.test.ts asserts no NaN ever escapes the
    // resampler. Asserted anyway because the consequence of being wrong is a
    // corrupt frame the provider gets to interpret, and the cost of the
    // guarantee is nothing.
    const view = await bytes(new Float32Array([NaN, Infinity, -Infinity]));

    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
  });
});
