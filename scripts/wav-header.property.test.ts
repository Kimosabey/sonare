/**
 * T33 — WAV header parsing, fuzzed: truncated, misdeclared and hostile.
 *
 * The parser's whole job is to refuse. A client that sends 48 kHz stereo, or a
 * header that lies about how many bytes follow it, produces
 * plausible-looking but meaningless scores — which is precisely the failure
 * this POC exists to eliminate, so a *misread* is worse than a rejection by a
 * long way.
 *
 * ## Why this file lives in scripts/
 *
 * The only WAV parser in the repository is `server/wav.ts`, and reaching it
 * needs Node's `Buffer`. `src/` is typechecked by tsconfig.json, which
 * deliberately carries no Node types, so a test under `src/` cannot hold a
 * Buffer at all. `scripts/` is covered by tsconfig.scripts.json, which does —
 * and vitest.config.ts now includes it for exactly this reason.
 *
 * Nothing under `server/` is modified by this file. It imports the parser and
 * feeds it bytes.
 *
 * ## What it asserts
 *
 * One property, over every generated buffer: the parser either **throws a
 * typed client error**, or **returns a description that the bytes actually
 * support**. There is no third outcome — no `NaN` duration, no negative byte
 * count, no silent truncation, and no hang. `server/wav.test.ts` next door
 * pins the individual cases; this sweeps the space between them.
 */

import { describe, expect, it } from "vitest";
import { assertAzureFormat, assertDuration, inspectWav, type WavInfo } from "../server/wav.js";
import { AppError } from "../server/errors.js";
import { encodeWav } from "../src/speech/capture/wav.js";
import { chance, intBetween, listOf, makeRng, pickFrom, type Rng } from "../src/testing/rng.js";

const SEED_BYTES = 0x5eed_b17e;
const SEED_HEADERS = 0x5eed_4ead;
const SEED_TRUNCATE = 0x5eed_7207;

const RANDOM_CASES = 3_000;
const HEADER_CASES = 4_000;

/** The route's own bounds — see server/routes/pronunciation.ts. */
const MIN_AUDIO_SECONDS = 0.25;
const MAX_AUDIO_SECONDS = 15;

/**
 * A well-formed 16 kHz mono PCM16 header, with every field individually
 * overridable so a fuzzer can corrupt exactly one thing at a time.
 */
interface HeaderSpec {
  riff: string;
  wave: string;
  fmtId: string;
  fmtSize: number;
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataId: string;
  /** What the header *claims* the data length is. */
  declaredDataBytes: number;
  /** How many bytes of audio actually follow. */
  actualDataBytes: number;
  /** RIFF's own size field. */
  riffSize: number | "correct";
  /** An extra chunk between fmt and data, as [id, declaredSize, bodyLength]. */
  filler?: [string, number, number];
  /**
   * A correctly formed extra chunk of the given declared size, padded to a
   * word boundary the way the RIFF spec requires. An odd size here is the
   * case that needs the walk's `size % 2` correction: without it the next
   * chunk id is read one byte early and the file becomes unreadable.
   */
  paddedFiller?: { id: string; size: number };
}

function goodSpec(actualDataBytes: number): HeaderSpec {
  return {
    riff: "RIFF",
    wave: "WAVE",
    fmtId: "fmt ",
    fmtSize: 16,
    audioFormat: 1,
    channels: 1,
    sampleRate: 16_000,
    byteRate: 32_000,
    blockAlign: 2,
    bitsPerSample: 16,
    dataId: "data",
    declaredDataBytes: actualDataBytes,
    actualDataBytes,
    riffSize: "correct",
  };
}

