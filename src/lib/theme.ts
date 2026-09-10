/**
 * Which end of the palette the app renders at.
 *
 * tokens.css defines three states and the CSS already handles all three; what
 * was missing was anything to *stamp* the attribute, so dark was reachable
 * only by changing the operating system's own setting.
 *
 * Three states, not two, and "system" is the one that matters:
 *
 *   system   stamp nothing. The bare :root is the complete light palette and
 *            the `prefers-color-scheme: dark` block takes over on a dark OS.
 *   light    stamp data-theme="light", which the media block is guarded
 *            against with :not([data-theme="light"]) so choosing light on a
 *            dark OS wins.
 *   dark     stamp data-theme="dark", a separate block so choosing dark on a
 *            light OS wins too.
 *
 * "System" is therefore the *absence* of the attribute, not a third value in
 * it. Stamping data-theme="system" would half-work — the media block's guard
 * only excludes "light", so a dark OS would still go dark — and it would be
 * wrong on a light OS in a way nothing would notice, because the guard would
 * pass and there would be no matching [data-theme] block. removeAttribute is
 * the operation, not setAttribute with a third name.
 *
 * ── on the flash ───────────────────────────────────────────────────────────
 *
 * Applying the stored choice from React is too late. In a production build
 * Vite puts the stylesheet in a render-blocking <link>, so by the time a
 * deferred module script runs the browser already has the light palette and
 * can have painted with it; a learner who chose dark would see a white flash
 * on every load. index.html therefore carries a tiny synchronous script in
 * <head> that stamps the attribute during parsing, before the first paint.
 *
 * That script is a second reader of this module's key and values, and it
 * cannot import them. src/lib/theme.test.ts asserts the two agree, so the
 * duplication cannot drift silently.
 */

export type Theme = "system" | "light" | "dark";

/**
 * Shared with the inline script in index.html. Both are asserted equal by the
 * test, so this is the one place the name is decided.
 */
export const THEME_STORAGE_KEY = "sonare.theme";

/** The order the control offers them in: no preference, then the two choices. */
export const THEMES: readonly Theme[] = ["system", "light", "dark"] as const;

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * The stored choice, or "system" when there isn't one.
 *
 * Every access is wrapped, for two different failures that both look like
 * this one:
 *
 * · jsdom hands out a `localStorage` that is a bare object with no methods,
 *   so `getItem` is not a function and the call throws a TypeError. Unwrapped,
 *   every component test that renders this would die on mount.
 * · A real browser in private mode, or with site data blocked, throws a
 *   SecurityError on access.
 *
 * Both land in the same place: no stored value, render as "system", which is
 * the correct default rather than a degraded one — it is what a visitor who
 * has never touched the control gets.
 */
export function readTheme(): Theme {
  let raw: string | null;
  try {
    raw = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return "system";
  }
  // Anything unrecognised — a hand-edited value, or a name from a future
  // version — is treated as no preference rather than stamped blindly.
  return isTheme(raw) ? raw : "system";
}

/** Remembers the choice. A failure here costs the next visit, not this one. */
export function writeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private browsing or storage disabled. The theme still applies for the
    // rest of this visit through applyTheme below; it just is not remembered.
  }
}

/**
 * Stamps the document, or unstamps it for "system".
 *
 * Takes the element so a test can hand it one rather than reaching for the
 * real document, and so the inline script's behaviour can be compared against
 * this function's on the same node.
 */
export function applyTheme(theme: Theme, root: HTMLElement): void {
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}
