/**
 * The model voice, generated once and kept as files on disk.
 *
 * ## Why a cache at all
 *
 * The corpus is small and fixed — 40 phrases, 1,534 characters across
 * fr/es/de/hi — and every learner hears the same forty. Synthesising on a
 * learner's request would pay a paid API, and a second of latency, for the
 * same bytes over and over; it would also put an outbound network call between
 * a learner and the model voice, which is exactly the dependency the offline
 * fallback exists to avoid.
 *
 * So generation happens ahead of time (`npm run generate-model-voice`, or a
 * publish) and serving is a static file read. Nothing on a request path calls
 * ElevenLabs.
 *
 * ## The key
 *
 * `sha256(contentVersion, language, phraseId, text, voiceId, modelId)`.
 *
 * Content is already immutable and versioned — `{slug}:{version}` in
 * server/store/content.ts — so a *published version* is the natural cache
 * epoch: a re-publish changes the version, changes every key in that language,
 * and regenerates. Nothing else does. The text is in the key as well, which
 * costs nothing and covers the bundled sets, whose "version" is 0 and never
 * moves: a phrase edited in `src/activities/languages/*.ts` cannot serve the
 * previous phrase's audio.
 *
 * Voice and model are in the key because they are the two things that change
 * what the audio *is*. Swapping the French voice must not leave the old voice
 * playing under the new configuration.
 *
 * The cost of keying on the version is stated plainly: re-publishing one
 * corrected phrase regenerates all ten in that language. At ~380 characters
 * per language that is the cheapest thing in this feature, and the alternative
 * — reusing audio across versions — is how a cache serves the wrong phrase.
 *
 * ## Where it lives, and why not `data/`
 *
 * `./voice-cache` by default, overridable with `MODEL_VOICE_CACHE_DIR`.
 *
 * Not `data/` under any circumstances: `.gitignore` carries an unanchored
 * `data/` (for the fallback log's real learner records) which once swallowed
 * nine committed source modules, and verify.mjs T14 now fails the build on a
 * git-ignored source file. Not `public/` either — that directory is copied
 * verbatim into the bundle and is held to a 205 KiB ceiling by
 * scripts/perf-budgets.test.ts, which a megabyte of mp3 would break. So: its
 * own directory, outside both, served by server/routes/modelVoice.ts.
 *
 * Nothing here holds learner data. It is our own reference text and audio of
 * our own reference text, so the directory is safe to commit if the owner
 * wants the assets to travel with the repository.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { logger } from "../logger.js";
import { numberFromEnv } from "../env.js";
import { reserveSynthesisCharacters } from "../counters.js";
import {
  AUDIO_EXTENSION,
  modelId as configuredModel,
  synthesise as realSynthesise,
  voiceIdFor,
} from "../services/elevenLabs.js";

/** Where the audio lives when `MODEL_VOICE_CACHE_DIR` is unset. */
export const DEFAULT_CACHE_DIR = "voice-cache";

/**
 * The cache directory, absolute.
 *
 * Read per call rather than captured at import so a test can point it at a
 * temporary directory without reloading the module graph.
 */
export function cacheDir(): string {
  const raw = process.env.MODEL_VOICE_CACHE_DIR?.trim();
  const dir = raw === undefined || raw === "" ? DEFAULT_CACHE_DIR : raw;
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
}

/**
 * A day's synthesis allowance, in characters.
 *
 * `numberFromEnv` rather than `Number(...)`: this is the number that bounds
 * spend on a paid API, and `characters > NaN` is false — a typo would remove
 * the ceiling rather than raise it, which is precisely the failure env.ts
 * exists to prevent.
 *
 * 20,000 is roughly thirteen full regenerations of the entire four-language
 * corpus per day. Generous for the work that is actually done (a publish
 * regenerates ~380 characters) and small enough that a loop cannot run up a
 * bill overnight.
 */
export const MAX_DAILY_VOICE_CHARACTERS = numberFromEnv("MAX_DAILY_VOICE_CHARACTERS", 20_000, {
  integer: true,
  min: 0,
});

/** Every part that changes what the audio is. Order is fixed — it is a hash input. */
export interface CacheKeyParts {
  contentVersion: number;
  language: string;
  phraseId: number;
  text: string;
  voiceId: string;
  modelId: string;
}

/**
 * The cache key: 32 hex characters of sha256 over the parts, newline-joined.
 *
 * Newline-joined behind a scheme tag rather than concatenated. A bare
 * concatenation lets two different tuples produce one string — phrase 12 of
 * version 3 and phrase 1 of version 23 both give "31 2" — and a cache that
 * confuses two phrases serves the wrong audio under the right words. The tag
 * means a future change to what goes into the key invalidates the old keys
 * rather than colliding with them.
 */
