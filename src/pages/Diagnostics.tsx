/**
 * Internal-only screen — not part of the learner flow, reached only by
 * typing #/diagnostics directly (no nav link anywhere in the product UI).
 * Polls the read-only GET /api/v1/diagnostics and /api/v1/attempts endpoints
 * so recent activity and errors are visible without a database client.
 *
 * Token-gated server-side when DIAGNOSTICS_TOKEN is set (server/routes/
 * diagnostics.ts) — pass it once as #/diagnostics?token=... and it's
 * remembered in localStorage from then on, so you don't retype it every visit.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { parseUserAgent } from "../ui/parseUserAgent.js";
import type { PronunciationResult } from "../speech/scoring/types.js";

const TOKEN_STORAGE_KEY = "sonare.diagnosticsToken";

// Mirrors server/attempts.ts and server/diagnostics.ts — kept as separate
// client-side types rather than importing across the client/server boundary,
// same convention PronunciationResult itself already follows (PRD §6).
interface AttemptRecord {
  at: string;
  sessionId?: string;
  activityId?: number;
  referenceText: string;
  language: string;
  audio: { seconds: number };
  timings: { totalMs: number; providerMs: number };
  deviceContext: unknown;
  result: PronunciationResult;
}

interface DiagnosticRecord {
  at: string;
  source: "client" | "server";
  sessionId?: string;
  activityId?: number;
  code: string;
  domain: string;
  context?: unknown;
}

const POLL_MS = 4000;

/**
 * Time-only was fine while every row was "just now" — once this runs across
 * more than one day, rows from different days would show identical-looking
 * times with nothing to tell them apart. Always show the date too.
 */
function formatAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function Diagnostics() {
  const [searchParams] = useSearchParams();
  const [attempts, setAttempts] = useState<AttemptRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const [pollCount, setPollCount] = useState(0);

  // A token in the URL wins and is remembered; otherwise fall back to
  // whatever was remembered from a previous visit. Neither may exist if
  // DIAGNOSTICS_TOKEN isn't set server-side — that's fine, the server
  // only checks the header when it has something to check it against.
  const urlToken = searchParams.get("token");
  if (urlToken) {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, urlToken);
    } catch {
      // Private browsing or storage disabled — the token still works for
      // this page load via urlToken, just won't be remembered next time.
    }
  }
  const token = urlToken ?? (() => {
    try {
      return localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    let cancelled = false;
    const headers: HeadersInit = token ? { "x-diagnostics-token": token } : {};

    const poll = async () => {
      try {
        const [attemptsRes, diagnosticsRes] = await Promise.all([
          fetch("/api/v1/attempts?limit=50", { headers }),
          fetch("/api/v1/diagnostics?limit=50", { headers }),
        ]);
        if (attemptsRes.status === 401 || diagnosticsRes.status === 401) {
          if (!cancelled) {
            setError('This server requires a diagnostics token. Add ?token=... to the URL once.');
          }
          return;
        }
        if (!attemptsRes.ok || !diagnosticsRes.ok) throw new Error("request failed");

        const attemptsBody = (await attemptsRes.json()) as { records: AttemptRecord[] };
        const diagnosticsBody = (await diagnosticsRes.json()) as { records: DiagnosticRecord[] };

        if (cancelled) return;
        setAttempts(attemptsBody.records);
        setDiagnostics(diagnosticsBody.records);
        setLastPolledAt(new Date());
        setPollCount((n) => n + 1);
        setError(null);
      } catch {
        if (!cancelled) setError("Couldn't reach the diagnostics API — is the server (and MongoDB) up?");
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  return (
    <>
      <section>
        <h2>Live status</h2>
        {error ? (
          <p className="what" style={{ color: "var(--fail)" }}>
            {error}
          </p>
        ) : (
          <p className="what" style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: 8 }}>
            {/* key forces the flash keyframe to replay on every successful
                poll, not just once on mount — a visible "just refreshed" beat
                distinct from steady-state, rather than a continuous pulse. */}
            <span key={pollCount} className="poll-flash" aria-hidden="true" />
            Polling every {POLL_MS / 1000}s
            {lastPolledAt && <> · last updated {lastPolledAt.toLocaleTimeString()}</>}
          </p>
        )}
      </section>

      <section>
        <h2>Recent attempts ({attempts.length})</h2>
        {attempts.length === 0 ? (
          <p className="what">No attempts recorded yet.</p>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>At</th>
                  <th>Session</th>
                  <th className="num">Activity</th>
                  <th>Reference</th>
                  <th>Heard</th>
                  <th>Lang</th>
                  <th className="num">Score</th>
                  <th>Device</th>
                  <th>Mic ID</th>
                  <th>DSP granted</th>
                  <th className="num">SNR dB</th>
                  <th>Auto-stop</th>
                  <th className="num">Recorded (s)</th>
                  <th className="num">Azure ms</th>
                  <th className="num">Total ms</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a, i) => {
                  const cap = captureSignals(a.deviceContext);
                  return (
                    <tr key={i}>
                      <td>{formatAt(a.at)}</td>
                      <td>{shortSessionId(a.sessionId)}</td>
                      <td className="num">{a.activityId ?? "—"}</td>
                      <td>{a.referenceText}</td>
                      <td>{a.result.indeterminate ? "—" : a.result.recognized || "—"}</td>
                      <td>{a.language}</td>
                      <td className="num">
                        {a.result.indeterminate ? "unclear" : Math.round(a.result.accuracy)}
                      </td>
                      <td>{shortUserAgent(a.deviceContext)}</td>
                      <td>{shortDeviceId(a.deviceContext)}</td>
                      <td>{cap.granted}</td>
                      <td className="num">{cap.snrDb}</td>
                      <td>{cap.autoStopped}</td>
                      <td className="num">{a.audio.seconds.toFixed(2)}</td>
                      <td className="num">{a.timings.providerMs}</td>
                      <td className="num">{a.timings.totalMs}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>Recent diagnostics ({diagnostics.length})</h2>
        {diagnostics.length === 0 ? (
          <p className="what">No errors recorded yet.</p>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>At</th>
                  <th>Session</th>
                  <th className="num">Activity</th>
                  <th>Source</th>
                  <th>Code</th>
                  <th>Domain</th>
                  <th>Device</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics.map((d, i) => (
                  <tr key={i}>
                    <td>{formatAt(d.at)}</td>
                    <td>{shortSessionId(d.sessionId)}</td>
                    <td className="num">{d.activityId ?? "—"}</td>
                    <td>{d.source}</td>
                    <td>{d.code}</td>
                    <td>{d.domain}</td>
                    <td>{shortUserAgent(d.context)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

interface ConstraintState {
  echoCancellation?: boolean | "not reported";
  autoGainControl?: boolean | "not reported";
  noiseSuppression?: boolean | "not reported";
}

/** Pulls the VAD/SNR/DSP signals out of the free-form deviceContext blob —
    already captured on every attempt, just not surfaced here until now. */
function captureSignals(deviceContext: unknown): { granted: string; snrDb: string; autoStopped: string } {
  if (typeof deviceContext !== "object" || deviceContext === null) {
    return { granted: "—", snrDb: "—", autoStopped: "—" };
  }
  const dc = deviceContext as {
    granted?: ConstraintState;
    snrDb?: number;
    endpoint?: { autoStopped?: boolean };
  };

  const granted = dc.granted;
  const dspGranted = granted
    ? // R4/R5: "not reported" (Safari) is a real, distinct outcome — never
      // collapse it into "off".
      [granted.echoCancellation, granted.autoGainControl, granted.noiseSuppression]
        .map((v) => (v === false ? "off" : v === true ? "ON" : "?"))
        .join("/")
    : "—";

  return {
    granted: dspGranted,
    snrDb: typeof dc.snrDb === "number" ? dc.snrDb.toFixed(1) : "—",
    autoStopped: dc.endpoint?.autoStopped === undefined ? "—" : dc.endpoint.autoStopped ? "yes" : "no",
  };
}

function shortSessionId(sessionId: string | undefined): string {
  // The first 8 hex chars of the UUID are enough to visually group rows from
  // the same session without a full 36-char string dominating the table.
  return sessionId ? sessionId.slice(0, 8) : "—";
}

function shortUserAgent(context: unknown): string {
  if (typeof context !== "object" || context === null) return "—";
  // The attempts path names this field "ua" (DeviceContext), the diagnostics
  // path names it "userAgent" (server-built context) — accept either rather
  // than silently showing "—" for one of the two tables.
  const c = context as { userAgent?: unknown; ua?: unknown };
  const ua = typeof c.userAgent === "string" ? c.userAgent : typeof c.ua === "string" ? c.ua : null;
  if (!ua) return "—";
  return parseUserAgent(ua);
}

/** The mic device id (already captured in `granted`, never surfaced until
    now) — an opaque per-origin hash, not a real hardware name/serial. */
function shortDeviceId(deviceContext: unknown): string {
  if (typeof deviceContext !== "object" || deviceContext === null) return "—";
  const id = (deviceContext as { granted?: { deviceId?: string } }).granted?.deviceId;
  if (!id || id === "not reported") return "—";
  if (id === "default") return "default";
  return id.slice(0, 12);
}
