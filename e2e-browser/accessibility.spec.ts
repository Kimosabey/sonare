/**
 * Accessibility, audited in a real browser — as much of N11 as can be
 * automated, and an honest account of what cannot.
 *
 * ## What this is not
 *
 * It is **not** VoiceOver or TalkBack. A screen reader is a person navigating
 * with gestures and hearing a linearised page, and nothing here reproduces
 * that: whether the reading order makes sense, whether a live region fires at
 * the moment it should, whether the swipe that a learner reaches for lands on
 * the control they meant. Those want a person and a device, and N11 stays open
 * for them.
 *
 * What this does catch is the class of defect a manual pass spends most of its
 * time finding and that nobody should be spending a device session on:
 * unlabelled controls, contrast below AA, ARIA that contradicts itself, a
 * heading level skipped, a form field with no name. Those are machine-checkable
 * and now checked on the built app, in both engines, on every screen a learner
 * reaches.
 *
 * ## Why here and not in jsdom
 *
 * Contrast is a rendering fact — it needs the cascade and a real colour to
 * measure. jsdom has neither, so the whole colour half of this is unreachable
 * from the unit suite regardless of how good the assertions are.
 */

import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/** Onboarded, so screens open on themselves rather than the first-run flow. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("sonare.onboarded.v1.anonymous", "2026-01-01T00:00:00.000Z");
  });
});

/**
 * Waits for the screen to be *at rest* before auditing it.
 *
 * Every screen animates in — `.enter-cta` is `animation: rise-in-cta … 250ms
 * both`, so with `both` the element sits in its `from` state until the delay
 * elapses. Auditing before that measures a half-transparent control against
 * the page behind it and reports contrast of 1.18:1 on a link that is
 * perfectly legible once it has arrived.
 *
 * The first version of this file did exactly that and produced two confident,
 * serious-rated findings about colours nobody had got wrong. Contrast is a
 * question about the resting state, so the audit has to wait for one.
 */
async function settle(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  /**
   * And for the screen itself. Routes are hash-based and lazily chunked, so a
   * navigation between two of them does not reload the document and
   * `networkidle` can resolve while the shell is up and the screen is not.
   *
   * That produced the second false finding in this file: "Journey has no
   * level-one heading", on a screen whose heading is the first thing it
   * renders. Every screen renders a `<section>`, so waiting for one waits for
   * the chunk.
   */
  await page.waitForSelector("section", { state: "attached", timeout: 10_000 });
  await page.evaluate(async () => {
    const running = document.getAnimations().map((a) => a.finished.catch(() => undefined));
    await Promise.all(running);
  });
}

/**
 * Every screen this product asks somebody to use.
 *
 * The teacher board is one of them. It was left out while this list said
 * "every address a learner reaches", which is true of the sentence and false
 * of the product: a teacher is a user, the board is a designed surface rather
 * than a debug readout, and the constraints it would be checked against — tap
 * targets, labels, headings, nothing pointer-only — are constraints it is
 * already meant to meet. It is also the most form-dense screen here, which is
 * where a machine check is worth the most. Nothing had ever run axe on it.
 */
const SCREENS: [name: string, path: string][] = [
  ["Today", "/"],
  ["the language picker", "/#/languages"],
  ["a session", "/#/fr"],
  ["Journey", "/#/fr/journey"],
  ["Progress", "/#/fr/progress"],
  ["the You tab", "/#/settings"],
  ["onboarding", "/#/welcome"],
  ["the microphone check", "/#/check"],
  ["the teacher board", "/#/teacher"],
];

/**
 * Screens left out, with the reason — because a hand-written list of
 * everything omits, and this one did.
 *
 * These three are genuinely internal: reached only by typing the address,
 * used by whoever is operating the product rather than by anybody it makes a
 * promise to. That is a real distinction, but it stops being a decision and
 * becomes an oversight the moment it is implied by absence instead of written
 * down — which is exactly how the teacher board sat unchecked.
 */
const NOT_AUDITED: Record<string, string> = {
  "/authoring": "internal content tooling, typed-address only",
  "/diagnostics": "a debug readout, typed-address only",
  "/fixture": "a test-fixture runner, typed-address only",
};

/** Read from the router rather than remembered — see the note above. */
function declaredRoutes(): string[] {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  return [...source.matchAll(/<Route\s+path="([^"]+)"/g)]
    .map((match) => (match[1] ?? "").replace(":slug", "fr"))
    .sort();
}

