/**
 * French Activity Test — ten activities, unlocked one at a time, ending in a
 * report.
 *
 * The gate is deliberately soft: passing advances immediately, but after
 * MAX_ATTEMPTS the learner may move on with the activity marked `skipped`. A
 * hard gate would strand anyone whose accent the scorer mishandles behind
 * activity 3 — which is the exact failure this POC exists to detect, not to
 * inflict.
 *
 * R11: progress is in-memory. A refresh restarts the session by design.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useRecorder } from "../speech/react/useRecorder.js";
import { hangoverForReference } from "../speech/capture/recorder.js";
import { RecordButton } from "../speech/components/RecordButton.js";
import { LevelMeter } from "../speech/components/LevelMeter.js";
import { ScoreCard } from "../speech/components/ScoreCard.js";
import { DebugPanel } from "../speech/components/DebugPanel.js";
import { ActivityReport } from "../speech/components/ActivityReport.js";
import { CaptureSettings, DEFAULT_CAPTURE_SETTINGS, SENSITIVITY_FACTOR } from "../ui/CaptureSettings.js";
import type { CaptureSettingsValue } from "../ui/CaptureSettings.js";
import { InterimFeedback } from "../ui/InterimFeedback.js";
import { useCaptureToasts } from "../ui/useCaptureToasts.js";
import { useToast } from "../ui/ToastProvider.js";
import { useWakeLock } from "../ui/useWakeLock.js";
import {
  FRENCH_ACTIVITIES,
  FRENCH_LANGUAGE,
  MAX_ATTEMPTS,
  PASS_SCORE,
} from "../activities/frenchActivities.js";
import { buildReport } from "../activities/report.js";
import type { ActivityAttempt, ActivityProgress } from "../activities/types.js";
import type { PronunciationResult } from "../speech/scoring/types.js";

export function FrenchActivityTest() {
  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState<ActivityProgress[]>([]);
  const [finished, setFinished] = useState(false);
  const [started, setStarted] = useState(false);
  const [settings, setSettings] = useState<CaptureSettingsValue>(DEFAULT_CAPTURE_SETTINGS);
  const startedAt = useRef(Date.now());
  // Ties every attempt and diagnostic in one session together for funnel
  // analysis (#/diagnostics) — regenerated on beginSession()/restart() so a
  // fresh session never gets attributed to the previous one's data.
  const sessionId = useRef(crypto.randomUUID());
  const toast = useToast();

  const activity = FRENCH_ACTIVITIES[index];
  const current = progress.find((p) => p.activityId === activity?.id);
  const attemptsUsed = current?.attempts.length ?? 0;

  const hangoverMs = Math.round(hangoverForReference(activity?.target ?? "") * SENSITIVITY_FACTOR[settings.sensitivity]);

  const recorder = useRecorder({
    referenceText: activity?.target ?? "",
    language: FRENCH_LANGUAGE,
    sessionId: sessionId.current,
    activityId: activity?.id ?? -1,
    autoStop: settings.autoStop,
    continuous: settings.continuous,
    silenceHangoverMs: hangoverMs,
    onScored: (result: PronunciationResult) => {
      if (!activity) return;

      const accuracy = result.indeterminate ? null : result.accuracy;
      const attempt: ActivityAttempt = {
        activityId: activity.id,
        result,
        accuracy,
        at: new Date().toISOString(),
      };

      setProgress((prev) => {
        const existing = prev.find((p) => p.activityId === activity.id);
        const attempts = [...(existing?.attempts ?? []), attempt];
        const best = attempts.reduce<number | null>(
          (acc, a) => (a.accuracy === null ? acc : acc === null ? a.accuracy : Math.max(acc, a.accuracy)),
          null,
        );
        const passed = best !== null && best >= PASS_SCORE;
        // An indeterminate attempt does not burn a try — the learner was never
        // measured, so charging them for it would be punishing our own failure.
        const scoredAttempts = attempts.filter((a) => a.accuracy !== null).length;
        const skipped = !passed && scoredAttempts >= MAX_ATTEMPTS;

        const next: ActivityProgress = { activityId: activity.id, attempts, best, passed, skipped };
        return existing ? prev.map((p) => (p.activityId === activity.id ? next : p)) : [...prev, next];
      });
    },
  });

  useCaptureToasts(recorder, {
    autoStop: settings.autoStop,
    sessionId: sessionId.current,
    activityId: activity?.id,
  });
  // Screen must stay awake for the whole session, not just while recording —
  // most of the risk is the learner reading the prompt before they tap Record.
  useWakeLock(started && !finished);

  const scoredAttempts = current?.attempts.filter((a) => a.accuracy !== null).length ?? 0;
  const canAdvance = Boolean(current?.passed) || scoredAttempts >= MAX_ATTEMPTS;
  const isLast = index === FRENCH_ACTIVITIES.length - 1;

  const advance = useCallback(() => {
    recorder.reset();
    if (isLast) {
      setFinished(true);
      toast.push({ kind: "success", title: "Session complete", detail: "Your report is ready below." });
    } else {
      setIndex((i) => i + 1);
      toast.push({ kind: "info", title: `Activity ${index + 2} unlocked` });
    }
  }, [isLast, recorder, toast, index]);

  const restart = useCallback(() => {
    recorder.reset();
    setProgress([]);
    setIndex(0);
    setFinished(false);
    startedAt.current = Date.now();
    sessionId.current = crypto.randomUUID();
  }, [recorder]);

  // Warms the microphone here, ahead of activity 1's own Record tap, so the
  // learner's first graded attempt hits the same warm path every later one
  // does instead of paying the cold getUserMedia + AudioWorklet cost.
  const beginSession = useCallback(() => {
    recorder.warm();
    startedAt.current = Date.now();
    setStarted(true);
  }, [recorder]);

  const report = useMemo(
    () => buildReport(FRENCH_ACTIVITIES, progress, Date.now() - startedAt.current),
    [progress, finished],
  );

  const exportReport = useCallback(() => {
    const payload = {
      language: FRENCH_LANGUAGE,
      generatedAt: new Date().toISOString(),
      report,
      progress,
      activities: FRENCH_ACTIVITIES,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "french-activity-report.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [report, progress]);

  if (!started) {
    return (
      <section>
        <h2 className="enter-1">Ready to practice?</h2>
        <p className="what enter-2">
          Ten short activities, French pronunciation scored phoneme by phoneme.
        </p>
        <p className="hint enter-2">Tapping Start also turns on your microphone.</p>
        <p className="hint enter-2">
          In a noisy room? Headphones with a built-in mic score better than the
          room's speaker and mic picking up everything around you.
        </p>
        <div className="row">
          <button type="button" className="enter-cta" onClick={beginSession}>
            Start
          </button>
        </div>
      </section>
    );
  }

  if (finished) {
    return (
      <ActivityReport
        report={report}
        activities={FRENCH_ACTIVITIES}
        progress={progress}
        onRestart={restart}
        onExport={exportReport}
      />
    );
  }

  if (!activity) return null;

  const passedCount = progress.filter((p) => p.passed).length;

  return (
    <>
      <section key={activity.id} className="enter-1">
        <h2>
          Activity {activity.id} of {FRENCH_ACTIVITIES.length} — {activity.title}
        </h2>
        <p className="what">
          {passedCount} passed · {progress.length} attempted
        </p>

        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${(index / FRENCH_ACTIVITIES.length) * 100}%` }} />
        </div>

        <p className="what" style={{ marginTop: 14 }}>
          {activity.kind === "respond" ? "Answer aloud in French" : "Say this aloud in French"}
        </p>
        <p className="what" style={{ marginBottom: 0 }}>
          <strong>{activity.prompt}</strong>
        </p>

        <div className="prompt">{activity.target}</div>
        <p className="hint">&ldquo;{activity.gloss}&rdquo;</p>

        <details>
          <summary>What this activity is testing</summary>
          <div className="body">
            <p className="what" style={{ margin: 0 }}>
              {activity.focus}
            </p>
          </div>
        </details>
      </section>

      <section>
        <h2>Record</h2>
        <p className="what">
          Attempt {Math.min(scoredAttempts + 1, MAX_ATTEMPTS)} of {MAX_ATTEMPTS} · pass at{" "}
          {PASS_SCORE}
        </p>

        <CaptureSettings
          value={settings}
          onChange={setSettings}
          hangoverMs={hangoverMs}
          disabled={recorder.state === "recording" || recorder.state === "processing"}
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
          {canAdvance && (
            <button type="button" onClick={advance}>
              {isLast ? "Finish and see report" : "Next activity"}
            </button>
          )}
        </div>

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

        {current?.passed && (
          <div className="verdict v-warn pass-banner" style={{ borderColor: "#b4dbcb", background: "#e7f3ee" }}>
            <div className="tag" style={{ color: "var(--pass)" }}>
              PASSED
            </div>
            <div>Scored {Math.round(current.best ?? 0)}. Move on when you are ready.</div>
          </div>
        )}

        {!current?.passed && scoredAttempts >= MAX_ATTEMPTS && (
          <div className="verdict v-warn">
            <div className="tag">MOVE ON</div>
            <div>
              {MAX_ATTEMPTS} attempts used. This one is recorded as not passed and will show in the
              report — carry on to the next activity.
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>Result</h2>
        {recorder.result ? <ScoreCard result={recorder.result} /> : <p className="what">No attempt yet.</p>}

        {attemptsUsed > 1 && (
          <p className="hint">
            Best so far: {current?.best === null ? "—" : Math.round(current?.best ?? 0)} across{" "}
            {attemptsUsed} attempts
          </p>
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
