/**
 * The things jsdom structurally cannot check.
 *
 * The Vitest suite covers this app thoroughly and is blind to an entire class
 * of failure, because jsdom has no layout engine, no CSS cascade and no
 * viewport. Everything here is a claim that only a real browser can settle:
 *
 *  - whether a target is **actually** 44px once the stylesheet has applied,
 *  - whether the page scrolls sideways at a phone width,
 *  - whether the fixed tab bar sits on top of the content it is meant to sit
 *    beside,
 *  - whether the per-width compositions actually change at their breakpoints.
 *
 * Run separately from `npm test` — see playwright.config.ts.
 */

import { expect, test } from "@playwright/test";

/** Onboarded, so the app opens on Today rather than redirecting to the flow. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("sonare.onboarded.v1.anonymous", "2026-01-01T00:00:00.000Z");
  });
});

test.describe("the page fits the screen it is on", () => {
  /**
   * A sideways scroll on a phone is the most reported layout bug there is, and
   * the one jsdom can never see. A single over-wide table or an unbroken
   * string is enough to cause it.
   */
  for (const path of ["/", "/#/fr", "/#/fr/journey", "/#/fr/progress", "/#/settings"]) {
    test(`does not scroll sideways at ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));

      // One pixel of slack for sub-pixel rounding, which is real and harmless.
      expect(overflow.scroll, `${path} overflows by ${String(overflow.scroll - overflow.client)}px`)
        .toBeLessThanOrEqual(overflow.client + 1);
    });
  }
});

test.describe("tap targets are the size the rule says", () => {
  /**
   * NFR-03 reads the stylesheet and flags a declared `min-height` under 44px.
   * It cannot see a control that declares none — which is exactly how an 11px
   * breadcrumb link passed it for months. This measures what actually renders.
   */
  test("every visible control on Today clears the tap floor", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const small = await page.evaluate(() => {
      const out: { text: string; height: number }[] = [];
      for (const el of document.querySelectorAll("a, button, select, summary")) {
        const box = el.getBoundingClientRect();
        // Hidden things have no size and are not targets.
        if (box.width === 0 || box.height === 0) continue;
        if (box.height < 44) {
          out.push({ text: (el.textContent ?? "").trim().slice(0, 40), height: Math.round(box.height) });
        }
      }
      return out;
    });

    expect(small, `controls under 44px: ${JSON.stringify(small)}`).toEqual([]);
  });
});

test.describe("the tab bar", () => {
  test("does not cover the end of the page", async ({ page }) => {
    /**
     * A phone width specifically. Above 620px the bar is a rail down the left
     * and "content must end above it" is meaningless — the first version of
     * this asserted it at desktop width and failed for that reason rather than
     * for a real overlap.
     */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const tabs = page.getByRole("navigation", { name: "Main" });
    await expect(tabs).toBeVisible();

    /**
     * The bar is fixed, so the page has to reserve room for it. Without that
     * the last control on every screen sits underneath it — reachable only by
     * over-scrolling, and on iOS not at all once the home indicator is added.
     */
    const clear = await page.evaluate(() => {
      const bar = document.querySelector(".tabs");
      const wrap = document.querySelector(".wrap");
      if (!bar || !wrap) return null;

      /**
       * The last child that is not the bar itself. `Navigation` renders inside
       * the wrapper, so `lastElementChild` *is* the bar — the first version of
       * this measured the bar against itself and reported an overlap that was
       * the control sitting exactly where it belongs.
       */
      const content = [...wrap.children].filter((el) => !el.classList.contains("tabs"));
      const contentBottom = Math.max(
        ...content.map((el) => el.getBoundingClientRect().bottom),
        0,
      );
      return { barTop: bar.getBoundingClientRect().top, contentBottom };
    });

    expect(clear).not.toBeNull();
    if (clear) expect(clear.contentBottom).toBeLessThanOrEqual(clear.barTop + 1);
  });

  test("is gone during a sitting", async ({ page }) => {
    await page.goto("/#/fr");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  });
});

test.describe("the widths actually change something", () => {
  /**
   * Every per-width composition is invisible to jsdom, which reports no
   * viewport. This is the only place the breakpoints are exercised at all.
   */
  test("the bar becomes a rail above 620px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const narrow = await page.evaluate(
      () => document.querySelector(".tabs")?.getBoundingClientRect().width ?? 0,
    );

    await page.setViewportSize({ width: 900, height: 900 });
    const wide = await page.evaluate(
      () => document.querySelector(".tabs")?.getBoundingClientRect().width ?? 0,
    );

    // Full width as a bar, a narrow column as a rail.
    expect(narrow).toBeGreaterThan(300);
    expect(wide).toBeLessThan(300);
  });
});
