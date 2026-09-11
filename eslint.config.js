import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  /**
   * `.claude` holds agent git worktrees — full checkouts of this repo nested
   * inside it. Left visible, each one presents its own tsconfig, and
   * typescript-eslint refuses to guess between them: "multiple candidate
   * TSConfigRootDirs are present", 1242 parsing errors, exit 1. The gate then
   * fails for a reason that has nothing to do with the code under review,
   * which is the worst kind of red — it trains you to stop reading it.
   */
  { ignores: ["dist", "dist-server", "node_modules", "reference", "server/data", ".claude"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["server/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  /**
   * `public/sw.js` is a classic service worker, served verbatim and never
   * bundled, so it is plain JS in a scope with neither `window` nor Node. Left
   * on the defaults, `no-undef` from js.configs.recommended fails the lint
   * gate on `self`, `caches` and `clients` — real globals in exactly one
   * environment, which is the one this file runs in. `sourceType: "script"`
   * for the same reason: package.json says `"type": "module"`, and a classic
   * worker is not one.
   */
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: globals.serviceworker,
      sourceType: "script",
    },
  },
  {
    // CLAUDE.md: no `any` in src/speech/ or server/services/.
    files: ["src/speech/**/*.ts", "server/services/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
