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
  "components/card.css:.lang-card-label": 19,
  "components/toast.css:.toast-close": 24,
  /**
   * Three inside the vowel chart's `viewBox`.
   *
   * SVG text is scaled by the viewBox, not by the root font size, so a token
   * from the type scale would not mean what it means everywhere else — a
   * `--text-sm` label in a 320-unit box renders at whatever the box happens to
   * be drawn at. These are sized in the chart's own coordinate space, which is
   * the only space they exist in.
   */
  "activity.css:.vowel-axis": 9,
  "activity.css:.vowel-label": 11,
  "activity.css:.vowel-landmark": 13,
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
      "activity.css -> 11px",
      "activity.css -> 13px",
      "activity.css -> 9px",
      "base.css -> 9px",
      "components/card.css -> 19px",
      "components/toast.css -> 24px",
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
      expect(source, `${sheet} not found in the glob`).not.toBe("");
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
    /**
     * 58 declarations migrated onto the scale plus the 3 that already used it,
     * then +1 for `.toast-action` — the service-worker update prompt's button
     * (src/styles/components/toast.css) — then +1 for `.listen-mark`, the ✓ / ✕
     * on a chosen `listen` option, and +2 for onboarding's language picker:
     * `.onboarding-language-sample` and `-name`, and +3 for the journey:
     * `.journey-unit-head h2`, `.journey-count` and `.journey-outcome`, and +1
     * for `.sitting-tag`, the NEW/DUE marks on Today's sitting (all
     * src/styles/activity.css), and +5 for the four-destination navigation:
     * `.tab`, `.tab` again at the sidebar width, `.back-link`
     * and `.back-chevron` (src/styles/components/navigation.css), and +2 for
     * the device link: `.link-code` and `.device-link h4`
     * (src/styles/settings.css), and +1 for `.leave-dialog h2`, the
     * leave-a-sitting question (src/styles/activity.css), and +1 for
     * `.class-promise h4`, the two headings on the pupil's copy of what a
     * class can see (src/styles/settings.css), and +1 for `a.enter-cta`, which
     * restates the button rule for anchors carrying that class
     * (src/styles/base.css), and +1 for `a.ghost`, the same restatement for the
     * quieter variant (src/styles/base.css), and +1 for `.vowel-chart h4`, the
     * "how the sound is made" heading (src/styles/activity.css), and +3 for
     * the publish diff (src/styles/authoring.css): the four mono labels
     * (`.publish-diff-versions`, `.diff-tag`, `.diff-where`, `.diff-kind`)
     * share one declaration because they share a step, then `.diff-before,
     * .diff-after` for the two sides of an edit, and `.diff-consequence` for
     * the sentence saying what a change does to a record that already exists,
     * and +4 for board 1h's authoring density (src/styles/authoring.css):
     * `.authoring-status` (the language/published/unsaved line),
     * `.activity-overview th`, `.activity-overview-kind` and
     * `.activity-overview-sounds`, and +6 for the teacher's class view
     * (src/styles/teacher.css): `.class-sounds th`, `.class-sounds tbody th`,
     * `.class-attendance-count`, `.class-attendance-day`,
     * `.sound-bucket-count` and `.sound-bucket-label`, and +0 for the pupil
     * list (board 1g), whose rows take the body size — the only figure on them
     * is a day count, and sizing it apart would make it look like a score.
     *
     * Exact equality on purpose, even though it means every new rule that sets
     * a font-size has to come past this line. That is the notification: a
     * declaration added with a literal lands in the census above instead and
     * fails there, and one added with a var() has to be counted here, so
     * neither can arrive unnoticed.
     */
    const onScale = declarations().filter((d) => d.value.startsWith("var(--text"));
    expect(onScale.length).toBe(93);
  });
});

describe("the two load-bearing steps keep their constraints", () => {
  /**
   * iOS Safari zooms the viewport when a focused form control's text is under
   * 16px. input, select and textarea all sit on --text-md, so the floor is a
   * property of the token rather than of those three rules.
   */
  test("--text-md clears the 16px iOS zoom floor", () => {
    const md = parseScale().get("--text-md");
    expect(md).toBeDefined();
    expect(md as number).toBeGreaterThanOrEqual(16);
  });

  test("the form controls that need that floor are on --text-md", () => {
    // If one of them moves off the token, the floor above stops protecting it
    // and this says so rather than leaving the guarantee half-true.
    // Both live in base.css now: D6 moved textarea up beside the other two
    // form-control defaults, so the floor covers one place rather than two.
    const base = sheets["./base.css"] ?? "";
    const inputRule = base.slice(base.indexOf("input,\nselect {"));
    expect(inputRule.slice(0, inputRule.indexOf("}"))).toContain("font-size: var(--text-md)");
    const textareaRule = base.slice(base.indexOf("textarea {"));
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
