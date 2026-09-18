/**
 * The four widths the design boards are drawn at.
 *
 * Every board carries one: 360 and 430 for a phone, 768 for a tablet, 1280 for
 * a desk. Seven checklist items sat at "partial" for one reason — the CSS is
 * fluid and *nothing exercised those numbers*. jsdom reports no viewport at
 * all, and the existing browser suite used 390 and 900, which are neither the
 * boards' widths nor either side of the 620/1100 breakpoints by much.
 *
 * What is asserted here is deliberately not "it looks right". It is the three
 * things a wrong layout does that a reader can measure: content escapes the
 * viewport sideways, a target shrinks below its floor, or a per-width
 * composition silently fails to happen.
 */

import { expect, test } from "@playwright/test";

/** The boards' own widths, with a plausible height for each. */
const WIDTHS = [
  { name: "360 · the narrowest phone a board is drawn at", width: 360, height: 780 },
  { name: "430 · a large phone", width: 430, height: 932 },
  { name: "768 · a tablet, above the 620 rail breakpoint", width: 768, height: 1024 },
  { name: "1280 · a desk, above the 1100 sidebar breakpoint", width: 1280, height: 900 },
] as const;

/**
 * The routes each width is checked on.
 *
 * `/teacher` is in the list and it is not an oversight. It renders its limits
 * and capability table without a token, and it is the **only** route in the
 * product with a wide table — every learner route measured zero
 * `.table-scroll` containers, which is why an early mutation breaking
 * `overflow-x` passed this file untouched. A sideways-scroll test whose routes
 * contain nothing wide is a test about nothing.
 */
const ROUTES = [
  "/",
  "/#/languages",
  "/#/fr",
  "/#/fr/journey",
  "/#/fr/progress",
  "/#/settings",
  "/#/teacher",
];

/**
 * The least this file must actually look at, per route.
 *
 * Both loops below report offenders, and a loop over nothing reports none — so
 * each one states its own sample size. Three routes render no `<button>` at
 * all, which is fine and was worth finding out rather than assuming.
 */
const MIN_CONTROLS_INSPECTED = 4;
const MIN_ELEMENTS_INSPECTED = 30;

async function settle(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("section", { state: "attached", timeout: 10_000 });
  await page.evaluate(async () => {
    const running = document.getAnimations().map((a) => a.finished.catch(() => undefined));
    await Promise.all(running);
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("sonare.onboarded.v1.anonymous", "2026-01-01T00:00:00.000Z");
  });
});

/**
 * One test per width **and per route**, rather than a loop over routes inside
 * one test.
 *
 * This is not a style choice. The app is a HashRouter, so going from
 * `/#/settings` to `/#/teacher` changes the hash and **does not reload the
 * document** — and `settle()` waits for a `<section>` that the previous screen
 * has already provided. A loop therefore measured the first route seven times
 * and reported a pass for six pages it never rendered.
 *
 * This repo has learned that once already: `accessibility.spec.ts` carries the
 * same note, and `layout.spec.ts` is shaped this way for the same reason. It
 * was found here by a 1,400px table planted on `/#/teacher` that the suite
 * cheerfully ignored — the document scrolled to 1,420px and every test passed,
 * because the page under measurement was still Settings.
 *
 * A test per pair gets a fresh page from Playwright's fixture, which makes
 * every `goto` a real navigation.
 */
for (const size of WIDTHS) {
  for (const route of ROUTES) {
    test.describe(`${size.name} · ${route}`, () => {
      /**
       * Sideways scroll is the failure mode of a fluid layout, and it is
       * always one element rather than the page: a table, a code, a long
       * phrase. The assertion names the widest offender, because "the page
       * scrolls" is not actionable and "`.class-sounds` is 1,412px in a 360px
       * viewport" is.
       */
      test("does not scroll sideways", async ({ page }) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(route);
        await settle(page);

        const overflow = await page.evaluate((viewport) => {
          const offenders: string[] = [];
          for (const element of document.querySelectorAll("body *")) {
            const box = element.getBoundingClientRect();
            if (box.width === 0) continue;
            // A container that scrolls its own content is the intended escape
            // hatch, so it is allowed to be wider than what holds it.
            const style = getComputedStyle(element);
            if (style.overflowX === "auto" || style.overflowX === "scroll") continue;
            if (box.right > viewport + 1) {
              offenders.push(
                `${element.tagName.toLowerCase()}.${element.className || "(no class)"} → ${Math.round(box.right)}px`,
              );
            }
          }
          return {
            offenders,
            inspected: document.querySelectorAll("body *").length,
            scrollWidth: document.documentElement.scrollWidth,
          };
        }, size.width);

        // Non-vacuity. A loop over an empty page reports no offenders and
        // reads exactly like a pass.
        expect(
          overflow.inspected,
          `${route} at ${size.width}px rendered almost nothing to measure`,
        ).toBeGreaterThanOrEqual(MIN_ELEMENTS_INSPECTED);

        expect(overflow.offenders, overflow.offenders.join("\n")).toEqual([]);
        expect(overflow.scrollWidth, "the document itself scrolls sideways").toBeLessThanOrEqual(
          size.width + 1,
        );
      });

      /**
       * The floor, measured rather than read. `verify.mjs` checks what the
       * stylesheet *declares*; this checks what a browser laid out — and the
       * two differ whenever a flex child is squeezed, which is what a narrow
       * viewport does.
       */
      test("every visible control clears the tap floor", async ({ page }) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(route);
        await settle(page);

        const small = await page.evaluate(() => {
          const offenders: string[] = [];
          let inspected = 0;
          for (const control of document.querySelectorAll("button, a[href], summary, select")) {
            const box = control.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) continue;
            if (getComputedStyle(control).visibility === "hidden") continue;
            inspected += 1;
            // 43 rather than 44: a browser can lay out a 44px box at 43.98 on
            // a fractional device ratio, and that is not the failure this rule
            // is about.
            if (box.height < 43) {
              offenders.push(
                `${control.tagName.toLowerCase()} "${(control.textContent ?? "").trim().slice(0, 24)}" → ${box.height.toFixed(1)}px`,
              );
            }
          }
          return { offenders, inspected };
        });

        expect(
          small.inspected,
          `${route} at ${size.width}px offered almost no controls to measure`,
        ).toBeGreaterThanOrEqual(MIN_CONTROLS_INSPECTED);

        expect(small.offenders, small.offenders.join("\n")).toEqual([]);
      });
    });
  }
}

