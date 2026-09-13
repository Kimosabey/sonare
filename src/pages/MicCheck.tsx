/**
 * The microphone check — board 1e–1l, all eight states.
 *
 * A measured 7.2% of real takes come back unusable, most of them the recording
 * rather than the scorer. Without this screen a learner with a muted, dead or
 * wrongly-routed microphone discovers that after speaking, where it reads as
 * the app failing to understand them rather than as a device they can fix.
 *
 * ## The eight, and why they are eight
 *
 * Three are about what the browser allows and are known before any audio —
 * `insecure`, `no-hardware`, `denied`. Two of those are **nobody's fault** and
 * are written that way: an address without `https` and a device with no input
 * are not things the learner did, so neither screen gives instructions to
 * follow, because there is nothing to undo. `denied` is the opposite: it is
 * recoverable, the page cannot ask again, and so the screen is a route through
 * settings rather than a retry button that would do nothing.
 *
 * Three are verdicts on a signal — `good`, `quiet`, `silent` — and `silent` is
 * emphatically not the bottom of the same scale. A flat reading means muted or
 * wrongly routed, and neither is fixed by speaking louder.
 *
 * Two are the screen working: `idle` and `listening`.
 *
 * ## What it never does
 *
 * Nothing here is scored, uploaded or kept, and the screen says so where a
 * learner is speaking. That is a promise about behaviour: `useRecorder` is
 * deliberately not used, because it uploads for scoring. The check reads
 * levels locally and throws them away.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMicEnvironment } from "../hooks/useMicEnvironment.js";
import {
  MIN_CHECK_SECONDS,
  verdictFor,
  type CheckResult,
} from "../speech/capture/micCheck.js";
import { analyseSignal } from "../speech/capture/snr.js";

type Phase = "idle" | "listening" | "done";

/** Bars in the level meter. Printed beside the reading so motion is never alone. */
const BARS = 24;

/** dBFS at the bottom of the meter — quieter than this reads as nothing. */
const FLOOR_DB = -60;

function barsFor(db: number): number {
  const clamped = Math.max(FLOOR_DB, Math.min(0, db));
  return Math.round(((clamped - FLOOR_DB) / -FLOOR_DB) * BARS);
}

