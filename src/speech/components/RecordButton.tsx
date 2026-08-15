import type { RecorderState } from "../capture/types.js";

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
}

export function RecordButton({
  state,
  onStart,
  onStop,
  autoStop = false,
  speaking = false,
  continuous = false,
  sessionActive = false,
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
            : continuous
              ? "Start session"
              : "Start speaking";

  return (
    <>
      <button
        type="button"
        className={recording ? "rec" : ""}
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
