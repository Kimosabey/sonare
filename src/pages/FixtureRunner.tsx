/**
 * T16/FR-26/PRD §8 — the actual deliverable: the outcome that matters is the
 * gap between Set A and Set B. This screen exists to make 80 recordings
 * quick to capture and clean to export, because a contaminated fixture
 * invalidates the entire experiment.
 *
 * Restored from git history (commit c52fcb3) — removed in 5764ef8 ("now that
 * the scorer's separation result is proven"), but the only evidence that
 * commit was actually working from was scripts/synthetic-fixture.mjs, whose
 * own docblock says "IT IS NOT A SUBSTITUTE FOR THE REAL FIXTURE... Only PRD
 * §8 answers that." Restoring this because that question is still open.
 *
 * Adapted for the current app: useRecorder now requires sessionId/activityId
 * (didn't exist when this was first written), and the phrase bank is the
 * real per-language activity content (src/activities/languages/) rather
 * than the now-deleted standalone src/phrases.ts.
 *
 * R11: the log is in-memory only. It is deliberately NOT written to browser
 * storage — a half-finished set surviving a reload and silently merging into
 * the next session is exactly how a fixture gets contaminated. Export before
 * you close the tab; the page warns you if you try to leave.
 */

import { useEffect, useRef, useState } from "react";
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
import { useToast } from "../ui/ToastProvider.js";
import { LANGUAGES } from "../activities/languages/index.js";
import type { CaptureResult, GrantedConstraints } from "../speech/capture/types.js";
import type { PronunciationResult } from "../speech/scoring/types.js";

type SetId = "A" | "B" | "ad-hoc";

interface LogEntry {
  n: number;
  set: SetId;
  speaker: string;
  reference: string;
  language: string;
  ua: string;
  contextRate: number;
  granted: GrantedConstraints;
  durationSeconds: number;
  snrDb: number;
  result: PronunciationResult;
  at: string;
}

const SET_LABELS: Record<SetId, string> = {
  A: "Set A — accented, correct",
  B: "Set B — deliberately wrong",
  "ad-hoc": "Ad-hoc",
};

