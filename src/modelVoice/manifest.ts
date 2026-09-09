/**
 * What the client knows about the served model voice.
 *
 * The server generates a native-quality recording of each reference phrase and
 * serves it as a static file (server/modelVoice/cache.ts). This module is the
 * client's half: it validates the index of those files, and it turns the
 * per-character alignment that came with the audio into "which word is
 * sounding now".
 *
 * ## Why the word numbering happens *here*
 *
 * The provider returns a time per character. The screen draws words, numbered
 * by `phraseTokens`. Collapsing characters into words on the server would put
 * two definitions of "word 3" in the product — the server's and
 * `phraseTokens`' — and the symptom of them disagreeing is a highlight one
 * word off, which teaches the learner exactly the wrong sound-to-spelling
 * mapping. That is worse than no highlight at all, and it is invisible in
 * every test that does not compare the two.
 *
 * So the raw alignment travels to the client and the same function that draws
 * the words decides which one is which. `useModelSpeech.ts` already makes this
 * argument for `boundary` offsets; this is the same argument for a second
 * source of timings.
 *
 * ## Posture at the boundary
 *
 * Lenient in one direction only. Anything unreadable — a body that is not an
 * object, a manifest for a different language, an entry whose arrays do not
 * agree — yields *no served audio for that phrase*, and the caller falls back
 * to the platform voice it already had. Nothing here throws and nothing here
 * degrades into a guess: a wrong time is a wrong highlight, and there is no
 * such thing as approximately the right word.
 */

import type { PhraseToken } from "../hooks/useModelSpeech.js";

/** Where the server mounts the cache. See server/routes/modelVoice.ts. */
const BASE = "/api/v1/model-voice";

/** One phrase with served audio, as the client uses it. */
export interface ServedPhrase {
  /** The reference text these bytes say. The lookup key. */
  text: string;
  /** Absolute URL of the audio, ready for an `<audio>` element. */
  url: string;
  /** One entry per character of `text`, in order. */
  characters: string[];
  startSeconds: number[];
  endSeconds: number[];
}

/** Served phrases for one language, keyed on their exact reference text. */
export type ServedIndex = ReadonlyMap<string, ServedPhrase>;

/** Where to fetch the index of served audio for one locale. */
export function manifestUrl(language: string): string {
  return `${BASE}/${encodeURIComponent(language)}/manifest.json`;
}

function isNumberArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function readPhrase(raw: unknown, language: string): ServedPhrase | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;

  const text = p["text"];
  const audio = p["audio"];
  if (typeof text !== "string" || text.trim() === "") return null;
  if (typeof audio !== "string" || audio.trim() === "") return null;

  /**
   * The file name is checked against the shape the cache writes rather than
   * trusted. It becomes a URL this client fetches, and "whatever the server
   * said" is not a thing to interpolate into one — a manifest is a document,
   * and a document can be wrong in ways a path traversal notices.
   */
  if (!/^[0-9a-f]{32}\.mp3$/.test(audio)) return null;

  const characters = p["characters"];
  if (!Array.isArray(characters) || characters.length === 0) return null;
  if (!characters.every((c) => typeof c === "string")) return null;

  /**
   * Three arrays that index each other. A short one means the last words of
   * the phrase have no time; the highlight would stop mid-phrase, which reads
   * as the voice having stopped.
   */
  if (!isNumberArray(p["startSeconds"], characters.length)) return null;
  if (!isNumberArray(p["endSeconds"], characters.length)) return null;

  return {
    text,
    url: `${BASE}/${encodeURIComponent(language)}/${audio}`,
    characters: characters as string[],
    startSeconds: p["startSeconds"],
    endSeconds: p["endSeconds"],
  };
}

/**
 * The served phrases in a manifest body, or an empty index.
 *
 * Empty rather than null, because the caller has one answer for "nothing is
 * served" whatever produced it: use the platform voice. Distinguishing an
 * absent manifest from a broken one would give the caller a branch with no
 * behaviour behind it.
 *
 * A manifest naming a different language is refused wholesale. A misrouted or
 * mis-cached body must not hand French audio to a Hindi phrase — a
 * pronunciation model saying the phrase in the wrong language is the single
 * most damaging thing this feature could do.
 */
export function readManifest(raw: unknown, language: string): ServedIndex {
  const index = new Map<string, ServedPhrase>();
  if (typeof raw !== "object" || raw === null) return index;

  const body = raw as Record<string, unknown>;
  if (body["language"] !== language) return index;

  const phrases = body["phrases"];
  if (!Array.isArray(phrases)) return index;

  for (const entry of phrases) {
    const phrase = readPhrase(entry, language);
    // First entry wins. A duplicated text is a content bug the publish gate
    // already refuses; silently preferring the later one would make which
    // recording plays depend on array order.
    if (phrase !== null && !index.has(phrase.text)) index.set(phrase.text, phrase);
  }
  return index;
}

/**
 * When each word of the phrase starts, in seconds — or `null` when the
 * alignment cannot be trusted to say.
 *
 * `null` is a first-class answer, not an error: the audio is still played, the
 * phrase still renders, and no word is marked. That is the same graceful floor
 * `boundary` events have always had, reached for a different reason.
 *
 * Three ways it refuses, each a real failure that would otherwise be silent:
 *
 *  - **The characters do not reproduce the phrase.** If the provider
 *    normalised the text, character *n* of the alignment is no longer
 *    character *n* of what is on screen, so every offset is wrong by an
 *    unknown amount.
 *  - **A word has no start time.** Nothing to schedule.
 *  - **The times run backwards.** A highlight that jumps back a word looks
 *    like the voice repeating itself.
 */
export function wordStartSeconds(tokens: PhraseToken[], phrase: ServedPhrase): number[] | null {
  if (phrase.characters.join("") !== tokens.map((t) => t.text).join("")) return null;

  /**
   * The alignment is indexed by *entry*, the tokens by UTF-16 offset, and the
   * two are not the same counter.
   *
   * `phraseTokens` reports `start` as a string offset, which is what a
   * `boundary` event reports and what `String.prototype.slice` understands.
   * The provider returns one entry per character, and a character outside the
   * BMP is two UTF-16 units — so `startSeconds[token.start]` would drift by
   * one position per such character and silently mark the wrong word from
   * there on. Indexing straight into the array happens to be right for every
   * script this product ships and would be wrong the first time it is not,
   * which is the shape of bug that survives a whole release.
   */
  const entryAtOffset = new Map<number, number>();
  let offset = 0;
  phrase.characters.forEach((character, entry) => {
    entryAtOffset.set(offset, entry);
    offset += character.length;
  });

  const starts: number[] = [];
  for (const token of tokens) {
    if (token.index === null) continue;
    const entry = entryAtOffset.get(token.start);
    // A word beginning mid-character means the two counters disagree about
    // what a character is. There is no honest time to use.
    if (entry === undefined) return null;
    const at = phrase.startSeconds[entry];
    if (at === undefined) return null;
    const previous = starts[starts.length - 1];
    if (previous !== undefined && at < previous) return null;
    // A negative time would schedule in the past, which is the same as zero
    // but reads as a bug in every log that prints it.
    starts.push(Math.max(0, at));
  }
  return starts;
}