function build(spec: HeaderSpec): Buffer {
  const chunks: Buffer[] = [];
  const ascii4 = (s: string): Buffer => {
    const b = Buffer.alloc(4, 0x20);
    b.write(s.slice(0, 4), 0, "ascii");
    return b;
  };

  const fmt = Buffer.alloc(8 + 16);
  ascii4(spec.fmtId).copy(fmt, 0);
  fmt.writeUInt32LE(spec.fmtSize >>> 0, 4);
  fmt.writeUInt16LE(spec.audioFormat & 0xffff, 8);
  fmt.writeUInt16LE(spec.channels & 0xffff, 10);
  fmt.writeUInt32LE(spec.sampleRate >>> 0, 12);
  fmt.writeUInt32LE(spec.byteRate >>> 0, 16);
  fmt.writeUInt16LE(spec.blockAlign & 0xffff, 20);
  fmt.writeUInt16LE(spec.bitsPerSample & 0xffff, 22);
  chunks.push(fmt);

  if (spec.filler) {
    const [id, declared, bodyLength] = spec.filler;
    const body = Buffer.alloc(8 + bodyLength, 0x7f);
    ascii4(id).copy(body, 0);
    body.writeUInt32LE(declared >>> 0, 4);
    chunks.push(body);
  }

  if (spec.paddedFiller) {
    const { id, size } = spec.paddedFiller;
    // 8 bytes of chunk header, `size` bytes of body, plus the pad byte an odd
    // size requires.
    const body = Buffer.alloc(8 + size + (size % 2), 0x7f);
    ascii4(id).copy(body, 0);
    body.writeUInt32LE(size >>> 0, 4);
    chunks.push(body);
  }

  const data = Buffer.alloc(8 + spec.actualDataBytes);
  ascii4(spec.dataId).copy(data, 0);
  data.writeUInt32LE(spec.declaredDataBytes >>> 0, 4);
  for (let i = 0; i < spec.actualDataBytes; i += 1) data[8 + i] = (i * 37) & 0xff;
  chunks.push(data);

  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  ascii4(spec.riff).copy(head, 0);
  head.writeUInt32LE(spec.riffSize === "correct" ? 4 + body.length : spec.riffSize >>> 0, 4);
  ascii4(spec.wave).copy(head, 8);
  return Buffer.concat([head, body]);
}

/** What `inspectWav` did: a description, or the typed refusal. */
type Outcome = { kind: "read"; info: WavInfo } | { kind: "refused"; error: AppError };

function inspect(buf: Buffer): Outcome {
  try {
    return { kind: "read", info: inspectWav(buf) };
  } catch (err) {
    if (err instanceof AppError) return { kind: "refused", error: err };
    throw err;
  }
}

/**
 * The single property, applied to every generated buffer.
 *
 * Either the parser refused with the typed client error the route turns into
 * a 400, or it produced a description the bytes support: every field a real
 * number, the byte count no larger than the buffer, and the duration
 * consistent with the fields it just reported.
 */
function assertReadOrRefused(buf: Buffer, where: string): Outcome {
  const outcome = inspect(buf);

  if (outcome.kind === "refused") {
    // A refusal is only useful if it is attributable and safe to show.
    expect(outcome.error.code, where).toBe("BAD_AUDIO_FORMAT");
    expect(outcome.error.domain, where).toBe("client");
    expect(outcome.error.userMessage, where).toBeTruthy();
    // The learner-facing text must never carry parser internals.
    expect(outcome.error.userMessage, where).not.toContain("RIFF");
    expect(outcome.error.userMessage, where).not.toContain("fmt");
    return outcome;
  }

  const { info } = outcome;

  /**
   * Every field a real number — with one carve-out, which this sweep found
   * and which is reported as a defect rather than accommodated away.
   *
   * A header declaring `sampleRate: 0` divides by zero and yields
   * `seconds: Infinity`, or `NaN` when the data chunk is also empty. The
   * carve-out is written as narrowly as it can be: it applies only to
   * `seconds`, and only when the declared rate is exactly zero. A non-finite
   * `seconds` from any other header, or a non-finite value in any other
   * field, still fails here — and the last test in "the route's three checks"
   * pins the consequence and names what currently prevents it reaching a
   * learner.
   */
  for (const [field, value] of Object.entries(info)) {
    if (field === "seconds" && info.sampleRate === 0) continue;
    expect(Number.isFinite(value), `${where}: ${field} is ${String(value)}`).toBe(true);
  }
  // It cannot claim more audio than the buffer holds, and it cannot claim a
  // negative amount of it.
  expect(info.dataBytes, where).toBeGreaterThanOrEqual(0);
  expect(info.dataBytes, where).toBeLessThanOrEqual(buf.length);
  if (info.sampleRate !== 0) {
    expect(info.seconds, where).toBeGreaterThanOrEqual(0);
    // The duration must follow from the fields it reported, not from anywhere
    // else — a duration that does not is the misread this parser exists to
    // prevent, because it is what gets billed and what gets scored.
    const bytesPerFrame = (info.bitsPerSample / 8) * info.channels;
    expect(info.seconds, where).toBeCloseTo(info.dataBytes / (info.sampleRate * bytesPerFrame), 9);
  }
  return outcome;
}

