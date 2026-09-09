/**
 * The provider, and every way it is allowed to fail.
 *
 * **No test here touches the real API.** `fetch` is injected, and the two
 * tests that assert nothing is spent assert it by proving `fetch` was never
 * called. A test that needs a key is a test that fails in CI; a test that
 * spends money is worse than one that fails.
 *
 * The load-bearing test in this file is the declared-language guard. Verified
 * against the live API: `eleven_flash_v2_5` returns **HTTP 200 for Kannada
 * text it does not declare** — it synthesises a mispronunciation and reports
 * success. So the only defence is refusing before the request, and the only
 * authority is the declared list. Everything else in here is the ordinary
 * fail-closed matrix: no key, 401, 429, a timeout, a body that does not parse.
 *
 * What "fails closed" buys is stated once: a `null` costs the learner the
 * *quality* of the model voice and never its existence, because the caller's
 * fallback is the platform synthesiser the app already shipped with. That is
 * why nothing here throws and why nothing here is retried.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_CONTENT_TYPE,
  AUDIO_EXTENSION,
  DEFAULT_MODEL_ID,
  PLACEHOLDER_VOICE_ID,
  apiKey,
  declaredLanguageCount,
  declaresLanguage,
  modelId,
  synthesise,
  voiceIdFor,
} from "./elevenLabs.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Every environment variable this module reads, restored after each test. */
const READS = [
  "ELEVENLABS_API_KEY",
  "ElevenLabs_API_KEY",
  "ELEVENLABS_MODEL_ID",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_VOICE_IDS",
] as const;

const ORIGINAL = new Map<string, string | undefined>(READS.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of READS) delete process.env[name];
  process.env.ELEVENLABS_API_KEY = "test-key-not-a-real-one";
});

