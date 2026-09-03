/**
 * The endpoint the whole product depends on, which until now had no test.
 *
 * It was verified only by hand with `curl` — which does catch real problems,
 * but only the ones somebody thinks to try, only on the day they try them, and
 * never in CI. What matters here is the validation ladder in front of the
 * provider (FR-19) and the honesty boundary behind it (R8): an unusable take
 * must come back as `indeterminate`, never as a number.
 *
 * Runs the real Express router on an ephemeral port and talks to it over HTTP,
 * rather than adding supertest. Multipart is the thing most worth exercising
 * for real — multer's parsing, the field/file split, the content-type sniffing
 * — and hand-driving the handler would skip exactly that.
 *
 * Four modules are stubbed, all of them for the same reason: they reach
 * outside the process. The provider (no Azure key, no billed calls), and the
 * attempt/diagnostic writers plus the rate limiter (no MongoDB). Everything
 * under test is the route's own logic.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { AppError } from "../errors.js";
import type { PronunciationResult } from "../services/types.js";

/** Set per test to control what the "provider" does. */
let providerBehaviour: () => Promise<PronunciationResult> = () =>
  Promise.resolve(SCORED_RESULT);

const scoreSpy = vi.fn(() => providerBehaviour());

vi.mock("../services/index.js", () => ({
  getScoringProvider: () => ({ name: "stub", score: scoreSpy }),
}));

// Both swallow their own failures in production; here they must not touch Mongo.
vi.mock("../attempts.js", () => ({ recordAttempt: vi.fn(() => Promise.resolve()) }));
vi.mock("../diagnostics.js", () => ({ recordDiagnostic: vi.fn(() => Promise.resolve()) }));