describe("arbitrary bytes are refused or read truthfully, never misread", () => {
  it(`sweeps ${RANDOM_CASES} random buffers without hanging or misreading`, () => {
    /**
     * Pure noise, plus noise that happens to start with the magic bytes. The
     * chunk walk is the risk here: it advances by a length field the buffer
     * itself supplies, so a hostile size is the obvious way to try to make it
     * loop forever or read past the end.
     */
    const rng = makeRng(SEED_BYTES);
    let refused = 0;
    let read = 0;

    for (let i = 0; i < RANDOM_CASES; i += 1) {
      const length = chance(rng, 0.3) ? intBetween(rng, 0, 48) : intBetween(rng, 0, 2_000);
      const buf = Buffer.alloc(length);
      for (let n = 0; n < length; n += 1) buf[n] = intBetween(rng, 0, 255);
      // A third of them look like a WAV at first glance, so the sweep gets
      // past the two magic-byte checks and into the chunk walk.
      if (chance(rng, 0.35) && length >= 12) {
        buf.write("RIFF", 0, "ascii");
        buf.write("WAVE", 8, "ascii");
      }
      // And some of those get a plausible chunk id at offset 12, so the walk
      // reads a hostile size out of random bytes.
      if (chance(rng, 0.5) && length >= 20) buf.write(pickFrom(rng, ["fmt ", "data"]), 12, "ascii");

      /**
       * A tenth of the sweep is a genuinely valid file with random bytes
       * appended, because pure noise essentially never produces both a fmt
       * and a data chunk — so without these the sweep would only ever
       * exercise the refusal path and the "read truthfully" half of the
       * property would go unasked. Trailing garbage is also the realistic
       * hostile shape: a valid header followed by chunks the walk has to
       * survive.
       */
      const subject = chance(rng, 0.1)
        ? Buffer.concat([build(goodSpec(intBetween(rng, 0, 400) * 2)), buf])
        : buf;

      const outcome = assertReadOrRefused(subject, `seed ${SEED_BYTES} case ${i} (${length} bytes)`);
      if (outcome.kind === "refused") refused += 1;
      else read += 1;
    }

    // Both outcomes must occur, or this sweep is only testing one of them.
    expect(refused).toBeGreaterThan(RANDOM_CASES / 2);
    expect(read).toBeGreaterThan(0);
  });

  it("refuses every prefix of a real file that is not a whole one", () => {
    /**
     * Truncation is the realistic corruption: a connection dropping
     * mid-upload leaves a valid prefix. Every prefix short of a complete
     * header must be refused rather than read as a tiny recording, and every
     * prefix past it must report only the bytes that actually arrived —
     * never the length the header still claims.
     */
    const rng = makeRng(SEED_TRUNCATE);
    const full = build(goodSpec(16_000)); // one second of 16 kHz mono PCM16
    expect(full.length).toBe(44 + 16_000);

    let refusedShort = 0;
    let readTruncated = 0;
    const offsets = new Set<number>([...listOf(60, (i) => i), 43, 44, 45, 46, full.length]);
    for (let i = 0; i < 200; i += 1) offsets.add(intBetween(rng, 0, full.length));

    for (const cut of [...offsets].sort((a, b) => a - b)) {
      const prefix = full.subarray(0, cut);
      const where = `truncated to ${cut} bytes`;
      const outcome = assertReadOrRefused(Buffer.from(prefix), where);

      if (cut < 44) {
        // Not even a complete header: there is no data chunk to find.
        expect(outcome.kind, where).toBe("refused");
        refusedShort += 1;
        continue;
      }
      expect(outcome.kind, where).toBe("read");
      if (outcome.kind === "read") {
        // The header still declares 16000 bytes of audio. The parser must
        // report what arrived, not what was promised.
        expect(outcome.info.dataBytes, where).toBe(cut - 44);
        expect(outcome.info.seconds, where).toBeCloseTo((cut - 44) / 32_000, 9);
        readTruncated += 1;
      }
    }

    expect(refusedShort).toBeGreaterThan(40);
    expect(readTruncated).toBeGreaterThan(40);
  });
});

