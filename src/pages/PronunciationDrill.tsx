/** T11/FR-21 — the learner-facing drill screen. */

import { useState } from "react";
import { useRecorder } from "../speech/react/useRecorder.js";
import { hangoverForReference } from "../speech/capture/recorder.js";
import { RecordButton } from "../speech/components/RecordButton.js";
import { LevelMeter } from "../speech/components/LevelMeter.js";
import { ScoreCard } from "../speech/components/ScoreCard.js";
import { DebugPanel } from "../speech/components/DebugPanel.js";
import { PhraseSelector } from "../speech/components/PhraseSelector.js";
import { CaptureSettings, DEFAULT_CAPTURE_SETTINGS, SENSITIVITY_FACTOR } from "../ui/CaptureSettings.js";
import type { CaptureSettingsValue } from "../ui/CaptureSettings.js";
import { InterimFeedback } from "../ui/InterimFeedback.js";
import { useCaptureToasts } from "../ui/useCaptureToasts.js";
import { firstPhraseFor } from "../phrases.js";

export function PronunciationDrill() {
  const [language, setLanguage] = useState("en-US");
  const [referenceText, setReferenceText] = useState(() => firstPhraseFor("en-US"));
  const [settings, setSettings] = useState<CaptureSettingsValue>(DEFAULT_CAPTURE_SETTINGS);

  const hangoverMs = Math.round(
    hangoverForReference(referenceText) * SENSITIVITY_FACTOR[settings.sensitivity],
  );

  const recorder = useRecorder({
    referenceText,
    language,
    autoStop: settings.autoStop,
    continuous: settings.continuous,
    silenceHangoverMs: hangoverMs,
  });
  useCaptureToasts(recorder, { autoStop: settings.autoStop });

  const busy = recorder.state === "recording" || recorder.state === "processing";

  return (
    <>
      <section>
        <h2>Target phrase</h2>
        <p className="what">Say this out loud. Scoring is per phoneme, against this exact text.</p>

        <PhraseSelector
          language={language}
          referenceText={referenceText}
          disabled={busy}
          onChange={(next) => {
            setLanguage(next.language);
            setReferenceText(next.referenceText);
          }}
        />

        <div className="prompt">
          {referenceText || <span style={{ color: "var(--dim)" }}>—</span>}
        </div>
      </section>

      <section>
        <h2>Record</h2>
        <p className="what">
          Captured at 16 kHz mono with gain control, noise suppression and echo cancellation
          switched off.
        </p>

        <CaptureSettings
          value={settings}
          onChange={setSettings}
          hangoverMs={hangoverMs}
          disabled={busy}
        />

        <div className="row">
          <RecordButton
            state={recorder.state}
            onStart={recorder.start}
            onStop={recorder.stop}
            autoStop={settings.autoStop}
            speaking={recorder.speaking}
            continuous={settings.continuous}
            sessionActive={recorder.sessionActive}
          />
          {recorder.sessionActive && (
            <button type="button" onClick={recorder.endSession}>
              End session
            </button>
          )}
          {recorder.result && !recorder.sessionActive && (
            <button type="button" className="ghost" onClick={recorder.reset}>
              Clear
            </button>
          )}
        </div>

        {recorder.sessionActive && (
          <p className="hint">
            {recorder.utteranceCount} utterance{recorder.utteranceCount === 1 ? "" : "s"} scored this
            session.
          </p>
        )}

        {settings.interim && (
          <InterimFeedback
            recording={recorder.state === "recording"}
            speaking={recorder.speaking}
            level={recorder.level}
            hangoverMs={hangoverMs}
            autoStop={settings.autoStop}
          />
        )}

        <LevelMeter level={recorder.level} active={recorder.state === "recording"} />

        {recorder.error && (
          <div className="verdict v-fail">
            <div className="tag">{recorder.error.code}</div>
            <div>
              {recorder.error.userMessage}
              <div className="hint">
                {recorder.error.domain} · {recorder.error.detail}
              </div>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>Result</h2>
        {recorder.result ? (
          <ScoreCard result={recorder.result} />
        ) : (
          <p className="what">No attempt yet.</p>
        )}

        <DebugPanel
          granted={recorder.granted}
          contextSampleRate={recorder.contextSampleRate}
          capture={recorder.lastCapture}
          result={recorder.result}
        />
      </section>
    </>
  );
}
