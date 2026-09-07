#!/usr/bin/env node
/**
 * T17 — the checks no type system catches. Written early on purpose: these are
 * cheap, and each one guards a rule whose violation silently invalidates the POC.
 *
 * Sources: CLAUDE.md "Verification" and HANDOFF.md "Verification".
 * Run: npm run verify
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);
const TEXT_EXT = /\.(m?[jt]sx?|c[jt]s|json|html|css|md|sh|env|example)$/i;

/** Every scannable file under `dir`, repo-relative, POSIX-separated. */
function walk(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  const stack = [abs];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(cur, entry);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (TEXT_EXT.test(entry) || entry.startsWith(".env")) {
        out.push(relative(ROOT, p).split(sep).join("/"));
      }
    }
  }
  return out;
}

const failures = [];

/**
 * Flag every line in `files` matching `pattern`.
 * `allow` is a predicate on the repo-relative path — files that may legitimately match.
 */
function forbid({ rule, what, why, files, pattern, allow = () => false }) {
  const hits = [];
  for (const file of files) {
    // This file necessarily contains every pattern it searches for.
    if (file === "scripts/verify.mjs" || allow(file)) continue;
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (pattern.test(line)) hits.push({ file, line: i + 1, text: line.trim().slice(0, 100) });
    });
  }
  if (hits.length) failures.push({ rule, what, why, hits });
}

/**
 * Flag every pattern in `patterns` that is *absent* from `files`. The mirror of
 * forbid, for rules whose violation is a missing line rather than a present
 * one — those are invisible to a grep-based check and, in the CSS case below,
 * to the type system and the test suite as well.
 *
 * Takes a list rather than one path because the stylesheet is now a directory.
 * The files are searched together: the question is whether a rule exists
 * anywhere in the stylesheet, not which sheet happens to hold it. Widening the
 * scope this way keeps the rule exactly as strict — a band with no rule in any
 * sheet is still a failure — where pointing it at one file of ten would have
 * left it passing on nine tenths of the evidence.
 */
function require({ rule, what, why, files, patterns }) {
  const text = files.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
  const where = files.length === 1 ? files[0] : `${files.length} sheets`;
  const hits = [];
  for (const { pattern, label } of patterns) {
    if (!pattern.test(text)) hits.push({ file: where, line: 0, text: `missing: ${label}` });
  }
  if (hits.length) failures.push({ rule, what, why, hits });
}

const srcAndServer = [...walk("src"), ...walk("server")];

// ── R1 — the API we exist to remove ──────────────────────────────────────────
forbid({
  rule: "R1",
  what: "SpeechRecognition referenced in src/ or server/",
  why: "It provides no phoneme data. A fallback preserves the bugs we are removing.",
  files: srcAndServer,
  pattern: /\b(webkit)?SpeechRecognition\b/,
});

// ── R3 — the scoring bug ─────────────────────────────────────────────────────
// Confidence answers "did I hear you", not "did you say it right".
forbid({
  rule: "R3",
  what: "a score derived from recognition confidence",
  why: "Confidence is not a pronunciation measurement. This is the bug the POC replaces.",
  files: srcAndServer,
  pattern: /(score|accuracy|overall)\s*[:=][^;\n]*\bconfidence\b/i,
});

// ── R2 / NFR-04 — credentials ────────────────────────────────────────────────
// scripts/ is allowed: it runs on a developer machine, never bundled to a client.
forbid({
  rule: "R2",
  what: "AZURE_SPEECH_KEY outside server/, scripts/ and .env.example",
  why: "A key in the bundle is a key in every user's devtools.",
  files: [...walk("src"), ...walk("server"), ...walk("scripts"), ".env.example"].filter((f) => existsSync(join(ROOT, f))),
  pattern: /AZURE_SPEECH_KEY/,
  allow: (f) => f.startsWith("server/") || f.startsWith("scripts/") || f === ".env.example",
});

