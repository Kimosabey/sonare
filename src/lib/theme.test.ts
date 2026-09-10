// @vitest-environment jsdom

/**
 * The theme store, and the one duplication it cannot avoid.
 *
 * index.html carries an inline copy of the read-and-stamp logic, because
 * nothing in <head> can import a module and applying the theme any later than
 * that means a flash of the wrong palette. Two copies of a rule is exactly the
 * shape of bug this revamp has been removing, so the copy is tested against
 * the original rather than trusted: same key, same stamped values, same
 * treatment of "system".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { THEMES, THEME_STORAGE_KEY, applyTheme, readTheme, writeTheme, type Theme } from "./theme.js";
import indexHtml from "../../index.html?raw";

/** A real Storage over a Map, matching the e2e harness's installStorage. */
function installStorage(seed?: Record<string, string>): Map<string, string> {
  const data = new Map(Object.entries(seed ?? {}));
  const storage: Storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
});

describe("reading the stored choice", () => {
  test("defaults to system when nothing is stored", () => {
    installStorage();
    expect(readTheme()).toBe("system");
  });

  test("returns each stored choice", () => {
    for (const theme of THEMES) {
      installStorage({ [THEME_STORAGE_KEY]: theme });
      expect(readTheme()).toBe(theme);
    }
  });

  /**
   * The failure the brief names, and it is the default in this test suite:
   * jsdom's own `localStorage` is a bare object with no methods, so `getItem`
   * is not a function and the call throws a TypeError. Unwrapped, every
   * component test that rendered the settings screen would die on mount.
   */
  test("renders correctly when localStorage is a bare object with no methods", () => {
    vi.stubGlobal("localStorage", {});
    expect(readTheme()).toBe("system");
  });

  /** A real browser in private mode, or with site data blocked. */
  test("renders correctly when reading throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(readTheme()).toBe("system");
  });

  test("survives localStorage being absent entirely", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readTheme()).toBe("system");
  });

  test("treats an unrecognised stored value as no preference", () => {
    // A hand-edited value, or a name from a future version. Stamping it
    // blindly would put an unknown string in the attribute and match no block.
    for (const junk of ["System", "DARK", "sepia", "", "null", '{"theme":"dark"}']) {
      installStorage({ [THEME_STORAGE_KEY]: junk });
      expect(readTheme(), `stored value ${JSON.stringify(junk)}`).toBe("system");
    }
  });
});

describe("writing the choice", () => {
  test("stores each choice under the shared key", () => {
    for (const theme of THEMES) {
      const data = installStorage();
      writeTheme(theme);
      expect(data.get(THEME_STORAGE_KEY)).toBe(theme);
    }
  });

  test("a write that throws does not propagate", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      },
    });
    expect(() => writeTheme("dark")).not.toThrow();
  });

  test("round-trips through storage", () => {
    installStorage();
    writeTheme("dark");
    expect(readTheme()).toBe("dark");
    writeTheme("system");
    expect(readTheme()).toBe("system");
  });
});

describe("stamping the document", () => {
  test("light and dark are stamped", () => {
    const root = document.documentElement;
    applyTheme("light", root);
    expect(root.getAttribute("data-theme")).toBe("light");
    applyTheme("dark", root);
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  /**
   * The point of having three states. "System" is the absence of the
   * attribute, because the bare :root is the complete light palette and the
   * prefers-color-scheme block takes it from there. Stamping
   * data-theme="system" would half-work — the media block's guard only
   * excludes "light" — and would be silently wrong on a light OS.
   */
  test("system removes the attribute rather than stamping a third value", () => {
    const root = document.documentElement;
    applyTheme("dark", root);
    applyTheme("system", root);
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  test("no theme ever stamps the string 'system'", () => {
    const root = document.documentElement;
    for (const theme of THEMES) {
      applyTheme(theme, root);
      expect(root.getAttribute("data-theme")).not.toBe("system");
    }
  });
});

describe("the inline script in index.html cannot drift from this module", () => {
  /** The contents of the <script> that runs before the first paint. */
  const inline = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? "";

  test("index.html was read and contains an inline script", () => {
    // Guards every assertion below — an empty string contains nothing, so a
    // failed read would make the "does not stamp system" test pass vacuously.
    expect(indexHtml.length).toBeGreaterThan(0);
    expect(inline).toContain("localStorage");
    expect(inline).toContain("data-theme");
  });

  test("it runs before the module script, not after", () => {
    // The whole reason it exists. Below the app's own <script type="module">
    // it would be no earlier than the code it is working around.
    expect(indexHtml.indexOf("<script>")).toBeLessThan(indexHtml.indexOf('<script type="module"'));
  });

  test("it runs in <head>, before anything can paint", () => {
    expect(indexHtml.indexOf("<script>")).toBeLessThan(indexHtml.indexOf("</head>"));
  });

  test("it reads the same storage key this module writes", () => {
    expect(inline).toContain(`"${THEME_STORAGE_KEY}"`);
  });

  test("it stamps exactly the values this module stamps", () => {
    const stamped = THEMES.filter((t) => t !== "system");
    for (const theme of stamped) {
      expect(inline, `inline script does not handle ${theme}`).toContain(`"${theme}"`);
    }
    // And nothing else: a value the module would never stamp appearing here
    // means the two have diverged.
    const quoted = [...inline.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const themeish = quoted.filter((q): q is Theme => THEMES.includes(q as Theme));
    expect([...new Set(themeish)].sort()).toEqual([...stamped].sort());
  });

  test("it does not stamp anything for system", () => {
    // "system" must never appear as a stamped value; the absence of the
    // attribute is the state.
    expect(inline).not.toContain('"system"');
  });

  test("it is wrapped, because an uncaught throw in <head> takes the page down", () => {
    expect(inline).toMatch(/try\s*\{/);
    expect(inline).toMatch(/catch\s*\(/);
  });

  /**
   * Behavioural equivalence rather than textual: the inline script is
   * evaluated here against the same seeded storage and the same document, and
   * has to leave the root in the state applyTheme would.
   */
  test("it leaves the document in the same state as applyTheme, for every input", () => {
    for (const stored of [...THEMES, "sepia", "DARK", ""]) {
      const root = document.documentElement;

      installStorage({ [THEME_STORAGE_KEY]: stored });
      root.removeAttribute("data-theme");
      new Function(inline)();
      const fromInline = root.getAttribute("data-theme");

      root.removeAttribute("data-theme");
      applyTheme(readTheme(), root);
      const fromModule = root.getAttribute("data-theme");

      expect(fromInline, `stored value ${JSON.stringify(stored)}`).toBe(fromModule);
    }
  });

  test("it stamps nothing when storage is missing entirely", () => {
    const root = document.documentElement;
    installStorage();
    root.removeAttribute("data-theme");
    new Function(inline)();
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  test("it does not throw when localStorage is a bare object", () => {
    vi.stubGlobal("localStorage", {});
    expect(() => new Function(inline)()).not.toThrow();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  test("it does not throw when localStorage access throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(() => new Function(inline)()).not.toThrow();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
