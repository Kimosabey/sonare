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
 * phrase no screen shows.
 *
 * It **can** miss one that is shown, and does: every phrase a published course
 * adds beyond the bundled set is uncached, because nothing has ever asked for
 * it to be generated.
 *
 * This paragraph used to say that extending the script to read `COURSES` could
 * not fix it — that clips made at version 0 for content served at version 2
 * would never be looked up. **That was wrong twice over.** The client indexes
 * served audio by the phrase's *text* and has never read a version at all (see
 * src/modelVoice/manifest.ts), so a version mismatch could not hide anything;
 * and since 23 September 2026 the cache key carries no version, so there is no
 * mismatch to have. Reading `COURSES` here would work.
 *
 * It deliberately does not, yet, and the reason is D3 rather than the cache:
 * course phrases have not been read by anybody who speaks the language, and
 * synthesising three hundred unreviewed lines is paying to record content we
 * expect to change.
 *
 * Nothing breaks in the meantime. `useModelSpeech` reports `available` as
 * `platformVoice || served.size > 0`, so an uncached phrase speaks through the
 * device's own voice — lower quality, and not the reference accent, but
 * present. Only a locale the device has no voice for at all leaves an activity
 * with no audio, and the screen refuses those rather than asking a question it
 * cannot play.
 *
 * The version is still passed, because the manifest records it — "which
 * content was this generated against" is a fair question — but it no longer
 * decides anything. A publish of unchanged words now re-uses every recording
 * instead of re-buying the language, which is what made "regenerate at publish
 * time" sound expensive when it is not.
 *
 * This script still needs no database and still cannot be the reason a publish
 * fails, which is why it stays a separate command run by hand.
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

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGUAGES } from "../src/activities/languages/index.js";
import { fillCache, cacheDir, type LanguageInput, type FillSummary } from "../server/modelVoice/cache.js";
import {
  apiKey,
  declaredLanguageCount,
  hasChosenVoice,
  modelId,
  voiceIdFor,
} from "../server/services/elevenLabs.js";

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

  /**
   * A language with no chosen voice is reported and dropped from the plan.
   *
   * `synthesise` refuses it anyway, so including it here would spend nothing —
   * but it would print a character total and a language count that a reader
   * would reasonably act on, and it hid a real mistake once: a dry run
   * cheerfully listed `hi-IN -> <the English placeholder>`, which reads as
   * "Hindi is covered" when the truth is the opposite. The plan should not
   * claim work the run will decline to do.
   */
  const speakable = sets.filter((set) => hasChosenVoice(set.language));
  const unvoiced = sets.filter((set) => !hasChosenVoice(set.language));

  const characters = speakable.reduce(
    (total, set) => total + set.phrases.reduce((n, p) => n + p.text.trim().length, 0),
    0,
  );

  console.log(`model: ${model} (declares ${declaredLanguageCount(model) ?? "?"} languages)`);
  for (const set of speakable) console.log(`voice: ${set.language} -> ${voiceIdFor(set.language)}`);
  for (const set of unvoiced) {
    console.log(
      `skip:  ${set.language} -> no voice chosen; it keeps the platform synthesiser ` +
        `(set ELEVENLABS_VOICE_IDS=${set.language}:<id> to include it)`,
    );
  }
  console.log(
    `${speakable.length} language(s), ${speakable.reduce((n, s) => n + s.phrases.length, 0)} phrase(s), ` +
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
  /**
   * `speakable`, not `sets`. `fillCache` resolves the voice per language and
   * passes it to `synthesise`, so handing it a language with no chosen voice
   * once produced ten Hindi phrases in the placeholder's English accent — the
   * plan said "skip: hi-IN" while the run generated it anyway, because only
   * the printing had been filtered.
   */
  report(await fillCache(speakable, { prune: !keepStale }));
  rebuildReviewPage();
}

/**
 * Rebuilds `voice-check.html`, because a run that does not is a run that
 * silently breaks the only review surface there is.
 *
 * The page names each clip by its cache key, so every generated file changes
 * its name and every player on the page goes dead. That is fine while it is a
 * documented follow-up step and somebody performs it; on 23 September 2026 the
 * key changed, the whole corpus regenerated, and the step was missed — leaving
 * fifty broken players on the page D3 is waiting for a fluent speaker to sit
 * down with. The instruction existed. Nothing performed it.
 *
 * A child process rather than an import: `voice-check.mjs` builds the page as
 * a side effect of being loaded, and `await import` for that effect reads as a
 * mistake to anybody who meets it later. `process.execPath` so it runs under
 * the same node this script is running under.
 *
 * Failure is reported and never fatal, exactly like a partial generation. The
 * audio is written and serving by this point; a page that failed to build
 * costs a review sitting, not a learner.
 */
function rebuildReviewPage(): void {
  const script = join(dirname(fileURLToPath(import.meta.url)), "voice-check.mjs");
  try {
    const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
    process.stdout.write(out);
  } catch (error) {
    console.error(
      `\ncould not rebuild voice-check.html (${String(error)}). ` +
        `The audio is generated; run "node scripts/voice-check.mjs" to get the review page.`,
    );
  }
}

await main();
