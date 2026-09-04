import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ports deliberately off the common defaults (3000/5173/8080) to avoid collisions.
const CLIENT_PORT = 5180;
const SERVER_PORT = Number(process.env.PORT ?? 5181);

export default defineConfig({
  plugins: [react()],
  server: {
    port: CLIENT_PORT,
    strictPort: true,
    // iOS needs the LAN address over HTTPS for on-device testing.
    host: true,
    // getUserMedia requires a secure context and localhost is the only exempt
    // origin, so on-device testing goes through an HTTPS tunnel. Vite rejects
    // Host headers it does not know, which would otherwise 403 the tunnel.
    allowedHosts: [".ngrok-free.dev", ".ngrok-free.app", ".ngrok.io", ".trycloudflare.com"],
    proxy: {
      "/api": {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    /**
     * The five platforms PRD §3 S2 names, stated rather than inherited.
     *
     * Without this the bundle is built for Vite's default ("modules" — any
     * browser with native ESM, which reaches back further than this app can
     * actually run). The real floor is AudioWorklet, which Safari only gained
     * in 14.1: shipping syntax an older Safari parses but an API it lacks
     * means a blank failure instead of the typed UNSUPPORTED_BROWSER the
     * capture layer raises. safari15 is the first version comfortably past
     * that line.
     *
     * Chrome 90 covers Android Chrome and desktop Chrome/Edge of the same
     * vintage; Firefox is not in S2 but costs nothing to keep working.
     */
    target: ["es2020", "safari15", "chrome90", "firefox90", "edge90"],
    outDir: "dist",
    // "hidden" still emits the .map for local post-mortem work but drops the
    // //# sourceMappingURL comment, so a deployed build no longer advertises
    // (or serves to any visitor's devtools) the app's full original source.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        /**
         * React, ReactDOM and the router are ~80% of the bundle's source and
         * change only when a dependency is upgraded. Bundled together with
         * app code, every one-line app edit invalidated the whole 98 kB for
         * every returning visitor. Splitting them means an app deploy busts
         * only the small app chunk and the vendor half stays cached.
         */
        // Vite 8 bundles with rolldown, which requires the function form —
        // the object map that classic Rollup accepted fails outright with
        // "manualChunks is not a function".
        manualChunks(id: string): string | undefined {
          if (id.includes("node_modules")) {
            if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
              return "vendor";
            }
          }
          return undefined;
        },
      },
    },
  },
});
