// @vitest-environment jsdom

/**
 * A sound carried across sessions, which is the one thing this product could
 * not do before.
 *
 * Two properties matter more than the arithmetic. The store must be **bounded**
 * — it grows on every take, forever, in a few megabytes — and it must be
 * **honest about not knowing**: a learner in their first week has no trend, and
 * reporting one as "no change" tells them something false.
 *
 * jsdom here exposes localStorage as a bare object with no methods, so a real
 * in-memory Storage is installed. Without it every call would fall through the
 * store's own try/catch and the whole file would pass vacuously.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSkills,
  readSkills,
  recordSkills,
  trendFor,
  weakestSkills,
} from "./skillStore.js";

function installStorage(seed?: Record<string, string>): Map<string, string> {
  const data = new Map(Object.entries(seed ?? {}));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
  return data;
}

const LEARNER = "marie";
const FR = "fr";

/** One take's worth of syllables. */
function take(...pairs: [string, number][]) {
  return pairs.map(([grapheme, accuracy]) => ({ grapheme, accuracy }));
}

/** `n` takes of the same syllable at the same score, oldest first. */
function history(grapheme: string, scores: number[], startDay = 1): void {
  scores.forEach((accuracy, i) => {
    recordSkills(FR, LEARNER, take([grapheme, accuracy]), `2026-09-${String(startDay + i).padStart(2, "0")}T10:00:00Z`);
  });
}

let data: Map<string, string>;

