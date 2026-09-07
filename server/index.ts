import express from "express";
import { pronunciationRouter } from "./routes/pronunciation.js";
import { diagnosticsRouter } from "./routes/diagnostics.js";
import { learnersRouter } from "./routes/learners.js";
import { syncRouter } from "./routes/sync.js";
import { nextRouter } from "./routes/next.js";
import { healthRouter } from "./routes/health.js";
import { warnIfIdentityDisabled } from "./identity.js";
import { countPending, replayPending } from "./fallbackLog.js";
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
app.use("/api/v1", learnersRouter);
app.use("/api/v1", syncRouter);
app.use("/api/v1", nextRouter);
// Unprefixed, because a liveness probe is infrastructure rather than API: an
// orchestrator should not have to know the app's versioning scheme.
app.use(healthRouter);

app.listen(PORT, () => {
  logger.info({ port: PORT }, "pronunciation API listening");
  if (!process.env.AZURE_SPEECH_KEY) {
    logger.warn("AZURE_SPEECH_KEY is not set — scoring requests will fail until it is set");
  }
  // Said out loud at startup rather than discovered when a learner's progress
  // fails to sync. Identity is off by default, which is the safe direction —
  // there is no built-in secret to fall back to.
  warnIfIdentityDisabled();
});

// Connect at startup rather than waiting for the first attempt/diagnostic —
// surfaces a bad MONGO_URL immediately instead of on a learner's first take.
// A failure here is logged, not fatal: attempts.ts/diagnostics.ts already
// tolerate getDb() rejecting and simply skip persistence for that call.
void getDb()
  .then(async (db) => {
    /**
     * Drain any fallback backlog now that Mongo is answering.
     *
     * At startup rather than on a timer or per request. A restart is exactly
     * the moment an outage has ended, and polling would spend a filesystem
     * read forever to discover nothing is waiting. A long outage with no
     * restart still accumulates — `fallback.pending` on /metrics is what makes
     * that visible, and `npm run replay-fallback` drains it without one.
     */
    const pending = await countPending();
    if (pending.attempts + pending.diagnostics === 0) return;

    logger.warn({ pending }, "[fallback] a backlog is waiting — replaying");
    for (const outcome of await replayPending(db)) {
      if (outcome.error !== undefined) {
        logger.error(outcome, "[fallback] replay failed — the file is left in place");
      } else if (outcome.records > 0) {
        logger.info(outcome, "[fallback] replayed");
      }
    }
  })
  .catch((err: unknown) => {
    // Never fatal. attempts.ts and diagnostics.ts already tolerate getDb()
    // rejecting and fall back to the local file, which is the mechanism this
    // replay exists to drain.
    logger.error({ err }, "[db] initial MongoDB connection or fallback replay failed");
  });
