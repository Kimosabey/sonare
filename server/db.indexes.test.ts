/**
 * Every index function is actually called by something.
 *
 * `ensureClassIndexes` existed for as long as classes have, documented as
 * "called from the migration runner", and **called by nothing**. So `classes`
 * and `classMembers` carried only `_id_`, and the lookup every pupil join
 * performs — finding a class by the digest of its join code — was a full
 * collection scan.
 *
 * Nothing could see it. The function was correct, its tests passed, the code
 * read properly, and two classes made a scan free. It became visible only by
 * listing the indexes a real cluster actually had, and the symptom at scale
 * would have been joins getting gradually slower rather than anything failing.
 *
 * That is the fifth time this shape has appeared here: a spend cap read and
 * never enforced, a verifier rule claimed and never written, an activity kind
 * built and shipped in no content, a component prop passed by nobody, and now
 * this. Each was invisible for the same reason — **a declaration is not a
 * call**, and a test of the declared thing passes either way.
 *
 * So this file checks the wiring rather than the behaviour.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("./", import.meta.url);

/** Every server source file, tests excluded. */
function sources(dir = "."): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(rel));
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const files = sources();
const text = new Map(files.map((f) => [f, readFileSync(new URL(f, ROOT), "utf8")]));

describe("index creation has one declaration site", () => {
  /**
   * The fix, held in place.
   *
   * The two class indexes lived in a store function that documented itself as
   * "called from the migration runner" and was called by nothing, so neither
   * existed. Two mechanisms for one job is what allowed it: a second list a
   * caller might or might not run.
   *
   * There is one now, `INDEXES` in db.ts, and these check nothing grows a
   * second — an exported `ensure*Indexes` outside db.ts is exactly the shape
   * that went uncalled, and a bare `createIndex` in a store is the same thing
   * written inline.
   */
  it("declares no index outside the table", () => {
    for (const [file, body] of text) {
      if (file.endsWith("db.ts")) continue;
      expect(body, `${file} creates an index outside INDEXES`).not.toMatch(/\.createIndex\(/);
    }
  });

  it("has no ensure*Indexes function outside db.ts", () => {
    for (const [file, body] of text) {
      if (file.endsWith("db.ts")) continue;
      expect(body, `${file} declares its own index function`).not.toMatch(
        /export async function ensure\w*Indexes/,
      );
    }
  });

  it("indexes the lookups a pupil's join performs", () => {
    const db = text.get("db.ts") ?? "";

    // Non-vacuity first: the table is read, not an empty string.
    expect(db).toMatch(/export const INDEXES/);
    expect(db, "no index on the join-code lookup").toMatch(/collection: "classes"[\s\S]{0,120}codeDigest/);
    expect(db, "no index on a class's members").toMatch(
      /collection: "classMembers"[\s\S]{0,120}classId/,
    );
  });
});