export function MicCheck() {
  const env = useMicEnvironment();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>("idle");
  const [levelDb, setLevelDb] = useState(FLOOR_DB);
  const [seconds, setSeconds] = useState(0);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const framesRef = useRef<Float32Array[]>([]);
  const rafRef = useRef<number | null>(null);

  /**
   * Everything the check opened, closed.
   *
   * A live microphone leaves the OS recording indicator on — the orange dot on
   * iOS, the red tab badge on desktop — which after a screen that promised
   * nothing is kept reads as the app still listening. It is also the same leak
   * that made the session screen hold the device between activities.
   */
  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close();
    contextRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const stop = useCallback(() => {
    teardown();

    const frames = framesRef.current;
    const total = frames.reduce((n, f) => n + f.length, 0);
    const joined = new Float32Array(total);
    let at = 0;
    for (const frame of frames) {
      joined.set(frame, at);
      at += frame.length;
    }

    const rate = 48_000;
    const elapsed = total / rate;
    const stats =
      total === 0
        ? { snrDb: 0, peakDbfs: FLOOR_DB, silent: true, clippedFraction: 0 }
        : analyseSignal(joined, rate);

    setResult(
      verdictFor({
        snrDb: stats.snrDb,
        speechDbfs: stats.peakDbfs,
        roomDbfs: stats.peakDbfs - stats.snrDb,
        clippedFraction: stats.clippedFraction,
        seconds: elapsed,
        silent: stats.silent,
      }),
    );
    setPhase("done");
  }, [teardown]);

  const start = useCallback(async () => {
    setFailed(null);
    framesRef.current = [];
    setSeconds(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const context = new AudioContext();
      contextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const buffer = new Float32Array(analyser.fftSize);
      const startedAt = performance.now();

      const tick = () => {
        analyser.getFloatTimeDomainData(buffer);
        framesRef.current.push(buffer.slice());

        let sum = 0;
        for (const sample of buffer) sum += sample * sample;
        const rms = Math.sqrt(sum / buffer.length);
        setLevelDb(rms <= 0 ? FLOOR_DB : Math.max(FLOOR_DB, 20 * Math.log10(rms)));
        setSeconds((performance.now() - startedAt) / 1000);

        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      setPhase("listening");
    } catch {
      /**
       * The prompt was refused, or the device vanished between the list and
       * the ask. Not narrowed into a cause here: `useMicEnvironment` re-reads
       * the permission and will render the `denied` screen on its own if that
       * is what happened, and guessing would risk telling a learner they
       * refused when the device was simply unplugged.
       */
      teardown();
      setFailed("The microphone could not be opened. Check it is connected and try again.");
      setPhase("idle");
    }
  }, [teardown]);

  /* ── the three the environment settles, before any audio ──────────────── */

  if (env.availability.state === "insecure") {
    return (
      <section className="enter-1 check">
        <h1>This address cannot use a microphone</h1>
        <p className="what">
          Browsers only hand out a microphone over a secure <code>https</code> connection. This page
          was opened over a plain one, so there is no microphone here to grant — by design, and
          nothing to do with your device.
        </p>
        <p className="hint">
          You opened <code>{env.origin}</code>
        </p>
        <p className="what">
          If someone sent you this link for testing, that is worth telling them — the link is the
          problem, not the phone.
        </p>
        <div className="row">
          <Link className="enter-cta" to="/">
            Practise listening here
          </Link>
        </div>
      </section>
    );
  }

  if (env.availability.state === "no-hardware") {
    return (
      <section className="enter-1 check">
        <h1>This device has no microphone</h1>
        {/* Nobody's fault, and phrased that way: nothing is switched off and
            nothing is blocked, so there are no instructions to follow. */}
        <p className="what">
          Nothing is switched off and nothing is blocked — the browser reports no input device at
          all. Plugging in headphones with a microphone, or moving to a phone, is all it takes.
        </p>
        <h2>What still works, fully</h2>
        <ul className="what">
          <li>Every listening activity — hear a phrase, pick what you heard.</li>
          <li>The model voice, on every phrase in the course.</li>
          <li>Your sound history, if you have practised on another device.</li>
        </ul>
        <p className="hint">
          What you cannot do is be scored, because that needs to hear you.
        </p>
        <div className="row">
          <Link className="enter-cta" to="/">
            Start with listening
          </Link>
          <button type="button" onClick={env.recheck}>
            Look for a microphone again
          </button>
        </div>
      </section>
    );
  }

  if (env.availability.state === "denied") {
    return (
      <section className="enter-1 check">
        <h1>The microphone was turned down</h1>
        <p className="what">
          Safari only asks once, so we cannot put the question back up. Turning it on takes four
          taps in Settings.
        </p>
        <ol className="what">
          <li>
            Open <strong>Settings</strong> on your phone.
          </li>
          <li>
            Scroll to <strong>Safari</strong>, then <strong>Microphone</strong>.
          </li>
          <li>
            Set it to <strong>Ask</strong> or <strong>Allow</strong>.
          </li>
          <li>Come back here and tap the button below.</li>
        </ol>
        <details>
          <summary>On Android Chrome instead</summary>
          <div className="body">
            <p className="what">
              Tap the padlock beside the address, then <strong>Permissions</strong>, then allow the
              microphone. Chrome will ask again after that.
            </p>
          </div>
        </details>
        <p className="hint">
          If you would rather not, that is a fine answer. The listening activities need no
          microphone, and everything else stays available.
        </p>
        <div className="row">
          <button type="button" className="enter-cta" onClick={env.recheck}>
            I&rsquo;ve changed it — try again
          </button>
          <Link className="ghost" to="/">
            Start with listening only
          </Link>
        </div>
      </section>
    );
  }

  /* ── the verdicts ─────────────────────────────────────────────────────── */

  if (phase === "done" && result) {
    const tag =
      result.verdict === "good" ? "GOOD" : result.verdict === "quiet" ? "QUIET" : "SILENT";

    return (
      <section className="enter-1 check">
        <h1>Sound check</h1>
        <div
          className={`verdict v-${result.verdict === "good" ? "pass" : "fail"}`}
          role="status"
          aria-live="polite"
        >
          <div className="tag">{tag}</div>
          <div>
            {result.verdict === "good" && (
              <>
                <strong>This device can be scored.</strong> Your voice came through about{" "}
                {result.marginDb} dB above the room — plenty for the scorer to work with.
              </>
            )}
            {result.verdict === "quiet" && !result.clipping && (
              <>
                <strong>We heard you, but only just.</strong> Your voice was about{" "}
                {result.marginDb} dB above the room. Takes will work, and more of them than usual
                will come back unclear.
              </>
            )}
            {result.verdict === "quiet" && result.clipping && (
              <>
                <strong>That was too loud to score.</strong> The sound was driven past what the
                microphone can record, which the scorer hears as distortion rather than speech.
              </>
            )}
            {result.verdict === "silent" && (
              <>
                <strong>Nothing reached us at all.</strong> Not quiet — flat. That is almost always
                a muted microphone, or the wrong input selected.
              </>
            )}
          </div>
        </div>

        {result.verdict === "quiet" && !result.clipping && (
          <>
            <h2>Worth trying, in this order</h2>
            <ol className="what">
              <li>Hold the phone closer — a hand&rsquo;s width from your mouth.</li>
              <li>Take your hand or a case off the bottom edge, where the microphone is.</li>
              <li>Headphones with a built-in microphone, if you have them.</li>
              <li>Somewhere quieter, if the room is the loud part.</li>
            </ol>
          </>
        )}

        {result.verdict === "quiet" && result.clipping && (
          <>
            <h2>Worth trying, in this order</h2>
            <ol className="what">
              <li>Hold the phone further away — about a hand&rsquo;s width.</li>
              <li>Speak across the microphone rather than straight into it.</li>
              <li>Turn the input level down, if your headset or system offers one.</li>
            </ol>
          </>
        )}

        {result.verdict === "silent" && (
          <>
            <h2>Two things look identical from here</h2>
            <ol className="what">
              <li>
                <strong>The microphone is muted.</strong> A hardware switch, a headset&rsquo;s
                inline mute, or a system mute. The level stays flat however loudly you speak.
              </li>
              <li>
                <strong>We are listening to the wrong thing.</strong> Something else is selected as
                the input — a connected headset, a virtual device, a TV.
              </li>
            </ol>
          </>
        )}

        {!result.conclusive && (
          <p className="hint">
            That was under {MIN_CHECK_SECONDS} seconds of sound, so treat it as a rough answer.
          </p>
        )}

        <div className="row">
          {result.verdict === "good" ? (
            <button type="button" className="enter-cta" onClick={() => navigate("/")}>
              Say your first phrase
            </button>
          ) : (
            <button type="button" className="enter-cta" onClick={() => setPhase("idle")}>
              Check again
            </button>
          )}
          {result.verdict !== "good" && (
            <button type="button" onClick={() => navigate("/")}>
              Carry on anyway
            </button>
          )}
        </div>

        <p className="hint">
          About one take in fourteen still comes back unusable — usually the recording, not the
          scoring. When that happens you are told so, and it costs you nothing.
        </p>
      </section>
    );
  }

  /* ── idle and listening ───────────────────────────────────────────────── */

  const bars = barsFor(levelDb);

  return (
    <section className="enter-1 check">
      <h1>Say anything</h1>
      <p className="what">
        Count to three, or read this line aloud. We are checking the microphone, not you — nothing
        here is scored or kept.
      </p>

      {/*
        The one place live movement carries the information, so the reading and
        the bar count are printed beside it. Both survive reduced motion, and a
        screen reader gets the numbers rather than an animation.
      */}
      <div className="check-meter" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <span key={i} className={i < bars ? "check-bar on" : "check-bar"} />
        ))}
      </div>
      <p className="hint" role="status" aria-live="polite">
        {phase === "listening"
          ? `${Math.round(levelDb)} dB · ${bars} of ${BARS} bars · ${seconds.toFixed(1)}s of ${MIN_CHECK_SECONDS}s`
          : "The bars move when the microphone hears something."}
      </p>

      {failed && (
        <p className="verdict v-fail" role="alert">
          {failed}
        </p>
      )}

      <div className="row">
        {phase === "listening" ? (
          <button type="button" className="enter-cta" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" className="enter-cta" onClick={() => void start()}>
            Start the check
          </button>
        )}
        <Link className="ghost" to="/">
          Skip the check
        </Link>
      </div>

      <p className="hint">
        Nothing from this check is uploaded or scored. It never leaves the device.
      </p>
    </section>
  );
}