beforeEach(() => {
  data = installStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("carrying a sound between sessions", () => {
  it("remembers a syllable after the take that produced it is gone", () => {
    recordSkills(FR, LEARNER, take(["ment", 48], ["bon", 92]));

    const store = readSkills(FR, LEARNER);

    expect(store["ment"]?.samples).toHaveLength(1);
    expect(store["bon"]?.samples[0]?.accuracy).toBe(92);
  });

  it("accumulates across takes rather than replacing", () => {
    // The whole point: one take is a score, several are a history.
    history("ment", [48, 55, 61]);

    expect(readSkills(FR, LEARNER)["ment"]?.samples.map((s) => s.accuracy)).toEqual([48, 55, 61]);
  });

  it("keeps one history per learner on a shared device", () => {
    /**
     * A fixture session runs several speakers through one browser. Pooling
     * their sounds would produce a history describing nobody, and the weakest
     * sound shown to one learner would be another's.
     */
    recordSkills(FR, "speaker-a", take(["ment", 40]));
    recordSkills(FR, "speaker-b", take(["ment", 90]));

    expect(readSkills(FR, "speaker-a")["ment"]?.samples[0]?.accuracy).toBe(40);
    expect(readSkills(FR, "speaker-b")["ment"]?.samples[0]?.accuracy).toBe(90);
  });

  it("keeps one history per language", () => {
    // "un" is a word in French and not in German. Sharing the bucket would
    // mix two languages' sounds under one spelling.
    recordSkills("fr", LEARNER, take(["un", 40]));
    recordSkills("de", LEARNER, take(["un", 90]));

    expect(readSkills("fr", LEARNER)["un"]?.samples[0]?.accuracy).toBe(40);
    expect(readSkills("de", LEARNER)["un"]?.samples[0]?.accuracy).toBe(90);
  });

  it("treats the same syllable in two positions as one sound", () => {
    // "Bonjour" comes back capitalised at the start of a phrase and lower-case
    // mid-phrase. Two buckets would each be half as long and both below the
    // threshold for saying anything.
    recordSkills(FR, LEARNER, take(["Bon", 50]));
    recordSkills(FR, LEARNER, take(["bon", 60]));

    expect(readSkills(FR, LEARNER)["bon"]?.samples).toHaveLength(2);
  });

  it("skips a syllable the provider could not name", () => {
    /**
     * Azure returns an empty grapheme where it could not map one — always for
     * Hindi, and around elision in French. Pooling those would put every
     * unnamed sound in one bucket and present it as the learner's weakest,
     * under a blank label.
     */
    recordSkills(FR, LEARNER, take(["", 20], ["   ", 15], ["ment", 61]));

    expect(Object.keys(readSkills(FR, LEARNER))).toEqual(["ment"]);
  });

  it("skips a non-finite accuracy rather than storing NaN", () => {
    // One NaN would poison every mean computed from that sound, permanently.
    recordSkills(FR, LEARNER, take(["ment", Number.NaN], ["bon", 80]));

    expect(readSkills(FR, LEARNER)["ment"]).toBeUndefined();
    expect(readSkills(FR, LEARNER)["bon"]).toBeDefined();
  });
});

describe("bounded, because it grows forever", () => {
  it("keeps only the most recent samples", () => {
    /**
     * This store gains an entry per syllable per take, with no natural end. A
     * learner practising daily for a year would otherwise carry a thousand
     * numbers per sound in a few megabytes of storage — and the only question
     * asked of them is recent-versus-older, which twenty answers.
     */
    history("ment", Array.from({ length: 40 }, (_, i) => i));

    const samples = readSkills(FR, LEARNER)["ment"]?.samples ?? [];
    expect(samples).toHaveLength(20);
    // The newest survive, not the oldest.
    expect(samples[samples.length - 1]?.accuracy).toBe(39);
  });

  it("trims on read as well as on write", () => {
    // An entry written by a build with a larger cap must not be trusted to
    // respect this one.
    const oversized = Array.from({ length: 50 }, (_, i) => ({ at: "2026-09-01T10:00:00Z", accuracy: i }));
    installStorage({
      [`sonare.skills.v1.${FR}.${LEARNER}`]: JSON.stringify({ ment: { grapheme: "ment", samples: oversized } }),
    });

    expect(readSkills(FR, LEARNER)["ment"]?.samples).toHaveLength(20);
  });
});

describe("the trend, and refusing to invent one", () => {
  it("reports no comparison in a learner's first week", () => {
    /**
     * The honest-about-not-knowing property. `before` is null until there is
     * history either side of the window, because a learner reading "no change"
     * on their first Tuesday has been told something false.
     */
    history("ment", [48, 52]);

    const trend = trendFor(readSkills(FR, LEARNER), "ment");

    expect(trend?.now).toBeCloseTo(50, 5);
    expect(trend?.before).toBeNull();
  });

  it("compares recent against older once there is enough", () => {
    // Three early takes around 45, five recent around 65.
    history("ment", [40, 45, 50, 60, 62, 65, 68, 70]);

    const trend = trendFor(readSkills(FR, LEARNER), "ment");

    expect(trend?.before).toBeCloseTo(45, 0);
    expect(trend?.now).toBeCloseTo(65, 0);
    expect((trend?.now ?? 0) - (trend?.before ?? 0)).toBeGreaterThan(10);
  });

  it("reports a decline as plainly as an improvement", () => {
    // A learner getting worse at a sound should be told. Only reporting gains
    // would make the figure a compliment rather than information.
    history("ment", [80, 82, 78, 50, 48, 45, 44, 42]);

    const trend = trendFor(readSkills(FR, LEARNER), "ment");

    expect((trend?.now ?? 0) - (trend?.before ?? 0)).toBeLessThan(0);
  });

  it("has no opinion on a sound it has never heard", () => {
    expect(trendFor(readSkills(FR, LEARNER), "jamais")).toBeNull();
  });

  it("finds a sound however it was capitalised in the question", () => {
    history("ment", [50, 55]);

    expect(trendFor(readSkills(FR, LEARNER), "MENT")).not.toBeNull();
  });
});

describe("the weakest sounds, for the one line a home screen shows", () => {
  it("orders by current mean, worst first", () => {
    history("ment", [40, 42]);
    history("bon", [90, 92], 10);
    history("jour", [65, 61], 20);

    expect(weakestSkills(readSkills(FR, LEARNER)).map((t) => t.grapheme)).toEqual(["ment", "jour", "bon"]);
  });

  it("ignores a sound heard only once", () => {
    /**
     * One bad take is not a pattern. Telling a learner their worst sound is
     * something they fluffed once sends them to practise the wrong thing — the
     * same threshold report.ts applies within a session, for the same reason.
     */
    recordSkills(FR, LEARNER, take(["fluffed", 12]));
    history("ment", [55, 58], 10);

    expect(weakestSkills(readSkills(FR, LEARNER)).map((t) => t.grapheme)).toEqual(["ment"]);
  });

  it("returns nothing at all for a learner with no history", () => {
    // The home screen has to render on a first visit, so an empty answer is
    // the normal case rather than an error.
    expect(weakestSkills(readSkills(FR, LEARNER))).toEqual([]);
  });

  it("caps how many it returns", () => {
    for (let i = 0; i < 8; i++) history(`s${i}`, [30 + i, 31 + i], 1 + i);

    expect(weakestSkills(readSkills(FR, LEARNER))).toHaveLength(3);
    expect(weakestSkills(readSkills(FR, LEARNER), 1)).toHaveLength(1);
  });
});

describe("data this store did not write", () => {
  it("starts empty on a corrupt value rather than throwing", () => {
    // Storage can be hand-edited, or truncated by a crash mid-write.
    installStorage({ [`sonare.skills.v1.${FR}.${LEARNER}`]: "{not json" });

    expect(readSkills(FR, LEARNER)).toEqual({});
  });

  it("drops one malformed sound and keeps the rest", () => {
    /**
     * `JSON.parse(...) as T` is a claim, not a check, and this data outlives
     * the type that described it — the progress store crashed the whole
     * activity screen on exactly that assumption. A corrupt entry costs one
     * syllable's history, not the screen.
     */
    installStorage({
      [`sonare.skills.v1.${FR}.${LEARNER}`]: JSON.stringify({
        ment: { grapheme: "ment", samples: [{ at: "2026-09-01T10:00:00Z", accuracy: 61 }] },
        broken: { samples: "not an array" },
        alsoBroken: { grapheme: "alsoBroken" },
        partial: { grapheme: "partial", samples: [{ at: "2026-09-01T10:00:00Z" }, { accuracy: 50 }] },
      }),
    });

    const store = readSkills(FR, LEARNER);

    expect(Object.keys(store)).toEqual(["ment"]);
    expect(store["ment"]?.samples).toHaveLength(1);
  });

  it("ignores an entry written under an older schema", () => {
    // The version is in the key, so a bump orphans rather than parses.
    installStorage({ [`sonare.skills.v0.${FR}.${LEARNER}`]: JSON.stringify({ ment: { grapheme: "ment", samples: [] } }) });

    expect(readSkills(FR, LEARNER)).toEqual({});
  });
});

describe("when storage refuses", () => {
  it("reads as empty rather than throwing on the home screen", () => {
    // Safari private browsing throws on access. This runs where a learner
    // first lands, so an escaping error is a blank page.
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(readSkills(FR, LEARNER)).toEqual({});
  });

  it("keeps the session working when the write fails", () => {
    /**
     * Fires mid-session, after the learner has already recorded. Losing the
     * cross-session history is a cost; failing the take is not acceptable.
     */
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => recordSkills(FR, LEARNER, take(["ment", 61]))).not.toThrow();
  });

  it("still returns the folded store in memory when it could not be saved", () => {
    // So a caller can show the learner this session's own trend even on a
    // device that cannot persist it.
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("nope");
    });

    expect(recordSkills(FR, LEARNER, take(["ment", 61]))["ment"]?.samples).toHaveLength(1);
  });

  it("survives a removeItem that throws", () => {
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
      throw new Error("nope");
    });

    expect(() => clearSkills(FR, LEARNER)).not.toThrow();
  });
});

describe("shape", () => {
  it("carries no score, pass mark or gate", () => {
    /**
     * This is a mean of past accuracies for one written syllable. It decides
     * nothing — it does not gate an activity, it is not a pass mark, and it
     * never replaces the number the provider returned for the take in front of
     * the learner. The names have to keep saying so.
     */
    history("ment", [48, 55, 61]);
    const trend = trendFor(readSkills(FR, LEARNER), "ment");
    const keys = Object.keys(trend ?? {}).join(" ").toLowerCase();

    expect(keys).not.toContain("score");
    expect(keys).not.toContain("pass");
    expect(keys).not.toContain("level");
  });

  it("clears one language without touching another", () => {
    recordSkills("fr", LEARNER, take(["ment", 61]));
    recordSkills("de", LEARNER, take(["chen", 71]));

    clearSkills("fr", LEARNER);

    expect(readSkills("fr", LEARNER)).toEqual({});
    expect(readSkills("de", LEARNER)["chen"]).toBeDefined();
    expect(data.size).toBe(1);
  });
});
