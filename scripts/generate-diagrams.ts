/**
 * Articulation diagrams — one picture per sound the scorer can name.
 *
 *     npm run generate-diagrams -- --dry-run   # what it would spend
 *     npm run generate-diagrams -- --only=/ʁ/  # one sound
 *     npm run generate-diagrams                # everything missing
 *
 * ## Why this exists
 *
 * The product measures more carefully than anything else in its market and
 * explains less kindly. A learner who cannot make the French ʁ is told which
 * sound they missed and given a sentence about it; the nearest competitor
 * shows them a mouth. A diagram is the cheapest way to close that without
 * conceding anything, because **a picture of where the tongue goes is not a
 * claim about the learner** — it describes the language, not the person, so it
 * touches none of the honesty this product is built on.
 *
 * ## Keyed by IPA, not by language
 *
 * `/ʁ/` is the same sound in French and German and gets one diagram. The
 * difficulty table is keyed by pair because *difficulty* is a relationship,
 * but articulation is not: the tongue does the same thing in Lyon and Leipzig.
 * Seventeen sounds across three languages, not eighteen.
 *
 * ## What is deliberately not generated
 *
 * Hindi and Kannada get none. The scorer names no syllables in either, so
 * there is no sound to attach a picture to, and a diagram for a sound the
 * product cannot identify would be decoration standing where a diagnosis
 * should be.
 *
 * ## Measured before building, and the answer was not yet
 *
 * Three attempts on 2026-09-23, one sound (`/ʁ/`), before spending on the
 * other sixteen:
 *
 * 1. **`gemini-2.5-flash-image`, first prompt.** Clean line art, no text, and
 *    anatomically useless — no hard palate, no velum, no uvula, no pharynx.
 *    The tongue lay flat between the teeth. `/ʁ/` is made at the back of the
 *    throat, and the back of the throat was not in the picture.
 * 2. **Same model, prompt demanding every articulator by name.** A real vocal
 *    tract appeared — nasal cavity, palate, pharynx, tongue root. The tongue
 *    was still low and flat, which is the opposite of this sound.
 * 3. **`gemini-3-pro-image`.** The tongue bunched high and back, which is
 *    roughly right. The teeth came out as garbled blobs.
 *
 * So the models draw a credible vocal tract and **cannot reliably place the
 * articulators for a named phoneme**. That is the entire content of the
 * picture. A diagram that is approximately right is not a milder version of a
 * correct one — it is an instruction a learner physically copies, and then
 * gets marked down by this product's own scorer for copying.
 *
 * Seventeen of these, each purporting to instruct a tongue, none checkable by
 * anyone here: if three are wrong, three sounds are taught wrongly and the
 * failure looks exactly like the learner's fault.
 *
 * ## What happened next, and why this paragraph changed
 *
 * `gpt-image-2.5-sunburst` was tried afterwards and is the first to place the
 * tongue correctly for `/ʁ/` — back raised toward a visible uvula, in a proper
 * textbook section. So the question stopped being "can a model draw this" and
 * became "can anybody here check it", and the risk **inverted**: an obviously
 * useless diagram gets thrown away, while a plausible and subtly wrong one
 * gets trusted. `/ʁ/` against `/x/` is a centimetre of drawing; `/e/` against
 * `/ø/` differs only in lip rounding.
 *
 * Sixteen are therefore generated into `diagram-cache/` and **none is
 * shipped**. They are out of `public/` because unreviewed content in the build
 * is shipped content, and because they arrive at ~890 KiB each — sixteen is
 * 14 MB against a 144 KiB learner bundle, so they need re-encoding before
 * shipping even if every one is right.
 *
 * The comparison that decided it: the model voice has the same failure mode
 * and a solution. A mispronounced clip is also an error every learner copies,
 * and `voice-check.html` puts every clip beside its phrase so a speaker can
 * catch it. `scripts/diagram-check.mjs` is now the equivalent surface — built
 * once the diagrams were good enough to be worth a reviewer's time, which they
 * were not at the three attempts above.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { L1_DIFFICULTY } from "../src/activities/difficulty.js";
import type { SoundDifficulty } from "../src/activities/difficulty.js";

/**
 * Outside `public/`, deliberately — the same shape as `voice-cache/`.
 *
 * A generated diagram is unreviewed, and unreviewed content must not be in the
 * build at all. Putting them in `public/` made them shipped assets the moment
 * they existed: the perf budget caught it immediately, which is the budget
 * doing its job rather than an inconvenience.
 *
 * It also caught the other reason. These come back at roughly **890 KiB each**
 * — a 1024px RGBA PNG of thin lines on white, which is most of a megabyte of
 * almost nothing. Seventeen would be 15 MB in a build where the entire
 * learner-facing bundle is 144 KiB gzipped. They would need re-encoding before
 * they could ship even if every one were correct.
 *
 * They move into `public/diagrams/` when a reviewer has passed them and they
 * have been re-encoded, and not before.
 */
