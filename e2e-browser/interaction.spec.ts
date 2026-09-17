/**
 * Three constraints the product states about itself, checked where they are
 * actually decided — in a browser, after the cascade has run.
 *
 *  - **Focus is visible.** Board 1d: "2px accent, 2px offset, on every
 *    interactive role." A keyboard user who cannot see where they are is lost
 *    on every screen at once, and this is invisible to jsdom, which has no
 *    `:focus-visible` and no computed outline.
 *  - **Motion is never the only carrier.** One of the nine design constraints.
 *    With `prefers-reduced-motion` the app must still say everything it says —
 *    which means nothing may arrive by animation alone and stay invisible when
 *    animation is off.
 *  - **Text can double.** WCAG 1.4.4 asks for 200% without loss of content or
 *    function. It is the check most reliably broken by fixed heights, and it
 *    cannot be made anywhere but in a browser.
 */

import { expect, test } from "@playwright/test";

const SCREENS: [name: string, path: string][] = [
  ["Today", "/"],
  ["a session", "/#/fr"],
  ["Journey", "/#/fr/journey"],
  ["Progress", "/#/fr/progress"],
  ["the You tab", "/#/settings"],
  ["the microphone check", "/#/check"],
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("sonare.onboarded.v1.anonymous", "2026-01-01T00:00:00.000Z");
  });
});

async function settle(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("section", { state: "attached", timeout: 10_000 });
  await page.evaluate(async () => {
    const running = document.getAnimations().map((a) => a.finished.catch(() => undefined));
    await Promise.all(running);
  });
}

test.describe("keyboard focus is visible", () => {
  for (const [name, path] of SCREENS) {
    test(`on ${name}`, async ({ page }) => {
      await page.goto(path);
      await settle(page);

      /**
       * Real Tab presses, not `element.focus()`.
       *
       * `:focus-visible` is a browser heuristic, and the stylesheet says so in
       * as many words: it "generally does NOT fire when script moves focus".
       * A scripted focus therefore reports *every* button as unringed, which
       * is a statement about the test rather than the product — the first
       * version of this did exactly that and named six controls that are
       * perfectly well ringed under a keyboard.
       *
       * Capped at twenty-five stops: a screen with fifty has already proved
       * the rule and the rest is wall-clock.
       */
      const invisible: string[] = [];
      for (let i = 0; i < 25; i += 1) {
        await page.keyboard.press("Tab");

        const stop = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;

          const style = window.getComputedStyle(el);
          const outlined =
            style.outlineStyle !== "none" && parseFloat(style.outlineWidth || "0") > 0;
          const ringed = style.boxShadow !== "none" && style.boxShadow.trim() !== "";

          return {
            visible: outlined || ringed,
            what: `${el.tagName.toLowerCase()}.${el.className || "(none)"} — "${(el.textContent ?? "").trim().slice(0, 24)}"`,
          };
        });

        if (stop === null) break;
        if (!stop.visible) invisible.push(stop.what);
      }

      expect(invisible, `${name} — focus invisible on:\n${invisible.join("\n")}`).toEqual([]);
    });
  }
});

test.describe("with motion switched off", () => {
  test.use({ reducedMotion: "reduce" });

  /**
   * The constraint is that motion is never the only carrier. The way that
   * fails in practice is an element that arrives by animation and, with
   * animation suppressed, never arrives at all — it sits at the `from` state
   * of a `both`-filled keyframe, invisible, forever.
   */
  for (const [name, path] of SCREENS) {
    test(`${name} still shows everything it says`, async ({ page }) => {
      await page.goto(path);
      await settle(page);

      const invisible = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(
          ".enter-1, .enter-2, .enter-cta, section, h1, h2",
        )) {
          const style = window.getComputedStyle(el);
          if (parseFloat(style.opacity) < 0.9) {
            out.push(`${el.tagName.toLowerCase()}.${el.className || "(none)"} at ${style.opacity}`);
          }
        }
        return out;
      });

      expect(invisible, `${name} — invisible with reduced motion:\n${invisible.join("\n")}`).toEqual(
        [],
      );
    });
  }
});

test.describe("at 200% text", () => {
  /**
   * WCAG 1.4.4. Doubling the root font size is the closest a browser test gets
   * to a learner who has turned text up — and the failure it catches is a
   * fixed height that clips its own content, which looks fine at 100% and
   * hides a sentence at 200%.
   */
  for (const [name, path] of SCREENS) {
    test(`${name} does not clip or scroll sideways`, async ({ page }) => {
      await page.goto(path);
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      await settle(page);

      const problems = await page.evaluate(() => {
        const out: string[] = [];
        const doc = document.documentElement;
        if (doc.scrollWidth > doc.clientWidth + 1) {
          out.push(`page scrolls sideways by ${String(doc.scrollWidth - doc.clientWidth)}px`);
        }
        /**
         * Clipped text: an element whose content is taller than its box while
         * overflow is hidden. That is a sentence a learner cannot read.
         */
        for (const el of document.querySelectorAll<HTMLElement>("p, h1, h2, h3, li, button, a")) {
          const style = window.getComputedStyle(el);
          if (style.overflow !== "hidden" && style.overflowY !== "hidden") continue;
          if (el.scrollHeight > el.clientHeight + 2) {
            out.push(
              `clipped: ${el.tagName.toLowerCase()}.${el.className || "(none)"} — "${(el.textContent ?? "").trim().slice(0, 30)}"`,
            );
          }
        }
        return out;
      });

      expect(problems, `${name} at 200%:\n${problems.join("\n")}`).toEqual([]);
    });
  }
});
