/**
 * What each kind withholds, which is the part that is easy to lose.
 *
 * Every one of these assertions is a way an activity silently becomes a
 * different activity. A `read` with a Listen button is a `repeat`. A `recall`
 * with its target on screen is a `read`. A `listen` that opens a microphone is
 * asking for a permission it never needs. None of those fail loudly; they all
 * render as a working screen that teaches something easier than intended.
 */

import { describe, expect, it } from "vitest";
import { affordancesFor } from "./affordances.js";
import { ACTIVITY_KINDS } from "../activities/types.js";

const FRESH = { takes: 0, revealed: false };

describe("every kind, whatever has happened", () => {
  /**
   * The sweep exists so a sixth kind cannot be added with a `switch` case that
   * returns something incoherent. The function is total by construction — no
   * default branch — but totality is about *having* an answer, not about the
   * answer making sense.
   */
  it("answers coherently for every kind and every state", () => {
    for (const kind of ACTIVITY_KINDS) {
      for (const takes of [0, 1, 3]) {
        for (const revealed of [false, true]) {
          const a = affordancesFor(kind, { takes, revealed });

          // A reveal is only meaningful where the target is hidden.
          if (a.canReveal) expect(a.showsTarget).toBe(false);
          // Nothing can be revealed twice.
          if (revealed) expect(a.canReveal).toBe(false);
          // An activity that needs no microphone cannot be stranded by one.
          if (!a.needsMicrophone) expect(a.canReveal).toBe(false);
        }
      }
    }
  });

  it("never strands a learner with nothing that counts and no way on", () => {
    for (const kind of ACTIVITY_KINDS) {
      for (const revealed of [false, true]) {
        const a = affordancesFor(kind, { takes: 0, revealed });
        expect(a.takeCounts || a.canMoveOn, `${kind}, revealed=${String(revealed)}`).toBe(true);
      }
    }
  });
});

describe("repeat and respond", () => {
  it("show the phrase and offer the model from the start", () => {
    for (const kind of ["repeat", "respond"] as const) {
      const a = affordancesFor(kind, FRESH);
      expect(a.showsTarget).toBe(true);
      expect(a.canListen).toBe(true);
      expect(a.needsMicrophone).toBe(true);
    }
  });
});

describe("read", () => {
  /**
   * The defining absence. `read` is `repeat` minus the model, and a Listen
   * button on the first take is not a small styling difference — it is the
   * exercise, deleted.
   */
  it("offers no model before the first take", () => {
    expect(affordancesFor("read", FRESH).canListen).toBe(false);
  });

  it("unlocks the model once the learner has committed to a pronunciation", () => {
    expect(affordancesFor("read", { takes: 1, revealed: false }).canListen).toBe(true);
  });

  it("still shows the phrase, which is the thing being read", () => {
    expect(affordancesFor("read", FRESH).showsTarget).toBe(true);
  });

  it("has nothing to reveal, because nothing is hidden", () => {
    expect(affordancesFor("read", FRESH).canReveal).toBe(false);
  });
});

describe("recall", () => {
  it("hides the target and the model, since either one is the answer", () => {
    const a = affordancesFor("recall", FRESH);
    expect(a.showsTarget).toBe(false);
    expect(a.canListen).toBe(false);
    expect(a.canReveal).toBe(true);
  });

  /**
   * The escape, and what it costs. A take after a reveal measures reading, not
   * recall, so it does not count — but it is still worth making, which is why
   * the microphone stays open and the model unlocks rather than the activity
   * simply ending.
   */
  it("shows everything after a reveal, and stops counting", () => {
    const a = affordancesFor("recall", { takes: 0, revealed: true });
    expect(a.showsTarget).toBe(true);
    expect(a.canListen).toBe(true);
    expect(a.takeCounts).toBe(false);
    expect(a.needsMicrophone).toBe(true);
  });

  /**
   * Without this the reveal is a trap: nothing counts, so the attempt limit
   * that normally unlocks "next" is never reached, and the learner is on a
   * screen with no way forward. The design forbids hard gates and that is the
   * hardest one there is.
   */
  it("offers a way on once revealed, since nothing can count any more", () => {
    expect(affordancesFor("recall", { takes: 0, revealed: true }).canMoveOn).toBe(true);
    expect(affordancesFor("recall", FRESH).canMoveOn).toBe(false);
  });

  /**
   * The model unlocks after a take even without a reveal, for the same reason
   * it does on `read`: the learner has already committed, so it is feedback
   * rather than the answer.
   */
  it("unlocks the model after a take, without spending the reveal", () => {
    const a = affordancesFor("recall", { takes: 1, revealed: false });
    expect(a.canListen).toBe(true);
    expect(a.takeCounts).toBe(true);
    expect(a.showsTarget).toBe(false);
  });
});

describe("listen", () => {
  /**
   * N5, at the level where it is decided. A microphone this activity never
   * needs is a permission prompt a learner is asked for no reason — and on
   * iOS, one they may only ever be asked once.
   */
  it("needs no microphone", () => {
    expect(affordancesFor("listen", FRESH).needsMicrophone).toBe(false);
  });

  it("plays the model, which is the question rather than a hint", () => {
    expect(affordancesFor("listen", FRESH).canListen).toBe(true);
  });

  it("does not show the target, which is one of the options", () => {
    expect(affordancesFor("listen", FRESH).showsTarget).toBe(false);
  });

  it("offers no reveal, which would simply be the answer", () => {
    expect(affordancesFor("listen", FRESH).canReveal).toBe(false);
  });
});