const OUT_DIR = join(process.cwd(), "diagram-cache");
const MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image";

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit !== undefined) return hit.slice(prefix.length);
  return process.argv.includes(`--${name}`) ? "" : undefined;
}

/**
 * A stable file name for a sound.
 *
 * Hashed rather than slugged from the IPA: `/ɑ̃/, /ɛ̃/` contains combining
 * marks, commas and slashes, and every one of those is a different kind of
 * trouble in a URL or on a case-insensitive filesystem. The hash is of the
 * exact IPA string, so a changed IPA is a changed file rather than a stale one
 * wearing the right name.
 */
function fileFor(ipa: string): string {
  return `${createHash("sha256").update(ipa).digest("hex").slice(0, 16)}.png`;
}

/** Every distinct sound across every pair, with one language's advice for context. */
export function soundsNeedingDiagrams(): { ipa: string; example: SoundDifficulty }[] {
  const seen = new Map<string, SoundDifficulty>();
  for (const entries of Object.values(L1_DIFFICULTY)) {
    for (const entry of entries) {
      if (!seen.has(entry.ipa)) seen.set(entry.ipa, entry);
    }
  }
  return [...seen.entries()].map(([ipa, example]) => ({ ipa, example }));
}

/**
 * The prompt, which is most of the work.
 *
 * Constrained hard and for reasons rather than taste. A stylised **mid-sagittal
 * section** is the convention every phonetics textbook uses, so a learner who
 * has seen one anywhere recognises this one. No colour beyond a single accent:
 * the picture has one job, which is showing where the tongue is, and anything
 * else competes with it. No text in the image — labels cannot be translated,
 * cannot be read by a screen reader, and would be the one part of this product
 * that ships English into a French lesson.
 */
function promptFor(ipa: string, entry: SoundDifficulty): string {
  return [
    "Draw a phonetics textbook mid-sagittal section: a head cut down the middle,",
    "facing LEFT, showing the vocal tract from the lips to the top of the windpipe.",
    "",
    "The following structures must ALL be clearly drawn and distinguishable, because",
    "this diagram is useless without them:",
    "  - upper and lower lip",
    "  - upper and lower teeth",
    "  - the alveolar ridge (the bump behind the upper teeth)",
    "  - the hard palate (the roof of the mouth)",
    "  - the soft palate / velum, and the uvula hanging from its back edge",
    "  - the whole tongue from tip to root, as one continuous filled shape",
    "  - the pharynx: the open throat cavity behind and below the tongue root",
    "  - the nasal cavity above the palate",
    "",
    `The tongue must be positioned to articulate ${ipa}, specifically:`,
    `  ${entry.advice}`,
    "The tongue shape is the entire content of this picture. Getting it wrong makes",
    "the diagram worse than no diagram, because a learner will copy it.",
    "",
    "Style:",
    "  - Clean line art, thin dark-grey outlines, plain white background.",
    "  - The tongue filled solid muted teal; everything else unfilled white.",
    "  - No text, letters, numbers, labels, arrows or leader lines anywhere.",
    "  - No shading, gradients, photorealism, borders or decoration.",
    "  - Square, the vocal tract filling the frame.",
  ].join("\n");
}

