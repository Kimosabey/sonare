/**
 * Every rule the verifier enforces is written down where people look.
 *
 * `docs/CLAUDE.md` is the first thing an engineer or an agent reads before
 * touching this repository, and its verification section named **four** of the
 * verifier's rules for months while the file enforced **fourteen**. The four it
 * named were the four that existed when it was written; everything added since
 * — the tap floor, the reduced-motion blanket, the untracked-file guard, the
 * anti-gamification constraint the product is *sold* on — was enforced by the
 * build and described nowhere.
 *
 * That is worse than it sounds, because the gap runs the wrong way. A rule
 * nobody has read is a rule somebody breaks by accident and then experiences as
 * an inexplicable build failure, which is how a verifier earns a reputation for
 * being in the way. The same section also listed three gates where there are
 * five, so anybody following it literally never ran the suite.
 *
 * ## Why a test rather than care
 *
 * This is the fourth hand-maintained list of "everything" in this project to be
 * found wrong — the others were a route list, a phoneme list, and the
 * procurement claims, all of which now read from the source. A list that is
 * correct today and updated by remembering is a list that is wrong later. This
 * one is short enough to live in prose, so the prose is held to the source
 * instead of replaced by it.
 *
 * ## Why this lives in scripts/
 *
 * It reads `scripts/verify.mjs` and `docs/CLAUDE.md` from disk. `src/` is
 * typechecked without Node types on purpose, so a test there cannot use
 * `node:fs`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);
const verifier = readFileSync(new URL("scripts/verify.mjs", ROOT), "utf8");
const claudeMd = readFileSync(new URL("docs/CLAUDE.md", ROOT), "utf8");

/**
 * The rule headings in the verifier, which is where its sections are named.
 *
 * Read from the section banners rather than from a list in this file, because a
 * list here would be the fifth hand-maintained inventory and would go stale the
 * same way. The report banner at the bottom is not a rule and is dropped.
 */
function ruleHeadings(): string[] {
  return [...verifier.matchAll(/^\/\/ ── (.+?) ─+$/gm)]
    .map((m) => (m[1] ?? "").trim())
    .filter((heading) => heading !== "report");
}

/** The identifier a heading leads with — "R1", "T16", "rate limiting". */
function ruleName(heading: string): string {
  return (heading.split("—")[0] ?? "").trim();
}

describe("the verifier's rules", () => {
  it("has rules to check, read from the file rather than listed here", () => {
    /**
     * The guard on the guard. Every assertion below iterates this list, so a
     * regex that stopped matching — a heading style changed, the banners
     * reformatted — would empty it and turn the rest of this file into three
     * tests that pass by having nothing to do.
     */
    expect(ruleHeadings().length).toBeGreaterThanOrEqual(10);
  });

  it("names every one of them in docs/CLAUDE.md", () => {
    const missing = ruleHeadings()
      .map(ruleName)
      .filter((name) => !claudeMd.includes(name));

    expect(missing).toEqual([]);
  });

  it("does not have CLAUDE.md claiming a rule the verifier does not enforce", () => {
    /**
     * The other direction, and the one that matters more. A documented rule
     * that nothing enforces is the shape of mistake this repository keeps
     * finding: the checklist asserted an anti-leaderboard verifier rule for
     * months and there was none, so the constraint the product is sold on was
     * a claim rather than a build failure.
     *
     * Scoped to the section, not the whole document — `R1`–`R12` are also the
     * hard-rules table above, and most of those are enforced by review rather
     * than by a script.
     */
    const section = claudeMd.slice(
      claudeMd.indexOf("`npm run verify` fails the build on"),
      claudeMd.indexOf("The browser suite"),
    );
    expect(section.length).toBeGreaterThan(0);

    const enforced = new Set(ruleHeadings().map(ruleName));
    const claimed = [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => (m[1] ?? "").trim());

    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed.filter((name) => !enforced.has(name))).toEqual([]);
  });

  it("tells the reader to run all five gates, not three", () => {
    /**
     * The omission that cost the most. This section listed typecheck, lint and
     * verify, so anybody following it literally never ran the suite or the
     * build — and a type error can survive typecheck and surface only when the
     * build resolves the graph.
     */
    const commands = claudeMd.slice(
      claudeMd.indexOf("## Verification before declaring anything done"),
      claudeMd.indexOf("Then the manual check"),
    );

    for (const gate of ["npm run typecheck", "npm run lint", "npm run verify", "npm test", "npm run build"]) {
      expect(commands).toContain(gate);
    }
  });
});
