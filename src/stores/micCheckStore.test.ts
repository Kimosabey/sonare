// @vitest-environment jsdom

/**
 * The carried verdict, and the two ways keeping one could mislead.
 *
 * **Staleness.** A verdict is about a device in a room at a moment. Repeated a
 * month later it is an assurance based on nothing — and worse, it is exactly
 * the sentence that stops someone re-running a check they should. Stale reads
 * as absent, which renders no line at all.
 *
 * **Scope.** The check screen promises that nothing it hears leaves the device
 * or is kept. A store that quietly retained levels or a waveform would make
 * that promise false, so this holds only what the screen already showed the
 * learner about their own setup.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { VERDICT_TTL_DAYS, clearCheck, readCheck, writeCheck } from "./micCheckStore.js";

/**
 * jsdom exposes `localStorage` as a bare object with no methods, so every test
 * that touches storage has to install a real one. This has bitten this
 * repository more than once.
 */
function installStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null,
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => void map.delete(k),
      setItem: (k: string, v: string) => void map.set(k, v),
    },
  });
}

const NOW = new Date("2026-09-15T09:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

beforeEach(installStorage);

describe("keeping a verdict", () => {
  it("reads back what was written", () => {
    writeCheck("marie", { verdict: "good", deviceLabel: "iPhone Microphone" });

    expect(readCheck("marie")).toMatchObject({
      verdict: "good",
      deviceLabel: "iPhone Microphone",
    });
  });

  it("is null when nothing has been checked", () => {
    expect(readCheck("marie")).toBeNull();
  });

  /**
   * A shared tablet has one microphone and several people. "Did the device
   * pass" and "did *your* check pass" are different questions, and the second
   * is the one the first activity asks.
   */
  it("keeps one learner's verdict out of another's", () => {
    writeCheck("marie", { verdict: "good", deviceLabel: "Built-in" });
    writeCheck("ahmed", { verdict: "quiet", deviceLabel: "Built-in" });

    expect(readCheck("marie")?.verdict).toBe("good");
    expect(readCheck("ahmed")?.verdict).toBe("quiet");
    expect(readCheck(null)).toBeNull();
  });

  it("forgets on request, for erasing a record", () => {
    writeCheck("marie", { verdict: "good", deviceLabel: null });
    clearCheck("marie");

    expect(readCheck("marie")).toBeNull();
  });
});

describe("expiry", () => {
  it("still repeats a recent verdict", () => {
    writeCheck("marie", { verdict: "good", deviceLabel: null, at: daysAgo(VERDICT_TTL_DAYS - 1) });

    expect(readCheck("marie", NOW)?.verdict).toBe("good");
  });

  it("stops repeating one about a setup the learner may have left behind", () => {
    writeCheck("marie", { verdict: "good", deviceLabel: null, at: daysAgo(VERDICT_TTL_DAYS + 1) });

    expect(readCheck("marie", NOW)).toBeNull();
  });

  /**
   * A device clock that moved backwards, or a record written in another
   * timezone's future. Neither is a measurement of now, so neither is trusted
   * — a future timestamp would otherwise never expire.
   */
  it("treats a verdict from the future as stale rather than fresh", () => {
    writeCheck("marie", { verdict: "good", deviceLabel: null, at: daysAgo(-3) });

    expect(readCheck("marie", NOW)).toBeNull();
  });
});

describe("what it refuses to restore", () => {
  it("returns null for anything unreadable, rather than half a verdict", () => {
    for (const bad of ["", "{", "null", '{"verdict":"excellent","at":"2026-09-15T09:00:00Z"}']) {
      localStorage.setItem("sonare.micCheck.v1.marie", bad);
      expect(readCheck("marie", NOW)).toBeNull();
    }
  });

  it("refuses a record with no timestamp, which cannot be aged", () => {
    localStorage.setItem("sonare.micCheck.v1.marie", JSON.stringify({ verdict: "good" }));
    expect(readCheck("marie", NOW)).toBeNull();
  });

  it("refuses an unparseable timestamp", () => {
    localStorage.setItem(
      "sonare.micCheck.v1.marie",
      JSON.stringify({ verdict: "good", at: "whenever" }),
    );
    expect(readCheck("marie", NOW)).toBeNull();
  });

  /**
   * The scope promise, asserted on the record itself. Anything beyond the
   * verdict, the label and the time would contradict what the check screen
   * told the learner while they were speaking.
   */
  it("stores nothing but the verdict, the device label and the time", () => {
    writeCheck("marie", { verdict: "quiet", deviceLabel: "Yeti Nano" });

    const raw = localStorage.getItem("sonare.micCheck.v1.marie") ?? "{}";
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
      "at",
      "deviceLabel",
      "verdict",
    ]);
  });
});
