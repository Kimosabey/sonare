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
