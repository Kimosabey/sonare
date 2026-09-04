/**
 * R6: batch upload, one complete utterance per request. Memory storage — these
 * are a few hundred KB at 16 kHz mono and go straight to the provider, so
 * touching disk would buy nothing.
 */

import multer from "multer";
import { numberFromEnv } from "../env.js";

// Fails closed on a malformed value: fileSize NaN is no ceiling at all, and
// storage here is memoryStorage, so that is an OOM kill rather than a slow
// request. See server/env.ts.
const MAX_AUDIO_SECONDS = numberFromEnv("MAX_AUDIO_SECONDS", 15, { max: 600 });

// 16 kHz × 2 bytes/sample × seconds, plus generous headroom for the header and
// any client that overshoots slightly. Duration itself is enforced from the
// decoded header in the route, not from byte count.
const MAX_BYTES = Math.ceil(16000 * 2 * MAX_AUDIO_SECONDS * 1.5) + 1024;

export const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 10 },
}).single("audio");