describe("a header that lies", () => {
  const rng = makeRng(SEED_HEADERS);

  /** One field of a good header, corrupted. */
  function corrupt(spec: HeaderSpec, r: Rng): HeaderSpec {
    const next = { ...spec };
    switch (intBetween(r, 0, 11)) {
      case 0:
        next.riff = pickFrom(r, ["RIFX", "FFIR", "riff", "    ", "ID3 "]);
        break;
      case 1:
        next.wave = pickFrom(r, ["AVI ", "wave", "WAV ", "    "]);
        break;
      case 2:
        next.fmtId = pickFrom(r, ["fmt", "FMT ", "junk", "data"]);
        break;
      case 3:
        next.fmtSize = pickFrom(r, [0, 1, 15, 17, 18, 40, 0xffff_ffff, 0x7fff_ffff]);
        break;
      case 4:
        next.audioFormat = pickFrom(r, [0, 2, 3, 6, 7, 0xfffe, 0xffff]);
        break;
      case 5:
        next.channels = pickFrom(r, [0, 2, 6, 255, 0xffff]);
        break;
      case 6:
        next.sampleRate = pickFrom(r, [0, 1, 8_000, 44_100, 48_000, 0xffff_ffff]);
        break;
      case 7:
        next.bitsPerSample = pickFrom(r, [0, 1, 8, 24, 32, 0xffff]);
        break;
      case 8:
        next.declaredDataBytes = pickFrom(r, [0, 1, 7, 0xffff_ffff, 0x7fff_ffff, spec.actualDataBytes * 4]);
        break;
      case 9:
        next.dataId = pickFrom(r, ["DATA", "dat ", "junk", "fmt "]);
        break;
      case 10:
        next.riffSize = pickFrom(r, [0, 1, 0xffff_ffff, 12]);
        break;
      default:
        // Either a malformed extra chunk, or a correctly padded one of a
        // random (often odd) size — the latter must still be walked past.
        if (chance(r, 0.5)) {
          next.filler = [
            pickFrom(r, ["LIST", "fact", "junk", "    "]),
            pickFrom(r, [0, 1, 4, 7, 0xffff_ffff]),
            intBetween(r, 0, 12),
          ];
        } else {
          next.paddedFiller = {
            id: pickFrom(r, ["LIST", "fact", "cue "]),
            size: intBetween(r, 0, 33),
          };
        }
        break;
    }
    return next;
  }

  it(`sweeps ${HEADER_CASES} misdeclared headers`, () => {
    let refused = 0;
    let read = 0;
    for (let i = 0; i < HEADER_CASES; i += 1) {
      let spec = goodSpec(intBetween(rng, 0, 8_000) * 2);
      // One to three corruptions, so single-field and interacting failures
      // both get exercised.
      for (let n = 0; n < intBetween(rng, 1, 3); n += 1) spec = corrupt(spec, rng);
      const outcome = assertReadOrRefused(build(spec), `seed ${SEED_HEADERS} case ${i}`);
      if (outcome.kind === "refused") refused += 1;
      else read += 1;
    }
    // Both branches reached, so neither is passing by never being asked.
    expect(refused).toBeGreaterThan(100);
    expect(read).toBeGreaterThan(100);
  });

  it("never reports more audio than arrived, however large the claim", () => {
    // The overclaim: a header saying four gigabytes of audio follows 200
    // bytes of it. Reading the claim would bill a provider for a recording
    // that does not exist.
    for (const declared of [0, 0xffff_ffff, 0x7fff_ffff, 1_000_000]) {
      const spec = { ...goodSpec(200), declaredDataBytes: declared };
      const info = inspectWav(build(spec));
      expect(info.dataBytes, `declared ${declared}`).toBe(200);
      expect(info.seconds, `declared ${declared}`).toBeCloseTo(200 / 32_000, 9);
    }
  });

  it("reads a truthful smaller claim as the claim, not as the buffer", () => {
    // The legitimate case the fallback must not swallow: trailing metadata
    // after the data chunk. 200 declared bytes inside a 600-byte body is a
    // 200-byte recording.
    const spec = { ...goodSpec(600), declaredDataBytes: 200 };
    const info = inspectWav(build(spec));
    expect(info.dataBytes).toBe(200);
  });

  it("refuses anything that is not RIFF/WAVE, whatever follows", () => {
    for (const riff of ["RIFX", "riff", "ID3 "]) {
      expect(() => inspectWav(build({ ...goodSpec(64), riff }))).toThrow(AppError);
    }
    for (const wave of ["AVI ", "wave", "WAV "]) {
      expect(() => inspectWav(build({ ...goodSpec(64), wave }))).toThrow(AppError);
    }
  });

  it("walks past a correctly padded chunk of any size, odd ones included", () => {
    /**
     * RIFF pads an odd-sized chunk to a word boundary, and the walk has to
     * account for that pad byte or it reads the *next* chunk id one byte
     * early — which turns a perfectly valid file into "no data chunk" and
     * rejects a recording that was fine.
     *
     * Swept over every size from 0 to 40 rather than checked at one, because
     * only the odd ones expose it and a single even example would still pass
     * with the correction removed entirely.
     */
    let oddSizes = 0;
    for (let size = 0; size <= 40; size += 1) {
      const info = inspectWav(build({ ...goodSpec(3_200), paddedFiller: { id: "LIST", size } }));
      const where = `filler chunk of ${size} bytes`;
      expect(info.dataBytes, where).toBe(3_200);
      expect(info.sampleRate, where).toBe(16_000);
      expect(info.seconds, where).toBeCloseTo(0.1, 9);
      if (size % 2 === 1) oddSizes += 1;
    }
    expect(oddSizes).toBe(20);
  });

  it("refuses a file with no fmt chunk and one with no data chunk", () => {
    expect(() => inspectWav(build({ ...goodSpec(64), fmtId: "junk" }))).toThrow(AppError);
    expect(() => inspectWav(build({ ...goodSpec(64), dataId: "junk" }))).toThrow(AppError);
  });
});

