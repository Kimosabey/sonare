/**
 * "Leave this sitting?" — board 1i, the dialog Android's system back and
 * desktop Esc both land on.
 *
 * ## What it is not
 *
 * It is not a warning, and it offers **no way to throw work away**. Progress is
 * kept either way; the only question is whether the learner carries on now.
 * That is the whole design and it is why there is no third button: a
 * destructive option would need a confirmation of its own, and nothing here
 * needs one because nothing here destroys anything.
 *
 * The second line says so explicitly — a take that has been scored is already
 * counted, and a learner who thinks leaving loses it will sit through an
 * activity they do not have time for. Saying "your progress is kept" only
 * works if it is true, and here it is: `applyTake` writes through to storage on
 * every take, so there is nothing in flight to lose.
 *
 * ## Focus
 *
 * Lands on **Keep going**, the safe one. A dialog that opens with focus on the
 * option that ends the session turns a stray Return — or a second Back press on
 * Android, which is a reflex — into leaving. Esc closes it as "keep going" for
 * the same reason: the gesture that opened it must not also confirm it.
 */

import { useEffect, useRef } from "react";

export interface LeaveSittingDialogProps {
  /** 1-based position in the sitting, for the sentence that orients the learner. */
  position: number;
  total: number;
  /** True once a take has been scored, which changes what is safe to say. */
  hasScoredTake: boolean;
  onKeepGoing: () => void;
  onLeave: () => void;
}

export function LeaveSittingDialog({
  position,
  total,
  hasScoredTake,
  onKeepGoing,
  onLeave,
}: LeaveSittingDialogProps) {
  const keepGoing = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    keepGoing.current?.focus();
  }, []);

  /**
   * Esc closes as "keep going", and the listener is on the dialog's own
   * container rather than the window — the session screen has its own Esc
   * handler to open this, and two listeners on the same key would race.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onKeepGoing();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onKeepGoing]);

  return (
    <div className="leave-backdrop" role="presentation">
      <div
        className="leave-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-title"
        aria-describedby="leave-body"
      >
        <h2 id="leave-title">Leave this sitting?</h2>
        <p id="leave-body" className="what">
          You are {position} {position === 1 ? "activity" : "activities"} into {total}. Your
          progress is kept either way — the question is only whether you carry on now.
        </p>
        {hasScoredTake && (
          <p className="hint">
            The take you just recorded has already been scored and counted. Nothing in flight is
            lost by leaving.
          </p>
        )}
        <div className="row">
          {/*
            First in the DOM as well as focused, so tabbing forward reaches the
            safe option before the one that ends the session.
          */}
          <button type="button" className="enter-cta" ref={keepGoing} onClick={onKeepGoing}>
            Keep going
          </button>
          <button type="button" onClick={onLeave}>
            Leave and come back later
          </button>
        </div>
      </div>
    </div>
  );
}
