/**
 * The review page for the model voice keeps working after a voice run.
 *
 * `voice-check.html` is the only detector there is for a clip that says the
 * wrong thing: the provider returns 200 with valid character timings for audio
 * that mispronounces a word, and a learner then copies the error *and* is
 * marked down for matching it. D3 — one fluent reviewer per language — is the
 * gate the whole 0.4 release sits behind, and this page is what that reviewer
 * is handed.
 *
 * Every clip is named by its cache key, so anything that changes the key
 * renames the whole corpus and every player on the page goes dead. That
 * happened on 23 September 2026: the key dropped the content version, all
 * fifty clips regenerated, and the page was left pointing at fifty files that
 * no longer existed. Regenerating it was a documented follow-up step in
 * `scripts/voice-check.mjs`'s own header. The instruction was right there and
 * nothing performed it, which is the difference this file is about.
 *
 * ## Why two assertions rather than one
 *
 * The property worth having is "the page matches the cache", and it can only
 * be checked where both exist — they are git-ignored, so a clone and CI have
 * neither. That check therefore runs on the machine that just generated, which
 * is exactly where a stale page is about to be handed to somebody, and stands
 * down elsewhere rather than inventing a verdict.
 *
 * Standing down everywhere else would leave nothing at all in CI, so the
 * second assertion reads the generator and holds it to calling the page
 * builder. That is a weaker claim — a call is not an outcome — and it is
 * written as the backstop it is, not as a substitute for the first.
 *
 * ## Why this lives in scripts/
 *
 * It reads generated artefacts from disk. `src/` is typechecked without Node
 * types on purpose, so a test there cannot use `node:fs`.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);
const PAGE = new URL("voice-check.html", ROOT);
const CACHE = new URL("voice-cache/", ROOT);

/** Every audio file the page asks a reviewer's browser to play. */
function referencedClips(html: string): string[] {
  return [...html.matchAll(/src="(voice-cache\/[^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("the model-voice review page", () => {
  const built = existsSync(PAGE) && existsSync(CACHE);

  it.runIf(built)("plays every clip it lists", () => {
    /**
     * A dead player is not a quiet failure — a reviewer sees it at once — but
     * it costs the sitting, and sittings are the scarce thing here. Asserted
     * on the whole set rather than a count, so the message names the files.
     */
    const clips = referencedClips(readFileSync(PAGE, "utf8"));
    expect(clips.length).toBeGreaterThan(0);

    const missing = clips.filter((clip) => !existsSync(new URL(clip, ROOT)));
    expect(missing).toEqual([]);
  });

  it("is rebuilt by the generator, so it cannot be left behind", () => {
    /**
     * The backstop, and deliberately a source scan: this is the assertion that
     * survives into CI, where neither the page nor the cache exists.
     *
     * It is pinned to the *call* rather than to the import, because an import
     * that nothing invokes is the precise shape of bug this repository keeps
     * finding — a spend cap read and never enforced, a verifier rule claimed
     * and never written, an index helper called by nobody.
     */
    const generator = readFileSync(new URL("scripts/generate-model-voice.ts", ROOT), "utf8");

    expect(generator).toMatch(/voice-check\.mjs/);
    expect(generator).toMatch(/^\s*rebuildReviewPage\(\);\s*$/m);
  });
});
