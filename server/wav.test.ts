/**
 * The byte-level parser every format guarantee rests on, and it had no tests.
 *
 * FR-19's whole premise is that the header is *validated* rather than trusted,
 * because a client that quietly sends 48 kHz stereo produces plausible-looking
 * and meaningless scores — the exact failure this POC exists to eliminate. That
 * premise is only as good as this parser, and a parser that reads the wrong
 * offset does not fail loudly: it reports a confident, wrong sample rate.
 *
 * Buffers here are built byte by byte rather than through a helper that could
 * share a bug with the code under test.
 */

import { describe, expect, it } from "vitest";
import { assertAzureFormat, assertDuration, inspectWav } from "./wav.js";
import { isAppError } from "./errors.js";

interface WavParts {
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  audioFormat?: number;
  dataBytes?: number;
  /** Written into the data chunk's size field; defaults to the real length. */
  declaredDataSize?: number;
  /** An extra chunk between fmt and data, as real encoders emit. */
  padChunk?: { id: string; size: number };
  riff?: string;
  wave?: string;
}

function wav({
  channels = 1,
  sampleRate = 16000,
  bitsPerSample = 16,
  audioFormat = 1,
  dataBytes = 32000,
  declaredDataSize,
  padChunk,
  riff = "RIFF",
  wave = "WAVE",
}: WavParts = {}): Buffer {
  const pad = padChunk ? 8 + padChunk.size + (padChunk.size % 2) : 0;
  const buf = Buffer.alloc(12 + 24 + pad + 8 + dataBytes);
  let o = 0;
  buf.write(riff, o, "ascii"); o += 4;
  buf.writeUInt32LE(buf.length - 8, o); o += 4;
  buf.write(wave, o, "ascii"); o += 4;

  buf.write("fmt ", o, "ascii"); o += 4;
  buf.writeUInt32LE(16, o); o += 4;
  const bytesPerFrame = (bitsPerSample / 8) * channels;
  buf.writeUInt16LE(audioFormat, o);
  buf.writeUInt16LE(channels, o + 2);
  buf.writeUInt32LE(sampleRate, o + 4);
  buf.writeUInt32LE(sampleRate * bytesPerFrame, o + 8);
  buf.writeUInt16LE(bytesPerFrame, o + 12);
  buf.writeUInt16LE(bitsPerSample, o + 14);
  o += 16;

  if (padChunk) {
    buf.write(padChunk.id, o, "ascii"); o += 4;
    buf.writeUInt32LE(padChunk.size, o); o += 4;
    o += padChunk.size + (padChunk.size % 2);
  }

  buf.write("data", o, "ascii"); o += 4;
  buf.writeUInt32LE(declaredDataSize ?? dataBytes, o);
  return buf;
}

describe("inspectWav", () => {
  it("reads the format fields from a plain 16 kHz mono file", () => {
    const info = inspectWav(wav());

    expect(info).toMatchObject({
      audioFormat: 1,
      channels: 1,
      sampleRate: 16000,
      bitsPerSample: 16,
      dataBytes: 32000,
    });
    // 32000 bytes / (16000 Hz x 2 bytes) = 1 second exactly.
    expect(info.seconds).toBeCloseTo(1, 5);
  });

  it("walks past a filler chunk between fmt and data", () => {
    /**
     * Not hypothetical: the repo's own fixtures/sample.wav carries a "FLLR"
     * chunk right after fmt. A parser that assumed data follows fmt would read
     * the filler's bytes as audio and report a wrong duration with total
     * confidence.
     */
    const info = inspectWav(wav({ padChunk: { id: "FLLR", size: 4044 } }));

    expect(info.sampleRate).toBe(16000);
    expect(info.dataBytes).toBe(32000);
    expect(info.seconds).toBeCloseTo(1, 5);
  });

  it("handles a chunk of odd size, which is word-aligned with a pad byte", () => {
    // Get the alignment wrong and every subsequent chunk id reads as garbage.
    const info = inspectWav(wav({ padChunk: { id: "LIST", size: 7 } }));

    expect(info.dataBytes).toBe(32000);
  });

  it("falls back to the real remaining length when data size is zero", () => {
    // Streamed encoders write 0 because they do not know the length yet.
    const info = inspectWav(wav({ dataBytes: 16000, declaredDataSize: 0 }));

    expect(info.dataBytes).toBe(16000);
    expect(info.seconds).toBeCloseTo(0.5, 5);
  });

  it("falls back when the declared size is impossibly large", () => {
    // 0xFFFFFFFF is the other thing streamed encoders write. Trusting it would
    // report a duration of days and sail past the maximum-length gate.
    const info = inspectWav(wav({ dataBytes: 16000, declaredDataSize: 0xffffffff }));

    expect(info.dataBytes).toBe(16000);
    expect(info.seconds).toBeCloseTo(0.5, 5);
  });

  it("rejects a buffer too short to be a WAV at all", () => {
    expect(() => inspectWav(Buffer.alloc(4))).toThrow();
    try {
      inspectWav(Buffer.alloc(4));
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("BAD_AUDIO_FORMAT");
    }
  });

  it("rejects something that is not RIFF/WAVE", () => {
    expect(() => inspectWav(wav({ riff: "RIFX" }))).toThrow();
    expect(() => inspectWav(wav({ wave: "AVI " }))).toThrow();
  });

  it("rejects a file with no fmt chunk", () => {
    const buf = wav();
    // Corrupt the chunk id in place, leaving the sizes intact.
    buf.write("junk", 12, "ascii");

    expect(() => inspectWav(buf)).toThrow();
  });

  it("never divides by zero on a degenerate frame size", () => {
    // 0 channels would make bytesPerFrame 0 and `seconds` Infinity, which
    // would then pass a maximum-duration check by being unorderable.
    expect(() => inspectWav(wav({ channels: 0 }))).toThrow();
  });
});

