/**
 * Serving the cached model voice.
 *
 * Real Express on an ephemeral port with real files in a temporary directory:
 * what is under test is a status code, a content type and a `Cache-Control`
 * header, none of which a mock would tell the truth about.
 *
 * Three things matter here.
 *
 * **A miss must be an ordinary 404.** Nothing generated, no API key, the
 * directory absent entirely — the client reads all three as "use the platform
 * voice", exactly as `GET /content/:slug` 404s into the bundled activity set.
 * If a miss were a 500 the client would still fall back, but every deployment
 * without generated audio would look like a broken server.
 *
 * **The two caching answers must differ.** Audio names are content hashes and
 * get a year; the manifest is rewritten on every run and must revalidate. The
 * dangerous direction is a cached manifest, because it points at files that
 * pruning has since removed — a learner would then be told audio exists,
 * request it, and get a 404 mid-tap.
 *
 * **No synthesis happens here.** This route reads local files. There is no way
 * to reach the provider through it, which is why it needs no spend cap and no
 * rate limiter.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/** The file-name shape the cache actually writes: 32 hex characters. */
const KEY = "0123456789abcdef0123456789abcdef";

/**
 * Set at the top level, before the router is imported. `express.static` binds
 * the directory at construction, so a nested `beforeAll` would configure a
 * different path than the one the running app holds — the mistake
 * content.test.ts documents, where four assertions passed against nothing.
 */
const dir = mkdtempSync(join(tmpdir(), "sonare-voice-route-"));
const ORIGINAL_DIR = process.env.MODEL_VOICE_CACHE_DIR;
process.env.MODEL_VOICE_CACHE_DIR = dir;

let server: Server;
let base: string;

beforeAll(async () => {
  mkdirSync(join(dir, "hi-IN"), { recursive: true });
  writeFileSync(
    join(dir, "hi-IN", "manifest.json"),
    JSON.stringify({ language: "hi-IN", phrases: [{ text: "नमस्ते", audio: `${KEY}.mp3` }] }),
  );
  writeFileSync(join(dir, "hi-IN", `${KEY}.mp3`), Buffer.from("not really an mp3"));

  const express = (await import("express")).default;
  const { modelVoiceRouter } = await import("./modelVoice.js");
  const app = express();
  app.use("/api/v1", modelVoiceRouter);
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL_DIR === undefined) delete process.env.MODEL_VOICE_CACHE_DIR;
  else process.env.MODEL_VOICE_CACHE_DIR = ORIGINAL_DIR;
});

describe("the manifest", () => {
  it("is served for a language that has been generated", async () => {
    const response = await fetch(`${base}/api/v1/model-voice/hi-IN/manifest.json`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { language: string };
    expect(body.language).toBe("hi-IN");
  });

  it("must revalidate, because pruning can remove what it names", async () => {
    /**
     * The manifest is rewritten on every generation run and is the only thing
     * telling a client which audio exists. Cached, it would point at files a
     * later run pruned — the client would believe a recording exists, request
     * it, and get a 404 in the middle of a tap.
     */
    const response = await fetch(`${base}/api/v1/model-voice/hi-IN/manifest.json`);

    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("is a 404 for a language nothing has been generated for", async () => {
    // The ordinary case for three of four languages until somebody runs the
    // script, and for all four with no API key. The client reads it as "use
    // the platform voice".
    const response = await fetch(`${base}/api/v1/model-voice/de-DE/manifest.json`);

    expect(response.status).toBe(404);
  });
});

describe("the audio", () => {
  it("is served as mp3, which is what makes an audio element play it", async () => {
    const response = await fetch(`${base}/api/v1/model-voice/hi-IN/${KEY}.mp3`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/mpeg");
  });

  it("is immutable for a year, because its name is a hash of its inputs", async () => {
    /**
     * This is what stops a learner paying for the same phrase twice. Safe
     * only because the file name is `sha256(content version, language,
     * phrase, voice, model)` — change any of those and it is a different
     * name, so no cached response can ever be stale.
     */
    const response = await fetch(`${base}/api/v1/model-voice/hi-IN/${KEY}.mp3`);
    const cacheControl = response.headers.get("cache-control") ?? "";

    expect(cacheControl).toContain("immutable");
    expect(cacheControl).toContain("max-age=31536000");
  });

  it("is a 404 for a phrase that was never generated, rather than an error", async () => {
    const response = await fetch(`${base}/api/v1/model-voice/hi-IN/ffffffffffffffffffffffffffffffff.mp3`);

    expect(response.status).toBe(404);
  });
});

describe("what it will not do", () => {
  it("does not list the directory", async () => {
    // A client that needs to know what exists reads the manifest. A listing
    // would be a second, unvalidated answer to the same question.
    const response = await fetch(`${base}/api/v1/model-voice/hi-IN/`);

    expect(response.status).toBe(404);
  });

  it("does not escape the cache directory", async () => {
    /**
     * Encoded rather than plain `../`: the client normalises a plain one away
     * before the request leaves, so a test written that way proves nothing
     * about the server. This is the shape that actually arrives.
     */
    const response = await fetch(`${base}/api/v1/model-voice/hi-IN/%2e%2e%2f%2e%2e%2fpackage.json`);

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("answers 404 below the mount point rather than serving from the root", async () => {
    const response = await fetch(`${base}/api/v1/model-voice/`);

    expect(response.status).toBe(404);
  });
});
