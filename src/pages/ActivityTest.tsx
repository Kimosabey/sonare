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
import { useParams, useSearchParams, useNavigate, Link } from "react-router-dom";
import { useRecorder } from "../speech/react/useRecorder.js";
import { hangoverForReference } from "../speech/capture/recorder.js";
import { RecordButton } from "../speech/components/RecordButton.js";
import { ScoreCard } from "../speech/components/ScoreCard.js";
import { ScoreCardSkeleton } from "../speech/components/ScoreCardSkeleton.js";
import { DebugPanel } from "../speech/components/DebugPanel.js";
import { ActivityReport } from "../speech/components/ActivityReport.js";
import { SessionSummary } from "../components/SessionSummary.js";
import { CaptureSettings, DEFAULT_CAPTURE_SETTINGS, SENSITIVITY_FACTOR } from "../components/CaptureSettings.js";
import type { CaptureSettingsValue } from "../components/CaptureSettings.js";
import { LiveInterimFeedback, LiveLevelMeter } from "../components/LiveLevel.js";
import { HEARD_SPEECH_SNR_DB, useCaptureToasts } from "../hooks/useCaptureToasts.js";
import { useToast } from "../components/ToastProvider.js";
import { useWakeLock } from "../hooks/useWakeLock.js";
import { useOnlineStatus } from "../hooks/useOnlineStatus.js";
import { useLearnerName } from "../hooks/useLearnerName.js";
import { useSyllablePlayback } from "../hooks/useSyllablePlayback.js";
import { useVowelEstimate } from "../hooks/useVowelEstimate.js";
import { VowelChart } from "../components/VowelChart.js";
import { phraseTokens, useModelSpeech } from "../hooks/useModelSpeech.js";
import { useMicrophonePermission } from "../hooks/useMicrophonePermission.js";
import { newSessionId } from "../lib/sessionId.js";
import { readStreak, recordPractice } from "../stores/streakStore.js";
import { recordSkills } from "../stores/skillStore.js";
import { markLanguageDirty, markStreakDirty } from "../sync/dirty.js";
import { affordancesFor, activityNeedsMicrophone } from "../learning/affordances.js";
import { isSpoken } from "../activities/types.js";
import { ListenOptions } from "../components/ListenOptions.js";
import { LocateOptions } from "../components/LocateOptions.js";
import { locateOptions } from "../activities/locate.js";
import { MicUnavailable } from "../components/MicUnavailable.js";
import { LeaveSittingDialog } from "../components/LeaveSittingDialog.js";
import { useMicEnvironment } from "../hooks/useMicEnvironment.js";
import { readCheck } from "../stores/micCheckStore.js";
import { listenOptions } from "../activities/listen.js";
import {
  applySkip,
  applyTake,
  canAdvanceFrom,
  celebrationFor,
  scoredAttemptsOf,
  stepStateFor,
} from "../learning/session.js";
import { useProgressPersistence } from "../hooks/useProgressPersistence.js";
/**
 * `PASS_SCORE` is deliberately absent now.
 *
 * With the threshold no longer printed and the pass decision living in
 * learning/session.ts, this screen does not know what the pass mark is — and
 * cannot accidentally state one that differs from the one being enforced.
 * `MAX_ATTEMPTS` stays because the tries-remaining line is real information a
 * learner needs.
 */
import { MAX_ATTEMPTS } from "../activities/languages/index.js";
import { resolveLanguage } from "../content/resolve.js";
import { buildReport } from "../activities/report.js";
import { adviceFor, weakestSyllable } from "../activities/advice.js";
import { useCompareToModel } from "../hooks/useCompareToModel.js";
import type { ActivityAttempt, ActivityKind, ActivityProgress } from "../activities/types.js";
import type { PronunciationResult } from "../speech/scoring/types.js";

/**
 * Whether an activity of this kind could ever open the microphone.
 *
 * Asked of `affordancesFor` rather than by listing kinds, so this cannot drift
 * from the rule the rest of the screen is driven by — and asked at `takes: 0`
 * because the question is what the kind *can* need, not what it needs right
 * now. A spoken kind whose tries are spent still had a microphone to warm.
 *
 * It exists because warming is invisible. `warm()` pays the getUserMedia cost
 * ahead of the learner's first Record tap, and on a `listen` or a `locate`
 * there is no Record tap and no record button — so the screen was opening the
 * microphone for an activity that only asks somebody to choose an answer.
 * On iOS that spends the one permission prompt a learner ever gets, on a
 * screen that gives them no reason to expect it.
 */
function canNeedMicrophone(kind: ActivityKind): boolean {
  return affordancesFor(kind, { takes: 0, revealed: false }).needsMicrophone;
}

/**
 * Whether the model voice *is* this activity's question, rather than an aid.
 *
 * `affordancesFor` already draws the line and says so: `canListen` is whether
 * the activity permits hearing the phrase, deliberately separate from whether
 * a voice exists on this device. For a `repeat` the model is help — with no
 * voice a learner can still read the phrase and record it. For a `listen` or a
 * `locate` there is nothing else: the phrase is never shown, and the question
 * is which sound was in a thing they were meant to hear.
 *
 * Derived from the affordances rather than listed, so a kind cannot be added
 * on one side of this and forgotten on the other — `canListen` with no
 * microphone is precisely "the audio is the whole task".
 */
function theQuestionIsAudio(kind: ActivityKind): boolean {
  const affords = affordancesFor(kind, { takes: 0, revealed: false });
  return affords.canListen && !affords.needsMicrophone;
}

