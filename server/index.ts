import express from "express";
import { pronunciationRouter } from "./routes/pronunciation.js";
import { diagnosticsRouter } from "./routes/diagnostics.js";
import { getDb } from "./db.js";
import { logger } from "./logger.js";
import { getScoringProvider } from "./services/index.js";
import { numberFromEnv } from "./env.js";

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
const PORT = numberFromEnv("PORT", 5181, { integer: true, min: 1, max: 65535 });

app.get("/api/v1/health", (_req, res) => {
  // Reports whether scoring is configured — never what the configuration is
  // (R2) — and, per R12, without knowing what a "configured" vendor even
  // looks like: getScoringProvider() throws MISCONFIGURED if it isn't, which
  // is the provider's own judgment, not env-var names this file would have
  // to know and keep in sync with whichever vendor is active.
  let configured = true;
  try {
    getScoringProvider();
  } catch {
    configured = false;
  }

  res.json({
    ok: true,
    provider: process.env.PRONUNCIATION_PROVIDER ?? "azure",
    configured,
  });
});

app.use("/api/v1", pronunciationRouter);
app.use("/api/v1", diagnosticsRouter);

app.listen(PORT, () => {
  logger.info({ port: PORT }, "pronunciation API listening");
  if (!process.env.AZURE_SPEECH_KEY) {
    logger.warn("AZURE_SPEECH_KEY is not set — scoring requests will fail until it is set");
  }
});

// Connect at startup rather than waiting for the first attempt/diagnostic —
// surfaces a bad MONGO_URL immediately instead of on a learner's first take.
// A failure here is logged, not fatal: attempts.ts/diagnostics.ts already
// tolerate getDb() rejecting and simply skip persistence for that call.
void getDb().catch((err: unknown) => {
  logger.error({ err }, "[db] initial MongoDB connection failed");
});
