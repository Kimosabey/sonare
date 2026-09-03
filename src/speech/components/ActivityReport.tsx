/** End-of-session report for the French Activity Test. */

import { verdictFor } from "../../activities/report.js";
import type { Activity, ActivityProgress, SessionReport } from "../../activities/types.js";
import { band } from "./band.js";
import { AnimatedCell } from "./AnimatedCell.js";
import { memo, useEffect, useRef } from "react";

interface ActivityReportProps {
  report: SessionReport;
  activities: Activity[];
  progress: ActivityProgress[];
  onRestart: () => void;
  onExport: () => void;
}

function ActivityReportBase({ report, activities, progress, onRestart, onExport }: ActivityReportProps) {
  const byId = new Map(progress.map((p) => [p.activityId, p]));
  const allPassed = report.totalCount > 0 && report.passedCount === report.totalCount;

  /**
   * Finishing replaces the entire activity view with this one, so the button
   * that got here unmounts and focus falls to <body> — same WCAG 2.4.3 problem
   * as advancing an activity, at the moment the learner most wants to be told
   * what they scored. Mount-time focus is right here precisely because this is
   * a navigation: the learner asked for this view.
   */
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section className="enter-1">
      <div className="report-hero">
        <div className="report-hero-badge">{allPassed ? "Perfect run" : "Session complete"}</div>
        <h2 className="report-hero-count" ref={headingRef} tabIndex={-1}>
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

      {/*
        Weakest syllables — the actionable part.

        Keyed on syllables, not phonemes: Azure returns empty `Phoneme` labels
        for every locale this product ships, so `weakPhonemes` is permanently
        empty and this section rendered nothing but its own apology. Syllables
        come back named 83% of the time across the French set, and a written
        syllable is the better unit anyway — most learners cannot read IPA, but
        they can re-read a piece of the word they just said.
      */}
      <h2 style={{ marginTop: 22 }}>Sounds to work on</h2>
      {!report.syllableLabelsAvailable ? (
        // Not a hypothetical: hi-IN scores all 7 syllables of its phrase and
        // names none of them. Saying so beats a row of blank chips.
        <p className="what">
          The scorer returned per-syllable scores for this language but did not name any of the
          syllables, so they cannot be listed here. Word-level detail below is unaffected.
        </p>
      ) : report.weakSyllables.length === 0 ? (
        <p className="what">
          No individual syllable scored consistently low. Nothing stands out as a systematic
          problem.
        </p>
      ) : (
        <>
          <p className="what">
            Averaged across every activity, weakest first. Only syllables that came up at least
            twice.
          </p>
          <div className="phonemes">
            {report.weakSyllables.map((syllable) => (
              <span key={syllable.grapheme} className={`p ${band(syllable.meanAccuracy)}`}>
                {syllable.grapheme} <b>{Math.round(syllable.meanAccuracy)}</b>
                <small style={{ color: "var(--dim)" }}> ×{syllable.occurrences}</small>
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

/**
 * Memoised because the level meter drives a 30Hz state update on the page that
 * renders this. Without a bail-out, every component in that subtree re-rendered
 * thirty times a second for the whole take — on the exact frames the recording
 * UI needs to stay smooth. Props here are referentially stable between level
 * ticks (callbacks are useCallback'd, the report is useMemo'd), so the
 * comparison genuinely short-circuits rather than just moving the cost.
 */
export const ActivityReport = memo(ActivityReportBase);
