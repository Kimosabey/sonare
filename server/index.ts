import express from "express";
import { pronunciationRouter } from "./routes/pronunciation.js";

const app = express();

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

app.listen(PORT, () => {
  console.log(`pronunciation API listening on http://localhost:${PORT}`);
  if (!process.env.AZURE_SPEECH_KEY) {
    console.warn("AZURE_SPEECH_KEY is not set — scoring requests will fail until it is.");
  }
});