/**
 * OpenAI's image endpoint, for comparison against Gemini's.
 *
 * Both are here because the failure differed by provider rather than being a
 * single wall, and the only way to know was to ask both. Neither answers the
 * question that matters — whether the tongue is where this phoneme needs it —
 * which is a fact about verification rather than about either model.
 */
async function generateOpenAI(
  ipa: string,
  entry: SoundDifficulty,
  key: string,
): Promise<Buffer | null> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1",
      prompt: promptFor(ipa, entry),
      size: "1024x1024",
      n: 1,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`  ${ipa}: HTTP ${res.status} — ${body.replace(key, "<redacted>").slice(0, 200)}`);
    return null;
  }

  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const first = json.data?.[0];
  if (first?.b64_json !== undefined) return Buffer.from(first.b64_json, "base64");
  if (first?.url !== undefined) {
    const img = await fetch(first.url);
    if (img.ok) return Buffer.from(await img.arrayBuffer());
  }
  console.error(`  ${ipa}: the model returned no image`);
  return null;
}

async function generate(ipa: string, entry: SoundDifficulty, key: string): Promise<Buffer | null> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptFor(ipa, entry) }] }],
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`  ${ipa}: HTTP ${res.status} — ${body.replace(key, "<redacted>").slice(0, 200)}`);
    return null;
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
  };
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data !== undefined);
  const data = part?.inlineData?.data;
  if (data === undefined) {
    console.error(`  ${ipa}: the model returned no image`);
    return null;
  }
  return Buffer.from(data, "base64");
}

async function main(): Promise<void> {
  const dryRun = flag("dry-run") !== undefined;
  const only = flag("only");
  const provider = flag("provider") ?? "gemini";
  const key =
    provider === "openai" ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;

  mkdirSync(OUT_DIR, { recursive: true });

  const wanted = soundsNeedingDiagrams().filter((s) => only === undefined || only === "" || s.ipa === only);
  const missing = wanted.filter((s) => !existsSync(join(OUT_DIR, fileFor(s.ipa))));

  console.log(
    `provider: ${provider}  model: ${provider === "openai" ? (process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1") : MODEL}`,
  );
  console.log(`${wanted.length} sound(s) in scope, ${missing.length} without a diagram`);
  for (const s of missing) console.log(`  ${s.ipa}  -> ${fileFor(s.ipa)}`);

  if (dryRun) {
    console.log("\n--dry-run: no requests made, nothing written.");
    return;
  }
  if (missing.length === 0) {
    console.log("\nnothing to do — every sound already has one.");
    return;
  }
  if (key === undefined || key === "") {
    console.error(
      `\n${provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"} is not set. Nothing generated.`,
    );
    process.exitCode = 1;
    return;
  }

  let made = 0;
  for (const { ipa, example } of missing) {
    // One at a time, like the model voice: a burst makes "what did that cost"
    // unanswerable mid-run, and a rate-limited provider would spend the quota
    // on work that produced nothing.
    const image =
      provider === "openai"
        ? await generateOpenAI(ipa, example, key)
        : await generate(ipa, example, key);
    if (image === null) continue;
    writeFileSync(join(OUT_DIR, fileFor(ipa)), image);
    console.log(`  wrote ${fileFor(ipa)} for ${ipa} (${image.length} bytes)`);
    made += 1;
  }

  console.log(`\n${made} of ${missing.length} generated into ${OUT_DIR}`);
  if (made > 0) {
    console.log("These are unverified. A wrong tongue position is an instruction a learner");
    console.log("will copy, and nothing automated can tell the difference.");
  }
}

await main();
