/**
 * The 1.4 seconds after a learner stops speaking.
 *
 * Measured: Azure takes p50 1370ms, p95 1526ms, and the round trip through a
 * tunnel was 1.83s. For that whole window the screen used to show nothing
 * moving — the record button read "Scoring…" and everything else sat still.
 * That is the moment of maximum anxiety in the entire interaction: the learner
 * has just performed and does not yet know how it went, and the interface said
 * nothing back.
 *
 * A skeleton rather than a spinner, deliberately. A spinner claims an unknown
 * duration; we know this takes about a second and a half. Rendering the score
 * card's own shape says "your take arrived, the numbers are coming, and here is
 * where they will be" — and because the geometry matches, the real values
 * replace it in place instead of pushing the page around.
 *
 * It must survive `prefers-reduced-motion`, which the global rule strips every
 * animation for. A skeleton whose only message is its shimmer says nothing at
 * all to a learner with that preference set, so the status line below is real
 * text and carries the meaning on its own.
 */

import { memo } from "react";

interface ScoreCardSkeletonProps {
  /** Same four labels the real card uses, so the shape is honest. */
  labels?: readonly string[];
}

const DEFAULT_LABELS = ["overall", "accuracy", "fluency", "complete"] as const;

function ScoreCardSkeletonBase({ labels = DEFAULT_LABELS }: ScoreCardSkeletonProps) {
  return (
    <div className="scoring" data-testid="score-skeleton">
      {/*
        The labels are shown for real. They are not unknown — every take
        reports the same four — so blanking them would be pretending to know
        less than we do, and it makes the arriving numbers land in a place the
        eye has already found.
      */}
      <div className="overall overall-pending" aria-hidden="true">
        {labels.map((label) => (
          <div key={label}>
            <div className="n sk-bar" />
            <div className="l">{label}</div>
          </div>
        ))}
      </div>

      <div className="sk-words" aria-hidden="true">
        {/* Three, because most activity targets are short phrases and a row
            that guesses the real word count would be a lie the layout tells. */}
        <span className="sk-chip" />
        <span className="sk-chip" />
        <span className="sk-chip" />
      </div>

      {/*
        The one part that is not decorative. `aria-live` sits on the container
        in ActivityTest, so this announces once when it appears — and it is the
        whole message under reduced motion.
      */}
      <p className="what">Scoring your take…</p>
    </div>
  );
}

export const ScoreCardSkeleton = memo(ScoreCardSkeletonBase);
