/**
 * One shared Mongo connection, lazily established and cached so every route
 * reuses it instead of reconnecting per request.
 */

import { MongoClient } from "mongodb";
import type { Db } from "mongodb";

const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017";
const MONGO_DB_NAME = process.env.MONGO_DB ?? "sonare";

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    const client = new MongoClient(MONGO_URL);
    dbPromise = client
      .connect()
      .then(() => {
        console.log(`[db] connected to MongoDB (${MONGO_DB_NAME})`);
        return client.db(MONGO_DB_NAME);
      })
      .catch((err: unknown) => {
        // Clear the cache so the next call retries rather than replaying the
        // same rejected promise forever.
        dbPromise = null;
        throw err;
      });
  }
  return dbPromise;
}
