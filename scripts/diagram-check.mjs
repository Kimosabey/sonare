/**
 * Builds a review page for the generated articulation diagrams.
 *
 *     node scripts/diagram-check.mjs    # writes diagram-check.html, then open it
 *
 * ## Why this exists
 *
 * The same reason `voice-check.mjs` does, and the same failure it guards.
 *
 * A learner looks at one of these and puts their tongue where it shows. If the
 * constriction is in the wrong place they practise a wrong articulation — and
 * then this product's own scorer marks them down for the habit its own diagram
 * taught them. The two failures compound and point in opposite directions,
 * which makes the cause very hard to find from the symptom.
 *
 * Nothing in the pipeline can detect it. The model returns a clean,
 * anatomically coherent picture whether or not the tongue is right, and the
 * difference between `/ʁ/` (uvular) and `/x/` (velar) is about a centimetre of
 * drawing. `/e/` and `/ø/` differ only in whether the lips are rounded. These
 * are not errors a non-phonetician catches by looking, which is precisely why
 * looking has to be somebody's job rather than nobody's.
 *
 * So: a page rather than a test. Each diagram sits beside the sound it claims
 * to show, the syllables it applies to, the substitution an English speaker
 * makes, and the advice the diagram is supposed to illustrate. A reviewer
 * needs no tooling and no context — they can say "that one is wrong" and mean
 * something actionable.
 *
 * ## What a reviewer is being asked
 *
 * Not "is it pretty". Three questions, in this order:
 *
 *   1. Is the constriction in the right place for this sound?
 *   2. Are the lips right — rounded or not, as this sound requires?
 *   3. Does it contradict the advice printed next to it?
 *
 * Any "no" means that diagram does not ship. There is no partial credit: a
 * diagram that is approximately right is an instruction that is wrong.
 *
 * Output is git-ignored because it points at `diagram-cache/`, which is also
 * ignored — committing the page would hand a fresh clone a file whose every
 * image is broken. Regenerate it after any diagram run instead.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIAGRAMS = join(ROOT, "diagram-cache");

/** Same hash the generator uses — see scripts/generate-diagrams.ts. */
function fileFor(ipa) {
  return `${createHash("sha256").update(ipa).digest("hex").slice(0, 16)}.png`;
}

/**
 * Read the difficulty table out of its source.
 *
 * Parsed rather than imported because this file is plain ESM run by node,
 * and the table is TypeScript. A regex over a literal is ugly and it is
 * honest about what it is: a review page is a developer tool, and adding a
 * build step to it would be the tail wagging the dog.
 */
function difficulties() {
  const source = readFileSync(join(ROOT, "src", "activities", "difficulty.ts"), "utf8");
  const out = [];
  const pairRe = /"(en→[a-z]{2}-[A-Z]{2})":\s*\[/g;
  let pair;
  while ((pair = pairRe.exec(source)) !== null) {
    const start = pair.index + pair[0].length;
    // Everything up to the closing bracket of this pair's array.
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === "[") depth += 1;
      if (source[i] === "]") depth -= 1;
      i += 1;
    }
    const body = source.slice(start, i - 1);
    const entryRe =
      /graphemes:\s*\[([^\]]*)\][\s\S]*?ipa:\s*"([^"]+)"[\s\S]*?substitution:\s*\n?\s*"([^"]*)"[\s\S]*?advice:\s*\n?\s*"([^"]*)"/g;
    let entry;
    while ((entry = entryRe.exec(body)) !== null) {
      out.push({
        pair: pair[1],
        graphemes: entry[1]
          .split(",")
          .map((g) => g.trim().replace(/"/g, ""))
          .filter(Boolean),
        ipa: entry[2],
        substitution: entry[3],
        advice: entry[4],
      });
    }
  }
  return out;
}

const entries = difficulties();

/** One diagram per distinct sound; the table lists a sound once per language. */
const bySound = new Map();
for (const entry of entries) {
  const existing = bySound.get(entry.ipa);
  if (existing === undefined) bySound.set(entry.ipa, { ...entry, pairs: [entry.pair] });
  else existing.pairs.push(entry.pair);
}

