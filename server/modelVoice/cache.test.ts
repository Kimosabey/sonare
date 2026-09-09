/**
 * The cache: what it keys on, what it refuses to spend, and what a failed run
 * leaves behind.
 *
 * Real files in a temporary directory, because half of what is being tested is
 * filesystem behaviour — a manifest that survives a failed run, an mp3 whose
 * name is its key, stale audio removed. A mocked `fs` would test the mock.
 *
 * The provider and the spend reservation are both injected. **Nothing here
 * reaches ElevenLabs and nothing here needs a database.**
 *
 * Four properties are worth more than the rest, and each is a way this could
 * be worse than having no cache:
 *
 *  - **A re-run spends nothing.** If it did, "generate once" would be a
 *    comment rather than a behaviour, and every deploy would be a bill.
 *  - **A re-publish regenerates.** If it did not, a corrected phrase would be
 *    read aloud in its old wording — the cache serving the wrong words under
 *    the right ones, which is the worst outcome available here.
 *  - **A failure leaves the cache serving.** No key, a refused cap, a provider
 *    outage: every phrase already cached must still be in the manifest
 *    afterwards. Otherwise one bad run takes the model voice away from
 *    languages it had nothing to do with.
 *  - **The cap is checked before the provider is called.** A cap enforced
 *    after the spend is not a cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CharacterReservation } from "../counters.js";
import type { Synthesis } from "../services/elevenLabs.js";
import { cacheKey, fillLanguage, readManifest, MANIFEST_FILE, type LanguageInput } from "./cache.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let dir = "";
const ORIGINAL_DIR = process.env.MODEL_VOICE_CACHE_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sonare-voice-"));
  process.env.MODEL_VOICE_CACHE_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL_DIR === undefined) delete process.env.MODEL_VOICE_CACHE_DIR;
  else process.env.MODEL_VOICE_CACHE_DIR = ORIGINAL_DIR;
  vi.restoreAllMocks();
});

/** A provider that always succeeds, recording what it was asked for. */
function provider(overrides: { fail?: boolean } = {}) {
  const asked: { text: string; language: string }[] = [];
  const synthesise = vi.fn((request: { text: string; language: string; voiceId?: string; modelId?: string }) => {
    asked.push({ text: request.text, language: request.language });
    if (overrides.fail === true) return Promise.resolve(null);
    const characters = [...request.text];
    const result: Synthesis = {
      audio: Buffer.from(`mp3-of-${request.text}`),
      alignment: {
        characters,
        startSeconds: characters.map((_, i) => i * 0.1),
        endSeconds: characters.map((_, i) => (i + 1) * 0.1),
      },
      voiceId: request.voiceId ?? "voice",
      modelId: request.modelId ?? "model",
    };
    return Promise.resolve(result);
  });
  return { synthesise: synthesise as never, asked };
}

/** A reservation that always allows, recording the characters it was asked for. */
function allowAll() {
  const reserved: number[] = [];
  const reserve = vi.fn((_cap: number, characters: number): Promise<CharacterReservation> => {
    reserved.push(characters);
    return Promise.resolve({ allowed: true, characters });
  });
  return { reserve: reserve as never, reserved };
}

function refuseAll(reason: "at-cap" | "unavailable" = "at-cap") {
  const reserve = vi.fn(
    (): Promise<CharacterReservation> =>
      Promise.resolve(
        reason === "at-cap"
          ? { allowed: false, reason: "at-cap", characters: 0 }
          : { allowed: false, reason: "unavailable", characters: null },
      ),
  );
  return { reserve: reserve as never };
}

const FRENCH: LanguageInput = {
  language: "fr-FR",
  contentVersion: 1,
  phrases: [
    { id: 1, text: "Bonjour" },
    { id: 2, text: "Comment allez-vous ?" },
  ],
};

function audioFiles(language: string): string[] {
  const path = join(dir, language);
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((f) => f.endsWith(".mp3")).sort();
}

