/**
 * Every component and hook is imported by something that ships.
 *
 * This exists because of one bug it would have caught for free. `VowelChart`
 * and its formant estimator were written, reviewed and tested — twenty cases
 * against Peterson & Barney reference vowels — and imported by nobody. Every
 * gate passed. `typecheck` is happy with an unused module, `lint` does not
 * look across files, the component's own tests rendered it directly and went
 * green, and `verify` has no rule about reachability. The corrective screen
 * shipped as dead weight and no learner could get to it.
 *
 * The failure is invisible in exactly the way that matters: nothing breaks. A
 * missing import is a feature that is never wrong, never slow and never seen.
 * Only a check that asks "does anything render this" can see it, so this is
 * that check.
 *
 * It deliberately does not care *which* file imports a module, only that a
 * non-test one does. Tracing a path from a route would be a better question
 * and a far more fragile test; "somebody who ships imports this" catches the
 * whole class at a hundredth of the cost.
 */

import { describe, expect, test } from "vitest";

const globbed = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Paths as `src/<dir>/<file>`, rather than as Vite hands them over.
 *
 * `import.meta.glob` returns paths relative to *this* file, so a sibling in
 * `src/components/` arrives as `./VowelChart.tsx` and everything else as
 * `../pages/Today.tsx`. The first version of this file filtered components
 * with `path.includes("/components/")`, which no sibling ever matches — so the
 * component check ran against an empty list and passed for every build.
 *
 * That is the same failure this file was written to catch, in the file that
 * catches it: green, silent, and vouching for nothing. The hook check was
 * unaffected — `../hooks/…` does contain its directory — which is why the
 * mutation run at the time reported the guard as working.
 */
const modules: Record<string, string> = Object.fromEntries(
  Object.entries(globbed).map(([path, source]) => [
    path.startsWith("./") ? `src/components/${path.slice(2)}` : `src/${path.replace(/^\.\.\//, "")}`,
    source,
  ]),
);

/** Source files that ship — tests are not evidence that anything is reachable. */
function shipping(): [string, string][] {
  return Object.entries(modules).filter(
    ([path]) => !/\.(test|property\.test|contract\.test)\.tsx?$/.test(path),
  );
}

/**
 * Modules that are entry points rather than things imported by a peer.
 *
 * `main.tsx` is the root, and the e2e harness is mounted by a browser test
 * rather than by application code. Everything else has to be reached.
 */
const ENTRY_POINTS = [/\/main\.tsx$/, /\/e2e\/harness\.tsx$/, /\/vite-env\.d\.ts$/];

function isEntryPoint(path: string): boolean {
  return ENTRY_POINTS.some((pattern) => pattern.test(path));
}

/** The basename a sibling would import this module by, without extension. */
function moduleName(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.tsx?$/, "");
}

describe("nothing ships unreachable", () => {
  test("has modules to read, so this cannot pass on an empty glob", () => {
    expect(shipping().length).toBeGreaterThan(50);
  });

  test("every component is imported by something that ships", () => {
    const files = shipping();
    const orphans: string[] = [];

    for (const [path] of files) {
      if (!path.includes("/components/") || !path.endsWith(".tsx")) continue;
      if (isEntryPoint(path)) continue;

      const name = moduleName(path);
      const importedElsewhere = files.some(
        ([other, source]) =>
          other !== path && new RegExp(`from "[^"]*/${name}\\.js"`).test(source),
      );

      if (!importedElsewhere) orphans.push(path);
    }

    expect(orphans, `imported by nothing that ships:\n${orphans.join("\n")}`).toEqual([]);
  });

  test("every hook is imported by something that ships", () => {
    const files = shipping();
    const orphans: string[] = [];

    for (const [path] of files) {
      if (!path.includes("/hooks/")) continue;

      const name = moduleName(path);
      const importedElsewhere = files.some(
        ([other, source]) =>
          other !== path && new RegExp(`from "[^"]*/${name}\\.js"`).test(source),
      );

      if (!importedElsewhere) orphans.push(path);
    }

    expect(orphans, `imported by nothing that ships:\n${orphans.join("\n")}`).toEqual([]);
  });

  /**
   * Non-vacuity. The matcher has to find a module that genuinely nothing
   * imports, or the two tests above would pass just as happily with a broken
   * regex — which is the same shape of mistake as the bug they exist for.
   */
  test("recognises an orphan when there is one", () => {
    const files = shipping();
    const name = "ThisComponentIsImportedByNobody";
    const importedElsewhere = files.some(([, source]) =>
      new RegExp(`from "[^"]*/${name}\\.js"`).test(source),
    );
    expect(importedElsewhere).toBe(false);

    // And the same matcher finds a module that really is imported, so it is
    // not simply answering false to everything.
    const real = files.some(([, source]) => /from "[^"]*\/VowelChart\.js"/.test(source));
    expect(real).toBe(true);
  });
});