const escape = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const rows = [...bySound.values()].map((s) => {
  const file = fileFor(s.ipa);
  const present = existsSync(join(DIAGRAMS, file));
  return `
    <article class="sound${present ? "" : " missing"}">
      <div class="art">
        ${
          present
            ? `<img src="diagram-cache/${file}" alt="Articulation diagram for ${escape(s.ipa)}" loading="lazy" />`
            : `<p class="none">No diagram generated.</p>`
        }
      </div>
      <div class="detail">
        <h2>${escape(s.ipa)}</h2>
        <p class="pairs">${s.pairs.map(escape).join(" · ")}</p>
        <p class="syllables">${s.graphemes.map((g) => `<code>${escape(g)}</code>`).join(" ")}</p>
        <dl>
          <dt>What an English speaker reaches for</dt>
          <dd>${escape(s.substitution)}</dd>
          <dt>What the diagram must show</dt>
          <dd class="advice">${escape(s.advice)}</dd>
        </dl>
        <p class="ask">Constriction in the right place? Lips right? Contradicts the advice?</p>
      </div>
    </article>`;
});

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Articulation diagrams — review</title>
    <style>
      :root { color-scheme: light; --ink: #14202b; --dim: #5d6b79; --rule: #d7dee5; --warn: #9a2f2f; }
      body { margin: 0; background: #f4f6f8; color: var(--ink);
             font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      main { max-width: 1000px; margin: 0 auto; padding: 32px 20px 64px; }
      h1 { font-size: 28px; margin: 0 0 8px; }
      .intro { color: var(--dim); max-width: 62ch; }
      .intro strong { color: var(--ink); }
      .sound { display: grid; grid-template-columns: 300px 1fr; gap: 24px;
               background: #fff; border: 1px solid var(--rule); border-radius: 6px;
               padding: 20px; margin: 18px 0; align-items: start; }
      .sound.missing { border-color: var(--warn); }
      .art img { width: 100%; height: auto; display: block; border: 1px solid var(--rule); border-radius: 4px; }
      .none { color: var(--warn); font-weight: 600; margin: 0; }
      h2 { font-size: 26px; margin: 0 0 4px; font-family: ui-monospace, Menlo, monospace; }
      .pairs, .syllables { color: var(--dim); font-size: 13px; margin: 0 0 8px; }
      code { background: #eef2f5; padding: 1px 6px; border-radius: 3px; font-size: 13px; }
      dl { margin: 12px 0 0; }
      dt { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); margin-top: 10px; }
      dd { margin: 2px 0 0; }
      .advice { font-weight: 600; }
      .ask { margin: 14px 0 0; padding-top: 10px; border-top: 1px dashed var(--rule);
             color: var(--dim); font-size: 13px; }
      @media (max-width: 720px) { .sound { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <h1>Articulation diagrams — review</h1>
      <p class="intro">
        A learner looks at one of these and puts their tongue where it shows. If the
        constriction is in the wrong place they practise a wrong articulation, and this
        product's own scorer then marks them down for the habit its own diagram taught
        them. <strong>Nothing automated can catch that</strong> — the model returns a clean,
        coherent picture either way, and <code>/ʁ/</code> against <code>/x/</code> is a
        centimetre of drawing.
      </p>
      <p class="intro">
        For each one: <strong>is the constriction in the right place, are the lips right,
        and does it contradict the advice beside it?</strong> Any no means it does not ship.
        A diagram that is approximately right is an instruction that is wrong.
      </p>
      ${rows.join("\n")}
    </main>
  </body>
</html>
`;

writeFileSync(join(ROOT, "diagram-check.html"), html);
const present = [...bySound.values()].filter((s) => existsSync(join(DIAGRAMS, fileFor(s.ipa))));
console.log(
  `wrote diagram-check.html — ${present.length} of ${bySound.size} sounds have a diagram`,
);