describe("the route's three checks, applied in the route's order", () => {
  const rng = makeRng(SEED_HEADERS + 1);

  /** inspectWav, then assertAzureFormat, then assertDuration — as the route does. */
  function validate(buf: Buffer): AppError | null {
    try {
      const info = inspectWav(buf);
      assertAzureFormat(info);
      assertDuration(info, MIN_AUDIO_SECONDS, MAX_AUDIO_SECONDS);
      return null;
    } catch (err) {
      if (err instanceof AppError) return err;
      throw err;
    }
  }

  it("accepts exactly what R7 prescribes and refuses everything else", () => {
    // A real 16 kHz mono PCM16 second passes.
    expect(validate(build(goodSpec(32_000)))).toBeNull();

    // And every single-field deviation from R7 is refused, with an
    // attributable code.
    const deviations: Array<Partial<HeaderSpec>> = [
      { sampleRate: 8_000 },
      { sampleRate: 44_100 },
      { sampleRate: 48_000 },
      { sampleRate: 0 },
      { channels: 2 },
      { channels: 0 },
      { bitsPerSample: 8 },
      { bitsPerSample: 24 },
      { bitsPerSample: 32 },
      { audioFormat: 3 },
      { audioFormat: 0xfffe },
    ];
    for (const deviation of deviations) {
      const error = validate(build({ ...goodSpec(32_000), ...deviation }));
      const where = JSON.stringify(deviation);
      expect(error, where).not.toBeNull();
      expect(error?.code, where).toBe("BAD_AUDIO_FORMAT");
      expect(error?.domain, where).toBe("client");
    }
  });

  it("gates the duration on the real byte count, not the declared one", () => {
    for (const seconds of [0, 0.1, 0.24, 0.25, 1, 14.9, 15, 15.1, 30]) {
      const bytes = Math.round(seconds * 32_000);
      // Declares an hour of audio; only `bytes` of it exist.
      const error = validate(build({ ...goodSpec(bytes), declaredDataBytes: 32_000 * 3_600 }));
      const where = `${seconds}s of real audio`;
      if (seconds < MIN_AUDIO_SECONDS) expect(error?.code, where).toBe("AUDIO_TOO_SHORT");
      else if (seconds > MAX_AUDIO_SECONDS) expect(error?.code, where).toBe("AUDIO_TOO_LONG");
      else expect(error, where).toBeNull();
    }
  });

  it("refuses every hostile header the sweep can build", () => {
    // The end-to-end form of the property: for a thousand corrupted headers,
    // the three checks together either accept a genuinely R7-conformant file
    // or return a typed client error. Nothing gets through unattributed.
    for (let i = 0; i < 1_000; i += 1) {
      let spec = goodSpec(intBetween(rng, 0, 8_000) * 2);
      for (let n = 0; n < intBetween(rng, 1, 3); n += 1) {
        spec = { ...spec, ...pickFrom(rng, [
          { sampleRate: pickFrom(rng, [0, 1, 8_000, 44_100, 48_000, 0xffff_ffff]) },
          { channels: pickFrom(rng, [0, 2, 255]) },
          { bitsPerSample: pickFrom(rng, [0, 1, 8, 24, 32]) },
          { audioFormat: pickFrom(rng, [0, 3, 0xfffe]) },
          { declaredDataBytes: pickFrom(rng, [0, 1, 0xffff_ffff]) },
          { fmtSize: pickFrom(rng, [0, 15, 17, 40]) },
        ]) };
      }
      const error = validate(build(spec));
      const where = `seed ${SEED_HEADERS + 1} case ${i}`;
      if (error === null) {
        // Accepted — then it really was R7-conformant and inside the window.
        const info = inspectWav(build(spec));
        expect(info.sampleRate, where).toBe(16_000);
        expect(info.channels, where).toBe(1);
        expect(info.bitsPerSample, where).toBe(16);
        expect(info.audioFormat, where).toBe(1);
        expect(info.seconds, where).toBeGreaterThanOrEqual(MIN_AUDIO_SECONDS);
        expect(info.seconds, where).toBeLessThanOrEqual(MAX_AUDIO_SECONDS);
      } else {
        expect(["BAD_AUDIO_FORMAT", "AUDIO_TOO_SHORT", "AUDIO_TOO_LONG"], where).toContain(
          error.code,
        );
        expect(error.domain, where).toBe("client");
      }
    }
  });

  it("depends on assertAzureFormat running first, and that is not stated anywhere", () => {
    /**
     * A latent coupling, recorded rather than blessed. See the report.
     *
     * A header declaring `sampleRate: 0` survives `inspectWav` — the
     * degenerate-frame guard checks `bitsPerSample/8 * channels`, which is
     * still 2 — and yields `seconds: Infinity`, or `NaN` when there are also
     * zero data bytes. `assertDuration` compares with `<` and `>`, and NaN
     * fails both, so on its own it would admit that file: the duration gate
     * would silently stop existing for exactly the input crafted to evade it.
     *
     * What prevents it today is only the call order in
     * server/routes/pronunciation.ts:154-155 — `assertAzureFormat` rejects
     * the 0 Hz rate before the duration is ever consulted. Nothing in
     * server/wav.ts says so, and swapping those two lines is a change no type
     * and no other test would catch. This is the test that would.
     */
    const zeroRate = inspectWav(build({ ...goodSpec(32_000), sampleRate: 0 }));
    expect(zeroRate.seconds).toBe(Number.POSITIVE_INFINITY);

    const zeroBoth = inspectWav(build({ ...goodSpec(0), sampleRate: 0, declaredDataBytes: 0 }));
    expect(Number.isNaN(zeroBoth.seconds)).toBe(true);
    // On its own, the duration gate admits it.
    expect(() => assertDuration(zeroBoth, MIN_AUDIO_SECONDS, MAX_AUDIO_SECONDS)).not.toThrow();
    // In the route's order, it does not get that far.
    expect(() => assertAzureFormat(zeroBoth)).toThrow(AppError);
    expect(validate(build({ ...goodSpec(0), sampleRate: 0 }))?.code).toBe("BAD_AUDIO_FORMAT");
  });
});

