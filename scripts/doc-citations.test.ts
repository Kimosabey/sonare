/**
 * Every path and command the documentation points at, checked.
 *
 * Eighteen documents cite files and tell people to run commands. Both rot the
 * same way and neither rots loudly: a file is renamed, a script is dropped
 * from `package.json`, and the document keeps pointing at it. The reader finds
 * out by trying it, which is the worst moment and the worst person.
 *
 * `scripts/procurement-claims.test.ts` does this for the one document a school
 * would be sent, and checks its semantic claims too. This is the cheaper,
 * wider half: it makes no judgement about whether any document is *right*,
 * only that the things it names exist.
 *
 * ## Why a doc is worth a test at all
 *
 * The usual answer is that documentation is not code and cannot be tested. The
 * checkable part of it can be, and in this repository documentation carries
 * load: `RELEASE.md` names the steps no gate covers,
 * `PERCEPTION-COURSE-TEMPLATE.md` is what a language reviewer fills in, and
 * `PROCUREMENT.md` is sent to buyers. A stale path in any of those is a person
 * blocked, not a typo.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, ROOT), "utf8");

const docs = readdirSync(new URL("docs/", ROOT))
  .filter((f) => f.endsWith(".md"))
  .map((f) => `docs/${f}`);

const text = new Map(docs.map((d) => [d, read(d)]));

describe("the files the documentation cites", () => {
  it("has documents to check", () => {
    // Non-vacuity: an empty list passes every sweep below.
    expect(docs.length).toBeGreaterThan(5);
  });

  it.each(docs)("%s cites only files that exist", (doc) => {
    const body = text.get(doc) ?? "";
    const cited = [
      ...new Set(
        [
          ...body.matchAll(
            /`((?:src|server|scripts|public|docs|e2e-browser)\/[A-Za-z0-9/._-]+)`/g,
          ),
        ].map((m) => m[1] ?? ""),
      ),
    ];

    for (const path of cited) {
      expect(existsSync(new URL(path, ROOT)), `${doc} cites ${path}, which does not exist`).toBe(
        true,
      );
    }
  });

  /**
   * And at least one document cites something, so the sweep is not passing on
   * an empty set every time.
   */
  it("finds citations across the documentation", () => {
    const total = [...text.values()].reduce(
      (n, body) =>
        n + [...body.matchAll(/`(?:src|server|scripts|public|docs|e2e-browser)\//g)].length,
      0,
    );

    expect(total).toBeGreaterThan(20);
  });
});

describe("the commands the documentation tells people to run", () => {
  const scripts = Object.keys(
    (JSON.parse(read("package.json")) as { scripts?: Record<string, string> }).scripts ?? {},
  );

  it("knows what scripts exist", () => {
    expect(scripts.length).toBeGreaterThan(5);
  });

  it.each(docs)("%s names only npm scripts that exist", (doc) => {
    const body = text.get(doc) ?? "";
    const named = [
      ...new Set([...body.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1] ?? "")),
    ];

    for (const script of named) {
      expect(
        scripts.includes(script),
        `${doc} says to run "npm run ${script}", which package.json does not define`,
      ).toBe(true);
    }
  });

  /**
   * Bare `node scripts/…` invocations too — `voice-check.mjs` and
   * `diagram-check.mjs` are both told to be run that way, being developer
   * tools rather than part of the build.
   */
  it.each(docs)("%s names only node scripts that exist", (doc) => {
    const body = text.get(doc) ?? "";
    const named = [
      ...new Set([...body.matchAll(/node (scripts\/[A-Za-z0-9._-]+)/g)].map((m) => m[1] ?? "")),
    ];

    for (const path of named) {
      expect(existsSync(new URL(path, ROOT)), `${doc} says to run ${path}, which is not there`).toBe(
        true,
      );
    }
  });
});
