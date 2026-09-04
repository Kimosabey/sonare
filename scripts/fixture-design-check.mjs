#!/usr/bin/env node
/**
 * Answers the question T19 is blocked on: words or phrases?
 *
 *   node --env-file=.env scripts/fixture-design-check.mjs
 *
 * PRD §8 specifies "40 target words". The README recorded, from two separate
 * earlier runs with different material, that single words separated by 0.5
 * while a French sentence set separated by 37.6 — which is suggestive but not
 * comparable: different material, different sessions, different methods.
 *
 * This measures both designs in one run, on the same vocabulary, with the same
 * method, so the numbers can actually be set beside each other. Set A is a
 * native French voice; Set B is an English voice reading the same French, which
 * is the accent proxy scripts/test-french-activity.ts already uses.
 *
 * Separation is PRD §8's own definition: p25(Set A) − p75(Set B). Positive
 * means the scorer distinguishes acceptable-but-accented speech from
 * fluent-but-wrong speech. Comparing means instead would let a few confident
 * outliers manufacture a gap the typical learner never sees.
 *
 * Costs 60 provider calls, about $0.03 at $1.00 per audio hour. It needs
 * macOS `say` and `afconvert` for the voices.
 */

import sdk from "microsoft-cognitiveservices-speech-sdk";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Drawn from the activity targets, so both designs test the same vocabulary. */
const WORDS = [
  "bonjour", "comment", "voudrais", "café", "croissant", "personnes", "réunion",
  "pharmacie", "proche", "froid", "beaucoup", "aujourd'hui", "commence", "heures",
  "combien", "chaussures", "marron", "addition", "service", "excellent",
];

/** The ten French activity targets verbatim. */
const PHRASES = [
  "Bonjour, comment allez-vous",
  "Je m'appelle Marie et j'habite à Paris",
  "Je voudrais un café et un croissant s'il vous plaît",
  "Il y a quarante-deux personnes à la réunion",
  "Où se trouve la pharmacie la plus proche",
  "Il fait très froid et il pleut beaucoup aujourd'hui",
  "Le film commence à neuf heures moins le quart",
  "Combien coûtent ces chaussures marron",
  "L'addition s'il vous plaît le service était excellent",
  "Bonne soirée à la prochaine et prenez soin de vous",
];

const VOICES = { A: "Thomas", B: "Alex" };
const LANGUAGE = "fr-FR";

function percentile(values, p) {
  if (!values.length) return null;
  const o = [...values].sort((a, b) => a - b);
  const pos = (o.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, o.length - 1);
  return o[lo] * (1 - (pos - lo)) + o[hi] * (pos - lo);
}

function synthesize(dir, text, voice, name) {
  const aiff = join(dir, `${name}.aiff`);
  const wav = join(dir, `${name}.wav`);
  execFileSync("say", ["-v", voice, "-o", aiff, text]);
  // 16 kHz mono PCM16 — R7, and what the endpoint accepts.
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  return wav;
}

async function score(wav, referenceText) {
  const speechConfig = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY,
    process.env.AZURE_SPEECH_REGION,
  );
  speechConfig.speechRecognitionLanguage = LANGUAGE;
  const pa = new sdk.PronunciationAssessmentConfig(
    referenceText,
    sdk.PronunciationAssessmentGradingSystem.HundredMark,
    sdk.PronunciationAssessmentGranularity.Phoneme,
    true,
  );
  const recognizer = new sdk.SpeechRecognizer(speechConfig, sdk.AudioConfig.fromWavFileInput(readFileSync(wav)));
  pa.applyTo(recognizer);
  try {
    const result = await new Promise((ok, no) => recognizer.recognizeOnceAsync(ok, no));
    const assessment = JSON.parse(result.json || "{}").NBest?.[0]?.PronunciationAssessment;
    // Absent scores are indeterminate, never zero — R8 applies to analysis too.
    return assessment?.AccuracyScore ?? null;
  } finally {
    recognizer.close();
  }
}

const dir = mkdtempSync(join(tmpdir(), "sonare-fixture-design-"));
try {
  const results = { word: { A: [], B: [] }, phrase: { A: [], B: [] } };
  let indeterminate = 0;

  for (const [design, items] of [["word", WORDS], ["phrase", PHRASES]]) {
    for (const [i, text] of items.entries()) {
      for (const [set, voice] of Object.entries(VOICES)) {
        const wav = synthesize(dir, text, voice, `${design}_${set}_${i}`);
        const accuracy = await score(wav, text);
        if (accuracy === null) indeterminate += 1;
        else results[design][set].push(accuracy);
        process.stderr.write(".");
      }
    }
  }
  process.stderr.write("\n\n");

  const row = (a, b, c, d, e, f, g) =>
    `  ${String(a).padEnd(9)}${String(b).padStart(4)}${String(c).padStart(4)}${String(d).padStart(8)}${String(e).padStart(8)}${String(f).padStart(8)}${String(g).padStart(12)}`;
  console.log(row("design", "set", "n", "p25", "median", "p75", "separation"));
  console.log("  " + "-".repeat(51));

  const separation = {};
  for (const design of ["word", "phrase"]) {
    const a = results[design].A;
    const b = results[design].B;
    separation[design] = percentile(a, 0.25) - percentile(b, 0.75);
    for (const set of ["A", "B"]) {
      const v = results[design][set];
      console.log(
        row(
          design, set, v.length,
          percentile(v, 0.25).toFixed(1),
          percentile(v, 0.5).toFixed(1),
          percentile(v, 0.75).toFixed(1),
          set === "B" ? separation[design].toFixed(1) : "",
        ),
      );
    }
  }

  console.log("");
  if (indeterminate) console.log(`  ${indeterminate} indeterminate, excluded rather than counted as zero`);
  const better = separation.phrase > separation.word ? "phrases" : "words";
  const margin = Math.abs(separation.phrase - separation.word).toFixed(1);
  console.log(`  ${better} separate better, by ${margin} points`);
  console.log("");
  console.log("  Caveat: Set B here is a TTS accent proxy, not a fluent speaker");
  console.log("  deliberately mispronouncing as PRD §8 specifies. It compares the two");
  console.log("  designs fairly; it does not predict absolute human scores.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
