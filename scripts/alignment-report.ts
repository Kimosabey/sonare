/**
 * Runs the word alignment over every attempt already on disk.
 *
 *   npm run alignment-report
 *
 * The alignment and its verdict comparison were built and tested against cases
 * chosen to exercise them. That proves the code does what it was written to
 * do; it does not prove the judgements are right about real speech. Real
 * transcripts are the only thing that can, and 139 of them already exist.
 *
 * Three questions this answers, in order of how much they matter:
 *
 *  1. **How often do the two verdicts disagree?** If never, the alignment is
 *     an expensive way to restate Azure and the honest thing is to say so.
 *  2. **Which direction?** Azure reporting omissions its own transcript
 *     contradicts is a different problem from the alignment over-reporting,
 *     and only one of them is ours to fix.
 *  3. **How often does the alignment find something Azure has no error type
 *     for?** Substitutions and repetitions are the whole justification for
 *     building it, so a zero here would be the finding.
 *
 * Reads only. Never writes, never calls a provider, never touches the audio.
 * Imports the real modules rather than reimplementing them, so the figures are
 * the ones the server would have recorded.
 */

import { readFileSync } from "node:fs";
import { alignSpoken } from "../server/alignment.js";
import { compareVerdicts } from "../server/verdicts.js";
import type { PronunciationResult } from "../server/services/types.js";

const TRAIL = "server/data/attempts.jsonl";

interface StoredAttempt {
  at?: string;
  language?: string;
  referenceText?: string;
  result?: PronunciationResult;
}

function readTrail(path: string): StoredAttempt[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(`No trail at ${path}. Nothing to analyse.`);
    process.exit(1);
  }
  const out: StoredAttempt[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as StoredAttempt);
    } catch {
      // A truncated final line from a process killed mid-append. Skipped, the
      // same way the fallback replay skips it.
    }
  }
  return out;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`;
}

const attempts = readTrail(TRAIL);

/** Only takes with both a reference and a transcript can be aligned. */
const alignable = attempts.filter(
  (a): a is StoredAttempt & { referenceText: string; result: PronunciationResult } =>
    typeof a.referenceText === "string" &&
    a.referenceText.trim().length > 0 &&
    a.result !== undefined,
);

const scored = alignable.filter((a) => a.result.indeterminate === false);
const indeterminate = alignable.length - scored.length;

let agree = 0;
let azureSaysClean = 0;
let weSayClean = 0;
let numericSkipped = 0;
let cannotExpress = 0;
let perfect = 0;
const byLanguage = new Map<string, { n: number; disagree: number; cannotExpress: number }>();
const interesting: string[] = [];

for (const attempt of scored) {
  const result = attempt.result;
  if (result.indeterminate) continue;

  const alignment = alignSpoken(attempt.referenceText, result.recognized);
  const verdict = compareVerdicts(result, alignment);

  const language = attempt.language ?? "?";
  const bucket = byLanguage.get(language) ?? { n: 0, disagree: 0, cannotExpress: 0 };
  bucket.n += 1;

  if (verdict.numericFormsDiffer) numericSkipped += 1;

  if (verdict.disagrees) {
    // Which side called the take clean is the actionable half: only one of
    // them is missing something.
    // Presence only, matching what `disagrees` compares.
    const providerFault = verdict.providerOmissions + verdict.providerInsertions > 0;
    if (providerFault) weSayClean += 1;
    else azureSaysClean += 1;
    bucket.disagree += 1;
  } else {
    agree += 1;
  }

  if (verdict.providerCannotExpress > 0) {
    cannotExpress += 1;
    bucket.cannotExpress += 1;
  }

  if (alignment.missing === 0 && alignment.substituted === 0 && alignment.extras.length === 0) {
    perfect += 1;
  }

  byLanguage.set(language, bucket);

  // The cases worth a human read: the two verdicts telling different stories,
  // or the alignment finding something Azure structurally cannot report.
  if (verdict.disagrees || verdict.providerCannotExpress > 0 || verdict.numericFormsDiffer) {
    const faults = [
      alignment.missing > 0 ? `${alignment.missing} missing` : null,
      alignment.substituted > 0 ? `${alignment.substituted} substituted` : null,
      alignment.repeated > 0 ? `${alignment.repeated} repeated` : null,
      alignment.extra > 0 ? `${alignment.extra} extra` : null,
      alignment.numericForms > 0 ? `${alignment.numericForms} number not compared` : null,
    ]
      .filter(Boolean)
      .join(", ");
    interesting.push(
      [
        `  ${(attempt.at ?? "?").slice(0, 19)}  ${language}`,
        `    asked : ${attempt.referenceText}`,
        `    heard : ${result.recognized || "(nothing)"}`,
        `    azure : ${verdict.providerOmissions} omission, ${verdict.providerInsertions} insertion, ${verdict.providerMispronunciations} mispronunciation`,
        `    ours  : ${faults || "nothing"}`,
        `    delta : ${verdict.omissionDelta > 0 ? "+" : ""}${verdict.omissionDelta} (positive = azure found more absent)`,
      ].join("\n"),
    );
  }
}

const disagree = azureSaysClean + weSayClean;

console.log(`\nWord alignment over ${TRAIL}\n${"=".repeat(52)}`);
console.log(`  attempts on disk        ${attempts.length}`);
console.log(`  alignable               ${alignable.length}`);
console.log(`  scored                  ${scored.length}`);
console.log(`  indeterminate (skipped) ${indeterminate}`);

console.log(`\nDo the two verdicts agree?`);
console.log(`  agree                   ${agree.toString().padStart(4)}  ${pct(agree, scored.length)}`);
console.log(`  disagree                ${disagree.toString().padStart(4)}  ${pct(disagree, scored.length)}`);
console.log(`    azure called it clean, we found a fault   ${azureSaysClean}`);
console.log(`    we called it clean, azure found a fault   ${weSayClean}`);
console.log(`  not compared (a number in digits)          ${numericSkipped}`);

console.log(`\nWhat only the alignment can say`);
console.log(
  `  takes with a substitution or repetition  ${cannotExpress.toString().padStart(4)}  ${pct(cannotExpress, scored.length)}`,
);
console.log(`  takes with nothing wrong at all          ${perfect.toString().padStart(4)}  ${pct(perfect, scored.length)}`);

if (byLanguage.size > 1) {
  console.log(`\nBy language`);
  console.log(`  ${"lang".padEnd(8)}${"n".padStart(5)}${"disagree".padStart(11)}${"only-ours".padStart(11)}`);
  for (const [language, b] of [...byLanguage.entries()].sort((a, z) => z[1].n - a[1].n)) {
    console.log(
      `  ${language.padEnd(8)}${String(b.n).padStart(5)}${String(b.disagree).padStart(11)}${String(b.cannotExpress).padStart(11)}`,
    );
  }
}

if (interesting.length > 0) {
  const shown = interesting.slice(0, 12);
  console.log(`\nWorth reading (${interesting.length} total, showing ${shown.length})`);
  console.log(shown.join("\n\n"));
}

console.log(
  `\nNote: these transcripts are Azure's own, so a disagreement is between two` +
    `\nparts of one response — not between us and the audio. Only a fixture run` +
    `\nwith a human confirming what was said can settle which is right.\n`,
);
