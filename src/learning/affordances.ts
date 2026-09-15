/**
 * What each kind of activity offers the learner, and what it withholds.
 * Pure, no React, no I/O.
 *
 * `ActivityTest` did not branch on `kind` at all — every activity rendered as a
 * `repeat`, with the phrase on screen and a Listen button beside the record
 * button. That is right for `repeat` and wrong for three of the other four, in
 * ways that quietly delete the exercise:
 *
 *  - A `read` activity with a Listen button **is** a `repeat`. Hearing it first
 *    is the thing being withheld; the learner is meant to work the spelling out
 *    for themselves, which is the whole skill. The model unlocks after the
 *    first take, when it has stopped being the answer and become feedback.
 *  - A `recall` activity with the phrase on screen **is** a `read`. The target
 *    is what the learner is supposed to produce, so showing it hands them the
 *    answer to the question being asked.
 *  - A `listen` activity has nothing to say aloud at all. Opening a microphone
 *    for it asks a permission the activity never needs (N5).
 *
 * Extracted rather than written inline for the same reason `session.ts` was:
 * these are the rules, and rules that live inside a 992-line component can only
 * be exercised by rendering it with a mocked recorder and reading the DOM.
 */

import { MAX_ATTEMPTS } from "../activities/languages/index.js";
import type { ActivityKind } from "../activities/types.js";

/** What has happened on this activity so far, as the affordances depend on it. */
export interface ActivityState {
  /** Takes recorded against this activity, of any kind. */
  takes: number;
  /** Whether the learner has asked to see a hidden target. */
  revealed: boolean;
}

export interface Affordances {
  /** Whether the target text is on screen. */
  showsTarget: boolean;
  /**
   * Whether the model voice may be played.
   *
   * Separate from "is a model voice available at all", which is a question
   * about the device and the network. This is whether the activity permits it.
   */
  canListen: boolean;
  /**
   * Whether to offer a reveal — and it is offered only where the target is
   * hidden *and* the learner is expected to produce it. A `listen` activity
   * hides its target too, but revealing there would simply be answering the
   * question for them.
   */
  canReveal: boolean;
  /** Whether this activity records the learner speaking. */
  needsMicrophone: boolean;
  /**
   * Whether a take would count.
   *
   * False after a reveal: the learner has seen what they were asked to
   * produce, so the take measures reading rather than recall. It is still
   * worth making — the pronunciation feedback is real and this is how they
   * learn the phrase — it just is not recorded as progress. Deliberately not
   * expressed as an attempt with a null accuracy, which already means
   * something else entirely: that the system declined to judge a take it was
   * given (R8).
   */
  takeCounts: boolean;
  /**
   * Whether to offer a way past this activity without passing it.
   *
   * A revealed `recall` would otherwise strand the learner: nothing they do
   * counts, so the attempt limit that normally unlocks "next" is never
   * reached. The design forbids hard gates, and a screen with no way forward
   * is the hardest gate there is.
   */
  canMoveOn: boolean;
  /**
   * How many judged answers this activity allows before it is over.
   *
   * `MAX_ATTEMPTS` for everything spoken: three takes at a phrase is three
   * genuine goes at making a sound, and the second is usually better than the
   * first.
   *
   * One for `listen`, and that is a judgement about what a second guess would
   * mean. A learner choosing between two or four written phrases either heard
   * the difference or did not; offering another go turns the exercise into
   * elimination, and with two options a "wrong" answer would be worth nothing
   * at all because the next tap is certain to be right. One answer, then the
   * right one shown — which is the moment the learning actually happens.
   */
  attemptLimit: number;
}

/**
 * The affordances of one activity, given what has happened on it.
 *
 * Total over `ActivityKind` by construction — a `switch` with no default, so
 * adding a sixth kind is a type error here rather than a screen that silently
 * renders it as a `repeat`, which is exactly how `read` and `recall` came to
 * be rendered as one.
 */
export function affordancesFor(kind: ActivityKind, state: ActivityState): Affordances {
  const { takes, revealed } = state;

  switch (kind) {
    /**
     * Hear it, say it back. The model is the point and is available from the
     * start.
     */
    case "repeat":
      return {
        showsTarget: true,
        canListen: true,
        canReveal: false,
        needsMicrophone: true,
        takeCounts: true,
        canMoveOn: false,
        attemptLimit: MAX_ATTEMPTS,
      };

    /**
     * Answer a question aloud. The target is the expected answer and is shown,
     * which is deliberate rather than an oversight: this is a pronunciation
     * trainer, and the learner is being measured on how they say it, not on
     * whether they could think of it. The question supplies the context that
     * makes the phrase worth saying.
     */
    case "respond":
      return {
        showsTarget: true,
        canListen: true,
        canReveal: false,
        needsMicrophone: true,
        takeCounts: true,
        canMoveOn: false,
        attemptLimit: MAX_ATTEMPTS,
      };

    /**
     * Read the written phrase aloud with no model first — the one kind whose
     * definition is a thing that is *absent*. The model unlocks after the
     * first take: by then the learner has committed to a pronunciation, so
     * hearing the model is feedback on what they did rather than the answer
     * before they do it.
     */
    case "read":
      return {
        showsTarget: true,
        canListen: takes > 0,
        canReveal: false,
        needsMicrophone: true,
        takeCounts: true,
        canMoveOn: false,
        attemptLimit: MAX_ATTEMPTS,
      };

    /**
     * See the English, produce the target from memory. The target is hidden
     * and so is the model, because either one is the answer.
     */
    case "recall":
      return {
        showsTarget: revealed,
        canListen: revealed || takes > 0,
        canReveal: !revealed,
        needsMicrophone: true,
        takeCounts: !revealed,
        canMoveOn: revealed,
        attemptLimit: MAX_ATTEMPTS,
      };

    /**
     * Hear the model and pick which phrase it was. The only kind that asks
     * nothing of the microphone — no recording, no provider call, no
     * permission prompt (N5) — and the only one where playing the model is not
     * a hint but the question itself.
     *
     * `showsTarget` is false because the target is the right answer: it
     * appears among the options, not above them.
     */
    case "listen":
      return {
        showsTarget: false,
        canListen: true,
        canReveal: false,
        needsMicrophone: false,
        takeCounts: true,
        canMoveOn: false,
        attemptLimit: 1,
      };
  }
}

/**
 * Whether a kind records the learner at all.
 *
 * A thin read of `affordancesFor`, for callers that need the answer before
 * they have any per-activity state — the session screen decides whether an
 * unavailable microphone blocks the activity, and that question is settled by
 * the kind alone.
 */
export function activityNeedsMicrophone(kind: ActivityKind): boolean {
  return affordancesFor(kind, { takes: 0, revealed: false }).needsMicrophone;
}
