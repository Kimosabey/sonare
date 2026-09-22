/**
 * The join that was missing, and the reason it needs its own test.
 *
 * `difficulty.test.ts` proves the table is complete and internally consistent.
 * `SoundDetail.test.tsx` proves a note renders when one is given. Both passed
 * for as long as they have existed, while nothing gave one — so a teacher
 * opening a sound saw the distribution, the words it was heard in, and no
 * guidance whatsoever on the screen whose purpose is telling them what to do.
 *
 * A test of a join is the only kind that can see a missing join.
 */

import { describe, expect, it } from "vitest";
import { soundNoteFor } from "./soundNote.js";
import { difficultiesFor } from "../activities/difficulty.js";
import { LANGUAGES } from "../activities/languages/index.js";

describe("the note for a sound", () => {
  it("returns the advice the table holds, verbatim", () => {
    const entry = difficultiesFor("en", "fr-FR")[0];
    expect(entry, "the French table is empty").toBeDefined();
    const grapheme = entry?.graphemes[0] ?? "";

    const note = soundNoteFor("fr-FR", grapheme);

    expect(note?.howItIsMade).toBe(entry?.advice);
  });

  /**
   * And names the substitution. A teacher who knows only that a sound is hard
   * listens for wrongness; one who knows which wrong sound is coming can name
   * it the moment it arrives.
   */
  it("says which wrong sound to listen for", () => {
    const entry = difficultiesFor("en", "fr-FR")[0];
    const grapheme = entry?.graphemes[0] ?? "";

    const note = soundNoteFor("fr-FR", grapheme);

    expect(note?.inTheRoom ?? "").toContain(entry?.substitution ?? "@@");
  });

  it("folds case, because the scorer's graphemes are not normalised", () => {
    const entry = difficultiesFor("en", "fr-FR")[0];
    const grapheme = entry?.graphemes[0] ?? "";

    expect(soundNoteFor("fr-FR", grapheme.toLocaleUpperCase())).toEqual(
      soundNoteFor("fr-FR", grapheme),
    );
  });

  /**
   * Null, never a placeholder. A sound nobody has written guidance for must
   * render nothing — a filled-in sentence would be advice on a screen a
   * teacher is about to act on that no one stands behind.
   */
  /**
   * A bare slug resolves, and this is the assertion the whole `tableLocaleFor`
   * branch exists for.
   *
   * The class response carries `slug` — "fr" — while the table is keyed
   * "en→fr-FR". Handing the slug straight through matches nothing, and a null
   * note renders nothing, so the screen looks exactly as it did when no note
   * was passed at all. The failure is silent in both directions: no error, no
   * blank space, just a teacher who never sees guidance and has no way to know
   * there was any.
   */
  it("accepts a language slug as well as a full locale", () => {
    const entry = difficultiesFor("en", "fr-FR")[0];
    const grapheme = entry?.graphemes[0] ?? "";

    expect(soundNoteFor("fr", grapheme)).toEqual(soundNoteFor("fr-FR", grapheme));
    expect(soundNoteFor("fr", grapheme)).not.toBeNull();
  });

  it("does the same for every language with a table", () => {
    for (const [slug, locale] of [
      ["fr", "fr-FR"],
      ["es", "es-ES"],
      ["de", "de-DE"],
    ] as const) {
      const grapheme = difficultiesFor("en", locale)[0]?.graphemes[0] ?? "";
      expect(grapheme, `no difficulties for ${locale}`).not.toBe("");
      expect(soundNoteFor(slug, grapheme), slug).toEqual(soundNoteFor(locale, grapheme));
      expect(soundNoteFor(slug, grapheme), slug).not.toBeNull();
    }
  });

  it("says nothing at all for a sound with no entry", () => {
    expect(soundNoteFor("fr-FR", "zzz")).toBeNull();
  });

  it("says nothing for a language with no table", () => {
    expect(soundNoteFor("hi-IN", "ka")).toBeNull();
  });
});

describe("what a teacher actually gets", () => {
  /**
   * The join, across every shipped language. This is the assertion that would
   * have failed for the whole life of the feature: it asks whether a sound a
   * teacher can open resolves to guidance, rather than whether the table and
   * the component each work alone.
   */
  it.each(LANGUAGES.map((l) => [l.label, l.code] as const))(
    "has a note for every sound %s drills",
    (_label, code) => {
      const entries = difficultiesFor("en", code);
      expect(entries.length, `no difficulties written for ${code}`).toBeGreaterThan(0);

      for (const entry of entries) {
        for (const grapheme of entry.graphemes) {
          const note = soundNoteFor(code, grapheme);
          expect(note, `${code} ${grapheme} resolves to no note`).not.toBeNull();
          expect((note?.howItIsMade ?? "").length, `${code} ${grapheme}`).toBeGreaterThan(20);
        }
      }
    },
  );

  /**
   * Non-vacuity: the sweep above passes against a language with no sounds and
   * against a `soundNoteFor` that returns a constant.
   */
  it("gives different sounds different advice", () => {
    const entries = difficultiesFor("en", "fr-FR");
    const notes = entries.map((entry) => soundNoteFor("fr-FR", entry.graphemes[0] ?? "")?.howItIsMade);

    expect(new Set(notes).size).toBe(entries.length);
  });
});
