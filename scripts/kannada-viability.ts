/**
 * Is Kannada a language this product can actually teach?
 *
 * Two facts decide it, and neither can be reasoned about — they have to be
 * measured against the real providers:
 *
 *   1. **Does Azure assess kn-IN at all?** Pronunciation Assessment supports
 *      fewer locales than speech-to-text, and a locale it does not support is
 *      not a degraded experience — it is no scoring.
 *
 *   2. **Does it name the syllables?** This is the one that caught Hindi.
 *      hi-IN scores every syllable and names **0 of 7**: Devanagari comes back
 *      with empty graphemes, so there is no sound history, no scheduler input,
 *      no per-sound advice and no vowel chart. A learner gets one number and
 *      nothing to act on, which is the product this was built not to be.
 *      Kannada is a different script, so Hindi's result predicts nothing.
 *
 * The audio is ElevenLabs' own Kannada voice, which is the closest thing to a
 * native speaker available here — and using it means the measurement is of the
 * provider rather than of my pronunciation.
 *
 * Run: npx tsx scripts/kannada-viability.ts
 */

// Env comes from `--env-file=.env`, the way every other script here gets it.
import { appendFileSync, writeFileSync } from "node:fs";
import { getScoringProvider } from "../server/services/index.js";
import { apiKey, modelId, voiceIdFor } from "../server/services/elevenLabs.js";

/**
 * Asks ElevenLabs for raw 16 kHz PCM and wraps it in a WAV header.
 *
 * The product's own `synthesise` returns mp3 — right for a cached model voice,
 * wrong here: Azure's SDK reads WAV and refused the mp3 with "RIFF was not
 * found". `pcm_16000` is also exactly the rate and shape the recorder produces
 * (R7), so this measures the provider against the audio the product actually
 * sends it rather than against a re-encode.
 */
async function speakAsWav(text: string, locale: string): Promise<Buffer | null> {
  const key = apiKey();
  if (key === undefined) return null;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceIdFor(locale)}?output_format=pcm_16000`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: modelId() }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    say(`  ElevenLabs: HTTP ${response.status} — ${(await response.text()).slice(0, 120)}`);
    return null;
  }

  const pcm = Buffer.from(await response.arrayBuffer());

  // Minimal 16-bit mono WAV header at 16 kHz.
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(16_000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Everyday phrases, chosen to cover a spread of syllable shapes. */
const PHRASES = [
  { text: "ನಮಸ್ಕಾರ", gloss: "hello" },
  { text: "ಧನ್ಯವಾದಗಳು", gloss: "thank you" },
  { text: "ಒಂದು ಕಾಫಿ ಕೊಡಿ", gloss: "one coffee, please" },
  { text: "ನಿಮ್ಮ ಹೆಸರು ಏನು", gloss: "what is your name" },
];

/**
 * Appended to a file as well as printed.
 *
 * Two runs of this lost every line: a piped stdout buffers, and backgrounding
 * it lost even the writes that came before any network call. A probe whose
 * findings vanish when it is interrupted is a probe that has to be run again
 * from the start, and this one takes a minute and costs an API call.
 */
const LOG = "/tmp/kannada-viability.log";
function say(line: string): void {
  process.stdout.write(`${line}\n`);
  appendFileSync(LOG, `${line}\n`);
}

async function main(): Promise<void> {
  writeFileSync(LOG, "");
  say("  starting");
  const provider = getScoringProvider();
  say("  scoring provider ready");

  for (const phrase of PHRASES) {
    say(`\n  ── ${phrase.text}  (${phrase.gloss}) ──`);

    const wav = await speakAsWav(phrase.text, "kn-IN");
    if (wav === null) {
      say("  ElevenLabs: no audio to score with");
      continue;
    }
    say(`  ElevenLabs: ${wav.byteLength.toLocaleString()} bytes of 16 kHz WAV`);

    try {
      const result = await provider.score(wav, phrase.text, "kn-IN");
      if (result.indeterminate) {
        say(`  Azure: indeterminate (${result.reason})`);
        continue;
      }

      const syllables = result.words.flatMap((w) => w.syllables);
      const named = syllables.filter((s) => s.grapheme.trim() !== "").length;

      say(`  Azure: accuracy ${result.accuracy}, ${result.words.length} words`);
      say(`  words: ${result.words.map((w) => w.word).join(" | ")}`);
      say(`  syllables: ${named} of ${syllables.length} named`);
      if (named > 0) {
        say(`  named: ${syllables.filter((s) => s.grapheme.trim() !== "").map((s) => s.grapheme).join(" · ")}`);
      }
    } catch (err) {
      say(`  Azure: threw — ${(err as Error).message}`);
    }
  }
}

await main();