afterEach(() => {
  for (const [name, value] of ORIGINAL) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

/** A well-formed body for a two-word phrase, with times per character. */
function alignedBody(text: string, audio = "QUJD") {
  const characters = [...text];
  return {
    audio_base64: audio,
    alignment: {
      characters,
      character_start_times_seconds: characters.map((_, i) => i * 0.1),
      character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.1),
    },
    // Present in the real response and deliberately not read — it describes
    // the *normalised* text, which no longer indexes the phrase on screen.
    normalized_alignment: { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A fetch that answers with `body`, and records what it was asked. */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(jsonResponse(body, status));
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("the key", () => {
  it("reads the conventional name", () => {
    process.env.ELEVENLABS_API_KEY = "conventional";

    expect(apiKey()).toBe("conventional");
  });

  it("reads the mixed-case name the .env file actually uses", () => {
    /**
     * `process.env` is case-sensitive and the variable was added as
     * `ElevenLabs_API_KEY` — mixed case, unlike every other name in that file.
     * Reading only the conventional spelling would leave the feature silently
     * off with a key present, which looks exactly like a provider outage.
     */
    delete process.env.ELEVENLABS_API_KEY;
    process.env.ElevenLabs_API_KEY = "as-written-in-dot-env";

    expect(apiKey()).toBe("as-written-in-dot-env");
  });

  it("prefers the conventional name, so renaming it is a one-line edit", () => {
    process.env.ELEVENLABS_API_KEY = "renamed";
    process.env.ElevenLabs_API_KEY = "old";

    expect(apiKey()).toBe("renamed");
  });

  it("treats blank as unset", () => {
    // A variable present and empty is the shape a half-finished `.env` has,
    // and sending an empty key would spend a request to be told 401.
    process.env.ELEVENLABS_API_KEY = "   ";

    expect(apiKey()).toBeUndefined();
  });
});

describe("the model", () => {
  it("defaults to the only model that declares Kannada", () => {
    /**
     * Verified against GET /v1/models: eleven_v3 declares 74 languages
     * including `kn`. multilingual_v2 (29), flash_v2_5 (32) and turbo_v2_5
     * (32) all cover fr/es/de/hi and none of them declares Kannada, so
     * defaulting to any of those would mean the model has to change the day a
     * Kannada set is published.
     */
    expect(modelId()).toBe(DEFAULT_MODEL_ID);
    expect(declaresLanguage(DEFAULT_MODEL_ID, "kn-IN")).toBe(true);
    expect(declaredLanguageCount(DEFAULT_MODEL_ID)).toBe(74);
  });

  it("is configuration, not a code edit", () => {
    process.env.ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";

    expect(modelId()).toBe("eleven_multilingual_v2");
  });

  it("refuses a model it cannot vouch for", () => {
    /**
     * An unknown model has no declared language list, so the guard below
     * cannot run for it — and the guard is the only thing standing between a
     * Kannada phrase and an HTTP 200 mispronunciation. Falling back loudly is
     * the only safe answer; honouring the name would silently disable the
     * check that matters most.
     */
    process.env.ELEVENLABS_MODEL_ID = "eleven_v99_turbo";

    expect(modelId()).toBe(DEFAULT_MODEL_ID);
    expect(declaresLanguage("eleven_v99_turbo", "fr-FR")).toBe(false);
  });
});

describe("the voice", () => {
  it("is a documented placeholder with nothing configured", () => {
    // 202 voices exist on the account and choosing one per language is the
    // owner's call. This is deliberately obviously a default.
    expect(voiceIdFor("fr-FR")).toBe(PLACEHOLDER_VOICE_ID);
  });

  it("takes a per-locale mapping from the environment", () => {
    process.env.ELEVENLABS_VOICE_IDS = "fr-FR:frenchvoice,hi-IN:hindivoice";

    expect(voiceIdFor("fr-FR")).toBe("frenchvoice");
    expect(voiceIdFor("hi-IN")).toBe("hindivoice");
  });

  it("accepts a bare language as well as a full locale", () => {
    // One Spanish voice for es-ES and es-MX alike is a reasonable thing to
    // want, and having to write both is how one of them gets forgotten.
    process.env.ELEVENLABS_VOICE_IDS = "es:spanishvoice";

    expect(voiceIdFor("es-ES")).toBe("spanishvoice");
    expect(voiceIdFor("es-MX")).toBe("spanishvoice");
  });

  it("prefers the exact locale over the bare language", () => {
    process.env.ELEVENLABS_VOICE_IDS = "es:generic,es-ES:castilian";

    expect(voiceIdFor("es-ES")).toBe("castilian");
    expect(voiceIdFor("es-MX")).toBe("generic");
  });

  it("falls back to one voice for every language", () => {
    process.env.ELEVENLABS_VOICE_ID = "one-for-all";

    expect(voiceIdFor("de-DE")).toBe("one-for-all");
  });

  it("skips a malformed entry rather than losing the other languages", () => {
    // One bad pair in a comma-separated variable must not cost the three
    // languages that were written correctly.
    process.env.ELEVENLABS_VOICE_IDS = "fr-FR:frenchvoice,nonsense,hi-IN:hindivoice";

    expect(voiceIdFor("fr-FR")).toBe("frenchvoice");
    expect(voiceIdFor("hi-IN")).toBe("hindivoice");
  });
});

describe("the declared-language guard", () => {
  it("refuses a language the model does not declare, without spending a request", async () => {
    /**
     * The verified trap, and the reason this guard exists at all:
     * `eleven_flash_v2_5` answered **200** for Kannada text despite not
     * declaring `kn`. A status code is therefore not evidence that a model
     * speaks a language, and inspecting the response cannot tell us — the
     * bytes are audio, they are simply wrong.
     *
     * The stub is rigged to answer 200 with a perfectly good body, exactly as
     * the real API did. If the guard were removed this test would receive
     * usable-looking audio, which is precisely how a learner ends up
     * imitating a mispronunciation of the language they are scored on.
     */
    const { impl, calls } = stubFetch(alignedBody("ನಮಸ್ಕಾರ"));

    const result = await synthesise({
      text: "ನಮಸ್ಕಾರ",
      language: "kn-IN",
      modelId: "eleven_flash_v2_5",
      fetchImpl: impl,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("allows the same language on the model that does declare it", async () => {
    const { impl, calls } = stubFetch(alignedBody("ನಮಸ್ಕಾರ"));

    const result = await synthesise({
      text: "ನಮಸ್ಕಾರ",
      language: "kn-IN",
      modelId: "eleven_v3",
      fetchImpl: impl,
    });

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("refuses a non-English language on an English-only model", async () => {
    // eleven_turbo_v2 and eleven_flash_v2 are English-only. Sending French to
    // one produces a French phrase read by an English reader, at 200.
    const { impl, calls } = stubFetch(alignedBody("Bonjour"));

    const result = await synthesise({
      text: "Bonjour",
      language: "fr-FR",
      modelId: "eleven_turbo_v2",
      fetchImpl: impl,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("matches on the language, not the region", async () => {
    // The declared codes are ISO 639-1; the app's locales are BCP-47. es-MX
    // and es-ES are the same declared language.
    expect(declaresLanguage("eleven_v3", "es-MX")).toBe(true);
    expect(declaresLanguage("eleven_v3", "es")).toBe(true);
  });
});

describe("failing closed", () => {
  it("returns null with no key, without spending a request", async () => {
    for (const name of READS) delete process.env[name];
    const { impl, calls } = stubFetch(alignedBody("Bonjour"));

    const result = await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null on 401 — a scoped or wrong key", async () => {
    // Verified: GET /v1/user/subscription returns 401 for this key, so quota
    // cannot be read and a 401 on synthesis is a real possibility to handle.
    const { impl } = stubFetch({ detail: "unauthorized" }, 401);

    expect(await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl })).toBeNull();
  });

  it("returns null on 429 — out of quota", async () => {
    const { impl } = stubFetch({ detail: "quota exceeded" }, 429);

    expect(await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl })).toBeNull();
  });

  it("returns null on 500", async () => {
    const { impl } = stubFetch({ detail: "server error" }, 500);

    expect(await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl })).toBeNull();
  });

  it("returns null when the request is aborted, and does not throw", async () => {
    /**
     * A timeout and a dropped connection both arrive as a rejected fetch. The
     * assertion that matters is that this *resolves* to null rather than
     * rejecting: a throw here would propagate out of a forty-phrase
     * generation run and abandon the thirty-nine phrases after it.
     */
    const abort = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const impl = vi.fn(() => Promise.reject(abort)) as unknown as typeof fetch;

    await expect(synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl })).resolves.toBeNull();
  });

  it("returns null when the body is not JSON", async () => {
    const impl = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      } as unknown as Response),
    ) as unknown as typeof fetch;

    expect(await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl })).toBeNull();
  });

  it("returns null when the body has no audio", async () => {
    const { impl } = stubFetch({ alignment: alignedBody("Bonjour").alignment });

    expect(await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl })).toBeNull();
  });

  it("returns null when the body has no alignment", async () => {
    const { impl } = stubFetch({ audio_base64: "QUJD" });

    expect(await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl })).toBeNull();
  });

  it("returns null when a time is not a number", async () => {
    const body = alignedBody("Bonjour");
    body.alignment.character_start_times_seconds = ["nope"] as unknown as number[];
    const { impl } = stubFetch(body);

    expect(await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl })).toBeNull();
  });

  it("returns null when the time arrays are shorter than the characters", async () => {
    /**
     * The failure this catches is specific and silent: the last words of a
     * phrase would have no time, so the highlight would stop mid-phrase and
     * read to a learner as the voice having stopped.
     */
    const body = alignedBody("Bonjour tout le monde");
    body.alignment.character_start_times_seconds.pop();
    const { impl } = stubFetch(body);

    expect(await synthesise({ text: "Bonjour tout le monde", language: "fr-FR", fetchImpl: impl })).toBeNull();
  });

  it("returns null when the alignment is empty", async () => {
    const { impl } = stubFetch({
      audio_base64: "QUJD",
      alignment: { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] },
    });

    expect(await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl })).toBeNull();
  });

  it("returns null when the audio decodes to nothing", async () => {
    // Buffer.from(_, "base64") does not throw on rubbish — it silently skips
    // what it cannot decode, so a non-empty string can yield zero bytes. This
    // is the check that catches it.
    const { impl } = stubFetch(alignedBody("Bonjour", "!!!!"));

    expect(await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl })).toBeNull();
  });

  it("refuses an empty phrase without spending a request", async () => {
    const { impl, calls } = stubFetch(alignedBody("x"));

    expect(await synthesise({ text: "   ", language: "fr-FR", fetchImpl: impl })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("a successful synthesis", () => {
  it("returns the audio bytes and the character alignment", async () => {
    const { impl } = stubFetch(alignedBody("Bonjour"));

    const result = await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl });

    expect(result?.audio.byteLength).toBeGreaterThan(0);
    expect(result?.alignment.characters.join("")).toBe("Bonjour");
    expect(result?.alignment.startSeconds).toHaveLength(7);
    expect(result?.alignment.endSeconds).toHaveLength(7);
  });

  it("echoes back the voice and model that produced the bytes", async () => {
    // The cache keys on these, so a caller that had to re-derive them could
    // key audio to a configuration that did not make it.
    process.env.ELEVENLABS_VOICE_IDS = "fr-FR:frenchvoice";
    const { impl } = stubFetch(alignedBody("Bonjour"));

    const result = await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl });

    expect(result?.voiceId).toBe("frenchvoice");
    expect(result?.modelId).toBe(DEFAULT_MODEL_ID);
  });

  it("trims the phrase, so the alignment describes what was sent", async () => {
    const { impl, calls } = stubFetch(alignedBody("Bonjour"));

    await synthesise({ text: "  Bonjour  ", language: "fr-FR", fetchImpl: impl });

    expect(JSON.parse(String(calls[0]?.init.body)).text).toBe("Bonjour");
  });

  it("keeps the audio when the alignment does not reproduce the phrase", async () => {
    /**
     * Deliberately *not* fatal. If a provider-side normalisation ever breaks
     * the character correspondence, the right outcome is a native-quality
     * recording that plays with no word marking — not silence. The client
     * checks the same correspondence again and declines to place a highlight;
     * see src/modelVoice/manifest.ts.
     */
    const { impl } = stubFetch(alignedBody("Bonjour!"));

    const result = await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl });

    expect(result).not.toBeNull();
    expect(result?.alignment.characters.join("")).toBe("Bonjour!");
  });

  it("sends the key as a header and never in the URL", async () => {
    // A key in a URL is a key in every proxy log and every browser history.
    const { impl, calls } = stubFetch(alignedBody("Bonjour"));

    await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl });

    const call = calls[0];
    expect((call?.init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key-not-a-real-one");
    expect(call?.url).not.toContain("test-key-not-a-real-one");
  });

  it("asks the with-timestamps endpoint for the configured voice", async () => {
    process.env.ELEVENLABS_VOICE_IDS = "hi-IN:hindivoice";
    const { impl, calls } = stubFetch(alignedBody("नमस्ते"));

    await synthesise({ text: "नमस्ते", language: "hi-IN", fetchImpl: impl });

    // with-timestamps is what carries the alignment. The plain endpoint
    // returns audio alone, which would cost the word highlight entirely.
    expect(calls[0]?.url).toContain("/text-to-speech/hindivoice/with-timestamps");
  });

  it("names the model in the body", async () => {
    const { impl, calls } = stubFetch(alignedBody("नमस्ते"));

    await synthesise({ text: "नमस्ते", language: "hi-IN", fetchImpl: impl });

    expect(JSON.parse(String(calls[0]?.init.body)).model_id).toBe(DEFAULT_MODEL_ID);
  });

  it("sends language_code only to the models that accept it", async () => {
    /**
     * An unsupported parameter is a 400, and under this file's fail-closed
     * posture a 400 costs the whole feature — so the parameter is sent only
     * where it is documented to be accepted. The default model is not one of
     * those, which is why the first half of this is the important half.
     */
    const v3 = stubFetch(alignedBody("Bonjour"));
    await synthesise({ text: "Bonjour", language: "fr-FR", modelId: "eleven_v3", fetchImpl: v3.impl });
    expect(JSON.parse(String(v3.calls[0]?.init.body)).language_code).toBeUndefined();

    const flash = stubFetch(alignedBody("Bonjour"));
    await synthesise({
      text: "Bonjour",
      language: "fr-FR",
      modelId: "eleven_flash_v2_5",
      fetchImpl: flash.impl,
    });
    expect(JSON.parse(String(flash.calls[0]?.init.body)).language_code).toBe("fr");
  });

  it("asks for mp3, which every browser this app targets can play", async () => {
    const { impl, calls } = stubFetch(alignedBody("Bonjour"));

    await synthesise({ text: "Bonjour", language: "fr-FR", fetchImpl: impl });

    expect(calls[0]?.url).toContain("output_format=mp3_44100_128");
    expect(AUDIO_EXTENSION).toBe("mp3");
    expect(AUDIO_CONTENT_TYPE).toBe("audio/mpeg");
  });
});