test.describe("the screens this file audits", () => {
  test("accounts for every route the app declares", () => {
    const audited = new Set(
      SCREENS.map(([, path]) => (path === "/" ? "/" : path.replace(/^\/#/, ""))),
    );

    for (const path of declaredRoutes()) {
      expect(
        audited.has(path) || path in NOT_AUDITED,
        `${path} is neither audited nor listed as out of scope`,
      ).toBe(true);
    }
  });

  test("audits nothing the router does not declare", () => {
    const declared = new Set(declaredRoutes());

    for (const [name, path] of SCREENS) {
      const route = path === "/" ? "/" : path.replace(/^\/#/, "");
      expect(declared.has(route), `${name} audits a dead address`).toBe(true);
    }
    for (const path of Object.keys(NOT_AUDITED)) {
      expect(declared.has(path), `${path} is excluded but no longer exists`).toBe(true);
    }
  });

  /** Non-vacuity: both checks above pass happily against an empty router. */
  test("actually reads the router", () => {
    const paths = declaredRoutes();

    expect(paths.length).toBeGreaterThan(5);
    expect(paths).toContain("/");
    expect(paths).toContain("/fr");
  });
});

test.describe("no violation a machine can see", () => {
  for (const [name, path] of SCREENS) {
    test(`on ${name}`, async ({ page }) => {
      await page.goto(path);
      await settle(page);

      const results = await new AxeBuilder({ page })
        /**
         * WCAG 2.1 A and AA — the level the design constraints already commit
         * to. AAA is not the bar and including it would bury real findings in
         * advice nobody agreed to follow.
         */
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      const summary = results.violations.map(
        (v) => `${v.id} (${v.impact ?? "unknown"}): ${v.help} — ${v.nodes.length} node(s)`,
      );

      expect(summary, `${name} has violations:\n${summary.join("\n")}`).toEqual([]);
    });
  }
});

test.describe("the two things a rule cannot check from source", () => {
  /**
   * Contrast is a rendering fact. The token file records measured ratios in
   * its comments — 12.42:1 on `--signal`, 10.32:1 for `--ink-2` — but a
   * comment is a claim, and what a learner sees is the cascade's answer after
   * every override has applied.
   */
  test("colour contrast holds on the busiest screen", async ({ page }) => {
    await page.goto("/#/fr");
    await settle(page);

    const results = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();

    const failures = results.violations.flatMap((v) =>
      v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary ?? ""}`),
    );
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /**
   * Heading order, on the app rather than per component. Each screen's own
   * suite can only see its own headings; the shell contributes one too, and it
   * was the shell that put a wrong `<h1>` above three screens' own.
   */
  /**
   * One test per screen rather than a loop over them, and that is not style.
   *
   * Routes are hash-based, so navigating between two of them inside one test
   * does not reload the document — and the previous screen's `<section>` is
   * still in the DOM, so every wait a loop could use is already satisfied
   * before the next screen exists. A loop reported "Journey has no level-one
   * heading" about a screen whose heading is the first thing it renders,
   * because it was still looking at the session it had come from.
   *
   * A test per screen gets a fresh page, which is the only wait that cannot
   * be satisfied by the thing it is waiting to replace.
   */
  for (const [name, path] of SCREENS) {
    test(`headings are well formed on ${name}`, async ({ page }) => {
      await page.goto(path);
      await settle(page);

      const results = await new AxeBuilder({ page })
        .withRules(["heading-order", "page-has-heading-one", "empty-heading"])
        .analyze();

      expect(
        results.violations.map((v) => v.id),
        `${name}: ${results.violations.map((v) => v.help).join("; ")}`,
      ).toEqual([]);
    });
  }
});

/**
 * Controls that contain other controls, and why the WCAG sweep above missed
 * eight of them.
 *
 * `<Link><button>Back to today</button></Link>` renders `<a><button></a>`.
 * It is invalid HTML, it is **two tab stops for one action**, a screen reader
 * announces "link, Back to today, button, Back to today", and pressing Enter
 * on the inner button does nothing because the anchor is what navigates. Eight
 * of those shipped.
 *
 * The sweep runs `withTags(["wcag2a", …])`, and axe files `nested-interactive`
 * under `best-practice` rather than any WCAG tag — so a rule that describes
 * exactly this defect was installed, working, and never asked. Naming it is
 * the fix, the same way `color-contrast` and the heading rules are named.
 *
 * The replacement was already in the stylesheet: `a.enter-cta` and `a.ghost`
 * exist to give an anchor a button's shape, with a comment saying so. The
 * pattern was there and these eight sites had not used it.
 */
test.describe("no control contains another control", () => {
  for (const [name, path] of SCREENS) {
    test(`controls do not nest on ${name}`, async ({ page }) => {
      await page.goto(path);
      await settle(page);

      const results = await new AxeBuilder({ page })
        .withRules(["nested-interactive"])
        .analyze();

      expect(
        results.violations.flatMap((v) => v.nodes.map((n) => n.html.slice(0, 90))),
        `${name}: ${results.violations.map((v) => v.help).join("; ")}`,
      ).toEqual([]);
    });
  }
});
