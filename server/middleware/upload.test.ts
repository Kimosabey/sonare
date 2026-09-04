/**
 * The byte ceiling on an unauthenticated upload endpoint.
 *
 * Two jobs, and only one of them is obvious. It caps what a caller can push
 * into this process's memory — storage is `memoryStorage`, so an uncapped
 * upload is an out-of-memory kill rather than a slow request. And it caps the
 * *field* count, which matters because multipart parsing is the one place a
 * caller controls how much work the server does before any of our own code
 * runs.
 *
 * The ceiling is derived from MAX_AUDIO_SECONDS at module load, so each case
 * loads a fresh module rather than trying to mutate a constant. What it must
 * not become is the *duration* check: bytes are a proxy with headroom in them,
 * and the route enforces real duration from the decoded header. A byte limit
 * tight enough to double as a duration limit would reject legitimate takes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const ORIGINAL = process.env.MAX_AUDIO_SECONDS;

interface Harness {
  base: string;
  close: () => Promise<void>;
}

/** A server whose upload middleware was built under the given env. */
async function serve(seconds?: string): Promise<Harness> {
  vi.resetModules();
  if (seconds === undefined) delete process.env.MAX_AUDIO_SECONDS;
  else process.env.MAX_AUDIO_SECONDS = seconds;

  const express = (await import("express")).default;
  const { uploadAudio } = await import("./upload.js");
  const app = express();
  app.post("/upload", uploadAudio, (req, res) => {
    const file = (req as { file?: { size: number; fieldname: string } }).file;
    res.json({ size: file?.size ?? null, field: file?.fieldname ?? null });
  });
  // multer signals a breach as an error, which without a handler becomes a
  // 500 with a stack. The real route has one; this mirrors its shape.
  app.use((err: { code?: string }, _q: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _n: unknown) => {
    res.status(413).json({ code: err.code ?? "UNKNOWN" });
  });

  let server: Server;
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  return {
    base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => server!.close(() => done())),
  };
}

/** Bytes for `seconds` of 16 kHz mono PCM16, header included. */
function wavBytes(seconds: number): number {
  return 44 + Math.round(16000 * 2 * seconds);
}

function audio(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
}

async function upload(h: Harness, form: FormData): Promise<Response> {
  return fetch(`${h.base}/upload`, { method: "POST", body: form });
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MAX_AUDIO_SECONDS;
  else process.env.MAX_AUDIO_SECONDS = ORIGINAL;
});

describe("what gets through", () => {
  it("accepts a take at the documented maximum length", async () => {
    // 15 seconds of 16 kHz mono is about 480 kB. If the ceiling were tighter
    // than this, the longest legitimate take would fail — and it would fail
    // as a 413 that says nothing about duration.
    const h = await serve("15");
    const form = new FormData();
    form.append("audio", audio(wavBytes(15)), "take.wav");

    const res = await upload(h, form);
    const body = (await res.json()) as { size: number };

    expect(res.status).toBe(200);
    expect(body.size).toBe(wavBytes(15));
    await h.close();
  });

  it("leaves headroom above the exact byte count of a maximum take", async () => {
    /**
     * Deliberate: a client that overshoots slightly, or an encoder that adds a
     * chunk, must not be rejected by the transport for a problem the duration
     * check would describe properly. The route enforces real duration from the
     * decoded header — this is a memory guard, not a duration guard.
     */
    const h = await serve("15");
    const form = new FormData();
    form.append("audio", audio(Math.round(wavBytes(15) * 1.2)), "take.wav");

    expect((await upload(h, form)).status).toBe(200);
    await h.close();
  });

  it("reads the file from the field the client actually sends", async () => {
    // `single("audio")`. A rename on either side means every upload arrives
    // with no file and the route reports MISSING_AUDIO for a working client.
    const h = await serve("15");
    const form = new FormData();
    form.append("audio", audio(1024), "take.wav");

    const body = (await (await upload(h, form)).json()) as { field: string };

    expect(body.field).toBe("audio");
    await h.close();
  });

  it("ignores a file sent under any other field name", async () => {
    const h = await serve("15");
    const form = new FormData();
    form.append("recording", audio(1024), "take.wav");

    expect((await upload(h, form)).status).toBe(413);
    await h.close();
  });
});

