/** End-of-session report for the French Activity Test. */

import { verdictFor } from "../../activities/report.js";
import type { Activity, ActivityProgress, SessionReport } from "../../activities/types.js";
import { band } from "./band.js";
import { AnimatedCell } from "./AnimatedCell.js";

interface ActivityReportProps {
  report: SessionReport;
  activities: Activity[];
  progress: ActivityProgress[];
  onRestart: () => void;
  onExport: () => void;
}

export function ActivityReport({ report, activities, progress, onRestart, onExport }: ActivityReportProps) {
  const byId = new Map(progress.map((p) => [p.activityId, p]));
  const allPassed = report.totalCount > 0 && report.passedCount === report.totalCount;

  return (
    <section className="enter-1">
      <div className="report-hero">
        <div className="report-hero-badge">{allPassed ? "Perfect run" : "Session complete"}</div>
        <h2 className="report-hero-count">
          {report.passedCount}/{report.totalCount} passed
        </h2>
        <p className="what" style={{ marginBottom: 0 }}>
          {verdictFor(report)}
        </p>
      </div>

      <div className="overall">
        <AnimatedCell value={report.overallScore} label="overall" />
        <AnimatedCell value={report.meanFluency} label="fluency" />
        <AnimatedCell value={report.meanCompleteness} label="complete" />
        <div>
          <div className="n">
            {report.passedCount}/{report.totalCount}
          </div>
          <div className="l">passed</div>
        </div>
      </div>

      <p className="hint">
        {report.totalAttempts} attempt{report.totalAttempts === 1 ? "" : "s"} ·{" "}
        {Math.round(report.durationMs / 1000)}s
        {report.indeterminateCount > 0 && (
          <> · {report.indeterminateCount} unclear (excluded, not counted as zero)</>
        )}
      </p>

      {/* Per-activity breakdown */}
      <h2 style={{ marginTop: 22 }}>By activity</h2>
      <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Activity</th>
            <th className="num">Best</th>
            <th className="num">Tries</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {activities.map((a) => {
            const p = byId.get(a.id);
            return (
              <tr key={a.id}>
                <td>{a.id}</td>
                <td>{a.title}</td>
                <td className="num">{p?.best === null || p?.best === undefined ? "—" : Math.round(p.best)}</td>
                <td className="num">{p?.attempts.length ?? 0}</td>
                <td>{!p ? "not reached" : p.passed ? "passed" : p.skipped ? "skipped" : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {/* Weakest sounds — the actionable part */}
      <h2 style={{ marginTop: 22 }}>Sounds to work on</h2>
      {!report.phonemeLabelsAvailable ? (
        <p className="what">
          The scorer returned per-sound scores for this language but did not label which sound each
          one is, so they cannot be named here. Word-level detail below is unaffected.
        </p>
      ) : report.weakPhonemes.length === 0 ? (
        <p className="what">
          No individual sound scored consistently low. Nothing stands out as a systematic problem.
        </p>
      ) : (
        <>
          <p className="what">
            Averaged across every activity, weakest first. Only sounds that came up at least twice.
          </p>
          <div className="phonemes">
            {report.weakPhonemes.map((p) => (
              <span key={p.phoneme} className={`p ${band(p.meanAccuracy)}`}>
                {p.phoneme} <b>{Math.round(p.meanAccuracy)}</b>
                <small style={{ color: "var(--dim)" }}> ×{p.occurrences}</small>
              </span>
            ))}
          </div>
        </>
      )}

      {/* Word-level mistakes */}
      <h2 style={{ marginTop: 22 }}>Mistakes</h2>
      {report.mistakes.length === 0 ? (
        <p className="what">No word was flagged as mispronounced, omitted or inserted.</p>
      ) : (
        <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Word</th>
              <th>Activity</th>
              <th>Type</th>
              <th className="num">Score</th>
            </tr>
          </thead>
          <tbody>
            {report.mistakes.slice(0, 20).map((m, i) => (
              <tr key={`${m.activityId}-${m.word}-${i}`}>
                <td>{m.word}</td>
                <td>{m.activityTitle}</td>
                <td>{m.errorType}</td>
                <td className="num">{Math.round(m.accuracy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {/* Advice derived from what was not passed */}
      {report.improvementAreas.length > 0 && (
        <>
          <h2 style={{ marginTop: 22 }}>Areas to improve</h2>
          <ul className="what" style={{ paddingLeft: 18 }}>
            {report.improvementAreas.map((area, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {area}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="row">
        <button type="button" onClick={onRestart}>
          Start again
        </button>
        <button type="button" className="ghost" onClick={onExport}>
          Download report JSON
        </button>
      </div>
    </section>
  );
}
