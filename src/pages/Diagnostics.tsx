/**
 * Internal-only screen — not part of the learner flow, reached only by
 * typing #/diagnostics directly (no nav link anywhere in the product UI).
 * Polls the read-only GET /api/v1/diagnostics and /api/v1/attempts endpoints
 * so recent activity and errors are visible without a database client.
 *
 * Token-gated server-side when DIAGNOSTICS_TOKEN is set (server/routes/
 * diagnostics.ts) — pass it once as #/diagnostics?token=... and it's
 * remembered in localStorage from then on, so you don't retype it every visit.
 *
 * Every table below is cross-everyone, which is what the "Learner lookup"
 * section exists to fix: a ticket says "it never hears me" and names one
 * person, and a most-recent-50-across-all-learners view cannot answer that
 * however long you stare at it.
 *
 * That panel is deliberately the narrowest view on the page. It shows when,
 * what failed, and the capture signals — and it does NOT show the target
 * phrase or what the learner was heard saying, because neither of those
 * separates a dead microphone from a dead provider, which is the only
 * judgment it exists to support. No audio is stored anywhere and nothing
 * here changes that.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { parsePlatform, parseUserAgent } from "../lib/parseUserAgent.js";
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
  /** The signed, anonymous id — the only field that identifies one learner
      reliably, and so the only thing the lookup below can key on. */
  learnerId?: string;
  referenceText: string;
  language: string;
  /**
   * Optional in the type because they are optional in the data. Records
   * written before a field existed, or replayed from the fallback log, do not
   * carry it — and declaring it required only moves the failure from a type
   * error to a render crash.
   */
  audio?: { seconds: number };
  timings?: { totalMs: number; providerMs: number };
  deviceContext: unknown;
  result: PronunciationResult;
}

interface DiagnosticRecord {
  at: string;
  source: "client" | "server";
  sessionId?: string;
  activityId?: number;
  learnerName?: string;
  learnerId?: string;
  code: string;
  domain: string;
  context?: unknown;
}

const POLL_MS = 4000;

/** The server's own MAX_LIST_LIMIT. One learner's whole recent trail rather
    than a window of it, since the point is not to miss the failure. */
const LOOKUP_LIMIT = 200;

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

/**
 * Mirrors server/spend.ts. Unlike everything else on this screen, these are
 * whole-history figures from a server-side aggregation rather than a sum over
 * the loaded snapshot — a spend number covering only the last 50 attempts
 * would read as a total and be wrong.
 */
interface SpendWindow {
  calls: number;
  audioSeconds: number;
  billableSeconds: number;
  indeterminateCalls: number;
  indeterminateSeconds: number;
  cost: number | null;
  indeterminateCost: number | null;
}

interface SpendReport {
  allTime: SpendWindow;
  today: SpendWindow;
  rate: { perAudioHour: number | null; currency: string };
  dailyCallCap: number;
  capUsedFraction: number | null;
}

/** Small amounts are the norm here — a whole fixture run costs cents — so
    four decimals, and never scientific notation. */
