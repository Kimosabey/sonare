/**
 * Builds a playable listening checklist for the generated model voice.
 *
 *     node scripts/voice-check.mjs      # writes voice-check.html, then open it
 *
 * ## Why this exists
 *
 * A learner imitates the model voice phoneme by phoneme, and is then scored
 * against the same reference text. So a mispronounced clip is not a cosmetic
 * problem: every learner copies the error, *and* the scorer marks them down
 * for matching it. The two failures compound and point in opposite directions,
 * which makes the cause very hard to find from the symptom.
 *
 * Nothing in the pipeline can detect it. The provider returns HTTP 200 and
 * valid character timings for a clip that says the wrong thing — a model asked
 * for a language it declares will still mispronounce individual words, and
 * `eleven_v3` is expressive enough to stress a word oddly. The only detector
 * is a person who speaks the language.
 *
 * Hence a page rather than a test: the clips are hash-named, so "listen to the
 * audio" is not actionable until each one sits next to the phrase it is meant
 * to be saying.
 *
 * Output is git-ignored because it points at `voice-cache/`, which is also
 * ignored — committing the page would hand a fresh clone a file whose every
 * player is broken. Regenerate it after any voice run instead.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CACHE = process.env.MODEL_VOICE_CACHE_DIR?.trim() || "voice-cache";
const OUT = "voice-check.html";

/** Human labels for the locales the MVP ships. Others still render, unlabelled. */
const LABELS = { "fr-FR": "French", "de-DE": "German" };

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

if (!existsSync(CACHE)) {
  console.error(`no cache at ${CACHE} — run \`npm run generate-model-voice\` first`);
  process.exit(2);
}

const langs = readdirSync(CACHE, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const sections = [];
let clips = 0;

for (const lang of langs) {
  const dir = join(CACHE, lang);
  const manifest = readdirSync(dir).find((f) => f.endsWith(".json"));
  if (manifest === undefined) continue;

  let data;
  try {
    data = JSON.parse(readFileSync(join(dir, manifest), "utf8"));
  } catch {
    console.error(`  ${lang}: manifest did not parse — skipped`);
    continue;
  }

  const phrases = Array.isArray(data.phrases) ? data.phrases : [];
  if (phrases.length === 0) continue;
  clips += phrases.length;

  const rows = phrases
    .map(
      (p) =>
        `<tr><td class="m">${escape(p.phraseId)}</td>` +
        `<td class="ph" lang="${escape(lang)}">${escape(p.text)}</td>` +
        `<td><audio controls preload="none" src="${escape(CACHE)}/${escape(lang)}/${escape(p.audio)}"></audio></td>` +
        `<td><input type="checkbox" aria-label="sounds right"></td></tr>`,
    )
    .join("\n");

  sections.push(
    `<h2>${escape(LABELS[lang] ?? lang)} <span class="m">${escape(lang)} · voice ${escape(data.voiceId)} · ${escape(data.modelId)} · ${phrases.length} clips</span></h2>` +
      `<table><tr><th>#</th><th>Phrase</th><th>Listen</th><th>Sounds right?</th></tr>${rows}</table>`,
  );
}

writeFileSync(
  OUT,
  `<!doctype html><meta charset="utf-8"><title>Model voice — listening check</title>
<style>
 body{font-family:Nunito,system-ui,-apple-system,sans-serif;max-width:900px;margin:0 auto;
      padding:24px;background:#fcfbfe;color:#1a0b2e;line-height:1.6}
 h1{font-size:28px;letter-spacing:-.02em;margin-bottom:8px}
 h2{font-size:19px;margin-top:34px;border-top:2px solid #41009a;padding-top:10px}
 .note{background:#f0e6ff;border:1px solid #41009a;border-radius:10px;padding:16px;font-size:15px}
 table{border-collapse:collapse;width:100%;font-size:15px;margin-top:12px}
 td,th{text-align:left;padding:10px 12px;border-bottom:1px solid #ebe5f5;vertical-align:middle}
 th{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#666;background:#f8f4ff}
 .ph{font-weight:700}
 .m{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;color:#666;font-weight:400}
 audio{height:34px}
 input[type=checkbox]{width:22px;height:22px}
</style>
<h1>Model voice — listening check</h1>
<p class="note"><b>Why this matters.</b> Learners imitate this voice phoneme by
phoneme and are then scored against the same reference text. A mispronounced
clip means every learner copies the error <em>and</em> loses marks for matching
it — two failures pointing in opposite directions, which makes the cause very
hard to find from the symptom. Nothing in the pipeline can detect this: the
provider returns 200 with valid timings for a clip that says the wrong thing.
A fluent ear is the only detector. Play each one; flag anything off.</p>
${sections.join("\n")}
`,
  "utf8",
);

console.log(`wrote ${OUT} — ${clips} clips across ${sections.length} language(s)`);