describe("assertAzureFormat", () => {
  it("accepts exactly what Azure prescribes", () => {
    expect(() => assertAzureFormat(inspectWav(wav()))).not.toThrow();
  });

  it("rejects the 48 kHz stereo case FR-19 exists for", () => {
    try {
      assertAzureFormat(inspectWav(wav({ sampleRate: 48000, channels: 2 })));
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("BAD_AUDIO_FORMAT");
      // Both problems reported, not just the first — a client fixing one and
      // resubmitting should not have to discover the second on the next round.
      expect(isAppError(err) && err.message).toContain("48000");
      expect(isAppError(err) && err.message).toContain("channels");
    }
  });

  it("rejects non-PCM encodings", () => {
    // 3 is IEEE float: same rate, same channels, unreadable by the scorer.
    expect(() => assertAzureFormat(inspectWav(wav({ audioFormat: 3 })))).toThrow();
  });

  it("rejects 8-bit and 24-bit depths", () => {
    expect(() => assertAzureFormat(inspectWav(wav({ bitsPerSample: 8 })))).toThrow();
    expect(() => assertAzureFormat(inspectWav(wav({ bitsPerSample: 24 })))).toThrow();
  });

  it("keeps the provider-facing detail out of what the learner is shown", () => {
    try {
      assertAzureFormat(inspectWav(wav({ sampleRate: 44100 })));
      throw new Error("should have thrown");
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.userMessage).not.toContain("44100");
      expect(err.toJSON().message).toBe(err.userMessage);
    }
  });
});

describe("assertDuration", () => {
  it("accepts a take inside the window", () => {
    expect(() => assertDuration(inspectWav(wav()), 0.25, 15)).not.toThrow();
  });

  it("rejects a take under the floor with the code the client retries on", () => {
    // 0.1s: 3200 bytes at 16kHz mono 16-bit.
    try {
      assertDuration(inspectWav(wav({ dataBytes: 3200 })), 0.25, 15);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("AUDIO_TOO_SHORT");
    }
  });

  it("rejects a take over the ceiling", () => {
    try {
      assertDuration(inspectWav(wav({ dataBytes: 16000 * 2 * 20 })), 0.25, 15);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("AUDIO_TOO_LONG");
    }
  });

  it("treats the bounds as inclusive, so a take exactly at the floor passes", () => {
    // A learner whose word lands precisely on 0.25s should not be refused for
    // hitting the number the product chose.
    const quarterSecond = wav({ dataBytes: 16000 * 2 * 0.25 });
    expect(() => assertDuration(inspectWav(quarterSecond), 0.25, 15)).not.toThrow();
  });
});

/**
 * The seam between two files written months apart that have to agree byte for
 * byte, which neither file's own tests can check alone.
 *
 * The client encoder (src/speech/capture/wav.ts) writes the header; this
 * parser reads it, and the route bills and enforces take length from what it
 * reads. A disagreement about one field is expensive in two directions at
 * once, and silent in both: the provider reads the audio at whatever rate the
 * header claims, so a wrong sample rate turns every utterance into a chipmunk
 * the scorer marks down, with no error raised anywhere.
 *
 * Lives on this side of the tree because inspectWav takes a Node Buffer and
 * src/ is deliberately DOM-only.
 */
describe("the client encoder and this parser agree", () => {
  async function encoded(seconds: number, rate = 16000): Promise<Buffer> {
    const { encodeWav } = await import("../src/speech/capture/wav.js");
    const samples = new Float32Array(Math.round(rate * seconds));
    for (let n = 0; n < samples.length; n++) {
      samples[n] = 0.4 * Math.sin((2 * Math.PI * 440 * n) / rate);
    }
    return Buffer.from(await encodeWav(samples, rate).arrayBuffer());
  }

  it("round-trips rate, channels and bit depth", async () => {
    const info = inspectWav(await encoded(1));

    expect(info.sampleRate).toBe(16000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.audioFormat).toBe(1);
  });

  it("passes the Azure-format assertion the route applies", async () => {
    // The check that rejects a take at the route. If the encoder ever drifted
    // from it, every upload would 4xx — loudly, but only in production.
    const info = inspectWav(await encoded(1));

    expect(() => assertAzureFormat(info)).not.toThrow();
  });

  it("reports the duration the encoder was handed, which is what gets billed", async () => {
    for (const seconds of [0.5, 1, 3.25, 15]) {
      const info = inspectWav(await encoded(seconds));

      expect(info.seconds, `${seconds}s`).toBeCloseTo(seconds, 3);
    }
  });

  it("counts exactly the bytes the encoder wrote", async () => {
    // dataBytes is what billable seconds is derived from. Off by the 44-byte
    // header and every invoice is wrong by the same small amount.
    const info = inspectWav(await encoded(2));

    expect(info.dataBytes).toBe(16000 * 2 * 2);
  });

  it("lands inside the duration window a real take is checked against", async () => {
    const info = inspectWav(await encoded(3));

    expect(() => assertDuration(info, 0.3, 15)).not.toThrow();
  });

  it("is measured as too short when it is too short", async () => {
    // Proves the round-trip is faithful at the boundary too: a 0.1s take must
    // read as 0.1s, so the honest "too short" refusal fires instead of the
    // provider being paid to score a fragment.
    const info = inspectWav(await encoded(0.1));

    expect(() => assertDuration(info, 0.3, 15)).toThrow();
  });
});
