/**
 * Real browser engines — N10.
 *
 * Separate from Vitest on purpose, and not merged into `npm test`. These start
 * a server and drive Chromium and WebKit; the unit suite is 3700 tests that
 * run in seconds against jsdom, and making every one of them wait on a browser
 * launch would be the surest way to stop people running it.
 *
 * ## What these can check that jsdom cannot
 *
 * jsdom is not a browser — it has no layout, no CSS engine, no media stack. So
 * a whole class of failure is invisible to the suite that otherwise covers
 * this app well:
 *
 *  - **Layout.** Whether the tab bar overlaps the content, whether a target is
 *    really 44px once CSS has applied, whether the page scrolls sideways.
 *  - **Media queries.** Every per-width composition is untested by jsdom,
 *    which reports no viewport at all.
 *  - **WebKit specifically.** Safari is the target platform — an installed PWA
 *    on iOS *is* WebKit — and it is the engine that differs most.
 *
 * Chromium and WebKit only. Firefox is not a target: this is a PWA aimed at
 * iOS Safari and Android Chrome, and a third engine is download time and CI
 * minutes spent on a browser no learner is using.
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "./e2e-browser",
  /* One retry: a real browser has real timing, and a flake that fails twice is
     a finding rather than noise. */
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: "retain-on-failure",
  },
  /**
   * The production build, not the dev server. What ships is what should be
   * driven — the dev server transforms modules on the fly and serves an
   * unminified graph, so a failure there might not be a failure in the thing a
   * learner downloads.
   */
  webServer: {
    command: `npm run build && npx vite preview --port ${String(PORT)} --strictPort`,
    url: `http://127.0.0.1:${String(PORT)}/`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    /* The engine an installed iOS PWA actually runs on. */
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    /* A phone viewport, for the per-width work and the tap floor. */
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] } },
  ],
});