export function cacheKey(parts: CacheKeyParts): string {
  const input = [
    "sonare-model-voice-v1",
    String(parts.contentVersion),
    parts.language,
    String(parts.phraseId),
    parts.text,
    parts.voiceId,
    parts.modelId,
  ].join("\n");
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

/** Cache keys are the only file names this cache ever writes or deletes. */
const AUDIO_FILE = new RegExp(`^[0-9a-f]{32}\\.${AUDIO_EXTENSION}$`);

/** One cached phrase, as the manifest records it. */
export interface ManifestPhrase {
  phraseId: number;
  /** The reference text these bytes say, so the client can match on it. */
  text: string;
  /** File name within the language directory. Content-addressed, so immutable. */
  audio: string;
  /**
   * Per-character alignment, uncollapsed. Word numbering is the client's to
   * decide (`phraseTokens`), so collapsing here would put two definitions of
   * "word 3" in the product — see src/modelVoice/manifest.ts.
   */
  characters: string[];
  startSeconds: number[];
  endSeconds: number[];
}

/**
 * What a language directory holds, and the only thing the client reads.
 *
 * `voiceId` and `modelId` are recorded rather than merely used: "which voice
 * is this?" is the first question anybody asks of a model recording, and the
 * answer being derivable from the key is not the same as it being readable.
 */
export interface Manifest {
  language: string;
  contentVersion: number;
  voiceId: string;
  modelId: string;
  generatedAt: string;
  phrases: ManifestPhrase[];
}

export const MANIFEST_FILE = "manifest.json";

/** One phrase to generate. Deliberately not `Activity` — the server does not import from src/. */
export interface PhraseInput {
  id: number;
  text: string;
}

export interface LanguageInput {
  /** BCP-47, e.g. "hi-IN". Also the directory name and the URL segment. */
  language: string;
  /** The published version, or 0 for the set bundled with the app. */
  contentVersion: number;
  phrases: PhraseInput[];
}

export interface FillOptions {
  /** Injected in tests. Defaults to the real provider; tests must never reach it. */
  synthesise?: typeof realSynthesise;
  /** Injected in tests, so the cap can be driven without a database. */
  reserve?: typeof reserveSynthesisCharacters;
  /** Characters allowed today. Defaults to MAX_DAILY_VOICE_CHARACTERS. */
  dailyCharacterCap?: number;
  /** Remove audio no longer referenced by the manifest. Default true. */
  prune?: boolean;
}

export interface FillSummary {
  language: string;
  /** Already on disk with a manifest entry — no call, no spend. */
  reused: number;
  generated: number;
  /** Refused by the daily character cap. */
  cappedOut: number;
  /** The provider returned nothing: no key, a refusal, a timeout, a bad body. */
  failed: number;
  /** Stale audio removed. */
  pruned: number;
}

function languageDir(language: string): string {
  return join(cacheDir(), language);
}

/**
 * Writes through a temporary name and renames into place.
 *
 * `rename` within a directory is atomic on every filesystem this runs on, so a
 * reader — including the static route serving a learner right now — never sees
 * a half-written mp3 or a truncated manifest. Writing in place would make a
 * partially flushed file briefly servable, and a truncated mp3 is a playback
 * error the client would answer by falling back, permanently, to the platform
 * voice for that phrase.
 */
async function writeAtomically(path: string, bytes: Buffer | string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

/** The manifest already in a language directory, or null when there is none to trust. */
export async function readManifest(language: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(languageDir(language), MANIFEST_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const manifest = parsed as Partial<Manifest>;
    if (!Array.isArray(manifest.phrases)) return null;
    return {
      language: typeof manifest.language === "string" ? manifest.language : language,
      contentVersion: typeof manifest.contentVersion === "number" ? manifest.contentVersion : 0,
      voiceId: typeof manifest.voiceId === "string" ? manifest.voiceId : "",
      modelId: typeof manifest.modelId === "string" ? manifest.modelId : "",
      generatedAt: typeof manifest.generatedAt === "string" ? manifest.generatedAt : "",
      phrases: manifest.phrases.filter((p): p is ManifestPhrase => isManifestPhrase(p)),
    };
  } catch {
    // No directory, no manifest, or unreadable JSON. All three mean "nothing
    // is cached yet", which is the ordinary state before the first run.
    return null;
  }
}

function isManifestPhrase(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const p = raw as Partial<ManifestPhrase>;
  return (
    typeof p.phraseId === "number" &&
    typeof p.text === "string" &&
    typeof p.audio === "string" &&
    AUDIO_FILE.test(p.audio) &&
    Array.isArray(p.characters) &&
    Array.isArray(p.startSeconds) &&
    Array.isArray(p.endSeconds)
  );
}

/**
 * Fills the cache for one language, generating only what is missing.
 *
 * The order of the three gates matters and each one saves the next its cost:
 * a phrase already on disk is never reserved against the cap or sent to the
 * provider; a phrase the cap refuses is never sent to the provider.
 *
 * **A failure never empties the cache.** The manifest is rebuilt from what
 * exists — reused entries plus newly generated ones — so a run with no API
 * key, or one that the cap stops halfway, leaves every phrase that was already
 * cached exactly where it was and serving. That is what makes this safe to
 * re-run.
 */
export async function fillLanguage(
  input: LanguageInput,
  options: FillOptions = {},
): Promise<FillSummary> {
  const synthesise = options.synthesise ?? realSynthesise;
  const reserve = options.reserve ?? reserveSynthesisCharacters;
  const cap = options.dailyCharacterCap ?? MAX_DAILY_VOICE_CHARACTERS;
  const prune = options.prune ?? true;

  const voiceId = voiceIdFor(input.language);
  const model = configuredModel();
  const dir = languageDir(input.language);
  await mkdir(dir, { recursive: true });

  const existing = await readManifest(input.language);
  const existingByAudio = new Map((existing?.phrases ?? []).map((p) => [p.audio, p]));
  const onDisk = new Set(await audioFilesIn(dir));

  const summary: FillSummary = {
    language: input.language,
    reused: 0,
    generated: 0,
    cappedOut: 0,
    failed: 0,
    pruned: 0,
  };
  const phrases: ManifestPhrase[] = [];

  for (const phrase of input.phrases) {
    const text = phrase.text.trim();
    if (text === "") continue;

    const key = cacheKey({
      contentVersion: input.contentVersion,
      language: input.language,
      phraseId: phrase.id,
      text,
      voiceId,
      modelId: model,
    });
    const audio = `${key}.${AUDIO_EXTENSION}`;

    /**
     * Cached means *both* halves are present. The bytes alone are not enough:
     * the alignment lives only in the manifest, and audio with no alignment
     * would play with no word highlight — which is the failure this feature
     * exists to remove, arrived at through the cache instead of the engine.
     */
    const cached = existingByAudio.get(audio);
    if (cached !== undefined && onDisk.has(audio)) {
      phrases.push({ ...cached, phraseId: phrase.id, text });
      summary.reused += 1;
      continue;
    }

    const reservation = await reserve(cap, text.length);
    if (!reservation.allowed) {
      summary.cappedOut += 1;
      logger.warn(
        { language: input.language, phraseId: phrase.id, characters: text.length, reason: reservation.reason },
        "[modelVoice] daily synthesis allowance refused this phrase — it keeps the platform voice",
      );
      continue;
    }

    const result = await synthesise({ text, language: input.language, voiceId, modelId: model });
    if (result === null) {
      // Already logged, once, by the provider. Nothing is thrown: a phrase
      // without served audio simply keeps the platform voice.
      summary.failed += 1;
      continue;
    }

    await writeAtomically(join(dir, audio), result.audio);
    phrases.push({
      phraseId: phrase.id,
      text,
      audio,
      characters: result.alignment.characters,
      startSeconds: result.alignment.startSeconds,
      endSeconds: result.alignment.endSeconds,
    });
    onDisk.add(audio);
    summary.generated += 1;
  }

  const manifest: Manifest = {
    language: input.language,
    contentVersion: input.contentVersion,
    voiceId,
    modelId: model,
    generatedAt: new Date().toISOString(),
    phrases,
  };
  await writeAtomically(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

  if (prune) {
    const referenced = new Set(phrases.map((p) => p.audio));
    for (const file of onDisk) {
      if (referenced.has(file)) continue;
      try {
        await unlink(join(dir, file));
        summary.pruned += 1;
      } catch (err) {
        // Leaving a stale file costs disk, not correctness — nothing references
        // it any more. Worth a line, never worth failing the run.
        logger.warn({ file, err: String(err) }, "[modelVoice] could not remove stale audio");
      }
    }
  }

  return summary;
}

/**
 * Audio files in a language directory, by cache-key name only.
 *
 * The pattern is what makes pruning safe to run by default: only a name this
 * cache could have written is ever a deletion candidate, so a
 * `MODEL_VOICE_CACHE_DIR` pointed somewhere unfortunate cannot lose anybody's
 * files.
 */
async function audioFilesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => AUDIO_FILE.test(name));
  } catch {
    return [];
  }
}

/** Every language, in the order given. Sequential — see the note in the script. */
export async function fillCache(
  inputs: LanguageInput[],
  options: FillOptions = {},
): Promise<FillSummary[]> {
  const summaries: FillSummary[] = [];
  for (const input of inputs) {
    summaries.push(await fillLanguage(input, options));
  }
  return summaries;
}
