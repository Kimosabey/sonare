/**
 * The type scale, held in place.
 *
 * D4 collapsed 61 font-size declarations across 19 distinct pixel values onto
 * the seven role-named steps in tokens.css. Nothing about that survives on its
 * own: the next rule anyone writes can put `font-size: 13px` back, and no type
 * error, no lint rule and no rendering test will say a word. That is exactly
 * how the tree got to 19 values in the first place.
 *
 * Read through Vite's `?raw` rather than `node:fs`, because vitest.config.ts
 * keeps src/ free of Node's filesystem APIs on purpose. That also means these
 * assertions depend on `test.css` being on — with Vitest's default the glob
 * still finds every sheet and each one is the empty string, so the count
 * assertion below is not decoration, it is what stops this whole file from
 * passing vacuously.
 */
import { describe, expect, test } from "vitest";

const sheets = import.meta.glob("./**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Sheet name -> source, with the leading "./" stripped for readable failures. */
const named: [string, string][] = Object.entries(sheets)
  .map(([path, source]): [string, string] => [path.replace(/^\.\//, ""), source])
  .sort(([a], [b]) => a.localeCompare(b));

/**
 * The steps, as tokens.css declares them. Parsed rather than restated, so a
 * step renamed or retuned there moves this check with it instead of leaving it
 * asserting a value the stylesheet no longer has.
 */
function parseScale(): Map<string, number> {
  const tokens = sheets["./tokens.css"] ?? "";
  const out = new Map<string, number>();
  for (const m of tokens.matchAll(/(--text-[a-z0-9]+):\s*([\d.]+)px;/g)) {
    const [, name, px] = m;
    if (name !== undefined && px !== undefined) out.set(name, Number(px));
  }
  return out;
}

/**
 * Literals that are deliberately off the scale, each keyed to the rule that
 * owns it. These are icons and one genuine gap, not text — see the OFF THE
 * TYPE SCALE comments at each site. Adding an entry here is meant to be a
 * visible decision in a diff, which is the point of listing them.
 */
const ALLOWED_LITERALS: Record<string, number> = {
  "base.css:.breadcrumb-lang-caret": 9,
  "activity.css:.lang-card-label": 19,
  "toasts.css:.toast-close": 24,
};

describe("the sheets are actually being read", () => {
  // Guards every other assertion in this file. An empty or stubbed glob makes
  // the font-size scan below find nothing and "pass".
  test("every stylesheet is present and non-empty", () => {
    expect(named.length).toBeGreaterThanOrEqual(13);
    for (const [name, source] of named) {
      expect(source.length, `${name} came back empty — is test.css off?`).toBeGreaterThan(0);
    }
  });

  test("tokens.css declares all seven steps", () => {
    const scale = parseScale();
    expect([...scale.keys()].sort()).toEqual(
      ["--text-2xs", "--text-base", "--text-lg", "--text-md", "--text-sm", "--text-xl", "--text-xs"],
    );
  });
});

describe("font sizes come from the scale", () => {
  /** Every font-size declaration outside tokens.css, with its sheet and line. */
  function declarations(): { sheet: string; line: number; value: string }[] {
    const out: { sheet: string; line: number; value: string }[] = [];
    for (const [sheet, source] of named) {
      if (sheet === "tokens.css") continue;
      source.split("\n").forEach((text, i) => {
        const value = /font-size:\s*([^;]+);/.exec(text)?.[1];
        if (value !== undefined) out.push({ sheet, line: i + 1, value: value.trim() });
      });
    }
    return out;
  }

  test("no font-size literal outside the documented exceptions", () => {
    // Keyed by sheet and value rather than by line: the set of literals is the
    // fact worth pinning, and a line number would make every comment edit
    // above one of them a test failure.
    const literals = declarations()
      .filter((d) => /^\d+(\.\d+)?px$/.test(d.value))
      .map((d) => `${d.sheet} -> ${d.value}`);

    expect(literals.sort()).toEqual([
      "activity.css -> 19px",
      "base.css -> 9px",
      "toasts.css -> 24px",
    ]);
  });

  test("the surviving literals match the reasoned-about list", () => {
    // Cross-checks the assertion above against ALLOWED_LITERALS, so the two
    // cannot drift apart into separately-maintained truths.
    const values = declarations()
      .filter((d) => /^\d+(\.\d+)?px$/.test(d.value))
      .map((d) => Number(d.value.replace("px", "")))
      .sort((a, b) => a - b);

    expect(values).toEqual(Object.values(ALLOWED_LITERALS).sort((a, b) => a - b));
  });

  test("each surviving literal is marked OFF THE TYPE SCALE at its own site", () => {
    // The reason has to travel with the value. A bare literal with no note is
    // indistinguishable from one that was simply missed.
    for (const key of Object.keys(ALLOWED_LITERALS)) {
      const [sheet, selector] = key.split(":");
      const source = sheets[`./${sheet}`] ?? "";
      const rule = source.slice(source.indexOf(`${selector} {`));
      const block = rule.slice(0, rule.indexOf("}"));
      expect(block, `${key} has no OFF THE TYPE SCALE note`).toContain("OFF THE TYPE SCALE");
    }
  });

  test("every var() font-size names a step that exists", () => {
    const scale = parseScale();
    const unknown = declarations()
      .filter((d) => d.value.startsWith("var("))
      .filter((d) => {
        const token = /var\((--[a-z0-9-]+)\)/.exec(d.value)?.[1];
        return token === undefined || !scale.has(token);
      })
      .map((d) => `${d.sheet}:${d.line} -> ${d.value}`);

    expect(unknown).toEqual([]);
  });

  test("the scale is actually used, not merely defined", () => {
    // 58 declarations migrated onto the scale plus the 3 that already used it.
    const onScale = declarations().filter((d) => d.value.startsWith("var(--text"));
    expect(onScale.length).toBe(61);
  });
});

describe("the two load-bearing steps keep their constraints", () => {
  /**
   * iOS Safari zooms the viewport when a focused form control's text is under
   * 16px. input/select (base.css) and textarea (content.css) all sit on
   * --text-md, so the floor is a property of the token, not of those rules.
   */
  test("--text-md clears the 16px iOS zoom floor", () => {
    const md = parseScale().get("--text-md");
    expect(md).toBeDefined();
    expect(md as number).toBeGreaterThanOrEqual(16);
  });

  test("the form controls that need that floor are on --text-md", () => {
    // If one of them moves off the token, the floor above stops protecting it
    // and this says so rather than leaving the guarantee half-true.
    const base = sheets["./base.css"] ?? "";
    const content = sheets["./content.css"] ?? "";
    const inputRule = base.slice(base.indexOf("input,\nselect {"));
    expect(inputRule.slice(0, inputRule.indexOf("}"))).toContain("font-size: var(--text-md)");
    const textareaRule = content.slice(content.indexOf("textarea {"));
    expect(textareaRule.slice(0, textareaRule.indexOf("}"))).toContain("font-size: var(--text-md)");
  });

  /**
   * .sk-bar holds the score card's shape for the ~1.4s the provider takes, so
   * the real numbers replace it in place. Its height is a hand-computed
   * --text-lg x 1.1; if the step moves and the height does not, the page jumps
   * on every attempt and no test would otherwise notice.
   */
  test("--text-lg still matches the skeleton bar's hand-computed height", () => {
    const lg = parseScale().get("--text-lg");
    expect(lg).toBeDefined();
    const report = sheets["./report.css"] ?? "";
    const skBar = report.slice(report.indexOf(".sk-bar {"));
    const height = Number(/height:\s*(\d+)px;/.exec(skBar.slice(0, skBar.indexOf("}")))?.[1]);
    expect(height).toBe(Math.round((lg as number) * 1.1));
  });
});
