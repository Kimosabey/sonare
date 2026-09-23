/**
 * Every phrase a learner is asked to say has the model recording of it.
 *
 * "Is the audio actually bound to the product" is not answered by the cache
 * being full. There are four separate ways a clip can exist on disk and still
 * never reach a learner, and three of them are silent — the app keeps working,
 * on the device's own synthetic voice, and nothing reports anything.
 *
 * ## The four joints, and which of them fail quietly
 *
 * 1. **The manifest names the phrase.** The client looks a recording up by the
 *    activity's `target` text, exactly (`src/modelVoice/manifest.ts`). An
 *    activity whose target was edited after the last generation run has a clip
 *    under the old words and no clip under the new ones. Silent.
 * 2. **The file is on disk under the name the manifest gives.** A pruned or
 *    half-written file leaves an entry pointing at nothing. This one is not
 *    silent — it is a 404 on the audio element — but it is only visible to
 *    somebody listening.
 * 3. **The name passes the client's own guard.** `readPhrase` refuses anything
 *    that is not 32 hex characters plus `.mp3`, because the name becomes a URL
 *    and a manifest is a document that can be wrong. A rejected entry is
 *    dropped with no error. Silent.
 * 4. **The alignment reproduces the phrase.** `wordStartSeconds` returns null
 *    unless the provider's characters join back to exactly the text on screen,
 *    because a normalised transcript means every offset is wrong by an unknown
 *    amount. The audio still plays; the word highlight simply never appears.
 *    The most silent of the four, and the one nobody would think to check.
 *
 * ## Why it stands down when the cache is absent
 *
 * `voice-cache/` is git-ignored — it is 2 MB of generated audio and a clone
 * has none of it. So this runs where the cache exists, which is the machine
 * that generated it and the machine about to serve a reviewer, and asserts
 * nothing elsewhere rather than inventing a verdict. The separate structural
 * assertion below always runs.
 *
 * ## Why this lives in scripts/
 *
 * It reads the cache directory with `node:fs`. `src/` is typechecked without
 * Node types on purpose, so a test there cannot.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../src/activities/languages/index.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CACHE = join(ROOT, "voice-cache");

/** The client's own filename guard, copied from src/modelVoice/manifest.ts. */
const AUDIO_NAME = /^[0-9a-f]{32}\.mp3$/;

/** An mp3 smaller than this is not a spoken phrase, whatever the manifest says. */
const PLAUSIBLE_BYTES = 2000;

interface ManifestPhrase {
  phraseId: number;
  text: string;
  audio: string;
  characters: string[];
  startSeconds: number[];
  endSeconds: number[];
}

function manifestFor(locale: string): { language: string; phrases: ManifestPhrase[] } | null {
  const path = join(CACHE, locale, "manifest.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as { language: string; phrases: ManifestPhrase[] };
}

describe("the model voice is bound to the phrases", () => {
  const generated = existsSync(CACHE);

  it("has languages to check", () => {
    // The guard on the guard: an empty LANGUAGES would make every loop below
    // pass by iterating nothing.
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(5);
  });

  it.runIf(generated)("has a recording for every phrase, in every language", () => {
    const missing: string[] = [];

    for (const set of LANGUAGES) {
      const manifest = manifestFor(set.code);
      if (manifest === null) {
        missing.push(`${set.slug}: no manifest at all`);
        continue;
      }
      /**
       * The client refuses a manifest whose `language` is not the one it asked
       * for, wholesale — handing French audio to a Hindi phrase is the single
       * most damaging thing this feature could do. A mismatch here would drop
       * every clip for the language while every file sat on disk.
       */
      if (manifest.language !== set.code) {
        missing.push(`${set.slug}: manifest says ${manifest.language}, the client asks for ${set.code}`);
        continue;
      }

      const byText = new Map(manifest.phrases.map((p) => [p.text, p]));
      for (const activity of set.activities) {
        const want = activity.target.trim();
        const phrase = byText.get(want);
        if (phrase === undefined) {
          missing.push(`${set.slug} #${String(activity.id)}: nothing recorded for ${JSON.stringify(want)}`);
          continue;
        }
        if (!AUDIO_NAME.test(phrase.audio)) {
          missing.push(`${set.slug} #${String(activity.id)}: ${phrase.audio} fails the client's name guard`);
          continue;
        }
        const file = join(CACHE, set.code, phrase.audio);
        if (!existsSync(file)) {
          missing.push(`${set.slug} #${String(activity.id)}: manifest names ${phrase.audio}, which is not on disk`);
          continue;
        }
        if (statSync(file).size < PLAUSIBLE_BYTES) {
          missing.push(`${set.slug} #${String(activity.id)}: ${phrase.audio} is too small to be speech`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it.runIf(generated)("carries an alignment that reproduces the phrase, so the highlight appears", () => {
    /**
     * Separated from the check above because the failure is different in kind.
     * Everything above ends in silence from the device's own voice, which is a
     * quality loss. This one plays the right audio and marks no word, which
     * reads as the feature being broken — and `wordStartSeconds` returns null
     * for it deliberately, since a highlight one word out teaches exactly the
     * wrong sound-to-spelling mapping.
     */
    const broken: string[] = [];

    for (const set of LANGUAGES) {
      const manifest = manifestFor(set.code);
      if (manifest === null || manifest.language !== set.code) continue;
      const byText = new Map(manifest.phrases.map((p) => [p.text, p]));

      for (const activity of set.activities) {
        const phrase = byText.get(activity.target.trim());
        if (phrase === undefined) continue;

        const n = phrase.characters.length;
        if (n === 0 || phrase.startSeconds.length !== n || phrase.endSeconds.length !== n) {
          broken.push(`${set.slug} #${String(activity.id)}: alignment arrays disagree`);
          continue;
        }
        if (phrase.characters.join("") !== activity.target.trim()) {
          broken.push(`${set.slug} #${String(activity.id)}: alignment does not reproduce the phrase`);
        }
      }
    }

    expect(broken).toEqual([]);
  });
});
