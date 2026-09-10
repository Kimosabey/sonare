import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose — that one configures the dev
// server for the browser app; these are unit/component tests, not a served
// app, and esbuild's default JSX transform (reading tsconfig's "react-jsx"
// setting) is enough for .tsx component tests without pulling in the full
// Vite React plugin.
//
// environment: "node" is the default; component test files opt into jsdom
// individually via a `// @vitest-environment jsdom` pragma at the top of the
// file, so the plain-TS suites (capture/, services/) stay on the lighter,
// faster node environment.
export default defineConfig({
  test: {
    environment: "node",
    /**
     * The stylesheet is now asserted by a test, and by default Vitest replaces
     * every CSS module with an empty string — including one imported `?raw`.
     * A sheet-reading test therefore passes vacuously without this: the glob
     * still finds all thirteen files and every one of them is "".
     *
     * Turning it on costs nothing here because exactly one non-test module
     * imports CSS at all (src/main.tsx, the app entry), and no test pulls that
     * in — it calls createRoot on a real #root. So no existing test's
     * getComputedStyle result changes.
     *
     * The alternative was `node:fs` from a src/ test, which this config's own
     * note below rules out on purpose: a src/ file that can read the
     * filesystem is a boundary worth keeping, and the sheet-reading tests that
     * need it live in scripts/ for that reason.
     */
    css: true,
    /**
     * `scripts/` is here for the tests that cannot live anywhere else.
     *
     * Three of them need Node's own APIs — `Buffer` to hand hostile bytes to
     * the WAV header parser, `node:fs` to read the stylesheet and the built
     * bundle, `node:child_process` to run the real build. `src/` is
     * typechecked by tsconfig.json, which has no Node types on purpose: a
     * `src/` file that can `import "node:fs"` is a `src/` file that can reach
     * the filesystem, and that is a boundary worth keeping. tsconfig.scripts.json
     * covers `scripts/**` and does have them.
     *
     * The alternative was to leave the perf budgets and the parser fuzz as
     * scripts nobody runs, which is the same as not having them.
     */
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
