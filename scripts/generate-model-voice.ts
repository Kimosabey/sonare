/**
 * Fills the model-voice cache: `npm run generate-model-voice`.
 *
 * One phrase in, one mp3 plus its character alignment out, keyed so that
 * re-running costs nothing and re-publishing regenerates. Run it once after a
 * publish and the served model voice is up to date; run it a second time and
 * it makes no API calls at all.
 *
 *     npm run generate-model-voice              # every bundled language
 *     npm run generate-model-voice -- --slug=hi # one of them
 *     npm run generate-model-voice -- --dry-run # what it would do, no spend
 *     npm run generate-model-voice -- --keep-stale
 *
 * ## Where the phrases come from
 *
 * The bundled sets in `src/activities/languages/`, resolved through the same
 * `LANGUAGES` list the app renders — so this cannot generate audio for a
 * phrase no screen shows, and cannot miss one that is shown.
 *
 * Content version 0, which is the bundle's epoch. Published content has real
 * versions (`{slug}:{version}` in server/store/content.ts) and a publish is
 * the natural time to regenerate; that path is a three-line addition to
 * `POST /content/:slug` and is deliberately not taken here, so that this
 * script needs no database and cannot be the reason a publish fails. See the
 * report accompanying this change.
 *
 * ## Sequential, on purpose
 *
 * Forty phrases could go out at once. They do not, for two reasons that both
 * matter more than the wall clock: the daily character cap is reserved per
 * phrase and a burst of concurrent reservations makes "how much did that
 * cost" unanswerable mid-run, and a rate-limited provider answering 429 to
 * thirty-nine of forty requests would burn the cap on work that produced
 * nothing. This takes about a minute for the whole corpus and is run by hand.
 *
 * ## What it never does
 *
 * It sends our reference text and nothing else. No learner audio, no learner
 * text, no attempt data — see the privacy note in server/services/elevenLabs.ts.
 */

import { LANGUAGES } from "../src/activities/languages/index.js";
import { fillCache, cacheDir, type LanguageInput, type FillSummary } from "../server/modelVoice/cache.js";
import { apiKey, declaredLanguageCount, modelId, voiceIdFor } from "../server/services/elevenLabs.js";

/** The bundle's epoch. Published sets carry real versions; see the header. */
const BUNDLED_CONTENT_VERSION = 0;

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit !== undefined) return hit.slice(prefix.length);
  return process.argv.includes(`--${name}`) ? "" : undefined;
}

function inputs(slug: string | undefined): LanguageInput[] {
  return LANGUAGES.filter((set) => slug === undefined || slug === "" || set.slug === slug).map((set) => ({
    language: set.code,
    contentVersion: BUNDLED_CONTENT_VERSION,
    phrases: set.activities.map((activity) => ({ id: activity.id, text: activity.target })),
  }));
}

function report(summaries: FillSummary[]): void {
  let generated = 0;
  let failed = 0;
  let cappedOut = 0;

  for (const s of summaries) {
    generated += s.generated;
    failed += s.failed;
    cappedOut += s.cappedOut;
    console.log(
      `  ${s.language}: ${s.generated} generated, ${s.reused} reused, ` +
        `${s.cappedOut} over the cap, ${s.failed} failed, ${s.pruned} stale removed`,
    );
  }

  console.log(`\ncache: ${cacheDir()}`);

  /**
   * A partial run is reported and is **not** an error exit.
   *
   * Every phrase without served audio keeps the platform voice, which is the
   * behaviour the app had before any of this — so a failed generation degrades
   * quality and nothing else. Exiting non-zero would make this script unsafe
   * to put in a deploy pipeline for a failure mode that costs no function.
   */
  if (failed > 0 || cappedOut > 0) {
    console.log(
      `\n${failed + cappedOut} phrase(s) have no served audio and will use the platform voice.`,
    );
  }
  if (generated === 0 && failed === 0 && cappedOut === 0) {
    console.log("\nnothing to do — every phrase is already cached.");
  }
}

async function main(): Promise<void> {
  const slug = flag("slug");
  const dryRun = flag("dry-run") !== undefined;
  const keepStale = flag("keep-stale") !== undefined;

  const sets = inputs(slug);
  if (sets.length === 0) {
    console.error(`no bundled language with slug ${JSON.stringify(slug)}`);
    process.exit(1);
  }

  const model = modelId();
  const characters = sets.reduce(
    (total, set) => total + set.phrases.reduce((n, p) => n + p.text.trim().length, 0),
    0,
  );

  console.log(`model: ${model} (declares ${declaredLanguageCount(model) ?? "?"} languages)`);
  for (const set of sets) console.log(`voice: ${set.language} -> ${voiceIdFor(set.language)}`);
  console.log(
    `${sets.length} language(s), ${sets.reduce((n, s) => n + s.phrases.length, 0)} phrase(s), ` +
      `${characters} characters if nothing is cached`,
  );

  if (dryRun) {
    console.log("\n--dry-run: no requests made, nothing written.");
    return;
  }

  /**
   * Said plainly rather than discovered from forty identical warnings. The
   * provider already refuses per phrase with no key; this is so somebody who
   * forgot the variable is told once, at the top, in the words of the thing
   * they need to set.
   */
  if (apiKey() === undefined) {
    console.error(
      "\nELEVENLABS_API_KEY is not set. Nothing will be generated, and the app keeps the platform voice.",
    );
  }

  console.log("");
  report(await fillCache(sets, { prune: !keepStale }));
}

await main();
