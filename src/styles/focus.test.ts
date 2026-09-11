/**
 * The focus ring, and the tokens the stylesheet claims to have.
 *
 * src/e2e/accessibility.test.tsx says of itself, in its own header: "a rule
 * that removed every focus ring in the product would not disturb one assertion
 * here (WCAG 2.4.7)". jsdom paints nothing and does not evaluate
 * `:focus-visible`, so that is not a gap anyone can close from the DOM side.
 * It is closeable from the stylesheet side, which is what this file does.
 *
 * Reads the sheets through Vite's `?raw` — see the note at the top of
 * scale.test.ts for why not node:fs, and why `test.css` has to be on.
 */
import { describe, expect, test } from "vitest";

const sheets = import.meta.glob("./**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const accessibilitySuite = import.meta.glob("../e2e/accessibility.test.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Comments removed before anything structural is asked.
 *
 * Learned the hard way while writing this file: the sheets in this repo are
 * heavily commented, and several of those comments quote the very selectors
 * and token names being checked for. Unstripped, the "one ring, defined once"
 * count came back 2 — the second "match" was the prose explaining why
 * programmatic focus uses `:focus` — and the phantom-token check reported
 * --faint as still present because the comment recording its removal names it.
 *
 * A comment is not a rule. Every assertion below reads `css`, not `raw`.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

const ordered = Object.entries(sheets).sort(([a], [b]) => a.localeCompare(b));

/** Every sheet's source concatenated — "does a rule exist anywhere" questions. */
const css = ordered.map(([, source]) => stripComments(source)).join("\n");

/** Attribute-selector quoting is optional in CSS, so compare without it. */
function norm(selector: string): string {
  return selector.replace(/["']/g, "");
}

/**
 * The interactive roles, read out of the accessibility suite's own INTERACTIVE
 * list rather than restated here.
 *
 * scripts/verify.mjs does the same thing for score bands — it parses band()'s
 * return type so that renaming a band moves the check with it — and names the
 * failure mode explicitly rather than letting an empty parse pass. The same
 * applies here: two hand-maintained copies of "everything that takes a pointer
 * or a keypress" is the drift this revamp exists to remove.
 */
function interactiveRoles(): string[] {
  const source = Object.values(accessibilitySuite)[0] ?? "";
  const block = /const INTERACTIVE = \[([\s\S]*?)\]\.join/.exec(source)?.[1] ?? "";
  // Line by line, with the outer quote captured and required to close the
  // entry. The entries include '[role="button"]', whose inner double quotes
  // defeat a naive /["']([^"']+)["']/ scan — that reads it as `[role=` and
  // then reports the role as uncovered, which is a false failure pointing at
  // the stylesheet for a bug in the parse.
  return block
    .split("\n")
    .map((line) => /^\s*(["'])(.+?)\1\s*,?\s*$/.exec(line.trim())?.[2])
    .filter((s): s is string => s !== undefined);
}

describe("the inputs to this file are actually readable", () => {
  test("every stylesheet came back non-empty", () => {
    const empty = ordered.filter(([, source]) => source.length === 0).map(([path]) => path);
    expect(empty, "sheets read as empty — is test.css off in vitest.config.ts?").toEqual([]);
  });

  test("the accessibility suite's INTERACTIVE list parses", () => {
    // Without this the coverage test below would iterate an empty list and
    // report that the stylesheet covers every one of nothing.
    const roles = interactiveRoles();
    expect(
      roles.length,
      "could not parse INTERACTIVE from src/e2e/accessibility.test.tsx — if that " +
        "list moved or was reformatted, update interactiveRoles() here to match",
    ).toBeGreaterThanOrEqual(13);
    expect(roles).toContain("button");
    expect(roles).toContain("a[href]");
    expect(roles).toContain("summary");
  });
});

describe("one focus treatment, on every interactive role", () => {
  test("each interactive role has a :focus-visible rule", () => {
    const covered = norm(css);
    const missing = interactiveRoles().filter(
      (role) => !covered.includes(`${norm(role)}:focus-visible`),
    );
    expect(missing, "these roles take a keypress and show nothing when focused").toEqual([]);
  });

  test("the treatment is defined once, not per sheet", () => {
    // The point of D5 is one answer to this question. Counting the blocks that
    // actually set an outline on a focus-visible selector catches a screen
    // sheet quietly growing its own ring again.
    const ringBlocks = [...css.matchAll(/:focus-visible[^{]*\{([^}]*)\}/g)].filter(([, body]) =>
      /outline:/.test(body ?? ""),
    );
    expect(ringBlocks.length).toBe(1);
  });

  test("nothing suppresses a focus ring without replacing it", () => {
    /**
     * `outline: none` on a focus selector is the single most common way a
     * product loses its keyboard affordance, and it is invisible to everything
     * else in this repo: it type-checks, it lints, and the jsdom suite cannot
     * see a painted ring. The breadcrumb language select shipped exactly this.
     */
    const suppressors = [...css.matchAll(/([^{}]*:focus[^{]*)\{([^}]*)\}/g)]
      .filter(([, , body]) => /outline:\s*(none|0)\b/.test(body ?? ""))
      .map(([, selector]) => (selector ?? "").trim().replace(/\s+/g, " "));
    expect(suppressors).toEqual([]);
  });

  test("the ring's colour comes from a token, not a literal", () => {
    // A hex here would be a second copy of --signal, correct on the day it was
    // picked and silently wrong the next time the palette moves. It is also
    // what lets settings.css recolour the ring for the destructive button with
    // one `outline-color` rather than a redeclaration of the whole treatment.
    const tokens = stripComments(sheets["./tokens.css"] ?? "");
    const ring = /--focus-ring:\s*([^;]+);/.exec(tokens)?.[1];
    expect(ring, "--focus-ring is not defined").toBeDefined();
    expect(ring as string).toContain("var(--");
    expect(ring as string).not.toMatch(/#[0-9a-f]{3,8}|\brgb|\bhsl/i);
  });
});

describe("the dimmed-text utility exists", () => {
  /**
   * `.dim` had no standalone rule — only `.trajectory-step.dim` in report.css
   * — while five sites across App.tsx, Progress.tsx, Today.tsx and
   * ActivityReport.tsx used `className="dim"` and got full-weight --ink. The
   * worst of them paired it with `.gain`: the rising and falling halves of a
   * trend rendered identically, so the markup's distinction vanished.
   */
  test(".dim resolves to a standalone rule", () => {
    expect(css).toMatch(/(^|\n)\.dim\s*\{/);
  });

  test(".dim and .gain are both styled, since they are used as a pair", () => {
    expect(css).toMatch(/(^|\n)\.gain\s*\{/);
  });

  test(".dim uses the muted-ink token", () => {
    const rule = /(^|\n)\.dim\s*\{([^}]*)\}/.exec(css)?.[2] ?? "";
    expect(rule).toContain("var(--dim)");
  });
});

describe("no phantom tokens", () => {
  /**
   * `var(--faint, var(--dim))` and `var(--rule-strong, var(--dim))` sat in
   * report.css referring to two custom properties that were defined nowhere.
   * They resolved to the fallback and rendered correctly, so nothing failed —
   * the cost was a reader grepping for a token that does not exist, and a
   * design system that appeared to have two steps it did not have.
   *
   * This is the general form of that bug, so the next one is caught on the
   * commit that introduces it. A fallback is not an excuse: referring to a
   * token that does not exist is the thing being ruled out, with or without
   * one.
   */
  test("every custom property the sheets read is also defined", () => {
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const referenced = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]));
    const undefinedRefs = [...referenced].filter((name) => !defined.has(name)).sort();
    expect(undefinedRefs).toEqual([]);
  });

  test("--faint and --rule-strong are gone rather than half-present", () => {
    expect(css).not.toContain("--faint");
    expect(css).not.toContain("--rule-strong");
  });

  /**
   * The mirror of the rule above, and the one that had no checker.
   *
   * A custom property whose ONLY definition sits inside an `@media` or
   * `@supports` block resolves to nothing for every visitor the query does not
   * match. `var(--x)` with no fallback then makes the whole declaration
   * invalid-at-computed-value-time and the property lands on its initial value
   * — `color: unset` reading as black, a background reading as transparent.
   * Nothing fails: the sheet parses, the phantom-token check above sees the
   * name defined, and the page is simply wrong for whoever fell outside the
   * query.
   *
   * The removed dark palette satisfied this by construction — it held its
   * values in the bare `:root` and let the two theme blocks point at them, so
   * there was no literal inside either block to be missing. That construction
   * is gone with the blocks, and this is what replaces it.
   */
  test("no custom property is defined only inside an at-rule", () => {
    const atRuleOnly = new Set<string>();
    const everywhereElse = new Set<string>();

    for (const [, source] of ordered) {
      const sheet = stripComments(source);
      // Brace-walk rather than regex the blocks: an `@media` body holds whole
      // rules, so its braces nest and a non-greedy match would stop at the
      // first inner close.
      let depth = 0;
      /** The depth at which the enclosing at-rule opened, or 0 for none. */
      let insideAtRule = 0;
      let buf = "";
      const record = (): void => {
        const name = /(--[a-z0-9-]+)\s*:/.exec(buf)?.[1];
        if (name !== undefined) (insideAtRule > 0 ? atRuleOnly : everywhereElse).add(name);
        buf = "";
      };
      for (const ch of sheet) {
        if (ch === "{") {
          depth += 1;
          if (insideAtRule === 0 && /@(?:media|supports|container)\b/.test(buf)) {
            insideAtRule = depth;
          }
          buf = "";
        } else if (ch === "}") {
          // Before the reset below, and before the depth changes: a block's
          // last declaration may carry no trailing semicolon, and the sheets
          // here write several of those on one line.
          record();
          if (insideAtRule === depth) insideAtRule = 0;
          depth -= 1;
        } else if (ch === ";") {
          record();
        } else {
          buf += ch;
        }
      }
    }

    const orphaned = [...atRuleOnly].filter((name) => !everywhereElse.has(name)).sort();
    expect(
      orphaned,
      "these resolve to nothing for any visitor the query does not match",
    ).toEqual([]);
  });
});

describe("the page paints its own ground", () => {
  /**
   * Two declarations carry the entire "this app is light" decision now that
   * there is no second palette behind them, and neither was covered by
   * anything: the suite ran green with both deleted.
   *
   * They are not interchangeable. `background-color` is what the page paints;
   * `color-scheme` is what the *browser* paints around and inside it — the
   * scrollbars, the select popup, the overscroll canvas, the form-control
   * defaults — and a stylesheet cannot reach any of that. Drop the first and a
   * visitor on a dark OS gets --ink text on whatever ground the UA chose.
   * Drop the second and they get a correctly light page framed in dark chrome.
   */
  test("body sets its background explicitly, from a token", () => {
    const body = /(^|\n)body\s*\{([^}]*)\}/.exec(stripComments(sheets["./base.css"] ?? ""))?.[2];
    expect(body, "no body rule found in base.css").toBeDefined();
    expect(body as string).toMatch(/background(-color)?:\s*var\(--/);
  });

  test("color-scheme is stated, and stated as light", () => {
    // The leading boundary is load-bearing: without it this matches the
    // `prefers-color-scheme:` of a media query prelude and reports the page as
    // declaring a scheme it never sets. Same shape as the height/width guard
    // in scripts/verify.mjs, for the same reason.
    const declarations = [...css.matchAll(/(?:^|[;{\s])color-scheme:\s*([^;}]+)/g)].map((m) =>
      (m[1] ?? "").trim(),
    );
    expect(declarations, "nothing declares color-scheme").not.toEqual([]);
    // Resolved, not spelt: a `var()` here would have to be chased, and the
    // indirection that made one worth having went with the theme blocks.
    expect([...new Set(declarations)]).toEqual(["light"]);
  });
});