// The real limiter allows 30/min, which this file would exhaust and then start
// asserting against 429s instead of the validation it means to test.
vi.mock("../rateLimit.js", () => ({
  scoringLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  diagnosticsLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const SCORED_RESULT: PronunciationResult = {
  indeterminate: false,
  provider: "stub",
  recognized: "Bonjour, comment allez-vous",
  overall: 93,
  accuracy: 95,
  fluency: 90,
  completeness: 100,
  words: [
    {
      word: "Bonjour",
      accuracy: 94,
      errorType: "None",
      phonemes: [],
      syllables: [{ grapheme: "bon", accuracy: 100, offsetTicks: 400000, durationTicks: 2500000 }],
    },
  ],
};

/**
 * A real WAV, because the route decodes the header rather than trusting the
 * declared content type (FR-19) — a stub buffer would be rejected before
 * reaching anything worth testing.
 */
function wav({
  seconds = 2,
  sampleRate = 16000,
  channels = 1,
  bitsPerSample = 16,
}: { seconds?: number; sampleRate?: number; channels?: number; bitsPerSample?: number } = {}): Buffer {
  const bytesPerFrame = channels * (bitsPerSample / 8);
  const dataBytes = Math.round(seconds * sampleRate) * bytesPerFrame;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  buf.writeUInt16LE(bytesPerFrame, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

interface ErrorBody {
  error: { code: string; domain: string; message: string; userMessage: string };
}

let server: Server;
let base: string;

beforeAll(async () => {
  const express = (await import("express")).default;
  const { pronunciationRouter } = await import("./pronunciation.js");

  const app = express();
  app.use("/api/v1", pronunciationRouter);

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  scoreSpy.mockClear();
  providerBehaviour = () => Promise.resolve(SCORED_RESULT);
});

/** Posts a well-formed request with whatever `overrides` change about it. */
async function post(
  overrides: {
    audio?: Buffer | null;
    contentType?: string;
    referenceText?: string | null;
    language?: string;
    extra?: Record<string, string>;
  } = {},
): Promise<Response> {
  const form = new FormData();
  const audio = overrides.audio === undefined ? wav() : overrides.audio;
  if (audio !== null) {
    form.append(
      "audio",
      new Blob([new Uint8Array(audio)], { type: overrides.contentType ?? "audio/wav" }),
      "capture.wav",
    );
  }
  const ref = overrides.referenceText === undefined ? "Bonjour, comment allez-vous" : overrides.referenceText;
  if (ref !== null) form.append("referenceText", ref);
  form.append("language", overrides.language ?? "fr-FR");
  for (const [k, v] of Object.entries(overrides.extra ?? {})) form.append(k, v);

  return fetch(`${base}/api/v1/pronunciation`, { method: "POST", body: form });
}

describe("POST /api/v1/pronunciation — validation before the provider", () => {
  it("rejects a request with no audio part at all", async () => {
    const res = await post({ audio: null });
    const body = (await res.json()) as ErrorBody;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("MISSING_AUDIO");
    expect(body.error.domain).toBe("client");
    // Nothing billed for a request that never had audio.
    expect(scoreSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing reference text — there is nothing to score against", async () => {
    const res = await post({ referenceText: null });
    const body = (await res.json()) as ErrorBody;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("MISSING_REFERENCE_TEXT");
    expect(scoreSpy).not.toHaveBeenCalled();
  });

  it("rejects an empty reference text, not just an absent one", async () => {
    const res = await post({ referenceText: "   " });
    const body = (await res.json()) as ErrorBody;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("MISSING_REFERENCE_TEXT");
  });

  it("rejects a declared content type that is not WAV", async () => {
    const res = await post({ contentType: "audio/mpeg" });
    const body = (await res.json()) as ErrorBody;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_CONTENT_TYPE");
    expect(scoreSpy).not.toHaveBeenCalled();
  });

  it("rejects audio whose header says the wrong rate or channel count", async () => {
    // The 48kHz stereo case from the verification evidence: decoded from the
    // header, not taken from the declared type, which a client could lie about.
    const res = await post({ audio: wav({ sampleRate: 48000, channels: 2 }) });
    const body = (await res.json()) as ErrorBody;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_AUDIO_FORMAT");
    expect(scoreSpy).not.toHaveBeenCalled();
  });

  it("rejects a take below the duration floor", async () => {
    // 0.1s, under the 0.25s floor FR-11 was revised to.
    const res = await post({ audio: wav({ seconds: 0.1 }) });
    const body = (await res.json()) as ErrorBody;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("AUDIO_TOO_SHORT");
    expect(scoreSpy).not.toHaveBeenCalled();
  });

  it("rejects a take above the duration ceiling", async () => {
    const res = await post({ audio: wav({ seconds: 20 }) });
    const body = (await res.json()) as ErrorBody;

    expect(res.status).toBe(400);
    // Either gate is correct here: multer's byte limit may fire before the
    // header is decoded. Both are refusals of the same over-long take.
    expect(["AUDIO_TOO_LONG", "MISSING_AUDIO"]).toContain(body.error.code);
    expect(scoreSpy).not.toHaveBeenCalled();
  });

  it("never leaks internal detail in the wire `message`", async () => {
    // errors.ts keeps `message` for shape-compatibility but always sends the
    // sanitized userMessage in it — a provider string or a path must never
    // reach a client.
    const res = await post({ audio: wav({ sampleRate: 48000, channels: 2 }) });
    const body = (await res.json()) as ErrorBody;

    expect(body.error.message).toBe(body.error.userMessage);
    // The internal wording for this case is "audio is not 16 kHz mono PCM16:
    // 48000 Hz, expected 16000; 2 channels, expected mono". None of those
    // specifics may cross the wire. Matching on the numbers and units rather
    // than on "expected", which is also a substring of the perfectly innocent
    // "unexpected format" the learner is shown.
    expect(body.error.message).not.toMatch(/48000|16000|kHz|PCM16|channels/);
  });
});

describe("POST /api/v1/pronunciation — the provider's answer, passed through", () => {
  it("returns the scored result unchanged in the PRD §6 shape", async () => {
    const res = await post();
    const body = (await res.json()) as PronunciationResult;

    expect(res.status).toBe(200);
    expect(body).toEqual(SCORED_RESULT);
    expect(scoreSpy).toHaveBeenCalledTimes(1);
  });

  it("passes the reference text and language straight to the provider", async () => {
    await post({ referenceText: "Guten Tag", language: "de-DE" });

    const [, referenceText, language] = scoreSpy.mock.calls[0] as unknown as [Buffer, string, string];
    expect(referenceText).toBe("Guten Tag");
    expect(language).toBe("de-DE");
  });

  it("defaults the language rather than failing when it is absent", async () => {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(wav())], { type: "audio/wav" }), "c.wav");
    form.append("referenceText", "hello");

    const res = await fetch(`${base}/api/v1/pronunciation`, { method: "POST", body: form });

    expect(res.status).toBe(200);
    const [, , language] = scoreSpy.mock.calls[0] as unknown as [Buffer, string, string];
    expect(language).toBe("en-US");
  });

  it("passes an indeterminate result through as-is — R8's whole point", async () => {
    // The route must never turn "I could not get a clear read" into a number,
    // and must not treat it as an error either: it is a successful response.
    providerBehaviour = () =>
      Promise.resolve({
        indeterminate: true,
        provider: "stub",
        reason: "no speech found to assess — every word was omitted",
      });

    const res = await post();
    const body = (await res.json()) as PronunciationResult;

    expect(res.status).toBe(200);
    expect(body.indeterminate).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/"overall"|"accuracy"/);
  });

  it("maps a provider AppError to its own status and code", async () => {
    providerBehaviour = () =>
      Promise.reject(
        new AppError({
          code: "PROVIDER_TIMEOUT",
          domain: "provider",
          message: "azure did not respond within 8000 ms",
          userMessage: "Scoring timed out. Please try again.",
        }),
      );

    const res = await post();
    const body = (await res.json()) as ErrorBody;

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("PROVIDER_TIMEOUT");
    expect(body.error.domain).toBe("provider");
    // The SDK's own wording stays server-side.
    expect(body.error.message).not.toMatch(/8000|azure/i);
  });

  it("turns an unexpected provider throw into a 500 without detail", async () => {
    providerBehaviour = () => Promise.reject(new Error("kaboom /Users/someone/secret"));

    const res = await post();
    const body = (await res.json()) as ErrorBody;

    expect(res.status).toBe(500);
    expect(body.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toMatch(/kaboom|Users/);
  });
});
