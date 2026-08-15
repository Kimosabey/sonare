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
    outDir: "dist",
    sourcemap: true,
  },
});
