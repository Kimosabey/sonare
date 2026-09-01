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

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { parsePlatform, parseUserAgent } from "../ui/parseUserAgent.js";
import { band } from "../speech/components/band.js";
import type { PronunciationResult } from "../speech/scoring/types.js";

const TOKEN_STORAGE_KEY = "sonare.diagnosticsToken";

// Mirrors server/attempts.ts and server/diagnostics.ts — kept as separate
// client-side types rather than importing across the client/server boundary,
// same convention PronunciationResult itself already follows (PRD §6).
interface AttemptRecord {
  at: string;
  sessionId?: string;
  activityId?: number;
  learnerName?: string;
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
  learnerName?: string;
  code: string;
  domain: string;
  context?: unknown;
}

const POLL_MS = 4000;

function extractUa(deviceContext: unknown): string | null {
  if (typeof deviceContext !== "object" || deviceContext === null) return null;
  // The attempts path names this field "ua" (DeviceContext), the diagnostics
  // path names it "userAgent" (server-built context) — accept either rather
  // than silently treating one of the two as unknown.
  const c = deviceContext as { userAgent?: unknown; ua?: unknown };
  if (typeof c.userAgent === "string") return c.userAgent;
  if (typeof c.ua === "string") return c.ua;
  return null;
}

interface RankedRow {
  key: string;
  count: number;
  detail?: string;
}

interface Aggregates {
  total: number;
  scoredCount: number;
  indeterminateCount: number;
  meanScore: number | null;
  passCount: number;
  warnCount: number;
  failCount: number;
  meanAzureSeconds: number | null;
  meanTotalSeconds: number | null;
  /** From client.ts's SCORE_TIMING pings — the true tap-to-result latency,
      including network transit, not just server-internal processing time. */
  meanUploadSeconds: number | null;
  retryRate: number | null;
  byLanguage: RankedRow[];
  byPlatform: RankedRow[];
  topErrors: RankedRow[];
}

/** Reported by src/speech/scoring/client.ts after every scoring attempt —
    a timing signal, not an error, so it's read separately and excluded
    from the error-code breakdown rather than polluting it. */
const SCORE_TIMING_CODE = "SCORE_TIMING";

/**
 * Computed from whatever's currently loaded (the most recent `limit` records
 * from each endpoint) — a snapshot for spotting trends at a glance, not a
 * full-history query. Good enough for an internal live-status view; a real
 * analytics need would call for a server-side aggregation endpoint instead.
 */
