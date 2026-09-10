/**
 * The three layers, and the one failure mode this reorganisation introduces.
 *
 * D6 split the sheets into tokens / base / components / screens. Two things
 * about that arrangement are load-bearing and neither is visible to the type
 * system, the linter, or any rendering test:
 *
 * 1. **A sheet can now be orphaned.** src/styles/ is a directory tree, and
 *    all three path-enforced rules in scripts/verify.mjs walk it recursively —
 *    so a sheet that exists on disk and is imported by nobody still satisfies
 *    every one of them. The score-band rule would find `.word.hi` in an
 *    unimported components/chip.css and report the bands as styled while the
 *    product rendered them unstyled. A rule passing on evidence that never
 *    reaches a browser is worse than a rule that fails.
 *
 * 2. **Components must precede screens.** That ordering is what lets a screen
 *    override a shared component at equal specificity, which is the direction
 *    overrides actually travel. It is one line's worth of ordering in
 *    index.css and nothing else enforces it.
 */
import { describe, expect, test } from "vitest";

const sheets = import.meta.glob("./**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Sheet paths on disk, relative to src/styles/, e.g. "components/chip.css". */
const onDisk = Object.keys(sheets)
  .map((p) => p.replace(/^\.\//, ""))
  .sort();

/** The @import list from index.css, in cascade order. */
const imported: string[] = [
  ...(sheets["./index.css"] ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/@import\s+["']\.\/([^"']+)["']\s*;/g),
]
  .map((m) => m[1])
  .filter((s): s is string => s !== undefined);

describe("the sheets are readable at all", () => {
  test("index.css was found and parsed", () => {
    // Guards every assertion below: an empty import list would make the
    // orphan check report that nothing is orphaned.
    expect(sheets["./index.css"], "index.css missing from the glob").toBeDefined();
    expect(imported.length).toBeGreaterThanOrEqual(15);
  });
});

describe("no sheet is orphaned", () => {
  test("every .css on disk is imported by index.css", () => {
    const orphans = onDisk.filter((f) => f !== "index.css" && !imported.includes(f));
    expect(
      orphans,
      "these sheets exist, satisfy every path-based rule in scripts/verify.mjs, and are never loaded",
    ).toEqual([]);
  });

  test("every import resolves to a sheet that exists", () => {
    const missing = imported.filter((f) => !onDisk.includes(f));
    expect(missing, "index.css imports these and they are not on disk").toEqual([]);
  });

  test("nothing is imported twice", () => {
    expect(imported.length).toBe(new Set(imported).size);
  });

  /**
   * The concrete version of failure mode 1, aimed at the rule most likely to
   * pass vacuously. scripts/verify.mjs requires a stylesheet rule for every
   * band that band() can return, and reads all of src/styles/ to find them —
   * so these live in components/chip.css now and it would still pass if that
   * file were unreachable.
   */
  test("the score-band rules live in a sheet that is actually loaded", () => {
    const loaded = imported
      .map((f) => sheets[`./${f}`] ?? "")
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const band of ["hi", "mid", "lo"]) {
      expect(loaded, `.word.${band} is not in any imported sheet`).toContain(`.word.${band}`);
      expect(loaded, `.trajectory-step.${band} is not in any imported sheet`).toContain(
        `.trajectory-step.${band}`,
      );
    }
  });

  /** Same argument for the reduced-motion kill-switch, the other blanket rule. */
  test("the reduced-motion kill-switch is in a sheet that is actually loaded", () => {
    const loaded = imported.map((f) => sheets[`./${f}`] ?? "").join("\n");
    expect(loaded).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(loaded).toMatch(/animation:\s*none\s*!important/);
  });
});

describe("the layers are in order", () => {
  const at = (f: string): number => imported.indexOf(f);
  const components = imported.filter((f) => f.startsWith("components/"));
  const screens = imported.filter((f) => !f.startsWith("components/") && f !== "tokens.css" && f !== "base.css");

  test("there is a component layer and a screen layer to compare", () => {
    expect(components.length).toBeGreaterThanOrEqual(4);
    expect(screens.length).toBeGreaterThanOrEqual(4);
  });

  test("tokens come first, because everything else reads them", () => {
    expect(at("tokens.css")).toBe(0);
  });

  test("base comes before every component", () => {
    for (const c of components) expect(at("base.css")).toBeLessThan(at(c));
  });

  test("every component comes before every screen", () => {
    // The property D6 exists to establish: a screen overriding a shared
    // component at equal specificity has to win, and only order decides that.
    for (const c of components) {
      for (const s of screens) {
        expect(at(c), `${c} must be imported before ${s}`).toBeLessThan(at(s));
      }
    }
  });

  test("motion stays after the sheets whose animations it switches off", () => {
    // It is a blanket `* { animation: none !important }`, so !important wins
    // regardless — but the file has always sat after the animations it kills,
    // and moving it ahead of them would make that no longer readable.
    const animated = imported.filter(
      (f) => f !== "motion.css" && /@keyframes|animation:/.test(sheets[`./${f}`] ?? ""),
    );
    expect(animated.length).toBeGreaterThan(0);
    const firstAnimated = Math.min(...animated.map(at));
    expect(at("motion.css")).toBeGreaterThan(firstAnimated);
  });
});

describe("screens do not keep shared things", () => {
  /**
   * The regression this directory exists to prevent: a control, chip, card or
   * table rule written into a screen sheet because that is the screen someone
   * had open. Three of the classes below were found exactly that way —
   * `.modes` was in diagnostics.css and used only by CaptureSettings,
   * `.lang-card` was in activity.css and used by neither activity screen, and
   * the word/syllable chips were a third of report.css.
   */
  const SHARED_OWNED_BY_COMPONENTS: Record<string, string> = {
    ".modes": "components/control.css",
    ".switch-track": "components/control.css",
    ".lang-card": "components/card.css",
    ".word": "components/chip.css",
    ".sy": "components/chip.css",
    ".streak-chip": "components/chip.css",
    ".hint": "components/text.css",
    ".sr-only": "components/text.css",
    "td.num": "components/table.css",
    ".scroll-x": "components/table.css",
    ".error-details": "components/disclosure.css",
  };

  test("each shared class is defined in its component sheet", () => {
    for (const [cls, sheet] of Object.entries(SHARED_OWNED_BY_COMPONENTS)) {
      const source = (sheets[`./${sheet}`] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(source, `${cls} should be defined in ${sheet}`).toContain(`${cls} {`);
    }
  });

  test("no screen sheet redefines one", () => {
    const screenSheets = onDisk.filter(
      (f) => !f.startsWith("components/") && !["index.css", "tokens.css", "base.css", "motion.css"].includes(f),
    );
    const offenders: string[] = [];
    for (const f of screenSheets) {
      const source = (sheets[`./${f}`] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const cls of Object.keys(SHARED_OWNED_BY_COMPONENTS)) {
        // A bare redefinition, not a scoped override like `.advice .hint`.
        if (new RegExp(`(^|\\n)\\s*\\${cls}\\s*(,[^{]*)?\\{`).test(source)) {
          offenders.push(`${f} redefines ${cls}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
