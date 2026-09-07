/**
 * Live capture feedback shown while recording — the "Interim results" toggle.
 *
 * Explicitly NOT transcription. Everything here is computed locally from the
 * audio we already have: no network, no WebSocket, no partial hypotheses from
 * the recogniser. R6 keeps the scoring path batch-only, and inventing a
 * plausible-looking live transcript would be worse than showing none.
 *
 * What it does give the learner is the thing a partial transcript is usually
 * wanted for: proof the microphone is hearing them, and warning that the take
 * is about to end.
 */

import { memo, useEffect, useRef, useState } from "react";

interface InterimFeedbackProps {
  recording: boolean;
  speaking: boolean;
  level: number;
  /** Silence window in ms, used for the countdown bar. */
  hangoverMs: number;
  autoStop: boolean;
}

function InterimFeedbackBase({ recording, speaking, level, hangoverMs, autoStop }: InterimFeedbackProps) {
  const [elapsed, setElapsed] = useState(0);
  const [silentFor, setSilentFor] = useState(0);
  const startedAt = useRef(0);
  const lastLoudAt = useRef(0);

  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      setSilentFor(0);
      return;
    }
    startedAt.current = performance.now();
    lastLoudAt.current = performance.now();

    const tick = setInterval(() => {
      const now = performance.now();
      setElapsed(now - startedAt.current);
      setSilentFor(now - lastLoudAt.current);
    }, 100);

    return () => clearInterval(tick);
  }, [recording]);

  // -45 dBFS is a display heuristic only; the real endpointer threshold is
  // adaptive and lives in the capture layer.
  useEffect(() => {
    if (recording && level > -45) lastLoudAt.current = performance.now();
  }, [level, recording]);

  if (!recording) return null;

  const remaining = Math.max(0, hangoverMs - silentFor);
  const closing = autoStop && speaking && remaining < hangoverMs;

  return (
    <div className="interim" aria-live="off">
      <div className="interim-row">
        <span className={`listening${speaking ? " heard" : ""}`}>
          <i />
          {speaking ? "hearing you" : "waiting for speech"}
        </span>
        <span className="interim-time">{(elapsed / 1000).toFixed(1)}s</span>
      </div>

      {closing && (
        <>
          <div className="interim-bar">
            <i style={{ width: `${(remaining / hangoverMs) * 100}%` }} />
          </div>
          <div className="interim-note">
            {remaining > 0
              ? `stops in ${(remaining / 1000).toFixed(1)}s if you stay quiet`
              : "finishing…"}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Memoised because the level meter drives a 30Hz state update on the page that
 * renders this. Without a bail-out, every component in that subtree re-rendered
 * thirty times a second for the whole take — on the exact frames the recording
 * UI needs to stay smooth. Props here are referentially stable between level
 * ticks, so the comparison genuinely short-circuits rather than just moving
 * the cost.
 */
export const InterimFeedback = memo(InterimFeedbackBase);