describe("what gets refused", () => {
  it("refuses a file past the ceiling instead of buffering it into memory", async () => {
    /**
     * The one that matters. Storage is memoryStorage, so an uncapped upload is
     * not a slow request — it is this process being killed by the OS, taking
     * every in-flight learner's take with it.
     */
    const h = await serve("15");
    const form = new FormData();
    form.append("audio", audio(wavBytes(15) * 4), "huge.wav");

    const res = await upload(h, form);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(413);
    expect(body.code).toBe("LIMIT_FILE_SIZE");
    await h.close();
  });

  it("refuses a second file rather than scoring an unpredictable one", async () => {
    // `files: 1`. Two files would leave which one gets scored up to multer's
    // iteration order.
    const h = await serve("15");
    const form = new FormData();
    form.append("audio", audio(1024), "a.wav");
    form.append("audio", audio(1024), "b.wav");

    expect((await upload(h, form)).status).toBe(413);
    await h.close();
  });

  it("refuses an absurd number of text fields", async () => {
    /**
     * `fields: 10`. Multipart parsing happens before any of our code runs, so
     * this is the one lever a caller has on how much work the server does for
     * free. Ten is generous for reference text, language and a session id.
     */
    const h = await serve("15");
    const form = new FormData();
    form.append("audio", audio(512), "take.wav");
    for (let i = 0; i < 50; i++) form.append(`junk${i}`, "x");

    expect((await upload(h, form)).status).toBe(413);
    await h.close();
  });
});

describe("the ceiling tracks its configuration", () => {
  it("shrinks when MAX_AUDIO_SECONDS shrinks", async () => {
    // Proves the limit is derived rather than a constant that happens to
    // agree with the default.
    const h = await serve("2");
    const form = new FormData();
    form.append("audio", audio(wavBytes(10)), "take.wav");

    expect((await upload(h, form)).status).toBe(413);
    await h.close();
  });

  it("grows when MAX_AUDIO_SECONDS grows", async () => {
    const h = await serve("60");
    const form = new FormData();
    form.append("audio", audio(wavBytes(30)), "take.wav");

    expect((await upload(h, form)).status).toBe(200);
    await h.close();
  });

  it("falls back to 15 seconds when the variable is unset", async () => {
    /**
     * An unset variable must not mean unlimited. Checked from both sides so a
     * default of NaN — which `Number(undefined)` produces and which would make
     * the computed ceiling NaN — cannot pass.
     */
    const h = await serve(undefined);
    const ok = new FormData();
    ok.append("audio", audio(wavBytes(14)), "take.wav");
    const tooBig = new FormData();
    tooBig.append("audio", audio(wavBytes(60)), "take.wav");

    expect((await upload(h, ok)).status).toBe(200);
    expect((await upload(h, tooBig)).status).toBe(413);
    await h.close();
  });

  it("does not become unlimited on a nonsense value", async () => {
    /**
     * The fail-open this file found. `Number("fifteen")` is NaN, and multer
     * compares each chunk against `fileSize` — every comparison against NaN is
     * false, so the ceiling silently disappeared. With memoryStorage that is
     * not a slow request, it is this process being killed by the OS and taking
     * every in-flight learner's take with it. Fixed in server/env.ts by
     * refusing an unreadable value and using the documented default instead.
     */
    for (const nonsense of ["fifteen", "15s", "abc", "1,000", ""]) {
      const h = await serve(nonsense);
      const oversize = new FormData();
      oversize.append("audio", audio(wavBytes(60)), "take.wav");
      const legitimate = new FormData();
      legitimate.append("audio", audio(wavBytes(10)), "take.wav");

      // The default is in force, so 60 seconds is refused and 10 is not.
      expect((await upload(h, oversize)).status, nonsense).toBe(413);
      expect((await upload(h, legitimate)).status, nonsense).toBe(200);
      await h.close();
    }
  });

  it("does not become absurd on an absurd value either", async () => {
    // 999999 seconds derives a ~32 GB ceiling, which is not a ceiling on an
    // in-memory upload in any useful sense.
    const h = await serve("999999");
    const form = new FormData();
    form.append("audio", audio(wavBytes(60)), "take.wav");

    expect((await upload(h, form)).status).toBe(413);
    await h.close();
  });
});
