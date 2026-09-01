import express from "express";
import { pronunciationRouter } from "./routes/pronunciation.js";
import { diagnosticsRouter } from "./routes/diagnostics.js";
import { getDb } from "./db.js";

const app = express();

// This server runs behind exactly one reverse proxy in every real deployment
// (an ngrok tunnel today, likely a single load balancer/App Service front
// end later) — trusting exactly one hop lets express-rate-limit read the
// real client IP from X-Forwarded-For correctly, without blindly trusting a
// header an attacker further down an arbitrary chain could spoof to dodge
// rate limiting. Plain `true` (trust every hop) would defeat the point.
app.set("trust proxy", 1);

// Diagnostics is plain JSON; the pronunciation route stays multipart via
// multer and is unaffected — express.json() only engages for an
// application/json Content-Type.
app.use(express.json());

// Deliberately off the common defaults (3000/8080) to avoid collisions.
const PORT = Number(process.env.PORT ?? 5181);

app.get("/api/v1/health", (_req, res) => {
  // Reports whether scoring is configured — never what the configuration is (R2).
  res.json({
    ok: true,
    provider: process.env.PRONUNCIATION_PROVIDER ?? "azure",
    configured: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
    region: process.env.AZURE_SPEECH_REGION ?? null,
  });
});

app.use("/api/v1", pronunciationRouter);
app.use("/api/v1", diagnosticsRouter);

app.listen(PORT, () => {
  console.log(`pronunciation API listening on http://localhost:${PORT}`);
  if (!process.env.AZURE_SPEECH_KEY) {
    console.warn("AZURE_SPEECH_KEY is not set — scoring requests will fail until it is.");
  }
});

// Connect at startup rather than waiting for the first attempt/diagnostic —
// surfaces a bad MONGO_URL immediately instead of on a learner's first take.
// A failure here is logged, not fatal: attempts.ts/diagnostics.ts already
// tolerate getDb() rejecting and simply skip persistence for that call.
void getDb().catch((err: unknown) => {
  console.error("[db] initial MongoDB connection failed:", String(err));
});
