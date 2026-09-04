#!/usr/bin/env node
/**
 * T17 — the checks no type system catches. Written early on purpose: these are
 * cheap, and each one guards a rule whose violation silently invalidates the POC.
 *
 * Sources: CLAUDE.md "Verification" and HANDOFF.md "Verification".
 * Run: npm run verify
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
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
 * Flag every pattern in `patterns` that is *absent* from `file`. The mirror of
 * forbid, for rules whose violation is a missing line rather than a present
 * one — those are invisible to a grep-based check and, in the CSS case below,
 * to the type system and the test suite as well.
 */
function require({ rule, what, why, file, patterns }) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const hits = [];
  for (const { pattern, label } of patterns) {
    if (!pattern.test(text)) hits.push({ file, line: 0, text: `missing: ${label}` });
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

  require({
    rule: "T12",
    what: "a band with no rule in the stylesheet",
    why: "Scores would render unstyled — no type error, no test failure, no visible error.",
    file: "src/styles.css",
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