forbid({
  rule: "R2",
  what: "client code reading a process.env value containing KEY or SECRET",
  why: "Anything the client bundle reads is public.",
  files: walk("src"),
  pattern: /process\.env(\.[A-Z0-9_]*(KEY|SECRET)[A-Z0-9_]*|\[\s*['"][^'"]*(KEY|SECRET)[^'"]*['"]\s*\])/,
});

// A literal connection string or key committed anywhere in the tree.
forbid({
  rule: "R2",
  what: "a hard-coded Azure credential literal",
  why: "Secrets belong in server environment variables, never in source.",
  files: [...walk("src"), ...walk("server"), ...walk("scripts")],
  pattern: /AccountKey=|DefaultEndpointsProtocol=/,
});

// ── R11 — capture state must not survive a reload ────────────────────────────
forbid({
  rule: "R11",
  what: "localStorage or sessionStorage in src/speech/",
  why: "Stale audio config across reloads produces confusing, unreproducible bugs.",
  files: walk("src/speech"),
  pattern: /\b(local|session)Storage\b/,
});

// ── Portability — the capture layer ports to React Native ────────────────────
forbid({
  rule: "NFR-05",
  what: "a React import inside src/speech/capture/",
  why: "The capture layer must stay framework-free to port to React Native.",
  files: walk("src/speech/capture"),
  pattern: /\bfrom\s+['"]react['"]|\brequire\(\s*['"]react['"]\s*\)/,
});

// ── R12 — one vendor, one file ───────────────────────────────────────────────
forbid({
  rule: "R12",
  what: "the Azure SDK imported outside server/services/",
  why: "Swapping to SpeechAce must be a file change, not a refactor.",
  files: [...walk("src"), ...walk("server")],
  pattern: /microsoft-cognitiveservices-speech-sdk/,
  allow: (f) => f.startsWith("server/services/"),
});

// ── T12 — every band the code can return has a style ─────────────────────────
// A renamed band breaks no type and fails no test: the page still renders,
// every score just comes out the same colour and the banding silently stops
// existing. This exact mistake shipped once, with band() returning hi/mid/lo
// against a stylesheet keyed on pass/warn/fail. Read from the source's own
// return type, so renaming a band moves the check with it.
{
  const bandSource = readFileSync(join(ROOT, "src/speech/components/band.ts"), "utf8");
  const returnType = /export function band\([^)]*\):\s*([^{]+)\{/.exec(bandSource)?.[1] ?? "";
  const bands = [...returnType.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);

  if (bands.length === 0) {
    failures.push({
      rule: "T12",
      what: "band()'s return type could not be read",
      why: "The CSS check below is only as good as this parse; a silent empty list would pass vacuously.",
      hits: [{ file: "src/speech/components/band.ts", line: 0, text: "no string-literal union found" }],
    });
  }

  /**
   * The stylesheet is a directory now (src/styles/), so the check reads all of
   * it. An empty list would make every pattern "missing" and fail loudly
   * rather than pass vacuously, but it would fail for the wrong reason and
   * send whoever hit it looking at band.ts — so it is named explicitly.
   */
  const sheets = walk("src/styles").filter((f) => f.endsWith(".css"));

  if (sheets.length === 0) {
    failures.push({
      rule: "T12",
      what: "no stylesheets found under src/styles/",
      why: "The band check has nothing to read, so it cannot vouch for anything.",
      hits: [{ file: "src/styles/", line: 0, text: "no .css files" }],
    });
  }

  require({
    rule: "T12",
    what: "a band with no rule in the stylesheet",
    why: "Scores would render unstyled — no type error, no test failure, no visible error.",
    files: sheets,
    patterns: bands.flatMap((b) => [
      { pattern: new RegExp(`\\.word\\.${b}\\b`), label: `.word.${b}` },
      { pattern: new RegExp(`\\.trajectory-step\\.${b}\\b`), label: `.trajectory-step.${b}` },
    ]),
  });
}

// ── rate limiting — trust exactly one proxy hop ──────────────────────────────
// `app.set("trust proxy", true)` trusts every hop, which means express-rate-
// limit reads whatever X-Forwarded-For says — and anyone can send that header.
// The per-IP ceiling on a metered provider becomes decorative, and nothing
// fails: the limiter still runs, still counts, and counts a different
// attacker-chosen address every request. One hop is the real topology (an
// ngrok tunnel today, a single load balancer later). The wrong value here is a
// one-word edit that no type or test would catch.
forbid({
  rule: "NFR-04",
  what: 'trust proxy set to a value other than exactly 1',
  why: "Trusting every hop lets a spoofed X-Forwarded-For dodge the per-IP rate limit entirely.",
  files: walk("server"),
  // The dangerous values named explicitly rather than "anything but 1". A
  // negative lookahead here has a backtracking hole: `\s*` can match zero
  // characters, so the lookahead lands on a space, succeeds, and the check
  // fires on the correct code. `true` trusts every hop; `false` trusts none,
  // so every request appears to come from the proxy and shares one bucket; a
  // two-digit hop count is nobody's real topology.
  pattern: /trust proxy["']\s*,\s*(?:true|false|["']|\d\d)/,
  // Test harnesses legitimately trust every hop: rateLimit.test.ts gives each
  // simulated caller its own X-Forwarded-For precisely to prove the ceiling is
  // counted per-caller rather than globally. Nothing there is deployed.
  allow: (f) => /\.test\.[tj]sx?$/.test(f),
});

// ── NFR-03 — nothing interactive below the tap floor ────────────────────────
// The syllable chips shipped at 36px, and they are buttons: tapping one plays
// back that slice of the learner's own audio, which is the product's core
// interaction. 44px is the practical floor — below it a thumb on a moving bus
// misses — and the failure is invisible on a desktop mouse, which is where
// stylesheets get written. Declared as `--tap` so a rule can say what it means.
{
  // Every sheet under src/styles/, since the stylesheet is a directory now.
  // Reported per file and per line, so a hit still names exactly where it is.
  const sheets = walk("src/styles").filter((f) => f.endsWith(".css"));
  const hits = [];

  if (sheets.length === 0) {
    failures.push({
      rule: "NFR-03",
      what: "no stylesheets found under src/styles/",
      why: "The tap-floor check has nothing to read, so it cannot vouch for anything.",
      hits: [{ file: "src/styles/", line: 0, text: "no .css files" }],
    });
  }

  for (const sheet of sheets) {
    readFileSync(join(ROOT, sheet), "utf8")
      .split("\n")
      .forEach((line, i) => {
        const m = /min-(?:height|width):\s*(\d+)px/.exec(line);
        // min-width is also used for table overflow, which is not a target —
        // only flag it under 44 when it is plausibly one, i.e. small.
        if (m && Number(m[1]) < 44 && Number(m[1]) > 0) {
          hits.push({ file: sheet, line: i + 1, text: line.trim().slice(0, 100) });
        }
      });
  }

  if (hits.length) {
    failures.push({
      rule: "NFR-03",
      what: "an interactive target declared below the 44px tap floor",
      why: "Below 44px a thumb misses. Use var(--tap); the miss is invisible on the desktop mouse the CSS was written with.",
      hits,
    });
  }
}

// ── T13 — reduced motion stays a blanket, not a list ────────────────────────
// The kill-switch works because it is `* { animation: none !important }`: every
// animation added anywhere is covered without anyone remembering to opt in.
// Narrowed to a list of selectors it would still look correct, still pass every
// test, and silently stop covering each new animation from then on — and the
// people it fails are the ones for whom motion causes nausea or seizures.
// Checked structurally rather than trusted, because there are 14 @keyframes in
// this stylesheet and nothing else ties them to the switch.
{
  const sheets = walk("src/styles").filter((f) => f.endsWith(".css"));
  const css = sheets.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

  const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  const body = block?.[1] ?? "";

  const problems = [];
  if (block === null) problems.push("no prefers-reduced-motion block found");
  else {
    if (!/(^|\s)\*\s*\{/.test(body)) problems.push("the block does not target `*`");
    if (!/animation:\s*none\s*!important/.test(body)) {
      problems.push("no `animation: none !important`");
    }
    if (!/transition:\s*none\s*!important/.test(body)) {
      problems.push("no `transition: none !important`");
    }
  }

  const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].length;
  if (keyframes === 0) {
    problems.push("no @keyframes found at all — this check cannot vouch for anything");
  }

  if (problems.length > 0) {
    failures.push({
      rule: "T13",
      what: "the reduced-motion kill-switch is not a blanket rule",
      why: `Every animation must be covered without opting in. ${keyframes} @keyframes rely on it.`,
      hits: problems.map((text) => ({ file: "src/styles/motion.css", line: 0, text })),
    });
  }
}

// ── T14 — no source file is invisible to git ────────────────────────────────
// Found the hard way: `.gitignore` carries an unanchored `data/` so the
// fallback log's real learner records can never be committed from any working
// directory. That rule also silently swallowed `server/data/*.ts` — nine
// repository modules that existed on disk, passed every gate, and were never
// committed. The build was green and the repository was broken for anyone who
// cloned it, because every gate runs against the working tree rather than
// against what is tracked.
//
// This is the check that would have caught it on the first commit.
{
  const sources = [...walk("src"), ...walk("server"), ...walk("scripts")].filter((f) =>
    /\.(m?[jt]sx?|c[jt]s)$/.test(f),
  );

  let ignored = [];
  try {
    // --stdin so one process handles every path; check-ignore exits 1 when
    // nothing matches, which is the healthy case rather than an error.
    const output = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: ROOT,
      input: sources.join("\n"),
      encoding: "utf8",
    });
    ignored = output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (err) {
    // Exit 1 means no path was ignored. Anything else — no git, not a
    // repository — leaves this check unable to vouch for anything, and it says
    // so rather than passing quietly.
    if (err.status !== 1) {
      failures.push({
        rule: "T14",
        what: "could not ask git which files are ignored",
        why: "A source file excluded by .gitignore passes every other gate and is missing for everyone who clones.",
        hits: [{ file: ".gitignore", line: 0, text: String(err.message).slice(0, 120) }],
      });
      ignored = [];
    }
  }

  if (ignored.length > 0) {
    failures.push({
      rule: "T14",
      what: "a source file is excluded by .gitignore",
      why: "It passes every gate locally and is absent for anyone who clones — the build is green and the repository is broken.",
      hits: ignored.map((file) => ({ file, line: 0, text: "ignored by .gitignore" })),
    });
  }
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log("verify: all checks passed");
  process.exit(0);
}

console.error("verify: FAILED\n");
for (const f of failures) {
  console.error(`[${f.rule}] ${f.what}`);
  console.error(`        ${f.why}`);
  for (const h of f.hits) console.error(`        ${h.file}:${h.line}  ${h.text}`);
  console.error("");
}
console.error(`${failures.length} check(s) failed.`);
process.exit(1);