function formatMoney(value: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** Reuses the score-band colours: the cap is a budget, and running out of it
    stops scoring outright, so it earns the same fail red as a failed word. */
function capBand(fraction: number | null): string {
  if (fraction === null) return "pass";
  if (fraction >= 0.9) return "fail";
  if (fraction >= 0.6) return "warn";
  return "pass";
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
  let timedAttempts = 0;

  const languageStats = new Map<string, { count: number; scoreSum: number; scoreCount: number }>();
  const platformCounts = new Map<string, number>();

  for (const a of attempts) {
    // Same reason as the table below: a record without timings is a record
    // this screen did not write. Skipping it keeps the mean honest — adding
    // zero would drag the average toward zero in proportion to how many
    // records were malformed, which is not a latency measurement.
    if (a.timings) {
      azureMsSum += a.timings.providerMs;
      totalMsSum += a.timings.totalMs;
      timedAttempts += 1;
    }

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
    // Divided by the records that actually carried timings, not by every
    // record — otherwise one malformed row understates the latency of all of
    // them.
    meanAzureSeconds: timedAttempts ? azureMsSum / timedAttempts / 1000 : null,
    meanTotalSeconds: timedAttempts ? totalMsSum / timedAttempts / 1000 : null,
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

/**
 * The distinction a support responder cannot currently make, and the whole
 * reason the lookup exists.
 *
 * Of 139 real stored attempts, 10 came back indeterminate: 7 were the
 * recording itself — no speech in it — and 3 were the provider cancelling.
 * Those need opposite replies, "check your microphone" versus "that one was
 * on us", and both render identically as "unclear" in the attempts table. A
 * responder who cannot tell them apart for one named learner cannot answer
 * the ticket at all.
 *
 * "network" stays its own verdict rather than being folded into either: a
 * failed upload is neither a bad recording nor a bad scorer, and telling
 * someone to check their mic over a dropped connection is exactly the wrong
 * answer, arrived at confidently.
 */
export type CaptureVerdict = "scored" | "capture" | "provider" | "network" | "other";

export const VERDICT_LABEL: Record<CaptureVerdict, string> = {
  scored: "scored",
  capture: "capture — no speech to score",
  provider: "provider failed",
  network: "network",
  other: "other",
};

/**
 * Matches the capture-side `reason` strings server/services/azureSpeech.ts
 * actually produces — "no speech recognised in the recording" and "no speech
 * found to assess — every word was omitted". Everything else indeterminate is
 * the provider: it cancelled, or sent back something unusable.
 *
 * The raw reason is rendered in its own column beside the verdict, so a new
 * reason string this pattern has not learned yet stays readable next to its
 * (wrong) label rather than being quietly mislabelled with nothing left on
 * screen to show it happened.
 */
const CAPTURE_REASON = /no speech|no audio|silence|every word was omitted/i;

export function classifyIndeterminate(reason: string): CaptureVerdict {
  return CAPTURE_REASON.test(reason) ? "capture" : "provider";
}

/**
 * Diagnostics carry server/errors.ts's domain taxonomy. "client" is the
 * capture side (PERMISSION_DENIED, NO_AUDIO_ENERGY, SNR_TOO_LOW,
 * MISSING_AUDIO, AUDIO_TOO_SHORT…); server, provider and model are all "it
 * arrived and we failed it" from a responder's point of view.
 */
export function classifyDiagnostic(domain: string): CaptureVerdict {
  if (domain === "client") return "capture";
  if (domain === "network") return "network";
  if (domain === "server" || domain === "provider" || domain === "model") return "provider";
  // An unrecognised domain must not be quietly filed as a mic problem.
  return "other";
}

export interface LookupRow {
  key: string;
  at: string;
  /** Which collection this came from, i.e. whether it reached scoring. */
  kind: "attempt" | "error";
  verdict: CaptureVerdict;
  /** A reason, an error code, or a score — never the spoken phrase. */
  detail: string;
  sessionId?: string;
  activityId?: number;
  /** Recorded length, attempts only. A 0.3s take is its own diagnosis. */
  seconds: number | null;
  deviceContext: unknown;
}

export interface LearnerLookup {
  rows: LookupRow[];
  counts: Record<CaptureVerdict, number>;
  total: number;
}

/**
 * Merges one learner's attempts and diagnostics into a single time-ordered
 * story.
 *
 * Both sides are required. A capture failure that never reached the server
 * exists only as a diagnostic; an indeterminate take exists only as an
 * attempt. Reading either alone shows half the timeline, and half a timeline
 * is what makes a wrong conclusion look well-evidenced.
 */
export function buildLearnerLookup(
  attempts: AttemptRecord[],
  diagnostics: DiagnosticRecord[],
): LearnerLookup {
  const rows: LookupRow[] = [];
  const counts: Record<CaptureVerdict, number> = {
    scored: 0,
    capture: 0,
    provider: 0,
    network: 0,
    other: 0,
  };

  attempts.forEach((a, i) => {
    const verdict: CaptureVerdict = a.result.indeterminate
      ? classifyIndeterminate(a.result.reason)
      : "scored";
    counts[verdict] += 1;
    rows.push({
      key: `a${i}`,
      at: a.at,
      kind: "attempt",
      verdict,
      detail: a.result.indeterminate ? a.result.reason : `score ${Math.round(a.result.accuracy)}`,
      ...(a.sessionId ? { sessionId: a.sessionId } : {}),
      ...(a.activityId !== undefined ? { activityId: a.activityId } : {}),
      // `audio` is optional in the data, not just in the type — a record
      // replayed from the fallback log may not carry it. Null, so the row
      // shows a dash rather than claiming a zero-second recording.
      seconds: typeof a.audio?.seconds === "number" ? a.audio.seconds : null,
      deviceContext: a.deviceContext,
    });
  });

  diagnostics.forEach((d, i) => {
    // A latency ping fires on every scoring call, so left in it would
    // outnumber every real row here and bury the failure the responder came
    // to find. The same exclusion computeAggregates() already makes.
    if (d.code === SCORE_TIMING_CODE) return;
    const verdict = classifyDiagnostic(d.domain);
    counts[verdict] += 1;
    rows.push({
      key: `d${i}`,
      at: d.at,
      kind: "error",
      verdict,
      detail: d.code,
      ...(d.sessionId ? { sessionId: d.sessionId } : {}),
      ...(d.activityId !== undefined ? { activityId: d.activityId } : {}),
      seconds: null,
      deviceContext: d.context,
    });
  });

  // `at` is an ISO string on both sides, so lexicographic ordering is already
  // chronological — no Date parsing needed to interleave the two lists.
  rows.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));

  return { rows, counts, total: rows.length };
}

export interface LearnerChip {
  learnerId: string;
  /** Whatever they typed on the language picker, if anything. */
  name: string | null;
}

/**
 * The learners present in whatever the live poll has already loaded, offered
 * as one-click chips.
 *
 * Discovery matters as much as the query here: the lookup keys on a UUID, and
 * nobody is going to read one off a support ticket. Clicking a chip is how a
 * responder gets from a name to the right id — including when two learners
 * typed the same name, which is the case a name-keyed lookup would silently
 * merge and this one keeps as two chips.
 */
export function knownLearners(attempts: AttemptRecord[], diagnostics: DiagnosticRecord[]): LearnerChip[] {
  const byId = new Map<string, string | null>();
  const note = (learnerId: string | undefined, name: string | undefined) => {
    if (!learnerId) return;
    // First name wins, but never let a later anonymous record erase one.
    const existing = byId.get(learnerId);
    byId.set(learnerId, existing ?? name ?? null);
  };
  for (const a of attempts) note(a.learnerId, a.learnerName);
  for (const d of diagnostics) note(d.learnerId, d.learnerName);

  return Array.from(byId.entries())
    .map(([learnerId, name]) => ({ learnerId, name }))
    .sort((x, y) => (x.name ?? "").localeCompare(y.name ?? "") || x.learnerId.localeCompare(y.learnerId));
}

/**
 * Records in the snapshot that no lookup can ever reach.
 *
 * Scoring works without an identity on purpose, so an unregistered learner's
 * failures carry no `learnerId` and belong to nobody findable. Saying how
 * many there are is the difference between a responder concluding "she has no
 * failures" and "her failures may not be attributable" — the second is true
 * and the first is what an unlabelled empty result implies.
 */
export function unattributedCount(attempts: AttemptRecord[], diagnostics: DiagnosticRecord[]): number {
  return (
    attempts.filter((a) => !a.learnerId).length +
    diagnostics.filter((d) => !d.learnerId && d.code !== SCORE_TIMING_CODE).length
  );
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
/**
 * A duration in seconds, or a dash when the record does not carry one. A dash
 * rather than 0.00, which would claim a measurement of zero where there was no
 * measurement at all — the same distinction R8 draws about scores.
 */
function secondsOrDash(value: number | undefined, divisor = 1): string {
  return typeof value === "number" && Number.isFinite(value) ? (value / divisor).toFixed(2) : "—";
}

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

  // `idInput` is what is typed; `lookupId` is what has been submitted, and
  // only the second reaches the server — so a responder mid-paste does not
  // fire a query per keystroke against a named person's records.
  const [idInput, setIdInput] = useState("");
  const [lookupId, setLookupId] = useState<string | null>(null);
  const [lookupData, setLookupData] = useState<{
    attempts: AttemptRecord[];
    diagnostics: DiagnosticRecord[];
  } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupPending, setLookupPending] = useState(false);

  // A token in the URL wins and is remembered; otherwise fall back to
  // whatever was remembered from a previous visit. Neither may exist if
  // DIAGNOSTICS_TOKEN isn't set server-side — that's fine, the server
  // only checks the header when it has something to check it against.
  const [spend, setSpend] = useState<SpendReport | null>(null);

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
        const [attemptsRes, diagnosticsRes, spendRes] = await Promise.all([
          fetch("/api/v1/attempts?limit=50", { headers }),
          fetch("/api/v1/diagnostics?limit=50", { headers }),
          fetch("/api/v1/spend", { headers }),
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
        // Non-fatal on its own: spend is an extra, and a Mongo aggregation
        // failing should not blank the whole screen the way a failed attempts
        // fetch legitimately does.
        setSpend(spendRes.ok ? ((await spendRes.json()) as SpendReport) : null);
        setLastPolledAt(new Date());
        setPollCount((n) => n + 1);
        setError(null);
      } catch {
        if (!cancelled) setError("Couldn’t reach the diagnostics API — is the server (and MongoDB) up?");
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  /**
   * A one-shot fetch, deliberately not folded into the 4s poll.
   *
   * A lookup answers one ticket. Re-pulling one named person's whole trail
   * every four seconds for as long as the tab happens to be open is more of
   * their data moving around, and sitting in more memory, than the question
   * needs — and the answer does not change while you read it.
   *
   * `lookupId` lives in component state and stays out of the URL: a
   * shareable link to one learner's failures puts them into browser history,
   * the referrer and every pasted link, which the token already in that URL
   * does nothing to justify.
   */
  useEffect(() => {
    if (!lookupId) {
      setLookupData(null);
      setLookupError(null);
      return;
    }

    let cancelled = false;
    const headers: HeadersInit = token ? { "x-diagnostics-token": token } : {};
    const query = `learnerId=${encodeURIComponent(lookupId)}&limit=${LOOKUP_LIMIT}`;
    setLookupPending(true);

    const run = async () => {
      try {
        const [attemptsRes, diagnosticsRes] = await Promise.all([
          fetch(`/api/v1/attempts?${query}`, { headers }),
          fetch(`/api/v1/diagnostics?${query}`, { headers }),
        ]);
        if (cancelled) return;

        if (attemptsRes.status === 401 || diagnosticsRes.status === 401) {
          setLookupData(null);
          setLookupError("This server requires a diagnostics token. Add ?token=... to the URL once.");
          return;
        }
        // The server refuses anything that is not a learner id rather than
        // falling back to an unfiltered read, so say which it was — a
        // responder who pasted a display name needs to know that, not an
        // empty table that looks like an answer.
        if (attemptsRes.status === 400 || diagnosticsRes.status === 400) {
          setLookupData(null);
          setLookupError("That is not a learner id. Pick a learner below rather than typing a name.");
          return;
        }
        if (!attemptsRes.ok || !diagnosticsRes.ok) throw new Error("request failed");

        const attemptsBody = (await attemptsRes.json()) as { records: AttemptRecord[] };
        const diagnosticsBody = (await diagnosticsRes.json()) as { records: DiagnosticRecord[] };
        if (cancelled) return;
        setLookupData({ attempts: attemptsBody.records, diagnostics: diagnosticsBody.records });
        setLookupError(null);
      } catch {
        if (!cancelled) {
          setLookupData(null);
          setLookupError("Couldn’t reach the diagnostics API — is the server (and MongoDB) up?");
        }
      } finally {
        if (!cancelled) setLookupPending(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [token, lookupId]);

  const stats = useMemo(() => computeAggregates(attempts, diagnostics), [attempts, diagnostics]);
  const scoredTotal = stats.passCount + stats.warnCount + stats.failCount;
  const learners = useMemo(() => knownLearners(attempts, diagnostics), [attempts, diagnostics]);
  const unattributed = useMemo(() => unattributedCount(attempts, diagnostics), [attempts, diagnostics]);
  const lookup = useMemo(
    () => (lookupData ? buildLearnerLookup(lookupData.attempts, lookupData.diagnostics) : null),
    [lookupData],
  );

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
        <h2>Learner lookup</h2>
        <p className="what">
          One ticket, one person. Keyed on the learner id rather than the name — two learners can
          type the same name, and merging their trails is how a responder ends up confidently
          blaming the wrong microphone.
        </p>

        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setLookupId(idInput.trim() || null);
          }}
        >
          <input
            aria-label="Learner id"
            placeholder="Learner id"
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
            style={{ flex: "1 1 240px", width: "auto" }}
          />
          <button type="submit" disabled={idInput.trim() === ""}>
            Look up
          </button>
          {lookupId !== null && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setIdInput("");
                setLookupId(null);
              }}
            >
              Clear
            </button>
          )}
        </form>

        {learners.length > 0 && (
          <>
            <label>Learners in the loaded snapshot</label>
            <div className="row" style={{ marginTop: 0 }}>
              {learners.map((l) => (
                <button
                  key={l.learnerId}
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setIdInput(l.learnerId);
                    setLookupId(l.learnerId);
                  }}
                >
                  {l.name ?? "(no name)"} · {l.learnerId.slice(0, 8)}
                </button>
              ))}
            </div>
          </>
        )}

        {unattributed > 0 && (
          <p className="hint">
            {unattributed} of the loaded records carry no learner id and no lookup can reach them.
            Scoring works without registering on purpose, so those failures belong to nobody
            findable — an empty result here means “not attributable”, not “nothing went wrong”.
          </p>
        )}

        {lookupError && (
          <p className="what" style={{ color: "var(--fail)", marginTop: 12 }}>
            {lookupError}
          </p>
        )}

        {lookupId !== null && !lookupError && (
          <>
            <label>
              {lookupId.slice(0, 8)}
              {lookupPending ? " · loading…" : ""}
            </label>
            {lookup === null ? null : lookup.total === 0 ? (
              <p className="what">
                No records for that learner in the last {LOOKUP_LIMIT}. Either nothing has failed
                for them, or their records predate the retention window.
              </p>
            ) : (
              <>
                <div className="overall">
                  <div>
                    <div className="n">{lookup.total}</div>
                    <div className="l">records</div>
                  </div>
                  <div>
                    <div className="n">{lookup.counts.scored}</div>
                    <div className="l">scored</div>
                  </div>
                  <div>
                    <div className="n">{lookup.counts.capture}</div>
                    <div className="l">capture</div>
                  </div>
                  <div>
                    <div className="n">{lookup.counts.provider}</div>
                    <div className="l">provider</div>
                  </div>
                </div>

                <p className="hint">
                  <strong>Capture</strong> means the recording had no speech in it — muted or
                  blocked mic, or nothing said. The answer is about their device.{" "}
                  <strong>Provider</strong> means the recording reached the scorer and the scorer
                  failed or cancelled. The answer is “that one was on us”.
                  {(lookup.counts.network > 0 || lookup.counts.other > 0) && (
                    <>
                      {" "}
                      Also {lookup.counts.network} network and {lookup.counts.other} unclassified,
                      neither of which is a microphone problem.
                    </>
                  )}
                </p>

                <div className="scroll-x">
                  <table>
                    <thead>
                      <tr>
                        <th>At</th>
                        {/* Whether this failure ever reached a scoring call —
                            an "error" row often never left the device. */}
                        <th>Record</th>
                        <th>Verdict</th>
                        <th>Detail</th>
                        <th>Session</th>
                        <th className="num">Activity</th>
                        <th>Device</th>
                        <th>Mic ID</th>
                        <th>DSP granted</th>
                        <th className="num">SNR dB</th>
                        <th>Auto-stop</th>
                        <th className="num">Recorded (s)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lookup.rows.map((r) => {
                        const cap = captureSignals(r.deviceContext);
                        return (
                          <tr key={r.key}>
                            <td>{formatAt(r.at)}</td>
                            <td>{r.kind}</td>
                            <td>{VERDICT_LABEL[r.verdict]}</td>
                            <td>{r.detail}</td>
                            <td>{shortSessionId(r.sessionId)}</td>
                            <td className="num">{r.activityId ?? "—"}</td>
                            <td>{shortUserAgent(r.deviceContext)}</td>
                            <td>{shortDeviceId(r.deviceContext)}</td>
                            <td>{cap.granted}</td>
                            <td className="num">{cap.snrDb}</td>
                            <td>{cap.autoStopped}</td>
                            <td className="num">{secondsOrDash(r.seconds ?? undefined)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
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

      </section>

      <section>
        <h2>Provider spend</h2>
        {spend === null ? (
          <p className="what">Spend aggregation unavailable — is MongoDB reachable?</p>
        ) : (
          <>
            <p className="what">
              Whole history within the retention window, from a server-side aggregation — not the
              snapshot above. Every scored attempt is one billed provider call.
            </p>

            <div className="overall">
              <div>
                <div className="n">{spend.allTime.calls}</div>
                <div className="l">calls all-time</div>
              </div>
              <div>
                <div className="n">{spend.today.calls}</div>
                <div className="l">calls today</div>
              </div>
              <div>
                {/* Billable, not raw: the provider rounds each request up to a
                    whole second, so summing durations understates the bill. */}
                <div className="n">{spend.allTime.billableSeconds}</div>
                <div className="l">billable seconds</div>
              </div>
              <div>
                <div className="n">
                  {spend.allTime.cost === null ? "—" : formatMoney(spend.allTime.cost, spend.rate.currency)}
                </div>
                <div className="l">cost all-time</div>
              </div>
            </div>

            {spend.rate.perAudioHour === null ? (
              <p className="hint">
                No rate configured, so only usage is shown. Set{" "}
                <code>AZURE_SPEECH_RATE_PER_AUDIO_HOUR</code> to see cost — deliberately unset by
                default, because a wrong rate displayed as money is worse than no money at all.
              </p>
            ) : (
              <p className="hint">
                At {formatMoney(spend.rate.perAudioHour, spend.rate.currency)} per audio-hour ·{" "}
                {spend.allTime.audioSeconds}s of audio sent, {spend.allTime.billableSeconds}s billed
                after the per-request round-up
                {spend.today.cost !== null && (
                  <> · {formatMoney(spend.today.cost, spend.rate.currency)} today</>
                )}
              </p>
            )}

            {spend.allTime.indeterminateCalls > 0 && (
              <p className="hint">
                {spend.allTime.indeterminateCalls} of those calls returned no score and were billed
                the same
                {spend.allTime.indeterminateCost !== null && (
                  <> — {formatMoney(spend.allTime.indeterminateCost, spend.rate.currency)}</>
                )}
                . Not a bug: an indeterminate result is the honest answer. It is spend that bought no
                learner feedback, which is the figure to watch when a fixture run costs more than
                expected.
              </p>
            )}

            <label>
              Daily cap — {spend.today.calls} of {spend.dailyCallCap} calls used
            </label>
            <div className="band-bar">
              <span
                className={`band-bar-seg ${capBand(spend.capUsedFraction)}`}
                style={{ width: `${(spend.capUsedFraction ?? 0) * 100}%` }}
              />
            </div>
            <p className="hint">
              Counted from MongoDB rather than the in-process counter, so it survives a restart. The
              cap bounds total spend regardless of how many callers it is spread across.
            </p>
          </>
        )}
      </section>

      <section>
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
                      {/*
                        Guarded, even though the types above declare these
                        required. They are a claim about documents this screen
                        did not write: records replayed from the fallback log,
                        or written before a field existed. `ScoredWord.
                        syllables` taught this lesson once already — a type
                        cannot make a promise about JSON that predates it, and
                        one malformed record here throws during render and
                        blanks the whole dashboard, which is the screen someone
                        opened *because* something was wrong.
                      */}
                      <td className="num">{secondsOrDash(a.audio?.seconds)}</td>
                      <td className="num">{secondsOrDash(a.timings?.providerMs, 1000)}</td>
                      <td className="num">{secondsOrDash(a.timings?.totalMs, 1000)}</td>
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
