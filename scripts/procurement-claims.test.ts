/**
 * The claims in `docs/PROCUREMENT.md`, checked against the code they cite.
 *
 * That document is written to be sent to a school. It answers the two
 * questions that come before pedagogy in an education procurement — what
 * happens to children's data, and whether the thing is accessible — and every
 * claim in it names what enforces it.
 *
 * A citation is only worth something while it is true. A file gets renamed, a
 * guard gets deleted, a sentence gets rewritten, and the document keeps
 * asserting to a buyer that something holds. That is a worse failure than an
 * uncited claim, because it looks like diligence.
 *
 * So the citations are checked. Not the prose — this cannot know whether the
 * argument is sound — but the load-bearing, checkable half: that the files
 * named exist, that the guards named still guard, and that the sentence
 * attributed to `attempts.ts` is actually in `attempts.ts`.
 *
 * This is the same posture the document itself takes: state what is enforced,
 * enforce what is stated.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, ROOT), "utf8");
const doc = read("docs/PROCUREMENT.md");

describe("every file the document cites", () => {
  /** Backticked paths that look like files, taken from the doc itself. */
  const cited = [
    ...new Set(
      [...doc.matchAll(/`((?:src|server|scripts|public|docs)\/[A-Za-z0-9/._-]+)`/g)].map(
        (m) => m[1] ?? "",
      ),
    ),
  ];

  it("finds citations to check", () => {
    // Non-vacuity: a document with no citations would pass the sweep below.
    expect(cited.length).toBeGreaterThan(4);
  });

  it.each(cited)("%s exists", (path) => {
    expect(existsSync(new URL(path, ROOT)), `${path} is cited and does not exist`).toBe(true);
  });
});

describe("the claims that are checkable", () => {
  /**
   * The strongest claim in the document, and the one a data officer asks
   * about first. `SAVE_AUDIO_DIR` is the single path that can write a
   * learner's voice to disk, and the document says it is off unless set and
   * warns on every write.
   */
  it("keeps learner audio unpersisted except behind the diagnostic flag", () => {
    const route = read("server/routes/pronunciation.ts");

    expect(route).toMatch(/const dir = process\.env\.SAVE_AUDIO_DIR;\s*\n\s*if \(!dir\) return;/);
    expect(route, "a write with no warning beside it").toMatch(
      /logger\.warn\([^)]*SAVE_AUDIO_DIR is set/,
    );
    // And nothing else in the server writes audio.
    const others = read("server/attempts.ts");
    expect(others).not.toMatch(/writeFile\(/);
  });

  /** The sentence the document attributes to `attempts.ts`, in `attempts.ts`. */
  it("quotes attempts.ts accurately", () => {
    expect(doc).toMatch(/storing learner voice recordings is a data-protection decision/);
    expect(read("server/attempts.ts")).toMatch(
      /storing\s*\n?\s*\*?\s*learner voice recordings is a data-protection decision, not a build one/,
    );
  });

  /**
   * "No analytics, no third-party tracking." Enforced by verify.mjs T17 rather
   * than by anybody remembering, which is the difference the document is
   * implicitly claiming.
   */
  it("still has the rule that makes the no-tracking claim true", () => {
    const verify = read("scripts/verify.mjs");

    expect(verify).toMatch(/rule: "T17"/);
    expect(verify).toMatch(/google-analytics|googletagmanager/);
  });

  /**
   * "The application makes no third-party request at all." The fonts were the
   * only one; this is what keeps them local.
   */
  it("still has the guard that keeps the fonts on this origin", () => {
    expect(existsSync(new URL("scripts/fonts-selfhosted.test.ts", ROOT))).toBe(true);
    const markup = read("index.html").replace(/<!--[\s\S]*?-->/g, "");
    expect(markup).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  /**
   * "A teacher sees their own class, and no other." The guard the document
   * names has to be mounted, not merely written — the failure this
   * repository has hit five times.
   */
  it("still mounts the class-ownership guard on every teacher route", () => {
    /**
     * Counted, not merely present. The first version asked whether the name
     * appeared in the file, which the import satisfies on its own — so
     * deleting one mount left two and the assertion passed. That is the third
     * time that exact vacuity has appeared here, and each time the fix is the
     * same: count the thing, or compare it to what it should equal.
     *
     * Every route addressing a `:classId` behind the operator token must carry
     * it. `server/middleware/classOwner.test.ts` makes the same check from the
     * other side and explains why the pupil routes are exempt.
     */
    const routes = read("server/routes/classes.ts");
    const handlers = routes.match(/classesRouter\.(get|post|delete)\([\s\S]*?\(req: Request/g) ?? [];
    const teacherRoutes = handlers.filter(
      (block) => block.includes(":classId") && block.includes("requireDiagnosticsToken"),
    );

    expect(teacherRoutes.length, "no teacher route addresses a class").toBeGreaterThan(2);
    for (const block of teacherRoutes) {
      const route = /"([^"]+)"/.exec(block)?.[1] ?? "?";
      expect(block, `${route} does not check who is asking`).toMatch(/requireClassOwner/);
    }
    expect(read("server/middleware/classOwner.ts")).toMatch(/export function requireClassOwner/);
  });
});
