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
