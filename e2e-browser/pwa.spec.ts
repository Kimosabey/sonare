/**
 * The two promises a PWA makes that nothing has ever checked.
 *
 * This app is installable and works offline — both are stated, neither was
 * verified anywhere. The unit suite tests `register.ts`'s *logic* against a
 * fake container; it cannot test that a browser accepts the manifest, that the
 * worker installs, or that a second load with the network cut actually serves
 * anything. Those are facts about a browser and only a browser can answer them.
 *
 * Chromium only for the worker cases, and deliberately: WebKit's service
 * worker support in Playwright is partial enough that a failure there would be
 * ambiguous between the app and the harness, and an ambiguous test is worse
 * than none. The manifest checks run everywhere.
 */

import { expect, test } from "@playwright/test";

test.describe("the manifest a browser is asked to install", () => {
  test("is served, parses, and says what an install needs", async ({ page, request }) => {
    await page.goto("/");

    const href = await page.getAttribute('link[rel="manifest"]', "href");
    expect(href, "no manifest link in the document").toBeTruthy();

    const response = await request.get(href ?? "/manifest.webmanifest");
    expect(response.status()).toBe(200);

    const manifest = (await response.json()) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      icons?: { sizes?: string; purpose?: string; src?: string }[];
      background_color?: string;
      theme_color?: string;
    };

    /**
     * The fields a browser actually requires before it will offer to install.
     * Missing any one means the prompt never appears, and nothing in the app
     * would say so — it simply never happens.
     */
    expect(manifest.name || manifest.short_name, "no name").toBeTruthy();
    expect(manifest.start_url, "no start_url").toBeTruthy();
    expect(["standalone", "fullscreen", "minimal-ui"]).toContain(manifest.display);

    /** At least one icon of 192px or more, which is the documented floor. */
    const large = (manifest.icons ?? []).filter((icon) =>
      (icon.sizes ?? "").split(" ").some((size) => Number(size.split("x")[0] ?? 0) >= 192),
    );
    expect(large.length, "no icon at 192px or larger").toBeGreaterThan(0);
  });

  /**
   * A maskable icon is cropped to a circle on Android. C2 chose to declare
   * `purpose: "maskable"` on exactly one icon, drawn for that crop — declaring
   * it on an icon that was not would put the art's edges outside the circle.
   */
  test("declares maskable on an icon drawn for it, and only that one", async ({ request }) => {
    const manifest = (await (await request.get("/manifest.webmanifest")).json()) as {
      icons?: { src?: string; purpose?: string }[];
    };

    const maskable = (manifest.icons ?? []).filter((icon) =>
      (icon.purpose ?? "").split(" ").includes("maskable"),
    );

    expect(maskable.length, "expected exactly one maskable icon").toBe(1);
    expect(maskable[0]?.src ?? "", "the maskable icon should be the one drawn for the crop")
      .toMatch(/maskable/i);
  });

  test("every icon it names is actually served", async ({ request }) => {
    const manifest = (await (await request.get("/manifest.webmanifest")).json()) as {
      icons?: { src?: string }[];
    };

    for (const icon of manifest.icons ?? []) {
      const response = await request.get(icon.src ?? "");
      expect(response.status(), `${icon.src ?? "(no src)"} is declared but not served`).toBe(200);
    }
  });
});

test.describe("the service worker", () => {
  // See the file header: Chromium only, so a failure is unambiguous.
  test.skip(({ browserName }) => browserName !== "chromium", "worker cases are Chromium-only");

  test("registers on the built app", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const registered = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration !== undefined;
    });

    expect(registered, "no service worker registered on the production build").toBe(true);
  });

  /**
   * The promise itself. `sw.js` is runtime-caching with no precache manifest —
   * a documented trade — so the first offline visit requires a prior online
   * load. This is that: load once, cut the network, load again.
   *
   * If this fails, "works offline" is a claim the product cannot keep, and a
   * learner finds out on a train.
   */
  test("serves the app on a second visit with the network cut", async ({ page, context }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Let the worker take control — it claims clients on activation, but the
    // first load is the one that installed it.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    await context.setOffline(true);
    try {
      await page.reload();
      await page.waitForSelector("section", { state: "attached", timeout: 15_000 });

      const heading = await page.textContent("h1");
      expect(heading, "offline reload rendered no heading").toBeTruthy();
    } finally {
      await context.setOffline(false);
    }
  });
});
