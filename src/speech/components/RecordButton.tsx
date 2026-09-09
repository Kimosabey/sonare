import type { RecorderState } from "../capture/types.js";
import { memo } from "react";

interface RecordButtonProps {
  state: RecorderState;
  onStart: () => void;
  onStop: () => void;
  /** In auto mode the button does not offer a stop — silence ends the take. */
  autoStop?: boolean;
  /** True once speech has been heard in the current take. */
  speaking?: boolean;
  /** Session stays open across utterances. */
  continuous?: boolean;
  sessionActive?: boolean;
  /**
   * Label the idle button as a retake rather than a first attempt.
   *
   * "Start speaking" under a score the learner has just read is describing the
   * wrong moment — they are not starting, they are deciding whether to go
   * again. The label lives here rather than being duplicated as a second
   * bespoke button on the screen, because everything else about the tap
   * belongs here: R10 requires the call into the capture layer to happen
   * synchronously inside this handler, and the busy/disabled matrix is one
   * decision that should have one owner.
   */
  retry?: boolean;
  /**
   * Render as the quieter half of a pair.
   *
   * After a result there are two things a learner may want and both are
   * legitimate, so both are offered — but two identically filled buttons make
   * the pair ambiguous rather than ordered. This is styling only; nothing
   * about the tap changes.
   */
  secondary?: boolean;
}

function RecordButtonBase({
  state,
  onStart,
  onStop,
  autoStop = false,
  speaking = false,
  continuous = false,
  sessionActive = false,
  retry = false,
  secondary = false,
}: RecordButtonProps) {
  const recording = state === "recording";
  const busy = state === "requesting" || state === "processing" || state === "ready";

  // In a continuous session the button never returns to "Start" between
  // utterances — the session owns the microphone until it is ended.
  const label = recording
    ? autoStop
      ? "Listening…"
      : "Stop recording"
    : state === "requesting"
      ? "Opening microphone…"
      : state === "processing"
        ? "Scoring…"
        : sessionActive
          ? "Listening for the next…"
          : state === "error"
            ? "Try again"
            : retry
              ? "Try again"
              : continuous
                ? "Start session"
                : "Start speaking";

  return (
    <>
      <button
        type="button"
        // `rec` last where both apply: the live-microphone treatment is not
        // something a "quieter of the pair" hint may override.
        className={[secondary ? "ghost" : "", recording ? "rec" : ""].filter(Boolean).join(" ")}
        // In auto mode the take ends on silence, so the button has nothing to
        // do while recording — disabling it prevents a tap that would look
        // like a stop but land as a no-op.
        disabled={busy || sessionActive || (recording && autoStop)}
        // R10/FR-07: the call into the capture layer happens synchronously
        // inside this handler. Deferring it costs the gesture and iOS refuses
        // the microphone.
        onClick={recording ? onStop : onStart}
      >
        {label}
      </button>

      {recording && autoStop && (
        <span className={`listening${speaking ? " heard" : ""}`}>
          <i />
          {speaking ? "heard you — pause to finish" : "waiting for speech"}
        </span>
      )}
    </>
  );
}

/**
 * Memoised because the level meter drives a 30Hz state update on the page that
 * renders this. Without a bail-out, every component in that subtree re-rendered
 * thirty times a second for the whole take — on the exact frames the recording
 * UI needs to stay smooth. Props here are referentially stable between level
 * ticks (callbacks are useCallback'd, the report is useMemo'd), so the
 * comparison genuinely short-circuits rather than just moving the cost.
 */
export const RecordButton = memo(RecordButtonBase);
