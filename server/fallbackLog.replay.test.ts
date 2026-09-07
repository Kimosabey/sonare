/**
 * Draining a backlog of real learner records, and the gauge that says one
 * exists.
 *
 * The gap this closes is specific. `fallback.written` counts writes since the
 * process started, so a restart with a full backlog reports zero — and the
 * moment somebody most wants to know there is unreplayed learner data is right
 * after the restart that ended the outage. So `countPending` asks the
 * filesystem instead.
 *
 * Everything here handles records the product exists to produce (PRD §8), so
 * the ordering rule matters more than it looks: the file is archived only
 * *after* a successful insert. Renaming first would lose the backlog if the
 * insert then failed, which is the one thing this whole mechanism exists to
 * prevent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "mongodb";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let dir: string;
let inserted: Record<string, unknown[]>;
let insertFails: string | null = null;

function fakeDb(): Db {
  return {
    collection: (name: string) => ({
      insertMany: (docs: unknown[], options: { ordered: boolean }) => {
        if (insertFails === name) return Promise.reject(new Error("mongo is still down"));
        // Asserted below: one bad record must not block the rest.
        expect(options.ordered).toBe(false);
        inserted[name] = [...(inserted[name] ?? []), ...docs];
        return Promise.resolve({ insertedCount: docs.length });
      },
    }),
  } as unknown as Db;
}

/** A fresh module bound to a throwaway FALLBACK_DIR. */
async function load() {
  vi.resetModules();
  process.env.FALLBACK_DIR = dir;
  return import("./fallbackLog.js");
}

async function seed(collection: string, records: unknown[]): Promise<void> {
  await writeFile(
    join(dir, `${collection}.fallback.ndjson`),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sonare-fallback-"));
  inserted = {};
  insertFails = null;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.FALLBACK_DIR;
  vi.clearAllMocks();
});

describe("the gauge", () => {
  it("is zero with no files, which is the healthy case", async () => {
    const { countPending } = await load();

    expect(await countPending()).toEqual({ attempts: 0, diagnostics: 0 });
  });

  it("counts records waiting on disk", async () => {
    /**
     * Read from the filesystem rather than from a counter, so it survives the
     * restart that ends the outage — which is exactly when it is needed.
     */
    await seed("attempts", [{ at: "1" }, { at: "2" }, { at: "3" }]);
    await seed("diagnostics", [{ at: "1" }]);
    const { countPending } = await load();

    expect(await countPending()).toEqual({ attempts: 3, diagnostics: 1 });
  });

  it("ignores blank lines rather than counting them as records", async () => {
    await writeFile(join(dir, "attempts.fallback.ndjson"), '{"at":"1"}\n\n\n{"at":"2"}\n', "utf8");
    const { countPending } = await load();

    expect((await countPending()).attempts).toBe(2);
  });

  it("survives a directory it cannot read", async () => {
    // A metrics read that throws is worse than one reporting nothing.
    process.env.FALLBACK_DIR = join(dir, "does", "not", "exist");
    vi.resetModules();
    const { countPending } = await import("./fallbackLog.js");

    await expect(countPending()).resolves.toEqual({ attempts: 0, diagnostics: 0 });
  });
});

