import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose — that one configures the dev
// server/React plugin for the browser app; unit tests here cover plain
// TS in src/speech/capture/ and server/services/, neither of which needs it.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "server/**/*.test.ts"],
  },
});
