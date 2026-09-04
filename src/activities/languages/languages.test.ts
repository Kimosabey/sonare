/**
 * The activity sets are data, and data has no type checker for the things that
 * actually break: a duplicate id, an empty target, a slug that no longer
 * matches its route, a locale Azure will not accept. Each of those compiles
 * cleanly and fails at runtime for an entire language.
 *
 * These run over every set rather than one, so adding a fifth language gets the
 * same checks for free — which is the point, since a new set is exactly when
 * someone copies an existing file and forgets to change one field.
 */

import { describe, expect, it } from "vitest";
import { LANGUAGES, MAX_ATTEMPTS, PASS_SCORE, getLanguage } from "./index.js";

/** Azure pronunciation-assessment locales are BCP-47: two-letter, region-qualified. */
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

describe("the language set as a whole", () => {
  it("ships the four languages the product claims", () => {
    expect(LANGUAGES.map((l) => l.slug)).toEqual(["fr", "es", "de", "hi"]);
  });

  it("has no duplicate slugs — getLanguage() returns the first match", () => {
    // A duplicate would silently shadow a whole language: its route would
    // resolve to the wrong set rather than failing.
    const slugs = LANGUAGES.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("has no duplicate locales, which would make two languages score identically", () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("resolves a known slug and rejects an unknown one", () => {
    expect(getLanguage("fr")?.label).toBe("French");
    expect(getLanguage("xx")).toBeUndefined();
    // ActivityTest passes `slug ?? "unknown"` before the guard runs.
    expect(getLanguage(undefined)).toBeUndefined();
  });
});

describe.each(LANGUAGES.map((l) => [l.label, l] as const))("%s activity set", (_label, set) => {
  it("has a slug, a label, and a locale Azure will accept", () => {
    expect(set.slug).toMatch(/^[a-z]{2}$/);
    expect(set.label.trim().length).toBeGreaterThan(0);
    // A malformed locale is not rejected until the provider call, by which
    // point the learner has already recorded.
    expect(set.code).toMatch(LOCALE);
  });

  it("has exactly ten activities, as the product promises throughout", () => {
    // "Ten activities" is in the README, the intro copy and the report's
    // denominator. A set of nine would make the progress bar lie.
    expect(set.activities).toHaveLength(10);
  });

  it("numbers its activities 1..10 with no duplicates or gaps", () => {
    // `id` is the React key, the progress key, and what the report joins on —
    // a duplicate silently merges two activities' attempts.
    expect(set.activities.map((a) => a.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("gives every activity a non-empty target to score against", () => {
    // An empty target reaches the server and comes back
    // MISSING_REFERENCE_TEXT, after the learner has spoken.
    for (const activity of set.activities) {
      expect(activity.target.trim().length, `activity ${activity.id}`).toBeGreaterThan(0);
    }
  });

  it("gives every activity a prompt, a gloss and a focus", () => {
    // The gloss is what stops a learner guessing at meaning; the focus drives
    // the report's improvement areas. Neither is optional in practice.
    for (const activity of set.activities) {
      expect(activity.prompt.trim().length, `activity ${activity.id} prompt`).toBeGreaterThan(0);
      expect(activity.gloss.trim().length, `activity ${activity.id} gloss`).toBeGreaterThan(0);
      expect(activity.focus.trim().length, `activity ${activity.id} focus`).toBeGreaterThan(0);
    }
  });

  it("uses only the three activity kinds the UI knows how to render", () => {
    for (const activity of set.activities) {
      expect(["repeat", "respond", "read"]).toContain(activity.kind);
    }
  });

  it("keeps every target inside the capture duration ceiling", () => {
    /**
     * MAX_AUDIO_SECONDS is 15 and hangoverForReference tops out at 2400ms of
     * trailing silence. A target long enough to need more than ~12s of speech
     * would be cut off mid-phrase and scored as an omission — the learner
     * blamed for our timing. Roughly 2.5 words a second is a slow learner's
     * pace, which is the one that matters here.
     */
    for (const activity of set.activities) {
      const words = activity.target.trim().split(/\s+/).length;
      expect(words, `activity ${activity.id} is ${words} words`).toBeLessThanOrEqual(14);
    }
  });

  it("has no duplicate targets, which would score the same phrase twice", () => {
    const targets = set.activities.map((a) => a.target);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe("the gate constants", () => {
  it("passes below the halfway mark, deliberately", () => {
    // 60 is a soft gate. The README is explicit that a hard one would strand
    // anyone whose accent the scorer mishandles — which is the failure this
    // POC exists to detect, not inflict.
    expect(PASS_SCORE).toBe(60);
    expect(PASS_SCORE).toBeLessThan(80);
  });

  it("lets a learner move on after three scored attempts", () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