describe("draining", () => {
  it("inserts every record and archives the file", async () => {
    await seed("attempts", [{ at: "1" }, { at: "2" }]);
    const { replayPending, countPending } = await load();

    const outcomes = await replayPending(fakeDb());

    expect(inserted["attempts"]).toHaveLength(2);
    expect(outcomes.find((o) => o.collection === "attempts")?.archivedAs).toMatch(/\.replayed$/);
    // And the backlog is genuinely gone, not just reported as drained.
    expect((await countPending()).attempts).toBe(0);
  });

  it("archives rather than deletes", async () => {
    /**
     * These are real learner records. A rename is reversible and an unlink is
     * not, and the cost of keeping a file nobody reads is nothing next to
     * losing the measurement the product exists to produce.
     */
    await seed("attempts", [{ at: "1" }]);
    const { replayPending } = await load();

    await replayPending(fakeDb());

    const archived = (await readdir(dir)).filter((f) => f.endsWith(".replayed"));
    expect(archived).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, archived[0] as string), "utf8"))).toEqual({ at: "1" });
  });

  it("leaves the file in place when the insert fails", async () => {
    /**
     * The ordering rule. Archiving first would lose the backlog the moment the
     * insert failed — during an outage, which is the only time this code runs.
     */
    await seed("attempts", [{ at: "1" }]);
    insertFails = "attempts";
    const { replayPending, countPending } = await load();

    const outcomes = await replayPending(fakeDb());

    expect(outcomes.find((o) => o.collection === "attempts")?.error).toMatch(/still down/);
    expect((await countPending()).attempts).toBe(1);
    expect((await readdir(dir)).filter((f) => f.endsWith(".replayed"))).toHaveLength(0);
  });

  it("drains one collection even when the other fails", async () => {
    await seed("attempts", [{ at: "1" }]);
    await seed("diagnostics", [{ at: "2" }]);
    insertFails = "attempts";
    const { replayPending, countPending } = await load();

    await replayPending(fakeDb());

    const pending = await countPending();
    expect(pending.attempts).toBe(1);
    expect(pending.diagnostics).toBe(0);
  });

  it("skips a line torn by a crash instead of stranding the rest", async () => {
    /**
     * NDJSON is append-only precisely so a crash mid-write damages one line.
     * Failing the whole replay on it would strand every intact record behind
     * it — permanently, since the next run hits the same line.
     */
    await writeFile(
      join(dir, "attempts.fallback.ndjson"),
      '{"at":"1"}\n{"at":"2",tru\n{"at":"3"}\n',
      "utf8",
    );
    const { replayPending } = await load();

    await replayPending(fakeDb());

    expect(inserted["attempts"]).toEqual([{ at: "1" }, { at: "3" }]);
  });

  it("ignores a line that is valid JSON but not a record", async () => {
    // A bare number cannot be a document, and passing it to insertMany would
    // fail the whole batch.
    await writeFile(join(dir, "attempts.fallback.ndjson"), '{"at":"1"}\n42\n"nope"\n', "utf8");
    const { replayPending } = await load();

    await replayPending(fakeDb());

    expect(inserted["attempts"]).toEqual([{ at: "1" }]);
  });

  it("is a no-op with nothing pending", async () => {
    const { replayPending } = await load();

    const outcomes = await replayPending(fakeDb());

    expect(outcomes.every((o) => o.records === 0)).toBe(true);
    expect(inserted).toEqual({});
  });

  it("is a no-op on a file of only blank lines", async () => {
    await writeFile(join(dir, "attempts.fallback.ndjson"), "\n\n\n", "utf8");
    const { replayPending } = await load();

    await replayPending(fakeDb());

    expect(inserted).toEqual({});
    // Nothing to archive, so the empty file is left alone rather than renamed.
    expect((await readdir(dir)).filter((f) => f.endsWith(".replayed"))).toHaveLength(0);
  });

  it("is safe to run twice", async () => {
    // The first run archives the file, so the second finds nothing — which is
    // what makes running it on every startup harmless.
    await seed("attempts", [{ at: "1" }]);
    const { replayPending } = await load();

    await replayPending(fakeDb());
    await replayPending(fakeDb());

    expect(inserted["attempts"]).toHaveLength(1);
  });
});

describe("appending still counts", () => {
  it("increments the counter as well as writing the file", async () => {
    // The counter and the gauge answer different questions: how much this
    // process has spilled, and how much is waiting overall.
    const { appendFallback, countPending } = await load();
    const { snapshot, resetMetrics } = await import("./infra/metrics.js");
    resetMetrics();

    await appendFallback("attempts", { at: "1" });

    expect(snapshot().counters["fallback.written"]).toBe(1);
    expect((await countPending()).attempts).toBe(1);
  });
});
