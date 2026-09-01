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
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts"],
  },
});
