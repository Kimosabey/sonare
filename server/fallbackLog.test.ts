/**
 * The last line of defence for the data this product exists to produce.
 *
 * PRD §8 makes the attempt trail the deliverable rather than an incidental
 * log: silently dropping a record on a transient Mongo hiccup can invalidate
 * the exact measurement the fixture run is being conducted to take. So the
 * failure mode that matters is not "the write failed" — it is "the write
 * failed and nobody can tell afterwards".
 *
 * Real files in a temporary directory, not a mocked fs. The properties under
 * test are append-only-ness, one-record-per-line and crash survival, and every
 * one of those is a property of the filesystem behaviour rather than of the
 * calling code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
const ORIGINAL_DIR = process.env.FALLBACK_DIR;

/**
 * FALLBACK_DIR is read once at module load, so each test needs a fresh module
 * rather than a mutated constant. resetModules rather than a cache-busting
 * query string — the latter is not valid syntax to the transform.
 */
async function load() {
  vi.resetModules();
  return import("./fallbackLog.js");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sonare-fallback-"));
  process.env.FALLBACK_DIR = dir;
});

afterEach(async () => {
  if (ORIGINAL_DIR === undefined) delete process.env.FALLBACK_DIR;
  else process.env.FALLBACK_DIR = ORIGINAL_DIR;
  // chmod back first, or the cleanup of the permission test fails.
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("appendFallback", () => {
  it("creates the directory rather than requiring one to exist", async () => {
    // The first fallback write of a deployment's life happens during an
    // outage. Needing a directory somebody remembered to create would mean
    // losing exactly the records it exists to keep.
    const nested = join(dir, "deep", "nested");
    process.env.FALLBACK_DIR = nested;
    const { appendFallback, fallbackPath } = await load();

    await appendFallback("attempts", { at: "2026-09-04T10:00:00Z", referenceText: "Bonjour" });

    const text = await readFile(fallbackPath("attempts"), "utf8");
    expect(JSON.parse(text.trim())).toMatchObject({ referenceText: "Bonjour" });
  });

  it("writes one record per line, so a partial file is still parseable", async () => {
    const { appendFallback, fallbackPath } = await load();

    await appendFallback("attempts", { n: 1 });
    await appendFallback("attempts", { n: 2 });
    await appendFallback("attempts", { n: 3 });

    const lines = (await readFile(fallbackPath("attempts"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => (JSON.parse(l) as { n: number }).n)).toEqual([1, 2, 3]);
  });

  it("appends rather than replacing, across separate calls", async () => {
    // Truncating would turn an outage that cost one record into one that cost
    // every record — the opposite of the point.
    const { appendFallback, fallbackPath } = await load();

    await appendFallback("attempts", { first: true });
    await appendFallback("attempts", { second: true });

    const text = await readFile(fallbackPath("attempts"), "utf8");
    expect(text).toContain('"first"');
    expect(text).toContain('"second"');
  });

  it("ends every line with a newline, so a crash mid-write cannot corrupt a prior record", async () => {
    /**
     * This is the reason for NDJSON over a JSON array. A process killed
     * part-way through writing leaves a final truncated line, which the
     * replay skips — where an array would leave a file with no closing
     * bracket and lose everything before it too.
     */
    const { appendFallback, fallbackPath } = await load();

    await appendFallback("diagnostics", { code: "SNR_TOO_LOW" });
    const text = await readFile(fallbackPath("diagnostics"), "utf8");

    expect(text.endsWith("\n")).toBe(true);
  });

  it("keeps attempts and diagnostics in separate files", async () => {
    const { appendFallback, fallbackPath } = await load();

    await appendFallback("attempts", { kind: "attempt" });
    await appendFallback("diagnostics", { kind: "diagnostic" });

    expect(await readFile(fallbackPath("attempts"), "utf8")).toContain("attempt");
    expect(await readFile(fallbackPath("diagnostics"), "utf8")).not.toContain('"attempt"');
  });

  it("never throws into a learner's request, even when the disk refuses", async () => {
    /**
     * The whole chain is non-blocking by design: Mongo failing must not fail a
     * take, and the fallback failing must not either. A learner who just spoke
     * should get their score even if every persistence layer is broken —
     * losing the analysis record is bad, losing the learner's attempt is worse.
     */
    const { appendFallback } = await load();
    await chmod(dir, 0o500); // read + execute, no write

    await expect(appendFallback("attempts", { n: 1 })).resolves.toBeUndefined();
  });

  it("survives a record containing something JSON cannot represent", async () => {
    // deviceContext is whatever the client sent. A circular structure would
    // make JSON.stringify throw, and that must not escape either.
    const { appendFallback } = await load();
    const circular: Record<string, unknown> = { at: "now" };
    circular.self = circular;

    await expect(appendFallback("attempts", circular)).resolves.toBeUndefined();
  });
});

describe("fallbackPath", () => {
  it("names files the replay script looks for", async () => {
    // scripts/replay-fallback.mjs builds these names independently. A rename
    // on one side only would leave records on disk that nothing drains — the
    // failure being silent is what makes it worth asserting.
    const { fallbackPath } = await load();

    expect(fallbackPath("attempts")).toBe(join(dir, "attempts.fallback.ndjson"));
    expect(fallbackPath("diagnostics")).toBe(join(dir, "diagnostics.fallback.ndjson"));
  });

  it("is what the replay script would read, round trip", async () => {
    const { appendFallback, fallbackPath } = await load();
    await appendFallback("attempts", { at: "2026-09-04T10:00:00Z", language: "fr-FR" });

    // The replay's own parse: split on newlines, drop blanks, JSON.parse each.
    const text = await readFile(fallbackPath("attempts"), "utf8");
    const records = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { language: string });

    expect(records).toHaveLength(1);
    expect(records[0]?.language).toBe("fr-FR");
  });

  it("a truncated final line is skipped, not fatal, on replay", async () => {
    // Simulates a process killed mid-append.
    const { fallbackPath } = await load();
    await writeFile(fallbackPath("attempts"), '{"n":1}\n{"n":2}\n{"n":3', "utf8");

    const text = await readFile(fallbackPath("attempts"), "utf8");
    const parsed: unknown[] = [];
    let skipped = 0;
    for (const line of text.split("\n").filter((l) => l.trim().length > 0)) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        skipped += 1;
      }
    }

    // Two whole records recovered; only the interrupted one lost.
    expect(parsed).toHaveLength(2);
    expect(skipped).toBe(1);
  });
});
