#!/usr/bin/env node
/**
 * T1 — smoke test the Azure Speech resource. No app code involved.
 *
 *   node --env-file=.env scripts/smoke-azure.mjs <wav> <referenceText> [language]
 *
 * Succeeds only if Azure returns phoneme-level detail. The four top-level scores
 * arriving is NOT sufficient — the whole POC rests on per-phoneme data existing,
 * so this asserts on it directly.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import sdk from "microsoft-cognitiveservices-speech-sdk";

const [wavPath, referenceText, language = "en-US"] = process.argv.slice(2);

// ── usage ────────────────────────────────────────────────────────────────────
if (!wavPath || !referenceText) {
  console.error(
    `usage: node --env-file=.env scripts/smoke-azure.mjs <wav> <referenceText> [language]\n` +
      `   eg: node --env-file=.env scripts/smoke-azure.mjs ./fixtures/sample.wav "Would you like something to drink" en-US`,
  );
  process.exit(2);
}

// ── environment ──────────────────────────────────────────────────────────────
// Read, never print. R2: a key must not reach a log line.
const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION;

if (!key || !region) {
  console.error(
    `Missing environment.\n` +
      `  AZURE_SPEECH_KEY   ${key ? "set" : "MISSING"}\n` +
      `  AZURE_SPEECH_REGION ${region ? region : "MISSING"}\n\n` +
      `Copy .env.example to .env and fill both, then run via 'npm run smoke'.`,
  );
  process.exit(2);
}

// TASKS.md T1 names this as the first thing to check when the call fails.
if (region !== region.trim().toLowerCase()) {
  console.error(
    `AZURE_SPEECH_REGION must be lowercase with no surrounding spaces.\n` +
      `  got: ${JSON.stringify(region)}  expected shape: "southeastasia"`,
  );
  process.exit(2);
}

// ── WAV validation ───────────────────────────────────────────────────────────
// ffprobe is not guaranteed to be installed, and "the WAV was not really 16 kHz
// mono PCM16" is the failure TASKS.md flags. Parse the header rather than assume.
function inspectWav(buf) {
  if (buf.length < 12) throw new Error("file is too short to be a WAV");
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("missing RIFF header");
  if (buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAVE file");

  let offset = 12;
  let fmt = null;
  let dataBytes = null;

  // Walk the chunk list — fmt is not always immediately followed by data.
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      // Some encoders write 0 or 0xFFFFFFFF for streamed data; fall back to the
      // real remaining length so duration stays truthful.
      const remaining = buf.length - body;
      dataBytes = size === 0 || size > remaining ? remaining : size;
    }

    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) throw new Error("no fmt chunk found");
  if (dataBytes == null) throw new Error("no data chunk found");

  const bytesPerFrame = (fmt.bitsPerSample / 8) * fmt.channels;
  return { ...fmt, dataBytes, seconds: dataBytes / (fmt.sampleRate * bytesPerFrame) };
}

const absWav = resolve(wavPath);
if (!existsSync(absWav)) {
  console.error(`No such file: ${absWav}\nGenerate one with: npm run fixture`);
  process.exit(2);
}

const wav = readFileSync(absWav);
let info;
try {
  info = inspectWav(wav);
} catch (e) {
  console.error(`Not a readable WAV (${absWav}): ${e.message}`);
  process.exit(2);
}

const FORMAT_PCM = 1;
const formatProblems = [];
if (info.audioFormat !== FORMAT_PCM) formatProblems.push(`encoding is not PCM (got format ${info.audioFormat})`);
if (info.sampleRate !== 16000) formatProblems.push(`sample rate is ${info.sampleRate} Hz, must be 16000`);
if (info.channels !== 1) formatProblems.push(`${info.channels} channels, must be mono`);
if (info.bitsPerSample !== 16) formatProblems.push(`${info.bitsPerSample}-bit, must be 16-bit`);

console.log(`file          ${absWav}`);
console.log(`format        ${info.sampleRate} Hz · ${info.channels}ch · ${info.bitsPerSample}-bit PCM`);
console.log(`duration      ${info.seconds.toFixed(2)} s`);
console.log(`reference     "${referenceText}"`);
console.log(`language      ${language}`);
console.log(`region        ${region}`);
console.log("");

if (formatProblems.length) {
  console.error(`Audio is not in the format Azure requires (R7):`);
  for (const p of formatProblems) console.error(`  · ${p}`);
  console.error(`\nConvert with:\n  afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out.wav`);
  process.exit(1);
}

// ── the call ─────────────────────────────────────────────────────────────────
const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
speechConfig.speechRecognitionLanguage = language;

const paConfig = new sdk.PronunciationAssessmentConfig(
  referenceText,
  sdk.PronunciationAssessmentGradingSystem.HundredMark,
  sdk.PronunciationAssessmentGranularity.Phoneme,
  true, // miscue detection — FR-13
);

const audioConfig = sdk.AudioConfig.fromWavFileInput(wav);
const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
paConfig.applyTo(recognizer);

const startedAt = process.hrtime.bigint();

const result = await new Promise((res, rej) => {
  recognizer.recognizeOnceAsync(
    (r) => {
      recognizer.close();
      res(r);
    },
    (err) => {
      recognizer.close();
      rej(err);
    },
  );
}).catch((err) => {
  console.error(`Azure call failed: ${err}`);
  console.error(
    `\nCheck, in order:\n` +
      `  1. region is "southeastasia" (lowercase, no spaces) — currently ${region}\n` +
      `  2. the resource is Standard tier, not Free\n` +
      `  3. the key belongs to that same resource and region\n` +
      `  4. outbound network access to *.api.cognitive.microsoft.com`,
  );
  process.exit(1);
});

const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
console.log(`round trip    ${elapsedMs.toFixed(0)} ms\n`);

// ── interpret ────────────────────────────────────────────────────────────────
if (result.reason !== sdk.ResultReason.RecognizedSpeech) {
  const reasonName = sdk.ResultReason[result.reason] ?? String(result.reason);
  console.error(`No usable result — reason: ${reasonName}`);

  if (result.reason === sdk.ResultReason.Canceled) {
    const c = sdk.CancellationDetails.fromResult(result);
    // errorDetails carries the auth/quota message. It does not contain the key.
    console.error(`  cancellation: ${sdk.CancellationReason[c.reason] ?? c.reason}`);
    if (c.errorDetails) console.error(`  details: ${c.errorDetails}`);
  }
  console.error(
    `\nThis is the 'indeterminate' path (R8). In the real endpoint this returns\n` +
      `{ indeterminate: true, reason }, never a fabricated number.`,
  );
  process.exit(1);
}

// R9 / FR-15: the typed PronunciationAssessmentResult carries only the four
// top-level scores. Per-phoneme detail exists only in the raw JSON.
const raw = JSON.parse(result.json);
const nBest = raw.NBest?.[0];

if (!nBest) {
  console.error("Recognized speech, but NBest[0] is absent — no assessment detail to read.");
  process.exit(1);
}

const pa = nBest.PronunciationAssessment ?? {};
const words = nBest.Words ?? [];

console.log(`recognized    "${result.text}"`);
console.log("");
console.log("  overall       " + fmtScore(pa.PronScore));
console.log("  accuracy      " + fmtScore(pa.AccuracyScore));
console.log("  fluency       " + fmtScore(pa.FluencyScore));
console.log("  completeness  " + fmtScore(pa.CompletenessScore));
// PRD §6 marks prosody optional — narrower language coverage. Absent is normal.
console.log("  prosody       " + (pa.ProsodyScore == null ? "not returned for this language" : fmtScore(pa.ProsodyScore)));
console.log("");

function fmtScore(n) {
  return n == null ? "—" : String(n);
}

const firstWord = words[0];
if (!firstWord) {
  console.error("No per-word detail returned. T1 is NOT satisfied.");
  process.exit(1);
}

const phonemes = firstWord.Phonemes ?? [];
console.log(`first word    "${firstWord.Word}"  accuracy ${fmtScore(firstWord.PronunciationAssessment?.AccuracyScore)}  errorType ${firstWord.PronunciationAssessment?.ErrorType ?? "—"}`);

if (!phonemes.length) {
  console.error(
    `\nNo phoneme detail on the first word. T1 is NOT satisfied.\n` +
      `Granularity may not have applied — confirm PronunciationAssessmentGranularity.Phoneme.`,
  );
  process.exit(1);
}

console.log(
  "phonemes      " +
    phonemes.map((p) => `${p.Phoneme}:${p.PronunciationAssessment?.AccuracyScore ?? "—"}`).join("  "),
);

// modelVersion, for FR-17. Not always present on the wire.
if (raw.ModelVersion) console.log(`\nmodelVersion  ${raw.ModelVersion}`);

console.log(
  `\nT1 PASS — ${words.length} word(s), ${phonemes.length} phoneme(s) on the first word.\n` +
    `Phoneme-level assessment is reaching us. Phases 2-5 are worth building.`,
);
