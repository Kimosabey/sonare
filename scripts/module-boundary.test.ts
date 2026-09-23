/**
 * The client and the server do not reach into each other.
 *
 * `server/store/content.ts` duplicates `Activity`, the activity-kind union and
 * the silent-kind list, all of which already exist in `src/activities/`. That
 * duplication is deliberate and it only makes sense if the boundary it exists
 * to respect is actually held. Until now nothing held it: the rule was stated
 * in two comments, obeyed by everyone who happened to read them, and enforced
 * by nothing.
 *
 * ## The two directions fail differently
 *
 * **A page importing from `server/`** is the dangerous one. Vite follows the
 * import and bundles what it finds, so server code ships to the browser — with
 * whatever it reads from `process.env` inlined into the bundle. `verify.mjs`
 * already refuses a bundle containing a `KEY` or `SECRET` value, which catches
 * the worst outcome; this catches the cause, and also the cases that leak no
 * credential but ship database code to a learner's phone.
 *
 * **The server importing from `src/`** is not a security problem, it is a
 * portability one. `src/` is typechecked for the browser and freely reaches
 * for `localStorage`, `window` and React. A server module that pulls one of
 * those in fails at require time, in production, on a path that may not run
 * until somebody publishes.
 *
 * ## Why the tests are exempt, and why that is not a hole
 *
 * A server contract test importing `src/sync/wire.ts` is the *point* of a
 * contract test: it asserts the two independent definitions still agree, which
 * cannot be done from one side. Those imports never reach a running server,
 * because `tsconfig.server.build.json` excludes every test file from
 * the server build.
 *
 * `scripts/` is exempt entirely. Tooling is allowed to know about both halves
 * — `generate-model-voice.ts` reads the bundled languages from `src/` and the
 * cache from `server/`, which is exactly what a build script is for.
 *
 * ## Why this lives in scripts/
 *
 * It walks the tree with `node:fs`. `src/` is typechecked without Node types
 * on purpose, so a test there cannot.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `fileURLToPath`, not `URL.pathname`. The latter is percent-encoded, so a
 * checkout under a directory with a space in its name — this one is under
 * "Kimo's Garage" — yields a path `readdirSync` cannot open, and the whole
 * file fails to collect with "no tests" rather than a failure anybody reads
 * as a failure.
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Every TypeScript source file under a directory, tests included. */
function sourcesIn(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...sourcesIn(rel));
    } else if (/\.(m?ts|tsx)$/.test(entry.name)) {
      found.push(rel);
    }
  }
  return found;
}

/**
 * The specifiers a file imports, from `import` and from `export … from`.
 *
 * Deliberately not a parse. A regex over the two statement forms is enough to
 * find a path, and the failure mode of missing one is a boundary crossing this
 * does not catch — not a false accusation, which is the failure that would
 * make the test worth deleting.
 */
function importsOf(file: string): string[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  return [...text.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

/** A file that may know about both halves, and why. */
function isContractTest(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

describe("the client/server module boundary", () => {
  const clientFiles = sourcesIn("src");
  const serverFiles = sourcesIn("server");

  it("has files to check on both sides", () => {
    /**
     * The guard on the guard. Both assertions below iterate these lists, and a
     * walk that returned nothing — a renamed directory, a changed extension —
     * would leave two tests passing by having nothing to look at.
     */
    expect(clientFiles.length).toBeGreaterThan(50);
    expect(serverFiles.length).toBeGreaterThan(20);
  });

  it("keeps server code out of the browser bundle", () => {
    /**
     * No exemption for tests here, unlike the other direction. A client test
     * importing from `server/` is how a server module first becomes reachable
     * from `src/`, and the browser bundle is the thing that must not contain
     * database code — there is no version of this that is only a test concern.
     */
    const crossing = clientFiles.filter((file) =>
      importsOf(file).some((specifier) => /(^|\/)\.\.\/server\//.test(specifier)),
    );

    expect(crossing, "a file under src/ imports from server/").toEqual([]);
  });

  it("keeps browser code out of the running server", () => {
    const crossing = serverFiles
      .filter((file) => !isContractTest(file))
      .filter((file) => importsOf(file).some((specifier) => /(^|\/)\.\.\/src\//.test(specifier)));

    expect(crossing, "a server module that runs in production imports from src/").toEqual([]);
  });

  it("keeps the build's test exclusion, which is what makes the exemption safe", () => {
    /**
     * The contract tests are allowed across because they are compiled out. If
     * that exclusion ever goes, the exemption above stops being an exemption
     * and becomes the hole — server builds would start pulling React and
     * `localStorage` in through a test file.
     */
    const config = readFileSync(join(ROOT, "tsconfig.server.build.json"), "utf8");

    expect(config).toMatch(/\*\*\/\*\.test\.ts/);
  });
});
