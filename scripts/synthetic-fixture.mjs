#!/usr/bin/env node
/**
 * A synthetic stand-in for the PRD §8 fixture, for exercising the pipeline
 * end to end without waiting on speaker recruitment.
 *
 * IT IS NOT A SUBSTITUTE FOR THE REAL FIXTURE. Text-to-speech is not accented
 * learner speech: it is clean, consistent, and produced by a model that shares
 * training lineage with the scorer. A separation measured here says the
 * plumbing discriminates; it says nothing reliable about whether Azure
 * penalises a real Tamil or Telugu speaker. Only PRD §8 answers that.
 *
 * What it IS good for: proving the scorer responds to phoneme substitution at
 * all, exercising every error type, and giving analyze_fixture.py real input.
 *
 *   npm run dev            # in another terminal
 *   node scripts/synthetic-fixture.mjs [outfile.json]
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, mkdtemp } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

const ENDPOINT = process.env.ENDPOINT ?? "http://localhost:5181/api/v1/pronunciation";
const CONCURRENCY = 5;

/**
 * Set B spellings are chosen to force the substitutions that actually show up
 * in L2 English from Indian first languages: dental fricative fronting
 * (th → s/t), v/w confusion, vowel epenthesis before initial clusters, and
 * final-consonant deletion.
 */
const WORDS = [
  { correct: "think", wrong: "sink", pattern: "th → s" },
  { correct: "three", wrong: "tree", pattern: "th → t" },
  { correct: "very", wrong: "wery", pattern: "v → w" },
  { correct: "school", wrong: "iskool", pattern: "vowel epenthesis" },
  { correct: "world", wrong: "wurl", pattern: "final consonant dropped" },
  { correct: "vote", wrong: "bote", pattern: "v → b" },
  { correct: "clothes", wrong: "cloze", pattern: "cluster reduction" },
  { correct: "measure", wrong: "mejar", pattern: "zh → j" },
];

const SPEAKERS = [
  { voice: "Aman", label: "S01-en-IN-aman", accent: "Indian English" },
  { voice: "Rishi", label: "S02-en-IN-rishi", accent: "Indian English" },
  { voice: "Tara", label: "S03-en-IN-tara", accent: "Indian English" },
  { voice: "Samantha", label: "S04-en-US-samantha", accent: "US English" },
  { voice: "Daniel", label: "S05-en-GB-daniel", accent: "UK English" },
];

async function synthesise(dir, voice, text, tag) {
  const aiff = join(dir, `${tag}.aiff`);
  const wav = join(dir, `${tag}.wav`);
  await run("say", ["-v", voice, text, "-o", aiff]);
  // R7: 16 kHz mono PCM16.
  await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  await unlink(aiff).catch(() => {});
  return wav;
}

async function score(wavPath, referenceText) {
  const bytes = await readFile(wavPath);
  const form = new FormData();
  form.append("audio", new Blob([bytes], { type: "audio/wav" }), "capture.wav");
  form.append("referenceText", referenceText);
  form.append("language", "en-US");
  form.append(
    "deviceContext",
    JSON.stringify({ ua: "synthetic-fixture/node", contextRate: 16000, granted: null }),
  );

  const res = await fetch(ENDPOINT, { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

async function main() {
  const outfile = process.argv[2] ?? "synthetic-fixture.json";
  const dir = await mkdtemp(join(tmpdir(), "fixture-"));

  const jobs = [];
  for (const speaker of SPEAKERS) {
    for (const word of WORDS) {
      jobs.push({ speaker, word, set: "A", spoken: word.correct });
      jobs.push({ speaker, word, set: "B", spoken: word.wrong });
    }
  }

  console.log(`${jobs.length} attempts — ${SPEAKERS.length} speakers × ${WORDS.length} words × 2 sets`);
  console.log(`endpoint ${ENDPOINT}\n`);

  let done = 0;
  const entries = await pool(jobs, CONCURRENCY, async (job, i) => {
    const tag = `${job.set}-${job.speaker.voice}-${job.word.correct}-${i}`;
    try {
      const wav = await synthesise(dir, job.speaker.voice, job.spoken, tag);
      const result = await score(wav, job.word.correct);
      await unlink(wav).catch(() => {});

      done++;
      const shown = result.indeterminate ? "indet" : String(Math.round(result.accuracy)).padStart(3);
      process.stdout.write(
        `[${String(done).padStart(2)}/${jobs.length}] ${job.set} ${job.speaker.voice.padEnd(9)} ` +
          `"${job.spoken}" vs "${job.word.correct}" → ${shown}\n`,
      );

      return {
        n: i + 1,
        set: job.set,
        speaker: job.speaker.label,
        reference: job.word.correct,
        spoken: job.spoken,
        pattern: job.word.pattern,
        accent: job.speaker.accent,
        language: "en-US",
        // Platform bucketing in analyze_fixture.py reads this.
        ua: `synthetic/${job.speaker.accent.replace(/\s+/g, "-")}`,
        contextRate: 16000,
        granted: null,
        result,
        at: new Date().toISOString(),
      };
    } catch (err) {
      done++;
      console.error(`[${done}/${jobs.length}] FAILED ${tag}: ${String(err)}`);
      return null;
    }
  });

  const clean = entries.filter(Boolean);
  writeFileSync(outfile, JSON.stringify(clean, null, 2));
  console.log(`\nwrote ${outfile} (${clean.length} attempts)`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
