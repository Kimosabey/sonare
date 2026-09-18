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

import { memo } from "react";

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

function CaptureSettingsBase({ value, onChange, hangoverMs, disabled }: CaptureSettingsProps) {
  const set = <K extends keyof CaptureSettingsValue>(key: K, next: CaptureSettingsValue[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <details>
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
            {/*
              A plain element, not a <label htmlFor>. This text is the heading
              for all three buttons, but `for` associates it with exactly one
              of them and *renames* it: the middle option was announced as
              "Pause before it stops" and the word "Normal" was never spoken,
              while Quick and Patient read correctly. Pointing the group at it
              with aria-labelledby says what was meant — the text labels the
              choice, and each button keeps its own name.
            */}
            <span className="field-label" id="sens-heading">
              Pause before it stops
            </span>
            <div className="modes" role="group" aria-labelledby="sens-heading">
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
  /*
   * `<label for>` and the accessible name are two different things, and this
   * component used to assume they were one.
   *
   * A `<button>` is a labelable element, so the label does forward activation:
   * tapping the text flips the switch, and the whole row is a real target.
   * But the accessible *name* of a button comes from its **contents**, not
   * from an associated label — HTML-AAM does not consult `<label for>` for a
   * button the way it does for an input. This button's contents are one empty
   * `<span>`.
   *
   * So all three switches on the session screen announced as "switch", with no
   * name at all. It was invisible to every check: axe's WCAG sweep does not
   * flag it, jsdom reports no accessible name to compare, and on screen the
   * label is right there next to the control. A UX audit that listed every
   * control by position found three with no text.
   *
   * `aria-labelledby` names it and `aria-describedby` carries the sentence
   * underneath, which is the split those two attributes exist for: a screen
   * reader reads the name every time and the description once.
   */
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;

  return (
    <div className="switch">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        className="switch-track"
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
      <label htmlFor={id} className="switch-text">
        <span className="switch-label" id={labelId}>
          {label}
        </span>
        <span className="switch-desc" id={descriptionId}>
          {description}
        </span>
      </label>
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
export const CaptureSettings = memo(CaptureSettingsBase);