export function FixtureRunner() {
  const [setId, setSetId] = useState<SetId>("A");
  const [speaker, setSpeaker] = useState("");
  const firstLanguage = LANGUAGES[0];
  const [language, setLanguage] = useState(firstLanguage?.code ?? "en-US");
  const [referenceText, setReferenceText] = useState(firstLanguage?.activities[0]?.target ?? "");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [copied, setCopied] = useState("");
  const [settings, setSettings] = useState<CaptureSettingsValue>(DEFAULT_CAPTURE_SETTINGS);
  const toast = useToast();
  // Regenerated per set switch, not per recording — every take in one
  // A-or-B pass belongs to the same funnel-analysis session, same
  // convention ActivityTest.tsx uses.
  const sessionId = useRef(crypto.randomUUID());

  const hangoverMs = Math.round(hangoverForReference(referenceText) * SENSITIVITY_FACTOR[settings.sensitivity]);

  const recorder = useRecorder({
    referenceText,
    language,
    sessionId: sessionId.current,
    activityId: log.length,
    autoStop: settings.autoStop,
    continuous: settings.continuous,
    silenceHangoverMs: hangoverMs,
    onScored: (result: PronunciationResult, capture: CaptureResult) => {
      setLog((prev) => [
        ...prev,
        {
          n: prev.length + 1,
          set: setId,
          speaker,
          reference: referenceText,
          language,
          ua: navigator.userAgent,
          contextRate: capture.contextSampleRate,
          granted: capture.granted,
          durationSeconds: Number(capture.durationSeconds.toFixed(3)),
          snrDb: Number(capture.snrDb.toFixed(1)),
          result,
          at: new Date().toISOString(),
        },
      ]);
    },
  });

  useCaptureToasts(recorder, {
    autoStop: settings.autoStop,
    sessionId: sessionId.current,
    activityId: log.length,
  });

  // Unexported attempts are unrecoverable — the log is in memory by design.
  useEffect(() => {
    if (log.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [log.length]);

  const exportJson = JSON.stringify(log, null, 2);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportJson);
      setCopied("Copied.");
      toast.push({ kind: "success", title: `Copied ${log.length} attempts` });
    } catch {
      setCopied("Clipboard blocked — select the text below and copy.");
      toast.push({ kind: "warn", title: "Clipboard blocked", detail: "Select the text below and copy manually." });
    }
    setTimeout(() => setCopied(""), 2400);
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([exportJson], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `fixture-set-${setId}-${log.length}-attempts.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.push({ kind: "success", title: `Exported ${log.length} attempts` });
  };

  const clear = () => {
    if (log.length > 0 && !window.confirm(`Discard ${log.length} unexported attempts?`)) return;
    setLog([]);
    sessionId.current = crypto.randomUUID();
  };

  const countFor = (id: SetId) => log.filter((e) => e.set === id).length;

  return (
    <>
      <section>
        <h2>Fixture</h2>
        <p className="what">
          Set A must be independently confirmed acceptable by a fluent speaker. Drop anything
          ambiguous — a contaminated Set A invalidates the experiment.
        </p>

        <label htmlFor="set">Set</label>
        <select id="set" value={setId} onChange={(e) => setSetId(e.target.value as SetId)}>
          {(Object.keys(SET_LABELS) as SetId[]).map((id) => (
            <option key={id} value={id}>
              {SET_LABELS[id]}
            </option>
          ))}
        </select>

        <label htmlFor="spk">Speaker label</label>
        <input
          id="spk"
          type="text"
          value={speaker}
          placeholder="e.g. S03-tamil-en"
          spellCheck={false}
          onChange={(e) => setSpeaker(e.target.value)}
        />

        <PhraseSelector
          language={language}
          referenceText={referenceText}
          onChange={(next) => {
            setLanguage(next.language);
            setReferenceText(next.referenceText);
          }}
        />
      </section>

      <section>
        <h2>Record</h2>
        <p className="what">
          A · {countFor("A")} &nbsp; B · {countFor("B")} &nbsp; total {log.length}
        </p>

        <div className="prompt">{referenceText}</div>

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

        {recorder.result && <ScoreCard result={recorder.result} />}

        <DebugPanel
          granted={recorder.granted}
          contextSampleRate={recorder.contextSampleRate}
          capture={recorder.lastCapture}
          result={recorder.result}
        />
      </section>

      <section style={{ border: "none" }}>
        <h2>Session log</h2>
        <p className="what">In memory only. Export before closing this tab.</p>

        <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Set</th>
              <th>Speaker</th>
              <th>Reference</th>
              <th className="num">Accuracy</th>
              <th className="num">Overall</th>
            </tr>
          </thead>
          <tbody>
            {log.map((e) => (
              <tr key={e.n}>
                <td>{e.n}</td>
                <td>{e.set}</td>
                <td>{e.speaker || "—"}</td>
                <td>
                  {e.reference.slice(0, 26)}
                  {e.reference.length > 26 ? "…" : ""}
                </td>
                <td className="num">
                  {e.result.indeterminate ? "indet." : Math.round(e.result.accuracy)}
                </td>
                <td className="num">
                  {e.result.indeterminate ? "—" : Math.round(e.result.overall)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>

        <div className="row">
          <button type="button" className="ghost" onClick={download} disabled={log.length === 0}>
            Download JSON
          </button>
          <button type="button" className="ghost" onClick={copy} disabled={log.length === 0}>
            Copy JSON
          </button>
          <button type="button" className="ghost" onClick={clear} disabled={log.length === 0}>
            Clear
          </button>
          <span className="hint">{copied}</span>
        </div>

        <textarea readOnly rows={6} value={log.length ? exportJson : "No attempts yet."} />
      </section>
    </>
  );
}