function computeAggregates(attempts: AttemptRecord[], diagnostics: DiagnosticRecord[]): Aggregates {
  let scoredCount = 0;
  let indeterminateCount = 0;
  let scoreSum = 0;
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  let azureMsSum = 0;
  let totalMsSum = 0;

  const languageStats = new Map<string, { count: number; scoreSum: number; scoreCount: number }>();
  const platformCounts = new Map<string, number>();

  for (const a of attempts) {
    azureMsSum += a.timings.providerMs;
    totalMsSum += a.timings.totalMs;

    const lang = languageStats.get(a.language) ?? { count: 0, scoreSum: 0, scoreCount: 0 };
    lang.count += 1;

    if (a.result.indeterminate) {
      indeterminateCount += 1;
    } else {
      const score = a.result.accuracy;
      scoredCount += 1;
      scoreSum += score;
      lang.scoreSum += score;
      lang.scoreCount += 1;
      const b = band(score);
      if (b === "hi") passCount += 1;
      else if (b === "mid") warnCount += 1;
      else failCount += 1;
    }
    languageStats.set(a.language, lang);

    const ua = extractUa(a.deviceContext);
    const platform = ua ? parsePlatform(ua) : "?";
    platformCounts.set(platform, (platformCounts.get(platform) ?? 0) + 1);
  }

  const errorCounts = new Map<string, number>();
  let uploadMsSum = 0;
  let timingPings = 0;
  let retriedPings = 0;
  for (const d of diagnostics) {
    if (d.code === SCORE_TIMING_CODE) {
      const ctx = d.context as { uploadMs?: unknown; retryCount?: unknown } | undefined;
      if (typeof ctx?.uploadMs === "number") {
        uploadMsSum += ctx.uploadMs;
        timingPings += 1;
        if (typeof ctx.retryCount === "number" && ctx.retryCount > 0) retriedPings += 1;
      }
      continue;
    }
    errorCounts.set(d.code, (errorCounts.get(d.code) ?? 0) + 1);
  }

  const toRankedRows = (m: Map<string, number>): RankedRow[] =>
    Array.from(m.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((x, y) => y.count - x.count);

  return {
    total: attempts.length,
    scoredCount,
    indeterminateCount,
    meanScore: scoredCount ? scoreSum / scoredCount : null,
    passCount,
    warnCount,
    failCount,
    meanAzureSeconds: attempts.length ? azureMsSum / attempts.length / 1000 : null,
    meanTotalSeconds: attempts.length ? totalMsSum / attempts.length / 1000 : null,
    meanUploadSeconds: timingPings ? uploadMsSum / timingPings / 1000 : null,
    retryRate: timingPings ? retriedPings / timingPings : null,
    byLanguage: Array.from(languageStats.entries())
      .map(([key, v]) => ({
        key,
        count: v.count,
        detail: v.scoreCount ? `mean ${Math.round(v.scoreSum / v.scoreCount)}` : "unscored",
      }))
      .sort((x, y) => y.count - x.count),
    byPlatform: toRankedRows(platformCounts),
    topErrors: toRankedRows(errorCounts).slice(0, 6),
  };
}

function RankedBars({ rows }: { rows: RankedRow[] }) {
  if (rows.length === 0) return <p className="what">No data yet.</p>;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <>
      {rows.map((r) => (
        <div className="meter" key={r.key}>
          <i style={{ width: `${(r.count / max) * 100}%` }} />
          <em>
            {r.key}
            {r.detail ? ` · ${r.detail}` : ""}
          </em>
          <span>{r.count}</span>
        </div>
      ))}
    </>
  );
}

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

  const stats = useMemo(() => computeAggregates(attempts, diagnostics), [attempts, diagnostics]);
  const scoredTotal = stats.passCount + stats.warnCount + stats.failCount;

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
        <h2>Overview</h2>
        <p className="what">
          Computed from the {attempts.length} most recent attempts and {diagnostics.length} recent
          diagnostics loaded above — a snapshot, not a full-history query.
        </p>

        <div className="overall">
          <div>
            <div className="n">{stats.total}</div>
            <div className="l">attempts</div>
          </div>
          <div>
            <div className="n">{stats.meanScore === null ? "—" : Math.round(stats.meanScore)}</div>
            <div className="l">mean score</div>
          </div>
          <div>
            <div className="n">{stats.meanTotalSeconds === null ? "—" : stats.meanTotalSeconds.toFixed(2)}</div>
            <div className="l">mean latency (s)</div>
          </div>
          <div>
            <div className="n">{diagnostics.length}</div>
            <div className="l">errors logged</div>
          </div>
        </div>

        {stats.meanUploadSeconds !== null && (
          <p className="hint">
            Mean tap-to-result latency (client-measured, includes network transit):{" "}
            {stats.meanUploadSeconds.toFixed(2)}s
            {stats.retryRate !== null && stats.retryRate > 0 && (
              <> · {Math.round(stats.retryRate * 100)}% of uploads needed a retry</>
            )}
          </p>
        )}

        <label>Score bands (scored attempts only — {stats.indeterminateCount} indeterminate excluded)</label>
        {scoredTotal === 0 ? (
          <p className="what">No scored attempts yet.</p>
        ) : (
          <>
            <div className="band-bar">
              <span
                className="band-bar-seg pass"
                style={{ width: `${(stats.passCount / scoredTotal) * 100}%` }}
              />
              <span
                className="band-bar-seg warn"
                style={{ width: `${(stats.warnCount / scoredTotal) * 100}%` }}
              />
              <span
                className="band-bar-seg fail"
                style={{ width: `${(stats.failCount / scoredTotal) * 100}%` }}
              />
            </div>
            <div className="band-legend">
              <span>
                <i className="pass" /> Pass (≥80): {stats.passCount}
              </span>
              <span>
                <i className="warn" /> Warn (60–79): {stats.warnCount}
              </span>
              <span>
                <i className="fail" /> Fail (&lt;60): {stats.failCount}
              </span>
            </div>
          </>
        )}

        <label>By language</label>
        <RankedBars rows={stats.byLanguage} />

        <label>By platform</label>
        <RankedBars rows={stats.byPlatform} />

        {stats.topErrors.length > 0 && (
          <>
            <label>Top error codes</label>
            <RankedBars rows={stats.topErrors} />
          </>
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
                  <th>Learner</th>
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
                  <th className="num">Azure (s)</th>
                  <th className="num">Total (s)</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a, i) => {
                  const cap = captureSignals(a.deviceContext);
                  return (
                    <tr key={i}>
                      <td>{formatAt(a.at)}</td>
                      <td>{a.learnerName ?? "—"}</td>
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
                      <td className="num">{(a.timings.providerMs / 1000).toFixed(2)}</td>
                      <td className="num">{(a.timings.totalMs / 1000).toFixed(2)}</td>
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
                  <th>Learner</th>
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
                    <td>{d.learnerName ?? "—"}</td>
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
  const ua = extractUa(context);
  return ua ? parseUserAgent(ua) : "—";
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