export function ActivityTest() {
  const { slug } = useParams<{ slug: string }>();
  const activeLanguage = resolveLanguage(slug);
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
  /**
   * Whether the learner has asked to see a hidden target on *this* activity.
   *
   * Reset by the `activity.id` effect below rather than carried, so advancing
   * cannot arrive at a `recall` activity with the answer already on screen.
   */
  const [revealed, setRevealed] = useState(false);

  /**
   * Whether "Leave this sitting?" is open — board 1i.
   *
   * Opened by Esc and by Android's system back, and by nothing else. It is not
   * a confirmation of a destructive act: there is no destructive act here, and
   * the dialog exists so that leaving is a decision rather than something that
   * happens to a learner who pressed Back out of habit.
   */
  const [leaving, setLeaving] = useState(false);
  const navigate = useNavigate();

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
  const micEnv = useMicEnvironment();
  const offlineToastId = useRef<number | null>(null);
  useEffect(() => {
    if (!online) {
      offlineToastId.current = toast.push({
        key: "network-status",
        kind: "warn",
        title: "You’re offline",
        detail: "Recordings can’t be scored until you reconnect.",
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
        kind: "spoken",
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
      /**
       * Credit the practice day and the sound history.
       *
       * Both stores existed and nothing was calling them — the streak could
       * never be anything but zero, and the sound history accumulated only
       * server-side through the scoring rollup. So a learner practising
       * offline built up neither.
       *
       * `recordPractice` takes no score, deliberately and by signature: a day
       * is credited for showing up. It runs even for an indeterminate take,
       * because a learner whose audio could not be judged still practised —
       * and R8 already says that take costs them nothing.
       */
      recordPractice(learnerName);
      markStreakDirty(learnerName);

      /**
       * Syllables, only from a take that was actually measured. Rolling
       * anything up from an indeterminate result would invent a measurement
       * for audio the system declined to judge, and it would then be averaged
       * into what the learner is told about their own pronunciation.
       */
      // Narrowed here rather than trusting the `activity` guard above: the
      // compiler cannot see that one implies the other inside this closure,
      // and the slug is what keys the learner's stored history.
      if (activeLanguage !== undefined) {
        if (!result.indeterminate) {
          const syllables = result.words.flatMap((word) =>
            word.syllables.map((syllable) => ({
              grapheme: syllable.grapheme,
              accuracy: syllable.accuracy,
            })),
          );
          if (syllables.length > 0) recordSkills(activeLanguage.slug, learnerName, syllables);
        }
        markLanguageDirty(learnerName, activeLanguage.slug);
      }

      const existingBefore = progress.find((p) => p.activityId === activity.id);
      const previousBest = existingBefore?.best ?? null;
      setBestBeforeAttempt(previousBest);

      // The rule lives in learning/session.ts, where it is tested directly
      // rather than through a rendered screen with a mocked recorder.
      setCelebration(
        celebrationFor({
          accuracy,
          previousBest,
          // Scored attempts, not all attempts. An indeterminate take is not a
          // try: R8 says it costs the learner nothing, and every other
          // allowance decision on this screen already counts with
          // scoredAttemptsOf. Counting raw length here meant one unusable take
          // pushed the next take past `firstTry` into `personalBest`, so a
          // learner who had never scored was congratulated for beating a best
          // that did not exist — the honesty boundary broken by arithmetic
          // rather than by a fabricated number.
          isFirstAttempt: scoredAttemptsOf(existingBefore?.attempts ?? []) === 0,
        }),
      );

      /**
       * Recorded, unless the learner asked to see the answer first.
       *
       * A take with the target on screen measures reading rather than recall,
       * so it must not claim the activity was passed from memory. The feedback
       * above still happens in full — the score, the syllable breakdown, the
       * comparison against the model — because saying it is how they learn the
       * phrase, and withholding that would make the reveal a punishment rather
       * than a way through.
       *
       * `revealed` is safe to read from this closure: `useRecorder` keeps its
       * options in a ref that is reassigned on every render, so this sees the
       * current value rather than the one from the render that started the
       * take.
       *
       * Nothing is stored to say the take happened, deliberately. An attempt
       * with a null accuracy would be the obvious place to put it and would be
       * wrong: that already means the system declined to judge a take it was
       * given (R8), and a learner who peeked is not a recording that failed.
       */
      if (!revealed) {
        setProgress((prev) => applyTake(prev, activity.id, attempt));
      }
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
  /**
   * Where the tapped syllable's vowel actually sat — board 1j.
   *
   * Driven by the same tap as the playback comparison rather than shown
   * unasked. A chart that appeared under every result would be a measurement
   * nobody requested, on syllables that mostly have no vowel worth placing;
   * a tap is the learner pointing at one sound and asking about it.
   */
  const vowel = useVowelEstimate(recorder.lastCapture?.wav ?? null);

  /**
   * The model pronunciation of the current target.
   */
  // Same fallback the recorder uses: this runs before the "language not
  // found" guard below, and nothing in that branch renders the control.
  const model = useModelSpeech(activeLanguage?.code ?? "en-US");

  /**
   * The two sounds the learner needs beside each other: their own weakest
   * syllable, then the model saying the word it belongs to. Both halves
   * already existed and nothing sequenced them, so either was heard alone and
   * compared against a memory.
   */
  const compare = useCompareToModel(playback, model, activeLanguage?.code ?? "en-US");

  /**
   * Tapping a syllable: hear yourself, then the model saying the word it came
   * from — board 1e.
   *
   * Both halves already existed and only ever met on the weakest syllable,
   * behind a "Hear yours, then mine" button. Everywhere else a tap played the
   * learner back and stopped, which is the half that cannot teach anything:
   * hearing your own vowel again tells you what you did, not what to aim at.
   *
   * The word is found from the result rather than threaded through
   * `WordChips` → `PhonemeDetail` → `SyllableChips` as a fourth argument.
   * Those three pass the handler straight down and none of them needs to know
   * what it does; widening all of them so the last could carry a value the
   * first already has would be three signatures changed to avoid one lookup.
   *
   * Falls back to playing the take alone whenever the comparison is not
   * available — no voice for the language, which is the ordinary case for
   * Hindi on some devices — because a tap that did nothing would read as a
   * broken chip.
   */
  const hearSyllable = useCallback(
    (syllable: { offsetTicks: number; durationTicks: number }) => {
      const owner = recorder.result?.indeterminate
        ? undefined
        : recorder.result?.words.find((word) =>
            word.syllables.some((s) => s.offsetTicks === syllable.offsetTicks),
          );

      // Measured from the same tap, and before the audio starts: the estimate
      // is about the slice, not about anything the playback does to it.
      const scored = owner?.syllables.find((s) => s.offsetTicks === syllable.offsetTicks);
      vowel.measure({
        offsetTicks: syllable.offsetTicks,
        durationTicks: syllable.durationTicks,
        grapheme: scored?.grapheme ?? "",
      });

      if (compare.available && owner !== undefined) {
        compare.compare({
          offsetTicks: syllable.offsetTicks,
          durationTicks: syllable.durationTicks,
          word: owner.word,
        });
        return;
      }
      playback.play(syllable.offsetTicks, syllable.durationTicks);
    },
    [compare, playback, recorder.result, vowel],
  );
  const weakest = recorder.result ? weakestSyllable(recorder.result) : null;

  /**
   * Advisory only — "unknown" is the normal answer on Safari, and getUserMedia
   * stays the authority. This exists so a learner whose microphone is already
   * blocked reads that before committing to an attempt, rather than tapping
   * Start and being refused.
   */
  const micPermission = useMicrophonePermission();

  /**
   * Silence the model the instant the microphone opens.
   *
   * This is the one way this feature could actively damage the product rather
   * than merely fail: a phrase still sounding through the speaker while the
   * mic is live is captured into the learner's own take and scored as if they
   * had said it. On a device without headphones that is the normal case, not
   * an edge one — and the result would be a learner credited or blamed for a
   * synthetic voice.
   */
  useEffect(() => {
    if (recorder.state === "recording" || recorder.state === "requesting") model.cancel();
  }, [recorder.state, model.cancel]);

  // A new prompt makes the previous one's audio wrong, not merely stale.
  useEffect(() => {
    model.cancel();
  }, [index, model.cancel]);
  // Screen must stay awake for the whole session, not just while recording —
  // most of the risk is the learner reading the prompt before they tap Record.
  useWakeLock(started && !finished);

  /**
   * Esc opens "Leave this sitting?" — board 1i.
   *
   * ## Why Esc only, and what is missing
   *
   * The board asks for Android's system back to land here too. Doing that from
   * a `HashRouter` means pushing a history entry when the sitting starts and
   * intercepting `popstate`, and that approach failed twice in ways worth
   * recording rather than repeating:
   *
   *  - It intercepted navigation it had no business touching — any `popstate`,
   *    including a real move to another route — and then fought it by pushing
   *    again.
   *  - The pushed entries **leaked**. Nothing removed them, so every sitting
   *    added one and Back needed one more press than the last time. An
   *    end-to-end suite surfaced it as a dialog appearing in a test that never
   *    asked for one, which is the same fault seen from outside.
   *
   * Removing an entry on the way out means calling `history.back()` from a
   * cleanup, which navigates asynchronously and can land somewhere else
   * entirely. The correct mechanism is a router-level blocker, and `useBlocker`
   * needs a data router — a migration off `HashRouter`, which is a separate
   * decision with its own reasons (see App.tsx on why the hash is there).
   *
   * So: Esc works, is reliable, and touches nothing. Android back still leaves
   * immediately, which is what it did before — no worse, and honestly stated
   * rather than half-trapped.
   */
  const inSitting = started && !finished;

  useEffect(() => {
    if (!inSitting) return;

    const onKey = (event: KeyboardEvent) => {
      // The dialog owns Esc once open — it closes itself as "keep going".
      if (event.key === "Escape") setLeaving(true);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inSitting]);

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

    /**
     * The device is released either way — a silent activity should not leave
     * the recording indicator lit while somebody reads four options — but it
     * is only re-warmed for a kind that can actually use it.
     */
    recorder.releaseDevice();
    const next = activities[index];
    if (next !== undefined && canNeedMicrophone(next.kind)) recorder.warm();
  }, [index, started, finished, activities, recorder.releaseDevice, recorder.warm]);

  // A learner who already passed can still retry to beat their own score —
  // the old banner must not survive into that new attempt looking current.
  useEffect(() => {
    if (recorder.state === "requesting") setCelebration(null);
  }, [recorder.state]);

  const scoredAttempts = scoredAttemptsOf(current?.attempts ?? []);

  const isLast = index === activities.length - 1;

  const advance = useCallback(() => {
    recorder.reset();
    setCelebration(null);
    // Cleared on the way out rather than on the way in, so advancing can never
    // land on a `recall` activity with its answer already on screen.
    setRevealed(false);
    if (isLast) {
      setFinished(true);
      toast.push({ kind: "success", title: "Session complete", detail: "Your report is ready below." });
    } else {
      setIndex((i) => i + 1);
      toast.push({ kind: "info", title: `Activity ${index + 2} unlocked` });
    }
  }, [isLast, recorder, toast, index]);

  /**
   * Let a learner past an activity without recording.
   *
   * A learner on a bus is not a learner who has failed, and the only ways past
   * an activity were to pass it or to spend three tries failing it — so
   * someone who cannot speak had to either record in a place they should not,
   * or abandon the session. Recording in a bad place is also where the 9.4%
   * indeterminate rate comes from, so this should show up in that figure.
   *
   * Stored as zero attempts plus `skipped`, which the existing shape already
   * expresses unambiguously: nobody tried. Deliberately not a new field —
   * `ActivityProgress` is persisted, so widening it means bumping the schema
   * version, and that orphans every session currently in progress for a
   * distinction the shape can already carry.
   */
  const skipWithoutRecording = useCallback(() => {
    if (!activity) return;
    setProgress((prev) => applySkip(prev, activity.id));
    advance();
  }, [activity, advance]);

  /**
   * Show a `recall` learner the answer they could not produce.
   *
   * The escape this kind gets, and it costs what it should: nothing recorded
   * after a reveal counts, because a take with the target on screen measures
   * reading rather than recall. The microphone stays open and the model
   * unlocks all the same — saying it is still how they learn it, and refusing
   * to let them would make the reveal a dead end instead of a way through.
   *
   * Deliberately not stored. A reveal is about this sitting, not about the
   * learner: they meet the phrase again when the scheduler brings the sound
   * back round, and the record of that meeting should not say they once
   * peeked. `ActivityProgress` is persisted, so anything stored here would
   * also mean a schema bump for a fact that expires in thirty seconds.
   */
  const reveal = useCallback(() => {
    setRevealed(true);
  }, []);

  /**
   * Record a `listen` answer.
   *
   * A `ChosenAttempt`, not a spoken one: there is no recording, no provider
   * call and no accuracy, and `correct` is frozen here rather than re-derived
   * later so that republishing the content with the near-misses reordered
   * cannot rewrite what a learner answered.
   *
   * `affords.attemptLimit` is 1 for this kind, so the take both answers the
   * question and ends it — a wrong answer lands as `skipped`, which is exactly
   * "advanced without passing", and the right answer is then shown beside it.
   */
  const chooseOption = useCallback(
    (option: { id: string; correct: boolean }) => {
      if (!activity) return;
      setProgress((prev) =>
        applyTake(
          prev,
          activity.id,
          {
            kind: "chosen",
            activityId: activity.id,
            choice: option.id,
            correct: option.correct,
            at: new Date().toISOString(),
          },
          // The limit is a property of the kind alone — it does not vary with
          // takes or a reveal — so it is asked for here rather than read from
          // the `affords` below, which is only in scope after the narrowing
          // guard and so cannot be reached from a hook.
          affordancesFor(activity.kind, { takes: 0, revealed: false }).attemptLimit,
        ),
      );
      recordPractice(learnerName);
      markStreakDirty(learnerName);
    },
    [activity, learnerName],
  );

  const restart = useCallback(() => {
    recorder.reset();
    setProgress([]);
    setIndex(0);
    setRevealed(false);
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
    // Only when the first activity is one that can use it — see
    // canNeedMicrophone. Start is a tap, and a permission prompt on the back
    // of it is exactly what the learner does not expect from a listening
    // question.
    const first = activities[index];
    if (first !== undefined && canNeedMicrophone(first.kind)) recorder.warm();
    startedAt.current = Date.now();
    setStarted(true);
  }, [recorder, activities, index]);

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
          <Link to="/languages" className="enter-cta">
            Back to language picker
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
      <>
        <ActivityReport
          report={report}
          activities={activities}
          progress={progress}
          onRestart={restart}
          onExport={exportReport}
        />
        {/* A sibling rather than part of the report: everything it shows comes
            from browser-persistent storage, which R11 forbids inside
            src/speech/ where ActivityReport lives. */}
        <SessionSummary slug={activeLanguage.slug} learnerName={learnerName} />
      </>
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
            : `Ten short ${activeLanguage.label} phrases. Hear each one, say it, and see exactly which sounds to fix.`}
        </p>
        {micPermission === "denied" ? (
          <p className="verdict v-fail enter-2" role="status">
            <span className="tag">BLOCKED</span>
            <span>
              This site is blocked from using your microphone. Open the padlock or camera icon in
              the address bar, allow the microphone, then reload — recording can&rsquo;t start until
              you do.
            </span>
          </p>
        ) : (
          <p className="hint enter-2">Tapping Start also turns on your microphone.</p>
        )}
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

  /**
   * The microphone is unavailable and this activity needs it — board 1g.
   *
   * Placed before every other state on this screen, because it outranks them:
   * a learner cannot record, so the prompt, the try counter and the record
   * button would all be furniture around a control that does nothing. It was a
   * toast, which appears, is missed, and leaves exactly that screen behind.
   *
   * Gated on the activity's own need for a microphone, so a `listen` activity
   * is unaffected — which is also what makes "practise listening instead" a
   * real offer rather than a consolation.
   */
  if (micEnv.availability.state !== "available" && activityNeedsMicrophone(activity.kind)) {
    return (
      <MicUnavailable
        availability={micEnv.availability}
        listeningHref={`/${activeLanguage.slug}`}
        onRetry={micEnv.recheck}
      />
    );
  }

  /**
   * What this kind of activity offers, given what has happened on it.
   *
   * Below the narrowing guard rather than beside the other derived state, and
   * that is the reason: the kind is only knowable once there *is* an activity,
   * and defaulting it to `repeat` above would be the exact bug this exists to
   * stop — an unknown activity rendered as the easiest kind.
   *
   * The screen rendered every kind as a `repeat` before this: phrase on
   * screen, Listen button beside Record. That quietly turned `read` into
   * `repeat` and `recall` into `read`. `affordancesFor` holds the rules and is
   * exhaustive over the union, so a sixth kind is a type error rather than
   * another activity silently rendered as the easiest one.
   */
  const affords = affordancesFor(activity.kind, { takes: attemptsUsed, revealed });

  /**
   * A revealed `recall` can advance without passing. `canAdvanceFrom` asks the
   * attempt arithmetic, which cannot know about a reveal — and would never
   * unlock on its own, because nothing recorded after a reveal counts toward
   * the limit that normally opens the way on.
   */
  const canAdvance = canAdvanceFrom(current, affords.attemptLimit) || affords.canMoveOn;

  /**
   * The option this learner picked, or null while the question is open.
   *
   * Read back from the recorded attempt rather than held in its own state.
   * A second copy would be a second thing to clear on advancing, and this one
   * already survives a reload — a learner who answered, closed the tab and came
   * back sees what they chose rather than an open question they have spent.
   */
  const chosenOptionId =
    current?.attempts.reduce<string | null>(
      (found, attempt) => (isSpoken(attempt) ? found : attempt.choice),
      null,
    ) ?? null;

  /**
   * Read at render rather than held in state: it changes only on another
   * screen, and a copy here would be one that could disagree with a check the
   * learner just re-ran.
   */
  const storedCheck = readCheck(learnerName);

  const passedCount = progress.filter((p) => p.passed).length;

  /**
   * The learner's practice days, read rather than recomputed.
   *
   * `recordPractice` already credits the day on every take — including an
   * indeterminate one, because a learner whose audio could not be judged still
   * showed up — so the number exists and nothing on this screen was showing
   * it. It only appeared on the report, after ten activities, which is the
   * least useful moment: a streak is a reason to keep going, and by then there
   * is nothing left to keep going with.
   *
   * Read on render rather than held in state, like Today.tsx: the source is
   * synchronous localStorage, and a take credits a day mid-session, so a
   * cached copy would show a learner yesterday's figure for the rest of the
   * sitting. Nothing here derives, thresholds or judges the number — this is
   * the store's own answer, and `recordPractice` takes no score by signature
   * so a bad take can never cost a day.
   */
  const streak = readStreak(learnerName);

  /**
   * Which of the three states the screen is in.
   *
   * All three used to render at once. A learner who had not yet spoken was
   * shown the phrase, then a record region, then a result region announcing
   * its own emptiness — "Result / No attempt yet." That is the component's
   * state shape drawn as UI: three regions because there are three kinds of
   * state to hold, rather than because a learner needs three things in front
   * of them at once.
   *
   * Derived on every render, and derived from the recorder. Not held in state
   * and deliberately not carried in the route: the honesty rule (R8) and the
   * three-try count both live on this screen and both read the recorder, so a
   * second, settable copy of "where are we" is a copy that can disagree with
   * the take actually in flight — a learner mid-take on a screen that has
   * moved on, or a try charged against a state that no longer exists. There is
   * nothing to keep in sync here because there is nothing second.
   *
   * `processing` belongs to the result state rather than the speaking one: the
   * take is already over, and what belongs on screen while the provider thinks
   * is the skeleton holding the score card's shape.
   */
  const phase =
    recorder.state === "requesting" || recorder.state === "ready" || recorder.state === "recording"
      ? "speaking"
      : recorder.state === "processing" || recorder.result !== null || recorder.error !== null
        ? "result"
        : "prompt";

  /**
   * Which word of the phrase the model voice is saying, or null for none.
   *
   * Following along while hearing a phrase is how a learner maps a sound to
   * its spelling; the phrase was previously a wall of text that a voice moved
   * through invisibly, so a learner hearing an unfamiliar syllable had no way
   * to tell which part of the spelling had just produced it.
   *
   * Null far more often than not — nothing is speaking, or the engine reports
   * no word boundaries — and null is a complete answer, not a degraded one:
   * see the branch at the phrase below.
   *
   * `useCompareToModel` drives the same hook with a single word rather than
   * the phrase, so its index is 0 and would mark the phrase's first word if
   * the phrase were on screen. It is not: comparison only exists once there is
   * a result, and the phrase is replaced by the outcome then. Both ways back
   * to the phrase — retrying and advancing — cancel the model first, in the
   * two effects above, which clears this to null with it.
   */
  const spokenWord = model.wordIndex;

  return (
    <section key={activity.id} className="enter-1">
      {/*
        Board 1i. Rendered inside the session rather than at the app shell,
        because what it says depends on where the learner is in *this* sitting
        — and because the shell has no business knowing there is one.
      */}
      {leaving && (
        <LeaveSittingDialog
          position={index + 1}
          total={activities.length}
          hasScoredTake={scoredAttempts > 0}
          onKeepGoing={() => setLeaving(false)}
          onLeave={() => {
            setLeaving(false);
            navigate("/");
          }}
        />
      )}
      <div className="activity-head">
        {/*
          The activity's own name, which is what the learner is about to do.
          The heading used to read "Activity 3 of 10 — Ordering in a café":
          two thirds of it was a position, and the only part that says
          anything about the next thirty seconds arrived after an em dash.
          Position moved to the rail below, which shows exactly that and
          already carries "Activity 3 of 10" as its accessible name, so
          nothing was lost by not saying it twice.

          tabIndex -1: focusable by the advance effect above, never a tab
          stop of its own.
        */}
        <h2 ref={activityHeadingRef} tabIndex={-1}>
          {activity.title}
        </h2>

        {/*
          Attendance, in front of the learner while they can still add to it.
          Nothing is shown at zero: "0 days in a row" is a scoreboard reading
          nil, which is the opposite of the encouragement a streak is for.
        */}
        {streak.current > 0 && (
          <p className="streak-chip">
            {streak.current === 1 ? "Day 1" : `${streak.current} days in a row`}
          </p>
        )}
      </div>
      <div className="steps-track" aria-hidden="true">
        <div
          className="steps-fill"
          style={{ transform: `scaleX(${activities.length === 0 ? 0 : passedCount / activities.length})` }}
        />
      </div>
      <div className="steps" role="list" aria-label={`Activity ${activity.id} of ${activities.length}`}>
        {activities.map((a, i) => {
          const p = progress.find((pr) => pr.activityId === a.id);
          const state = stepStateFor(i === index, p);
          return <span key={a.id} role="listitem" className={`step step-${state}`} aria-label={`Activity ${a.id}: ${state}`} />;
        })}
      </div>

      {/*
        The phrase. Shown while the learner is reading it and while they are
        saying it — the target cannot vanish the moment the microphone opens,
        because with auto-stop they are still reading it — and replaced by the
        outcome once there is one.
      */}
      {phase !== "result" && (
        <>
          {/* The task, not the content. It was set in bold above a 22px
              target, which put the English instruction and the thing being
              taught at roughly equal weight; there is one subject on this
              screen and it is the phrase. */}
          <p className="task">{activity.prompt}</p>

          {/*
            What a `recall` learner is given instead of the phrase: the English
            meaning, at the size the phrase would have had.

            The gloss is normally a quiet line below the actions — the answer
            sitting next to the question, deliberately out of the way. Here it
            *is* the question, so it takes the phrase's place rather than being
            duplicated: rendering both would put the same sentence on screen
            twice at two different sizes.

            Untagged, because it is English. The `lang` on the phrase below
            exists so a screen reader does not say a French phrase in an
            English voice (WCAG 3.1.2); tagging this would do the reverse.
          */}
          {!affords.showsTarget && activity.kind === "recall" && (
            <p className="phrase phrase-hidden">&ldquo;{activity.gloss}&rdquo;</p>
          )}

          {/*
            The product, at the size of the product.
            `.phrase` rather than the shared `.prompt`, which is now the
            fixture runner's alone: the name was actively confusing — the
            activity's `prompt` field is the English instruction *above* this —
            and a diagnostics tool has no reason to render its reference text
            at 40px.

            The one field here genuinely in the language being taught, so the
            `lang` tag stays: without it a screen reader says a French phrase
            in an English voice, in a product whose entire subject is how a
            phrase should sound (WCAG 3.1.2). The task above and the gloss
            below are English *about* the phrase and stay untagged — tagging
            those would make a reader speak English in a French voice.
          */}
          {affords.showsTarget && (
          <p className="phrase" lang={activeLanguage.code}>
            {spokenWord === null
              ? // The phrase as one text node — which is what it was before
                // word marking existed, and what it stays on every engine
                // that reports no boundaries. The branch is the guarantee:
                // where there is no word to mark there is no wrapper, no
                // extra node, and nothing for the absent event to hold up.
                activity.target
              : phraseTokens(activity.target).map((token) =>
                  token.index === null ? (
                    token.text
                  ) : (
                    <span
                      key={token.start}
                      className={token.index === spokenWord ? "phrase-word now" : "phrase-word"}
                    >
                      {token.text}
                    </span>
                  ),
                )}
          </p>
          )}
        </>
      )}

      {/*
        The sound check's verdict, carried forward as one quiet line — board 1m.

        Only on the very first activity of a session and only before a take has
        landed, because that is the whole window in which it is useful: a
        learner whose first result comes back unclear otherwise concludes the
        app cannot hear them. After that they have evidence of their own and
        this becomes noise. Gated on the activity recording at all, too — a
        listening question has nothing to reassure anyone about.

        Two readings of the same fact. A passed check means an unclear take is
        the take rather than the setup, which is genuinely reassuring. A quiet
        check says so instead, so the unclear result is already half-explained
        before it happens — and it links back, because the actionable thing is
        to run it again.
      */}
      {index === 0 && attemptsUsed === 0 && phase === "prompt" && affords.needsMicrophone && storedCheck && (
        <p className="hint check-carry">
          {storedCheck.verdict === "good" ? (
            <>
              ✓ Sound check passed
              {storedCheck.deviceLabel === null ? "" : ` on ${storedCheck.deviceLabel}`}. If a take
              comes back unclear, it is the take — not your setup.
            </>
          ) : (
            <>
              Your check came out {storedCheck.verdict === "silent" ? "silent" : "quiet"}. Hold the
              phone closer than feels necessary — or{" "}
              <Link to="/check">run it again</Link>.
            </>
          )}
        </p>
      )}

      {/*
        Offline — board 1h, and it is a wait rather than a failure.
        Shown in the prompt phase, before a learner commits to speaking, which
        is the only moment the information is still actionable. It was a toast
        alone, which can be missed and leaves a learner talking to a record
        button that will refuse them.

        The copy says what actually happens rather than what would be nicer.
        Takes are **not** held for later: there is no outbox, so a take made
        now cannot be scored now or afterwards. Saying "held and scored when
        you are back" would be a promise the app does not keep, and the learner
        would find out by looking for takes that never arrived.
      */}
      {phase === "prompt" && !online && affords.needsMicrophone && (
        <div className="verdict v-warn" role="status" aria-live="polite">
          <div className="tag">WAITING</div>
          <div>
            You&rsquo;re offline, so a take can&rsquo;t be scored right now. Your practice day is
            already credited, and nothing you have done is lost.
          </div>
        </div>
      )}

      {phase === "result" && recorder.error && (
        <div className="verdict v-fail" role="status" aria-live="polite" ref={errorRef} tabIndex={-1}>
          {/*
            "STOPPED", not "ERROR". The learner is being told what happened to
            their take, and the word that names the state is more use than the
            word that names its severity — which they can see from the styling
            anyway.
          */}
          <div className="tag">STOPPED</div>
          <div>
            {recorder.error.userMessage}
            {/*
              Said here rather than left to the tries line, and said in the
              same breath as the failure. A take that failed to capture was
              never judged, so R8 applies exactly as it does to an
              indeterminate one — and a learner watching a take fail will
              assume it cost them unless told otherwise.
            */}
            <p className="hint" style={{ margin: "var(--space-2) 0 0" }}>
              This take didn&rsquo;t count.
            </p>
            {/*
              Behind ?debug=1. The code and domain are real support value and
              the wrong audience: this is already sent to the diagnostics
              collection, so hiding it loses nothing — and a learner reading
              an error code concludes the app is broken rather than that
              their microphone is off.
            */}
            {debugEnabled && (
              <details className="error-details">
                <summary>Technical details</summary>
                <div className="hint">
                  {recorder.error.code} · {recorder.error.domain} · {recorder.error.detail}
                </div>
              </details>
            )}
          </div>
        </div>
      )}

      {phase === "result" && current?.passed && (
        <div
          className={`verdict v-pass pass-banner${celebration && celebration.kind !== "pass" ? " pass-banner-celebrate" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className="tag">
            {celebration?.kind === "firstTry" ? "FIRST TRY!" : celebration?.kind === "personalBest" ? "NEW BEST!" : "PASSED"}
          </div>
          <div>
            {celebration?.kind === "personalBest"
              ? `Scored ${Math.round(current.best ?? 0)} — beat your previous best. Move on when you are ready.`
              : `Scored ${Math.round(current.best ?? 0)}. Move on when you are ready.`}
          </div>
        </div>
      )}

      {phase === "result" && !current?.passed && scoredAttempts >= MAX_ATTEMPTS && (
        <div className="verdict v-warn">
          <div className="tag">MOVE ON</div>
          <div>
            {MAX_ATTEMPTS} attempts used. This one is recorded as not passed and will show in the
            report — carry on to the next activity.
          </div>
        </div>
      )}

      {/*
        The live region is mounted in every state, empty or not, and that is
        the point rather than an oversight. A screen reader only announces
        changes inside an `aria-live` container that was already in the
        document — mounting the container together with its content is the
        classic way to make an announcement silently never fire. So the
        container is unconditional and its *contents* are sequenced.

        What it no longer holds is "No attempt yet.": a learner who has not
        spoken does not need to be told they have not spoken.
      */}
      <div aria-live="polite">
        {phase === "result" && (
          <>
            {/*
              Specific to the attempt just made, unlike the activity's own
              focus text, which reads the same at 41 and at 79. Rendered above
              the score card because it is the actionable half — the numbers
              say how it went, this says what to do about it.
            */}
            {recorder.result && adviceFor(recorder.result) && (
              <p className="advice">
                {adviceFor(recorder.result)}
                {/*
                  Offered only when there is something specific to compare and
                  both halves are available — a platform with no voice for the
                  language is the ordinary case for Hindi on some devices, and a
                  button that played only the learner back under this label
                  would be worse than no button.
                */}
                {weakest && compare.available && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="ghost"
                      onClick={() =>
                        compare.compare({
                          offsetTicks: weakest.syllable.offsetTicks,
                          durationTicks: weakest.syllable.durationTicks,
                          word: weakest.word,
                        })
                      }
                    >
                      Hear yours, then mine
                    </button>
                  </>
                )}
              </p>
            )}
            {/*
              Three outcomes, not two. "processing" is its own — it used to
              fall through to "No attempt yet.", which is actively wrong: the
              learner has just made an attempt and is told there isn't one, for
              the second and a half they most want reassurance.
            */}
            {recorder.result ? (
              <ScoreCard
                result={recorder.result}
                heardSpeech={(recorder.lastCapture?.snrDb ?? 0) >= HEARD_SPEECH_SNR_DB}
                lang={activeLanguage.code}
                previousBest={bestBeforeAttempt}
                detailed={debugEnabled}
                {...(playback.available ? { onSelectSyllable: hearSyllable } : {})}
                playingOffsetTicks={playback.playingOffsetTicks}
              />
            ) : recorder.state === "processing" ? (
              <ScoreCardSkeleton />
            ) : null}

            {/*
              Below the card, because it is about one syllable of the result
              rather than about the result. `target` is null: no content names
              the vowel a syllable is aiming at yet, and the chart is built to
              show a measurement against the four landmarks without one —
              inventing a goal would put a number on the screen that nothing
              measured.
            */}
            {vowel.estimate !== null && (
              <VowelChart
                outcome={vowel.estimate.outcome}
                target={null}
                grapheme={vowel.estimate.grapheme}
              />
            )}
          </>
        )}
      </div>

      {/*
        No stated threshold. Publishing the pass mark turned practice into a
        number to clear: it invited gaming the figure rather than saying the
        phrase well, and a learner can act on the syllable chips but not on
        "60".

        Tries remaining stays, because running out is a real constraint a
        learner needs to see coming, and it is as relevant beside a result as
        it is before one. It counts *scored* attempts — an unusable take costs
        nothing (R8).
      */}
      {/* Only where there are tries to spend. A `listen` activity gets one
          answer, and "1 try left" above a pair of options would read as a
          warning about something the learner cannot do twice anyway. */}
      {affords.needsMicrophone && (
        <p className="what">
          {MAX_ATTEMPTS - scoredAttempts === 1
            ? "Last try for this one"
            : `${MAX_ATTEMPTS - scoredAttempts} tries left`}
        </p>
      )}

      {/*
        A `listen` activity asks its question here, where every other kind puts
        the phrase and the record button. The options are the content — the
        model says one of them — so they sit at reading weight rather than as a
        row of controls.

        Rendered before the actions row, and the actions row then carries only
        "Next activity": there is nothing to record, nothing to skip for want
        of a quiet place, and no try to spend.
      */}
      {/*
        A question made of audio, on a device that cannot play it.

        Without this the screen renders "Listen, then choose", then "Which
        sound was in that?", then four syllables and **no Listen button** —
        because the button is gated on `model.available`. The learner is asked
        which sound was in a phrase they were never able to hear, and whatever
        they tap is recorded as their answer. Measured, not imagined: that is
        exactly what rendered with the voice turned off.

        It is not a rare path. `npm run generate-model-voice` reads `LANGUAGES`
        — the bundled ten per language — so a published course phrase has no
        cached audio, and a device with no installed voice for the language has
        nothing to fall back to. Hindi on a phone with no hi-IN voice is the
        ordinary case the affordances already mention.

        Symmetric with `MicUnavailable` above: an activity that cannot be
        attempted says so and costs nothing, rather than taking an answer it
        has no right to.
      */}
      {theQuestionIsAudio(activity.kind) && phase !== "result" && !model.available && (
        <p className="what">
          This question is a phrase to listen to, and this device has no voice for{" "}
          {activeLanguage.label}. Nothing has been counted against you.
        </p>
      )}

      {activity.kind === "listen" && phase !== "result" && model.available && (
        <ListenOptions
          options={listenOptions(activity)}
          code={activeLanguage.code}
          target={activity.target}
          focus={activity.focus}
          chosen={chosenOptionId}
          onChoose={chooseOption}
        />
      )}

      {/*
        A `locate` activity asks which sound was in the phrase. Composed from
        the language's own sound targets rather than from authored options —
        the answer is a syllable this phrase drills, the wrong ones are
        syllables other phrases drill that this one does not contain.

        `null` means the language cannot compose a question: too few distinct
        syllables, or an activity whose targets do not occur in its own phrase.
        The publish gate refuses both, but this reads served content, so it
        says so rather than rendering a blank task.
      */}
      {activity.kind === "locate" && phase !== "result" && model.available && (() => {
        const options = locateOptions(activity, activeLanguage);
        if (options === null) {
          return (
            <p className="what">
              This question could not be put together from the sounds this
              language has. Nothing has been counted against you.
            </p>
          );
        }
        return (
          <LocateOptions
            options={options}
            code={activeLanguage.code}
            target={activity.target}
            chosen={chosenOptionId}
            onChoose={(grapheme) =>
              chooseOption({
                id: grapheme,
                correct: options.some((o) => o.grapheme === grapheme && o.correct),
              })
            }
          />
        );
      })()}

      <div className="row">
        {/*
          Hearing the phrase is the first half of practising it, and it sat
          below the target as a small outlined afterthought — a learner had to
          decide to go looking for it. It is a peer of the record button now
          and it comes first, because that is the order the two are used in.

          Disabled rather than hidden while the mic is live: hiding it would
          shift the row at the exact moment the learner is about to speak. The
          effect above also cancels any playback the instant the microphone
          opens, so the model's voice can never be captured into a take and
          scored as the learner's own.
        */}
        {phase !== "result" && model.available && affords.canListen && (
          <button
            type="button"
            className="listen"
            disabled={phase === "speaking"}
            onClick={() =>
              model.speaking ? model.cancel() : model.speak(activity.target, activeLanguage.code)
            }
          >
            {model.speaking ? "Stop" : "Listen"}
          </button>
        )}
        {/*
          After a result, going again and moving on are the two things a
          learner wants, and they now sit together. Retrying used to be the
          record button in a region above the score, so "have another go" and
          "carry on" were in different places on the screen and the nearer one
          was the one that discarded what they had just read.

          `retry` only changes the label. Both remain real choices — a learner
          who passed may want to beat their own score, and one who has not may
          want to move on — so neither is withheld; the quieter styling says
          which is the ordinary next step without taking the other away.
        */}
        {affords.needsMicrophone && (
        <RecordButton
          state={recorder.state}
          onStart={recorder.start}
          onStop={recorder.stop}
          autoStop={settings.autoStop}
          speaking={recorder.speaking}
          continuous={settings.continuous}
          sessionActive={recorder.sessionActive}
          retry={phase === "result"}
          secondary={phase === "result" && canAdvance}
        />
        )}
        {canAdvance && (
          <button type="button" onClick={advance}>
            {isLast ? "Finish and see report" : "Next activity"}
          </button>
        )}
        {/*
          Offered only while this activity has nothing recorded against it and
          nothing is in flight. Once there is a take, "Next activity" is the
          honest way on and a second escape would invite discarding a real
          result by mistake.
        */}
        {/*
          The `recall` escape. Offered in the same place as "Can't speak right
          now" and styled the same way, because it is the same kind of thing:
          a way through for a learner who is stuck, that costs them the
          exercise rather than the session.

          Its consequence is stated on the button, not discovered after
          tapping it. A learner deciding whether to give up needs to know what
          giving up does — and "this one won't count" is the honest version of
          a reveal, not a penalty for asking.
        */}
        {affords.canReveal && phase === "prompt" && (
          <button type="button" className="ghost" onClick={reveal}>
            Show me &mdash; this one won&rsquo;t count
          </button>
        )}
        {attemptsUsed === 0 && phase === "prompt" && affords.needsMicrophone && (
          <button type="button" className="ghost" onClick={skipWithoutRecording}>
            Can&rsquo;t speak right now
          </button>
        )}
      </div>

      {/*
        The English meaning, below the actions and quieter than either.
        It was directly under the target, at 12px against 22px, which made the
        first thing a learner's eye landed on after the phrase an English
        sentence — the answer, next to the question. It is still here because
        nobody should practise a sentence they cannot translate; it is just no
        longer in the way of saying it.
      */}
      {phase !== "result" && (
        <>
          {/* Suppressed while it is standing in for the phrase above — the
              same sentence twice, at two sizes, reads as a rendering fault. */}
          {affords.showsTarget && <p className="hint gloss">&ldquo;{activity.gloss}&rdquo;</p>}

          <details>
            <summary>Why this phrase</summary>
            <div className="body">
              <p className="what" style={{ margin: 0 }}>
                {activity.focus}
              </p>
            </div>
          </details>
        </>
      )}

      {/*
        Only while the microphone is actually open. Both of these used to
        render before the learner had spoken — a level meter reading silence
        and an interim panel with nothing to report are instruments idling,
        which is a large part of what made this screen read as a tool.
      */}
      {phase === "speaking" && settings.interim && (
        <LiveInterimFeedback
          store={recorder.levelStore}
          recording={recorder.state === "recording"}
          speaking={recorder.speaking}
          hangoverMs={hangoverMs}
          autoStop={settings.autoStop}
        />
      )}

      {phase === "speaking" && (
        <LiveLevelMeter
          store={recorder.levelStore}
          active={recorder.state === "recording"}
          clipping={recorder.clipping}
        />
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
  );
}