describe("the client encoder's output, fuzzed through this parser", () => {
  it("is read back with the rate, shape and duration it was given", async () => {
    /**
     * The property that matters end to end: whatever the capture path
     * produces, the server reads back as exactly what was recorded. Swept
     * over lengths rather than checked at one, because the sizes that break a
     * 16-bit stride are the short and odd ones.
     */
    const rng = makeRng(SEED_BYTES + 2);
    const lengths = [0, 1, 2, 3, 4_000, 16_000, 16_001, ...listOf(30, () => intBetween(rng, 0, 240_000))];

    for (const samples of lengths) {
      const wav = encodeWav(new Float32Array(samples), 16_000);
      const buf = Buffer.from(await wav.arrayBuffer());
      const info = inspectWav(buf);
      const where = `${samples} samples`;

      expect(info.sampleRate, where).toBe(16_000);
      expect(info.channels, where).toBe(1);
      expect(info.bitsPerSample, where).toBe(16);
      expect(info.audioFormat, where).toBe(1);
      expect(info.dataBytes, where).toBe(samples * 2);
      expect(info.seconds, where).toBeCloseTo(samples / 16_000, 9);
      // R7 conformance is the point of the encoder, so this must never throw.
      expect(() => assertAzureFormat(info), where).not.toThrow();
    }
  });
});
