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

describe("index creation is wired, not merely written", () => {
  /** Exported functions whose job is creating indexes. */
  const declared: { file: string; name: string }[] = [];
  for (const [file, body] of text) {
    for (const match of body.matchAll(/export async function (ensure\w*Indexes)\s*\(/g)) {
      declared.push({ file, name: match[1] ?? "" });
    }
  }

  it("finds the index functions at all", () => {
    // Non-vacuity: every check below passes against an empty list, which is
    // precisely the state that would hide the next one of these.
    expect(declared.length).toBeGreaterThan(1);
  });

  it.each(declared.map((d) => [d.name, d.file] as const))(
    "%s is called by something other than its own file",
    (name, file) => {
      const callers = [...text.entries()].filter(
        ([other, body]) => other !== file && new RegExp(`\\b${name}\\s*\\(`).test(body),
      );

      expect(
        callers.map(([f]) => f),
        `${name} is declared in ${file} and called by nothing — see this file's header`,
      ).not.toHaveLength(0);
    },
  );

  /**
   * And the collections whose reads depend on an index have one declared
   * somewhere. Named explicitly, because these are the two the missing call
   * left unindexed and they are both on a pupil's path rather than an
   * operator's.
   */
  it("indexes the lookups a pupil's join performs", () => {
    const all = [...text.values()].join("\n");

    expect(all, "no index on the join-code lookup").toMatch(/createIndex\(\{\s*codeDigest:\s*1\s*\}\)/);
    expect(all, "no index on a class's members").toMatch(/createIndex\(\{\s*classId:\s*1\s*\}\)/);
  });
});