describe("the cache key", () => {
  it("changes with the content version, so a re-publish regenerates", () => {
    /**
     * Content is immutable per version, so the version is the natural cache
     * epoch. Without this, publishing a corrected phrase would leave the
     * previous recording in place — the cache saying the old words under the
     * new ones.
     */
    const base = { language: "fr-FR", phraseId: 1, text: "Bonjour", voiceId: "v", modelId: "m" };

    expect(cacheKey({ ...base, contentVersion: 1 })).not.toBe(cacheKey({ ...base, contentVersion: 2 }));
  });

  it("changes with the text, so an edited bundled phrase regenerates", () => {
    // The bundled sets have no version — they are epoch 0 forever — so
    // without the text in the key, editing src/activities/languages/*.ts
    // would serve the previous phrase's audio indefinitely.
    const base = { contentVersion: 0, language: "fr-FR", phraseId: 1, voiceId: "v", modelId: "m" };

    expect(cacheKey({ ...base, text: "Bonjour" })).not.toBe(cacheKey({ ...base, text: "Bonsoir" }));
  });

  it("changes with the voice and with the model", () => {
    // These are the two things that change what the audio *is*. Swapping the
    // French voice must not leave the old voice playing.
    const base = { contentVersion: 1, language: "fr-FR", phraseId: 1, text: "Bonjour" };

    expect(cacheKey({ ...base, voiceId: "a", modelId: "m" })).not.toBe(
      cacheKey({ ...base, voiceId: "b", modelId: "m" }),
    );
    expect(cacheKey({ ...base, voiceId: "a", modelId: "m" })).not.toBe(
      cacheKey({ ...base, voiceId: "a", modelId: "n" })
    );
  });

  it("changes with the language, even for identical text", () => {
    // "No" is a word in several of these languages and is not the same
    // recording in any two of them.
    const base = { contentVersion: 1, phraseId: 1, text: "No", voiceId: "v", modelId: "m" };

    expect(cacheKey({ ...base, language: "es-ES" })).not.toBe(cacheKey({ ...base, language: "de-DE" }));
  });

  it("cannot be collided by shifting a digit between fields", () => {
    /**
     * A bare concatenation of the parts lets phrase 12 of version 3 and
     * phrase 1 of version 23 produce one string. A cache that confuses two
     * phrases serves the wrong audio under the right words, and no type or
     * test would notice.
     */
    const rest = { language: "fr-FR", text: "x", voiceId: "v", modelId: "m" };

    expect(cacheKey({ ...rest, contentVersion: 3, phraseId: 12 })).not.toBe(
      cacheKey({ ...rest, contentVersion: 23, phraseId: 1 }),
    );
  });

  it("is stable, so an unchanged phrase is never regenerated", () => {
    const parts = { contentVersion: 1, language: "fr-FR", phraseId: 1, text: "Bonjour", voiceId: "v", modelId: "m" };

    expect(cacheKey(parts)).toBe(cacheKey(parts));
    expect(cacheKey(parts)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("filling a language", () => {
  it("generates every phrase and writes a manifest naming them", async () => {
    const p = provider();

    const summary = await fillLanguage(FRENCH, { synthesise: p.synthesise, reserve: allowAll().reserve });

    expect(summary.generated).toBe(2);
    expect(summary.failed).toBe(0);
    expect(audioFiles("fr-FR")).toHaveLength(2);

    const manifest = await readManifest("fr-FR");
    expect(manifest?.phrases.map((entry) => entry.text)).toEqual(["Bonjour", "Comment allez-vous ?"]);
  });

  it("records the alignment, without which the audio would play unmarked", async () => {
    // The alignment lives only in the manifest. Audio with no alignment is
    // audio that cannot drive the word highlight — the failure this feature
    // exists to remove, arrived at through the cache instead of the engine.
    const p = provider();

    await fillLanguage(FRENCH, { synthesise: p.synthesise, reserve: allowAll().reserve });
    const manifest = await readManifest("fr-FR");
    const entry = manifest?.phrases[0];

    expect(entry?.characters.join("")).toBe("Bonjour");
    expect(entry?.startSeconds).toHaveLength(7);
    expect(entry?.endSeconds).toHaveLength(7);
  });

  it("names each file after its key, so the bytes cannot change under the name", async () => {
    const p = provider();

    await fillLanguage(FRENCH, { synthesise: p.synthesise, reserve: allowAll().reserve });
    const manifest = await readManifest("fr-FR");

    for (const entry of manifest?.phrases ?? []) {
      expect(entry.audio).toMatch(/^[0-9a-f]{32}\.mp3$/);
      expect(existsSync(join(dir, "fr-FR", entry.audio))).toBe(true);
    }
  });

  it("spends nothing on a second run", async () => {
    /**
     * "Generate once" as a behaviour rather than a comment. Without this, the
     * script would be a bill every time somebody ran it, and running it after
     * every publish — the recommended workflow — would be the most expensive
     * thing in the product.
     */
    const first = provider();
    await fillLanguage(FRENCH, { synthesise: first.synthesise, reserve: allowAll().reserve });

    const second = provider();
    const reserve = allowAll();
    const summary = await fillLanguage(FRENCH, { synthesise: second.synthesise, reserve: reserve.reserve });

    expect(summary.reused).toBe(2);
    expect(summary.generated).toBe(0);
    expect(second.asked).toHaveLength(0);
    // Not even reserved: a phrase already on disk costs neither cap nor call.
    expect(reserve.reserved).toHaveLength(0);
  });

  it("regenerates when the content version moves", async () => {
    const first = provider();
    await fillLanguage(FRENCH, { synthesise: first.synthesise, reserve: allowAll().reserve });

    const second = provider();
    const summary = await fillLanguage(
      { ...FRENCH, contentVersion: 2 },
      { synthesise: second.synthesise, reserve: allowAll().reserve },
    );

    expect(summary.generated).toBe(2);
    expect(summary.reused).toBe(0);
  });

  it("regenerates when a phrase's text changes", async () => {
    const first = provider();
    await fillLanguage(FRENCH, { synthesise: first.synthesise, reserve: allowAll().reserve });

    const second = provider();
    const summary = await fillLanguage(
      { ...FRENCH, phrases: [{ id: 1, text: "Bonsoir" }, { id: 2, text: "Comment allez-vous ?" }] },
      { synthesise: second.synthesise, reserve: allowAll().reserve },
    );

    expect(summary.generated).toBe(1);
    expect(summary.reused).toBe(1);
    expect(second.asked.map((a) => a.text)).toEqual(["Bonsoir"]);
  });

  it("regenerates audio whose alignment has been lost from the manifest", async () => {
    /**
     * The bytes alone are not "cached". Deleting the manifest but leaving the
     * mp3 is what a partially restored backup looks like, and treating that
     * as cached would serve audio no highlight could ride.
     */
    const first = provider();
    await fillLanguage(FRENCH, { synthesise: first.synthesise, reserve: allowAll().reserve });
    rmSync(join(dir, "fr-FR", MANIFEST_FILE));

    const second = provider();
    const summary = await fillLanguage(FRENCH, {
      synthesise: second.synthesise,
      reserve: allowAll().reserve,
    });

    expect(summary.generated).toBe(2);
    expect(summary.reused).toBe(0);
  });

  it("skips a phrase with no text rather than sending an empty request", async () => {
    const p = provider();

    const summary = await fillLanguage(
      { ...FRENCH, phrases: [{ id: 1, text: "   " }, { id: 2, text: "Bonjour" }] },
      { synthesise: p.synthesise, reserve: allowAll().reserve },
    );

    expect(summary.generated).toBe(1);
    expect(p.asked.map((a) => a.text)).toEqual(["Bonjour"]);
  });

  it("stores the trimmed text, so the client's exact-text lookup can match", async () => {
    const p = provider();

    await fillLanguage(
      { ...FRENCH, phrases: [{ id: 1, text: "  Bonjour  " }] },
      { synthesise: p.synthesise, reserve: allowAll().reserve },
    );

    expect((await readManifest("fr-FR"))?.phrases[0]?.text).toBe("Bonjour");
  });
});

describe("the spend cap", () => {
  it("reserves before calling the provider", async () => {
    /**
     * A cap checked after the spend is not a cap. This asserts the ordering
     * directly: with every reservation refused, the provider is never reached.
     */
    const p = provider();

    const summary = await fillLanguage(FRENCH, {
      synthesise: p.synthesise,
      reserve: refuseAll().reserve,
    });

    expect(summary.cappedOut).toBe(2);
    expect(summary.generated).toBe(0);
    expect(p.asked).toHaveLength(0);
  });

  it("reserves the phrase's own character count", async () => {
    // Characters, because that is how the provider bills. A call count would
    // be the wrong unit by an order of magnitude across these two phrases.
    const reserve = allowAll();

    await fillLanguage(FRENCH, { synthesise: provider().synthesise, reserve: reserve.reserve });

    expect(reserve.reserved).toEqual(["Bonjour".length, "Comment allez-vous ?".length]);
  });

  it("refuses just as firmly when the counter is unreachable", async () => {
    // Fails closed. A ceiling that disappears when the database is down is
    // not a ceiling — and nobody is waiting on this run.
    const p = provider();

    const summary = await fillLanguage(FRENCH, {
      synthesise: p.synthesise,
      reserve: refuseAll("unavailable").reserve,
    });

    expect(summary.cappedOut).toBe(2);
    expect(p.asked).toHaveLength(0);
  });

  it("leaves the phrases it did generate cached when the cap stops it halfway", async () => {
    /**
     * A cap that emptied the cache when it bit would make a partial run worse
     * than no run: the phrases already generated would stop being served.
     */
    let calls = 0;
    const reserve = vi.fn((_cap: number, characters: number): Promise<CharacterReservation> => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? { allowed: true, characters } : { allowed: false, reason: "at-cap", characters: 0 },
      );
    });

    const summary = await fillLanguage(FRENCH, {
      synthesise: provider().synthesise,
      reserve: reserve as never,
    });

    expect(summary.generated).toBe(1);
    expect(summary.cappedOut).toBe(1);
    expect((await readManifest("fr-FR"))?.phrases).toHaveLength(1);
  });
});

describe("a run that fails", () => {
  it("writes an empty manifest rather than throwing, when the provider gives nothing", async () => {
    /**
     * No key, a 401, a timeout: the provider returns null and this must not
     * throw. A throw from the first phrase of a forty-phrase run abandons the
     * thirty-nine after it, and every one of them would have been fine.
     */
    const p = provider({ fail: true });

    const summary = await fillLanguage(FRENCH, {
      synthesise: p.synthesise,
      reserve: allowAll().reserve,
    });

    expect(summary.failed).toBe(2);
    expect(summary.generated).toBe(0);
    expect((await readManifest("fr-FR"))?.phrases).toEqual([]);
  });

  it("keeps every already-cached phrase serving", async () => {
    /**
     * The property that makes this safe to re-run at any time, including
     * during a provider outage or with the key temporarily unset: a failing
     * run costs nothing that was already working.
     */
    await fillLanguage(FRENCH, { synthesise: provider().synthesise, reserve: allowAll().reserve });

    const summary = await fillLanguage(FRENCH, {
      synthesise: provider({ fail: true }).synthesise,
      reserve: allowAll().reserve,
    });

    expect(summary.reused).toBe(2);
    expect((await readManifest("fr-FR"))?.phrases).toHaveLength(2);
    expect(audioFiles("fr-FR")).toHaveLength(2);
  });
});

describe("pruning", () => {
  it("removes audio the new manifest no longer names", async () => {
    // Keying on the content version means a re-publish orphans the previous
    // version's files. Without pruning the directory grows by a full corpus
    // per publish, forever.
    await fillLanguage(FRENCH, { synthesise: provider().synthesise, reserve: allowAll().reserve });
    expect(audioFiles("fr-FR")).toHaveLength(2);

    await fillLanguage(
      { ...FRENCH, contentVersion: 2 },
      { synthesise: provider().synthesise, reserve: allowAll().reserve },
    );

    expect(audioFiles("fr-FR")).toHaveLength(2);
  });

  it("can be turned off, for a cache somebody wants to keep every version of", async () => {
    await fillLanguage(FRENCH, { synthesise: provider().synthesise, reserve: allowAll().reserve });

    await fillLanguage(
      { ...FRENCH, contentVersion: 2 },
      { synthesise: provider().synthesise, reserve: allowAll().reserve, prune: false },
    );

    expect(audioFiles("fr-FR")).toHaveLength(4);
  });

  it("only ever deletes a file whose name is a cache key", async () => {
    /**
     * What makes pruning safe to run by default. `MODEL_VOICE_CACHE_DIR`
     * pointed somewhere unfortunate must not be able to lose anybody's files,
     * so only a name this cache could have written is ever a candidate.
     */
    await fillLanguage(FRENCH, { synthesise: provider().synthesise, reserve: allowAll().reserve });
    writeFileSync(join(dir, "fr-FR", "important-notes.txt"), "not ours");
    writeFileSync(join(dir, "fr-FR", "song.mp3"), "also not ours");

    await fillLanguage(
      { ...FRENCH, contentVersion: 3 },
      { synthesise: provider().synthesise, reserve: allowAll().reserve },
    );

    expect(existsSync(join(dir, "fr-FR", "important-notes.txt"))).toBe(true);
    expect(existsSync(join(dir, "fr-FR", "song.mp3"))).toBe(true);
  });

  it("does not prune a phrase the cap refused, since there is nothing new to replace it", async () => {
    await fillLanguage(FRENCH, { synthesise: provider().synthesise, reserve: allowAll().reserve });

    const summary = await fillLanguage(FRENCH, {
      synthesise: provider().synthesise,
      reserve: refuseAll().reserve,
    });

    // Already cached, so the cap was never consulted and the files stand.
    expect(summary.reused).toBe(2);
    expect(summary.pruned).toBe(0);
    expect(audioFiles("fr-FR")).toHaveLength(2);
  });
});

describe("reading a manifest", () => {
  it("is null before anything has been generated", async () => {
    // The ordinary state before the first run, and not an error: the client
    // 404s and uses the platform voice.
    expect(await readManifest("de-DE")).toBeNull();
  });

  it("is null rather than a throw when the file is not JSON", async () => {
    const p = provider();
    await fillLanguage(FRENCH, { synthesise: p.synthesise, reserve: allowAll().reserve });
    writeFileSync(join(dir, "fr-FR", MANIFEST_FILE), "{ truncated");

    expect(await readManifest("fr-FR")).toBeNull();
  });

  it("drops an entry whose audio name is not a cache key", async () => {
    // A hand-edited manifest becomes a URL the client fetches. "Whatever the
    // file said" is not a path to interpolate into one.
    await fillLanguage(FRENCH, { synthesise: provider().synthesise, reserve: allowAll().reserve });
    const path = join(dir, "fr-FR", MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { phrases: { audio: string }[] };
    const first = manifest.phrases[0];
    if (first !== undefined) first.audio = "../../../etc/passwd";
    writeFileSync(path, JSON.stringify(manifest));

    expect((await readManifest("fr-FR"))?.phrases).toHaveLength(1);
  });

  it("writes the manifest atomically, leaving no partial file to serve", async () => {
    // Written to a temporary name and renamed into place, so a learner
    // fetching during a generation run never receives a truncated index.
    await fillLanguage(FRENCH, { synthesise: provider().synthesise, reserve: allowAll().reserve });

    expect(readdirSync(join(dir, "fr-FR")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
