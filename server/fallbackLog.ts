/**
 * Last-resort local persistence for attempts/diagnostics when MongoDB itself
 * is unreachable. Per PRD.md §8 the attempt/diagnostic trail *is* the
 * deliverable, not an incidental log — silently dropping a record on a
 * transient Mongo hiccup can invalidate the exact measurement the product
 * exists to make. NDJSON, append-only, so a crash mid-write never corrupts a
 * prior line. Replay with `npm run replay-fallback` once Mongo is back.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const FALLBACK_DIR = process.env.FALLBACK_DIR ?? join(process.cwd(), "data");

export type FallbackCollection = "attempts" | "diagnostics";

export function fallbackPath(collection: FallbackCollection): string {
  return join(FALLBACK_DIR, `${collection}.fallback.ndjson`);
}

export async function appendFallback(collection: FallbackCollection, record: unknown): Promise<void> {
  try {
    await mkdir(FALLBACK_DIR, { recursive: true });
    await appendFile(fallbackPath(collection), `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    // Nothing left to fall back to. Same non-blocking philosophy as the
    // Mongo write this backs up: log and move on, never throw into a
    // learner's request.
    console.error(`[fallback] failed to append ${collection} record:`, String(err));
  }
}