/**
 * The compositions that are supposed to change, checked at the boards' own
 * widths rather than either side of a guess.
 *
 * A fluid layout that never actually switches passes every overflow test in
 * this file — so these are the assertions that the per-width work happened.
 */
test.describe("each breakpoint composes something different", () => {
  test("the tab bar is a bar at 430, a rail at 768 and a sidebar at 1280", async ({ page }) => {
    await page.goto("/");
    await settle(page);

    const widthOfTabs = async (width: number, height: number): Promise<number> => {
      await page.setViewportSize({ width, height });
      await settle(page);
      return page.evaluate(() => document.querySelector(".tabs")?.getBoundingClientRect().width ?? 0);
    };

    const bar = await widthOfTabs(430, 932);
    const rail = await widthOfTabs(768, 1024);
    const sidebar = await widthOfTabs(1280, 900);

    // Full width as a bar across the bottom.
    expect(bar).toBeGreaterThan(400);
    // A narrow column once there is room beside the content.
    expect(rail).toBeLessThan(120);
    // Wider again, because the labels come out beside the marks.
    expect(sidebar).toBeGreaterThan(rail);
    expect(sidebar).toBeLessThan(260);
  });

  /**
   * The learner's phrase is the one clamped size in the product, and a clamp
   * that does not actually clamp is a literal with extra steps.
   */
  test("the learner's phrase grows with the viewport, within bounds", async ({ page }) => {
    /**
     * The phrase only exists once a sitting has started, so this starts one.
     *
     * An earlier version read `/#/fr` directly, found no `.phrase`, and called
     * `test.skip()` — which reported a pass while asserting nothing about the
     * only clamped size in the product. Starting the sitting needs no
     * microphone: the phrase is shown *before* anything is recorded, which is
     * the whole point of a `read` activity.
     */
    const sizeAt = async (width: number): Promise<number> => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/#/fr");
      await settle(page);

      const start = page.getByRole("button", { name: "Start" });
      if (await start.isVisible()) {
        await start.click();
        await settle(page);
      }

      return page.evaluate(() => {
        const phrase = document.querySelector(".phrase");
        return phrase === null ? 0 : Number.parseFloat(getComputedStyle(phrase).fontSize);
      });
    };

    const narrow = await sizeAt(360);
    const wide = await sizeAt(1280);

    // Found at all — the assertion this file exists to make would otherwise
    // pass over an element that was never there.
    expect(narrow, "no .phrase rendered at 360px").toBeGreaterThan(0);
    expect(wide, "no .phrase rendered at 1280px").toBeGreaterThan(0);

    expect(wide).toBeGreaterThan(narrow);
    // And both inside the clamp's own bounds, so neither end runs away.
    expect(narrow).toBeGreaterThanOrEqual(26);
    expect(wide).toBeLessThanOrEqual(38);
  });
});

/**
 * The page gutter, which the Motion board specifies as a clamp and which was a
 * flat 20px.
 *
 * Measured rather than read, because a clamp that does not actually clamp is a
 * literal with extra steps — and the browser is the only thing that resolves
 * `vw` against a real viewport.
 */
test.describe("the page gutter follows the viewport", () => {
  test("grows from a phone to a desk, within the board's bounds", async ({ page }) => {
    const gutterAt = async (width: number): Promise<number> => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await settle(page);
      return page.evaluate(() =>
        Number.parseFloat(getComputedStyle(document.body).paddingLeft),
      );
    };

    const phone = await gutterAt(360);
    const desk = await gutterAt(1280);

    // The board's own bounds: clamp(20px, 2.6vw, 40px).
    expect(phone).toBeCloseTo(20, 0);
    expect(desk).toBeCloseTo(33.3, 0);
    expect(desk).toBeGreaterThan(phone);
  });
});
