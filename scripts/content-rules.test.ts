/**
 * The publish rules that exist twice, checked against each other.
 *
 * `src/content/draft.ts` and `server/store/content.ts` implement the same
 * rules deliberately, because neither may import the other: a page cannot
 * import from `server/`, and the store must not reach into `src/` (PRD §6,
 * enforced by `rootDir: server` in the server tsconfig). The duplication is
 * the design. What it costs is that the two can disagree in silence, and the
 * disagreement is asymmetric:
 *
 * - A **stricter screen** refuses a publish the server would have taken. An
 *   annoyance — the author is blocked by a rule that is not real.
 * - A **looser screen** puts a set in front of somebody, tells them it is
 *   fine, and lets the server reject it. That is the one worth a test.
 *
 * `src/content/draft.test.ts` asserts every rule the server holds. This file
 * covers the piece that cannot: the rules stated as **lists of kinds**, where
 * an entry added to one copy typechecks perfectly on both sides and changes
 * what is publishable on only one.
 *
 * ## Why this file lives in scripts/
 *
 * It reads both files from disk, and neither side may read the other's. `src/`
 * is typechecked by tsconfig.json, which carries no Node types on purpose, so
 * a test there cannot `import "node:fs"`; the server's tsconfig has Node but
 * `rootDir: server` puts `src/` out of reach. tsconfig.scripts.json covers
 * `scripts/**` and belongs to neither side, so this is the one place the two
 * can be laid beside each other. Nothing here imports either module — it reads
 * their source as text, which is not a boundary crossing in either direction.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DRAFT = new URL("../src/content/draft.ts", import.meta.url);
const STORE = new URL("../server/store/content.ts", import.meta.url);

/**
 * Pull a `readonly string[]` declaration out of a source file.
 *
 * Returns `null` rather than an empty list when the declaration is absent, so
 * "the constant was renamed" fails loudly instead of comparing two empty
 * lists and passing — which is exactly the shape of vacuous check that let a
 * list-reading test pass against nothing in this repository before.
 */
function declaredList(source: string, name: string): string[] | null {
  const match = new RegExp(
    String.raw`const ${name}: readonly string\[\] = \[([^\]]*)\]`,
  ).exec(source);
  if (!match) return null;

  return (match[1] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0)
    .sort();
}

const draftSource = readFileSync(DRAFT, "utf8");
const storeSource = readFileSync(STORE, "utf8");

describe("the kinds that may reuse a phrase", () => {
  /**
   * The duplicate-target rule stops a phrase being **scored** twice — two
   * accuracies on one sentence, its syllables counted twice in the skills
   * store. Kinds that never open the microphone are outside it, because reuse
   * is how they work: a `locate` plays a phrase the course already teaches and
   * asks which sound was in it.
   *
   * If the server's list is shorter than the screen's, an author is told a
   * course is publishable and the publish is refused. If it is longer, the
   * screen blocks a publish the server would take.
   */
  it("is the same list on both sides of the boundary", () => {
    const draft = declaredList(draftSource, "SILENT_KINDS");
    const store = declaredList(storeSource, "SILENT_KINDS");

    expect(draft, "src/content/draft.ts declares no SILENT_KINDS").not.toBeNull();
    expect(store, "server/store/content.ts declares no SILENT_KINDS").not.toBeNull();
    expect(store).toEqual(draft);
  });

  /**
   * Non-vacuity. Both assertions above hold just as well against two empty
   * lists, and an empty list is a real regression: it would put every kind
   * back inside the rule and refuse the `locate` activities the French course
   * ships.
   */
  it("is not empty on either side", () => {
    expect(declaredList(draftSource, "SILENT_KINDS")?.length).toBeGreaterThan(0);
    expect(declaredList(storeSource, "SILENT_KINDS")?.length).toBeGreaterThan(0);
  });

  /**
   * And the reader itself works. Without this the file passes if `declaredList`
   * silently stops matching anything the day either declaration is reformatted
   * — the two `null` guards catch a rename, but not a reader that returns the
   * wrong thing for a list it *did* find.
   */
  it("reads a list rather than returning whatever it was given", () => {
    const sample = 'const SAMPLE: readonly string[] = ["beta", "alpha"];';

    expect(declaredList(sample, "SAMPLE")).toEqual(["alpha", "beta"]);
    expect(declaredList(sample, "ABSENT")).toBeNull();
  });
});
