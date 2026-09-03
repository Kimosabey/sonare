/**
 * Activity Test — ten activities per language, unlocked one at a time,
 * ending in a report. Generalized from what was originally French-only;
 * the language itself now comes from the route (:slug in App.tsx).
 *
 * The gate is deliberately soft: passing advances immediately, but after
 * MAX_ATTEMPTS the learner may move on with the activity marked `skipped`. A
 * hard gate would strand anyone whose accent the scorer mishandles behind
 * activity 3 — which is the exact failure this POC exists to detect, not to
 * inflict.
 *
 * R11 applies to the *capture* layer, not here: progress is persisted per
 * language + learner (useProgressPersistence.ts), so a refresh resumes the
 * session instead of discarding it. Start still needs a fresh user gesture to
 * open the microphone (R10), so a reload does land back on the intro screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { useRecorder } from "../speech/react/useRecorder.js";
import { hangoverForReference } from "../speech/capture/recorder.js";
import { RecordButton } from "../speech/components/RecordButton.js";
import { ScoreCard } from "../speech/components/ScoreCard.js";
import { ScoreCardSkeleton } from "../speech/components/ScoreCardSkeleton.js";
import { DebugPanel } from "../speech/components/DebugPanel.js";
import { ActivityReport } from "../speech/components/ActivityReport.js";
import { CaptureSettings, DEFAULT_CAPTURE_SETTINGS, SENSITIVITY_FACTOR } from "../ui/CaptureSettings.js";
import type { CaptureSettingsValue } from "../ui/CaptureSettings.js";
import { LiveInterimFeedback, LiveLevelMeter } from "../ui/LiveLevel.js";
import { HEARD_SPEECH_SNR_DB, useCaptureToasts } from "../ui/useCaptureToasts.js";
import { useToast } from "../ui/ToastProvider.js";
import { useWakeLock } from "../ui/useWakeLock.js";
import { useOnlineStatus } from "../ui/useOnlineStatus.js";
import { useLearnerName } from "../ui/useLearnerName.js";
import { useSyllablePlayback } from "../ui/useSyllablePlayback.js";
import { newSessionId } from "../ui/sessionId.js";
import { useProgressPersistence } from "../ui/useProgressPersistence.js";
import { getLanguage, MAX_ATTEMPTS, PASS_SCORE } from "../activities/languages/index.js";
import { buildReport } from "../activities/report.js";
import type { ActivityAttempt, ActivityProgress } from "../activities/types.js";
import type { PronunciationResult } from "../speech/scoring/types.js";

export function ActivityTest() {
  const { slug } = useParams<{ slug: string }>();
  const activeLanguage = getLanguage(slug);
  // T15/FR-25's device-grant panel is fixture instrumentation, not a
  // learner-facing feature (see DebugPanel.tsx) — opt in with ?debug=1
  // rather than showing every learner their own raw device diagnostics.
  const [searchParams] = useSearchParams();
  const debugEnabled = searchParams.get("debug") === "1";
  const [learnerName] = useLearnerName();
  // Keyed before activeLanguage resolves too — the "language not found"
  // branch never renders anything that reads it, so an "unknown" bucket for
  // that case is harmless.
  const progressStore = useProgressPersistence(slug ?? "unknown", learnerName);

  const [index, setIndex] = useState(progressStore.initial.index);
  const [progress, setProgress] = useState<ActivityProgress[]>(progressStore.initial.progress);
  const [finished, setFinished] = useState(progressStore.initial.finished);
  const [started, setStarted] = useState(false);
  const [settings, setSettings] = useState<CaptureSettingsValue>(DEFAULT_CAPTURE_SETTINGS);
  // Drives the pass-banner's copy for one attempt only — cleared as soon as
  // the next take starts, so praise never lingers past the moment it's about.
  const [celebration, setCelebration] = useState<{ kind: "pass" | "personalBest" | "firstTry"; score: number } | null>(
    null,
  );
  /**
   * The best as it stood immediately before the attempt now on screen — not
   * `current?.best`, which has already absorbed it by the time the score
   * renders and would make every attempt look like a gain of zero.
   */
  const [bestBeforeAttempt, setBestBeforeAttempt] = useState<number | null>(null);

  /**
   * Focus targets. Both are `tabIndex={-1}` headings/regions: programmatically
   * focusable, but never a stop on the natural tab order.
   */
  const activityHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);

  const startedAt = useRef(Date.now());
  // Ties every attempt and diagnostic in one session together for funnel
  // analysis (#/diagnostics) — regenerated on beginSession()/restart() so a
  // fresh session never gets attributed to the previous one's data.
  const sessionId = useRef(newSessionId());
  const toast = useToast();

  // A refresh still lands back on the intro screen (Start still needs a
  // fresh user gesture to open the microphone — R10), but it no longer
  // throws away index/progress/finished doing it.
  useEffect(() => {
    progressStore.save({ index, progress, finished });
  }, [index, progress, finished, progressStore.save]);

  // Warn before a take is recorded and lost to a failed upload, rather than
  // letting the learner discover the connection is down only after speaking.
  const online = useOnlineStatus();
  const offlineToastId = useRef<number | null>(null);
  useEffect(() => {
    if (!online) {
      offlineToastId.current = toast.push({
        key: "network-status",
        kind: "warn",
        title: "You're offline",
        detail: "Recordings can't be scored until you reconnect.",
        duration: 0,
      });
    } else if (offlineToastId.current !== null) {
      toast.dismiss(offlineToastId.current);
      offlineToastId.current = null;
    }
  }, [online, toast]);

  const activities = activeLanguage?.activities ?? [];
  const activity = activities[index];
  const current = progress.find((p) => p.activityId === activity?.id);
  const attemptsUsed = current?.attempts.length ?? 0;

  const hangoverMs = Math.round(hangoverForReference(activity?.target ?? "") * SENSITIVITY_FACTOR[settings.sensitivity]);

  const recorder = useRecorder({
    referenceText: activity?.target ?? "",
    language: activeLanguage?.code ?? "en-US",
    sessionId: sessionId.current,
    activityId: activity?.id ?? -1,
    ...(learnerName ? { learnerName } : {}),
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

      // Read from the closure, not the functional setProgress below: this is
      // "what was true right before this attempt landed," which is exactly
      // what a learner's own sense of "did I just beat myself" means. Rare,
      // brief double-scoring races (continuous mode) getting a downgraded
      // celebration copy is a fully acceptable trade against the complexity
      // of computing this inside a reducer.
      const existingBefore = progress.find((p) => p.activityId === activity.id);
      const previousBest = existingBefore?.best ?? null;
      const isFirstAttempt = (existingBefore?.attempts.length ?? 0) === 0;
      setBestBeforeAttempt(previousBest);

      if (accuracy !== null && accuracy >= PASS_SCORE) {
        if (isFirstAttempt) setCelebration({ kind: "firstTry", score: accuracy });
        else if (previousBest === null || accuracy > previousBest) setCelebration({ kind: "personalBest", score: accuracy });
        else setCelebration({ kind: "pass", score: accuracy });
      } else {
        setCelebration(null);
      }

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
    ...(learnerName ? { learnerName } : {}),
  });
  /**
   * Replay of the take that produced the score now on screen. Reads the blob
   * straight off the recorder's own state, so nothing extra is retained and
   * the next take replaces it — the audio is never persisted anywhere.
   */
  const playback = useSyllablePlayback(recorder.lastCapture?.wav ?? null);
  // Screen must stay awake for the whole session, not just while recording —
  // most of the risk is the learner reading the prompt before they tap Record.
  useWakeLock(started && !finished);

  /**
   * Let the microphone go the moment the session is over.
   *
   * The warm mic is deliberate — see keepMicWarm in recorder.ts — but nothing
   * was ending it here, so a learner reading their report sat with the OS
   * recording indicator lit until the 45s idle timer happened to fire. That
   * reads as the app still listening after it has finished with you, which is
   * exactly the impression a recording indicator exists to prevent.
   *
   * endSession() also scores a final in-flight utterance rather than
   * discarding it, so this is safe even if the last take is still running.
   */
  useEffect(() => {
    if (finished) recorder.endSession();
  }, [finished, recorder.endSession]);

  /**
   * Per-activity microphone scope.
   *
   * Holding the device open for a whole ten-activity session means the OS
   * recording indicator stays lit for minutes, including while the learner is
   * reading a score they just earned and not speaking at all. So the device is
   * handed back on every activity change, and re-acquired immediately for the
   * new prompt.
   *
   * This is affordable because of two things that were already true. The
   * expensive half of a cold start — `new AudioContext()`, `resume()`,
   * `addModule()` — survives releaseDevice(), so re-acquiring costs only
   * getUserMedia. And the calibration guards already discard startup
   * artifacts (FLOOR_IGNORE_BELOW_DB keeps warm-up frames out of the noise
   * floor, PEAK_CALIBRATION_GRACE_MS keeps the startup transient out of the
   * peak reference), so a fresh device no longer degrades the endpointer the
   * way the keepMicWarm comment warned it would.
   *
   * warm() rather than waiting for the Record tap: the learner spends seconds
   * reading the prompt, which is exactly long enough to hide the getUserMedia
   * round trip, so tap-to-recording stays inside NFR-01's 400ms.
   */
  /**
   * Move focus to the new activity when the learner advances (WCAG 2.4.3).
   *
   * The button they pressed to get here — "Next activity" — unmounts as part
   * of the advance, which drops focus to <body>. A keyboard or switch user is
   * then at the top of the document and has to traverse the whole page again
   * to reach the new prompt, on every one of ten activities. A screen reader
   * user is simply told nothing changed.
   *
   * Deliberately not on first render: `advancedOnce` keeps this from stealing
   * focus when the session opens, where the learner has just pressed Start
   * and expects to be on the record button. It also stays out of the way
   * mid-take — nothing should move focus while someone is speaking.
   */
  const advancedOnce = useRef(false);
  useEffect(() => {
    if (!advancedOnce.current) {
      advancedOnce.current = true;
      return;
    }
    if (recorder.state === "recording" || recorder.state === "processing") return;
    activityHeadingRef.current?.focus();
  }, [index, recorder.state]);

  /**
   * And to an error when one appears, so it is both announced and reachable.
   * `aria-live` alone reads it out but leaves focus wherever it was, which for
   * a capture failure is usually a record button that is now disabled.
   */
  const lastErrorCode = useRef<string | null>(null);
  useEffect(() => {
    const code = recorder.error?.code ?? null;
    if (code !== null && code !== lastErrorCode.current) errorRef.current?.focus();
    lastErrorCode.current = code;
  }, [recorder.error]);

  const lastScopedIndex = useRef(index);
  useEffect(() => {
    if (!started || finished) return;

    /**
     * Only on a genuine move between activities.
     *
     * Keying this on `started` as well was a real fault, not a nicety:
     * beginSession() warms the microphone and *then* sets started, so this
     * effect fired on that same transition and released the device the Start
     * tap had just acquired — then re-warmed it with no transient activation
     * left, surfacing GESTURE_REQUIRED on a screen the learner had only just
     * tapped into. The ref makes the effect ignore everything except the index
     * actually changing.
     */
    if (lastScopedIndex.current === index) return;
    lastScopedIndex.current = index;

    recorder.releaseDevice();
    recorder.warm();
  }, [index, started, finished, recorder.releaseDevice, recorder.warm]);

  // A learner who already passed can still retry to beat their own score —
  // the old banner must not survive into that new attempt looking current.
  useEffect(() => {
    if (recorder.state === "requesting") setCelebration(null);
  }, [recorder.state]);

  const scoredAttempts = current?.attempts.filter((a) => a.accuracy !== null).length ?? 0;
  const canAdvance = Boolean(current?.passed) || scoredAttempts >= MAX_ATTEMPTS;
  const isLast = index === activities.length - 1;

  const advance = useCallback(() => {
    recorder.reset();
    setCelebration(null);
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
    setCelebration(null);
    startedAt.current = Date.now();
    sessionId.current = newSessionId();
    progressStore.clear();
  }, [recorder, progressStore.clear]);

  // Warms the microphone here, ahead of activity 1's own Record tap, so the
  // learner's first graded attempt hits the same warm path every later one
  // does instead of paying the cold getUserMedia + AudioWorklet cost.
  const beginSession = useCallback(() => {
    recorder.warm();
    startedAt.current = Date.now();
    setStarted(true);
  }, [recorder]);

  const report = useMemo(
    () => buildReport(activities, progress, Date.now() - startedAt.current),
    [progress, finished, activities],
  );

  const exportReport = useCallback(() => {
    const payload = {
      language: activeLanguage?.code,
      generatedAt: new Date().toISOString(),
      report,
      progress,
      activities,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeLanguage?.slug ?? "activity"}-activity-report.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [report, progress, activities, activeLanguage]);

  if (!activeLanguage) {
    return (
      <section>
        <h2>Language not found</h2>
        <p className="what">That's not one of the available languages.</p>
        <div className="row">
          <Link to="/">
            <button type="button">Back to language picker</button>
          </Link>
        </div>
      </section>
    );
  }

  // Checked before !started: a refresh always lands back here first (started
  // resets to false on every page load — see useProgressPersistence.ts), but
  // restored progress can already be `finished`. Without this order, a
  // learner who finished before refreshing would see "Ready to practice?"
  // again instead of the report that's still sitting in storage.
  if (finished) {
    return (
      <ActivityReport
        report={report}
        activities={activities}
        progress={progress}
        onRestart={restart}
        onExport={exportReport}
      />
    );
  }

  if (!started) {
    const resuming = progress.length > 0;
    const passedSoFar = progress.filter((p) => p.passed).length;

    return (
      <section>
        <h2 className="enter-1">{resuming ? "Welcome back" : "Ready to practice?"}</h2>
        <p className="what enter-2">
          {resuming
            ? `Continuing Activity ${index + 1} of ${activities.length} — ${passedSoFar} passed so far.`
            : `Ten short activities, ${activeLanguage.label} pronunciation scored phoneme by phoneme.`}
        </p>
        <p className="hint enter-2">Tapping Start also turns on your microphone.</p>
        <p className="hint enter-2">
          In a noisy room? Headphones with a built-in mic score better than the
          room's speaker and mic picking up everything around you.
        </p>

        {/* Set once for the whole session, not re-shown per activity — the
            sensible defaults (auto-stop + interim) work for almost everyone,
            so this stays collapsed rather than asking for a decision upfront. */}
        <CaptureSettings value={settings} onChange={setSettings} hangoverMs={hangoverMs} />

        <div className="row">
          <button type="button" className="enter-cta" onClick={beginSession}>
            {resuming ? "Continue" : "Start"}
          </button>
        </div>
      </section>
    );
  }

  if (!activity) return null;

  const passedCount = progress.filter((p) => p.passed).length;

  return (
    <>
      <section key={activity.id} className="enter-1">
        {/* tabIndex -1: focusable by the advance effect above, never a tab
            stop of its own. */}
        <h2 ref={activityHeadingRef} tabIndex={-1}>
          Activity {activity.id} of {activities.length} — {activity.title}
        </h2>
        <p className="what">
          {passedCount} passed · {progress.length} attempted
        </p>

        <div className="steps-track" aria-hidden="true">
          <div className="steps-fill" style={{ width: `${(passedCount / activities.length) * 100}%` }} />
        </div>
        <div className="steps" role="list" aria-label={`Activity ${activity.id} of ${activities.length}`}>
          {activities.map((a, i) => {
            const p = progress.find((pr) => pr.activityId === a.id);
            const state = i === index ? "current" : p?.passed ? "passed" : p?.skipped ? "skipped" : "upcoming";
            return <span key={a.id} role="listitem" className={`step step-${state}`} aria-label={`Activity ${a.id}: ${state}`} />;
          })}
        </div>

        <p className="what" style={{ marginTop: 14 }}>
          {activity.kind === "respond" ? `Answer aloud in ${activeLanguage.label}` : `Say this aloud in ${activeLanguage.label}`}
        </p>
        <p className="what" style={{ marginBottom: 0 }}>
          <strong>{activity.prompt}</strong>
        </p>

        {/* The one field here genuinely in the language being taught. The
            prompt above and the gloss below are English instruction *about*
            it, so they stay untagged — tagging them would have a screen
            reader speak English in a French voice. WCAG 3.1.2. */}
        <div className="prompt" lang={activeLanguage.code}>
          {activity.target}
        </div>
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
          <LiveInterimFeedback
            store={recorder.levelStore}
            recording={recorder.state === "recording"}
            speaking={recorder.speaking}
            hangoverMs={hangoverMs}
            autoStop={settings.autoStop}
          />
        )}

        <LiveLevelMeter
          store={recorder.levelStore}
          active={recorder.state === "recording"}
          clipping={recorder.clipping}
        />

        {recorder.error && (
          <div className="verdict v-fail" role="status" aria-live="polite" ref={errorRef} tabIndex={-1}>
            <div className="tag">ERROR</div>
            <div>
              {recorder.error.userMessage}
              {/* The raw code/domain/detail is real diagnostic value for a support
                  report, but showing it as the primary, most-visible text (it used
                  to be the red tag itself) reads as broken rather than handled —
                  collapsed by default, one tap away when it's actually needed. */}
              <details className="error-details">
                <summary>Technical details</summary>
                <div className="hint">
                  {recorder.error.code} · {recorder.error.domain} · {recorder.error.detail}
                </div>
              </details>
            </div>
          </div>
        )}

        {current?.passed && (
          <div
            className={`verdict v-warn pass-banner${celebration && celebration.kind !== "pass" ? " pass-banner-celebrate" : ""}`}
            style={{ borderColor: "#b4dbcb", background: "#e7f3ee" }}
            role="status"
            aria-live="polite"
          >
            <div className="tag" style={{ color: "var(--pass)" }}>
              {celebration?.kind === "firstTry" ? "FIRST TRY!" : celebration?.kind === "personalBest" ? "NEW BEST!" : "PASSED"}
            </div>
            <div>
              {celebration?.kind === "personalBest"
                ? `Scored ${Math.round(current.best ?? 0)} — beat your previous best. Move on when you are ready.`
                : `Scored ${Math.round(current.best ?? 0)}. Move on when you are ready.`}
            </div>
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
        <div aria-live="polite">
          {/*
            Three states, not two. "processing" is its own — it used to fall
            through to "No attempt yet.", which is actively wrong: the learner
            has just made an attempt and is told there isn't one, for the
            second and a half they most want reassurance.
          */}
          {recorder.result ? (
            <ScoreCard
              result={recorder.result}
              heardSpeech={(recorder.lastCapture?.snrDb ?? 0) >= HEARD_SPEECH_SNR_DB}
              lang={activeLanguage.code}
              previousBest={bestBeforeAttempt}
              {...(playback.available
                ? { onSelectSyllable: (s: { offsetTicks: number; durationTicks: number }) => playback.play(s.offsetTicks, s.durationTicks) }
                : {})}
              playingOffsetTicks={playback.playingOffsetTicks}
            />
          ) : recorder.state === "processing" ? (
            <ScoreCardSkeleton />
          ) : (
            <p className="what">No attempt yet.</p>
          )}
        </div>

        {attemptsUsed > 1 && (
          <p className="hint">
            Best so far: {current?.best === null ? "—" : Math.round(current?.best ?? 0)} across{" "}
            {attemptsUsed} attempts
          </p>
        )}

        {debugEnabled && (
          <DebugPanel
            granted={recorder.granted}
            contextSampleRate={recorder.contextSampleRate}
            capture={recorder.lastCapture}
            result={recorder.result}
          />
        )}
      </section>
    </>
  );
}
