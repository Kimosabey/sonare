#!/usr/bin/env node
/**
 * Replays server/fallbackLog.ts's NDJSON files into MongoDB once it's back,
 * then archives each file it successfully drained. Safe to run any time —
 * a missing or empty fallback file is a no-op, not an error.
 *
 *   node --env-file=.env scripts/replay-fallback.mjs
 */

import { MongoClient } from "mongodb";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";

const FALLBACK_DIR = process.env.FALLBACK_DIR ?? join(process.cwd(), "data");
const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017";
const MONGO_DB_NAME = process.env.MONGO_DB ?? "sonare";

const COLLECTIONS = ["attempts", "diagnostics"];

async function replayOne(client, collection) {
  const path = join(FALLBACK_DIR, `${collection}.fallback.ndjson`);

  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return; // Nothing to replay for this collection.
  }

  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return;

  const records = lines.map((line) => JSON.parse(line));

  // unordered: one bad record (e.g. a duplicate _id from a partial prior
  // replay) shouldn't block the rest from going in.
  await client.db(MONGO_DB_NAME).collection(collection).insertMany(records, { ordered: false });

  const archivePath = `${path}.${Date.now()}.replayed`;
  await rename(path, archivePath);
  console.log(`[replay-fallback] ${collection}: replayed ${records.length} record(s) -> ${archivePath}`);
}

async function main() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  try {
    for (const collection of COLLECTIONS) {
      await replayOne(client, collection);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
