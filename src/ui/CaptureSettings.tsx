/**
 * The three capture toggles.
 *
 * They are genuinely independent — the four combinations of Continuous ×
 * Auto-Stop all mean something different:
 *
 *   continuous + autoStop   session stays open, segments on each silence,
 *                           scores every utterance  (default)
 *   continuous only         one long take until the user ends the session
 *   autoStop only           one utterance, ends itself                (default)
 *   neither                 tap to start, tap to stop
 *
 * Interim Results is NOT live transcription. Partial hypotheses require
 * streaming recognition over a WebSocket, which R6 forbids and PRD §4 lists as
 * out of scope. What this toggle shows is live *capture* feedback derived
 * locally from the audio — level, speech detection, elapsed time and the
 * silence countdown. It is honest about being that, rather than pretending to
 * be transcription.
 */

export type SilenceSensitivity = "quick" | "normal" | "patient";

export const SENSITIVITY_FACTOR: Record<SilenceSensitivity, number> = {
  quick: 0.6,
  normal: 1,
  patient: 1.7,
};

const SENSITIVITY_LABELS: Record<SilenceSensitivity, string> = {
  quick: "Quick",
  normal: "Normal",
  patient: "Patient",
};

export interface CaptureSettingsValue {
  continuous: boolean;
  autoStop: boolean;
  interim: boolean;
  sensitivity: SilenceSensitivity;
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettingsValue = {
  // Auto-Stop + Interim is the default experience.
  continuous: false,
  autoStop: true,
  interim: true,
  sensitivity: "normal",
};

interface CaptureSettingsProps {
  value: CaptureSettingsValue;
  onChange: (next: CaptureSettingsValue) => void;
  /** Effective silence window in ms, shown so the setting is not a guess. */
  hangoverMs: number;
  disabled?: boolean;
}

export function CaptureSettings({ value, onChange, hangoverMs, disabled }: CaptureSettingsProps) {
  const set = <K extends keyof CaptureSettingsValue>(key: K, next: CaptureSettingsValue[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <details open>
      <summary>Microphone settings</summary>
      <div className="body">
        <Switch
          id="cap-continuous"
          label="Continuous listening"
          description={
            value.continuous
              ? "Stays on until you end the session."
              : "Records one utterance, then stops."
          }
          checked={value.continuous}
          disabled={disabled}
          onChange={(v) => set("continuous", v)}
        />

        <Switch
          id="cap-autostop"
          label="Auto-stop"
          description={
            value.autoStop
              ? `Ends after ${(hangoverMs / 1000).toFixed(1)}s of silence. Shorter pauses will not stop it.`
              : "You tap to stop."
          }
          checked={value.autoStop}
          disabled={disabled}
          onChange={(v) => set("autoStop", v)}
        />

        <Switch
          id="cap-interim"
          label="Interim results"
          description="Live capture feedback while you speak — level, speech detection and the silence countdown. Not transcription."
          checked={value.interim}
          disabled={disabled}
          onChange={(v) => set("interim", v)}
        />

        {value.autoStop && (
          <>
            <label htmlFor="sens-normal">Pause before it stops</label>
            <div className="modes" role="group" aria-label="Pause sensitivity">
              {(Object.keys(SENSITIVITY_LABELS) as SilenceSensitivity[]).map((key) => (
                <button
                  key={key}
                  id={`sens-${key}`}
                  type="button"
                  aria-pressed={value.sensitivity === key}
                  disabled={disabled}
                  onClick={() => set("sensitivity", key)}
                >
                  {SENSITIVITY_LABELS[key]}
                </button>
              ))}
            </div>
          </>
        )}

        <p className="hint">
          {describeCombination(value)}
        </p>
      </div>
    </details>
  );
}

function describeCombination(v: CaptureSettingsValue): string {
  if (v.continuous && v.autoStop) {
    return "Session stays open and each utterance is scored separately as you pause between them.";
  }
  if (v.continuous) return "Records one long take until you end the session.";
  if (v.autoStop) return "Tap once, speak, and it ends itself.";
  return "Tap to start, tap again to stop.";
}

interface SwitchProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

function Switch({ id, label, description, checked, disabled, onChange }: SwitchProps) {
  return (
    <div className="switch">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className="switch-track"
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
      <label htmlFor={id} className="switch-text">
        <span className="switch-label">{label}</span>
        <span className="switch-desc">{description}</span>
      </label>
    </div>
  );
}
