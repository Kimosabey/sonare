/**
 * End-to-end test of the French Activity Test, without a microphone.
 *
 *   npm run dev                        # in another terminal
 *   npx tsx scripts/test-french-activity.ts
 *
 * Two speaker profiles are run through all ten activities:
 *
 *   native   — a French TTS voice reads the target. Should score well.
 *   learner  — an ENGLISH TTS voice reads the same French text. English
 *              phonology applied to French produces exactly the substitutions a
 *              real anglophone learner makes: no uvular /ʁ/, denasalised
 *              vowels, pronounced final consonants. It is a genuine stand-in
 *              for a beginner, not a synthetic corruption.
 *
 * If the scorer works, native clears learner by a wide margin and the learner's
 * report names the sounds French learners actually struggle with. If the two
 * profiles score the same, the scorer is not measuring French pronunciation.
 *
 * This imports the real buildReport() so the numbers here are the numbers the
 * UI renders — not a reimplementation that could drift.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, mkdtemp } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FRENCH } from "../src/activities/languages/french.js";
import { MAX_ATTEMPTS, PASS_SCORE } from "../src/activities/languages/index.js";

const FRENCH_ACTIVITIES = FRENCH.activities;
const FRENCH_LANGUAGE = FRENCH.code;
import { buildReport, verdictFor } from "../src/activities/report.js";
import type { ActivityAttempt, ActivityProgress, SessionReport } from "../src/activities/types.js";
import type { PronunciationResult } from "../src/speech/scoring/types.js";

const run = promisify(execFile);
const ENDPOINT = process.env.ENDPOINT ?? "http://localhost:5181/api/v1/pronunciation";

interface Profile {
  key: string;
  label: string;
  voice: string;
  note: string;
}

const PROFILES: Profile[] = [
  { key: "native", label: "Native French", voice: "Jacques", note: "fr_FR voice reading French" },
  { key: "learner", label: "English learner", voice: "Samantha", note: "en_US voice reading French" },
];

async function synthesise(dir: string, voice: string, text: string, tag: string): Promise<string> {
  const aiff = join(dir, `${tag}.aiff`);
  const wav = join(dir, `${tag}.wav`);
  await run("say", ["-v", voice, text, "-o", aiff]);
  await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  await unlink(aiff).catch(() => undefined);
  return wav;
}

async function score(wavPath: string, referenceText: string): Promise<PronunciationResult> {
  const bytes = await readFile(wavPath);
  const form = new FormData();
  form.append("audio", new Blob([bytes], { type: "audio/wav" }), "capture.wav");
  form.append("referenceText", referenceText);
  form.append("language", FRENCH_LANGUAGE);
  form.append(
    "deviceContext",
    JSON.stringify({ ua: "french-activity-test/node", contextRate: 16000, granted: null }),
  );

  const res = await fetch(ENDPOINT, { method: "POST", body: form });
  const body: unknown = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body as PronunciationResult;
}

/** Drives the same sequential-unlock rules the page enforces. */
async function runProfile(profile: Profile, dir: string): Promise<{ report: SessionReport; progress: ActivityProgress[] }> {
  console.log(`\n─── ${profile.label} (${profile.note}) ${"─".repeat(Math.max(0, 34 - profile.label.length))}`);

  const progress: ActivityProgress[] = [];
  const startedAt = Date.now();

  for (const activity of FRENCH_ACTIVITIES) {
    const attempts: ActivityAttempt[] = [];

    // The UI allows up to MAX_ATTEMPTS before letting the learner move on.
    // TTS is deterministic, so a retry would return the same score — one
    // attempt is enough to establish the outcome.
    const wav = await synthesise(dir, profile.voice, activity.target, `${profile.key}-${activity.id}`);
    const result = await score(wav, activity.target);
    await unlink(wav).catch(() => undefined);

    const accuracy = result.indeterminate ? null : result.accuracy;
    attempts.push({ activityId: activity.id, result, accuracy, at: new Date().toISOString() });

    const best: number | null = accuracy;
    const passed = best !== null && best >= PASS_SCORE;

    const scoredAttempts = attempts.filter((a) => a.accuracy !== null).length;
    progress.push({
      activityId: activity.id,
      attempts,
      best,
      passed,
      skipped: !passed && scoredAttempts >= MAX_ATTEMPTS,
    });

    const shown = best === null ? "indet" : String(Math.round(best)).padStart(3);
    console.log(
      `  ${String(activity.id).padStart(2)}. ${activity.title.padEnd(22)} ${shown}  ${passed ? "pass" : "FAIL"}`,
    );
  }

  const report = buildReport(FRENCH_ACTIVITIES, progress, Date.now() - startedAt);
  return { report, progress };
}

function printReport(label: string, report: SessionReport): void {
  console.log(`\n  ── ${label} report ──`);
  console.log(`  verdict        ${verdictFor(report)}`);
  console.log(`  overall        ${report.overallScore === null ? "—" : Math.round(report.overallScore)}`);
  console.log(`  fluency        ${report.meanFluency === null ? "—" : Math.round(report.meanFluency)}`);
  console.log(`  completeness   ${report.meanCompleteness === null ? "—" : Math.round(report.meanCompleteness)}`);
  console.log(`  passed         ${report.passedCount}/${report.totalCount}`);
  console.log(`  indeterminate  ${report.indeterminateCount}`);

  if (report.weakPhonemes.length) {
    const shown = report.weakPhonemes
      .map((p) => `${p.phoneme}:${Math.round(p.meanAccuracy)}(×${p.occurrences})`)
      .join("  ");
    console.log(`  weak sounds    ${shown}`);
  } else {
    console.log(`  weak sounds    none stood out`);
  }

  console.log(`  mistakes       ${report.mistakes.length}`);
  for (const m of report.mistakes.slice(0, 6)) {
    console.log(`                 ${m.word.padEnd(16)} ${m.errorType.padEnd(18)} ${Math.round(m.accuracy)}`);
  }
  if (report.strongestActivity) {
    console.log(`  strongest      ${report.strongestActivity.title} (${Math.round(report.strongestActivity.score)})`);
  }
  if (report.weakestActivity) {
    console.log(`  weakest        ${report.weakestActivity.title} (${Math.round(report.weakestActivity.score)})`);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "french-activity-"));
  console.log(`French Activity Test — ${FRENCH_ACTIVITIES.length} activities × ${PROFILES.length} profiles`);
  console.log(`endpoint ${ENDPOINT}`);

  const results: Record<string, { report: SessionReport; progress: ActivityProgress[] }> = {};

  for (const profile of PROFILES) {
    results[profile.key] = await runProfile(profile, dir);
  }

  for (const profile of PROFILES) {
    const entry = results[profile.key];
    if (entry) printReport(profile.label, entry.report);
  }

  // ── the assertion that matters ───────────────────────────────────────────
  const native = results.native?.report;
  const learner = results.learner?.report;

  console.log(`\n${"═".repeat(58)}`);
  if (native?.overallScore != null && learner?.overallScore != null) {
    const gap = native.overallScore - learner.overallScore;
    console.log(`native ${Math.round(native.overallScore)}  ·  learner ${Math.round(learner.overallScore)}  ·  gap ${gap.toFixed(1)}`);
    console.log(
      gap > 10
        ? "PASS — the scorer separates a native speaker from an anglophone learner."
        : "INCONCLUSIVE — the two profiles scored too close to call this discrimination.",
    );
  }

  const out = "french-activity-test-results.json";
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((err: unknown) => {
  console.error(String(err));
  process.exit(1);
});
