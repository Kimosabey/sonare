/**
 * T15/FR-25 — the panel that has to be on every device during the fixture run.
 *
 * R5: this is where "what iOS actually granted" becomes visible. It is not a
 * developer convenience — it is the per-recording evidence the whole POC turns
 * on, which is why it ships rather than hiding behind a build flag.
 */

import { describeConstraint } from "../capture/constraints.js";
import { parseUserAgent } from "../../ui/parseUserAgent.js";
import type { CaptureResult, GrantedConstraints } from "../capture/types.js";
import type { PronunciationResult } from "../scoring/types.js";
import { memo } from "react";

interface DebugPanelProps {
  granted: GrantedConstraints | null;
  contextSampleRate: number | null;
  capture: CaptureResult | null;
  result: PronunciationResult | null;
}

function DebugPanelBase({ granted, contextSampleRate, capture, result }: DebugPanelProps) {
  return (
    <details>
      <summary>Debug — what this device granted</summary>
      <div className="body">
        <div className="scroll-x">
        <table>
          <tbody>
            <Row label="device" value={parseUserAgent(navigator.userAgent)} />
            <Row label="user agent" value={navigator.userAgent} />
            <Row label="secure context" value={window.isSecureContext ? "yes" : "NO — mic will not open"} />
            <Row label="context rate" value={contextSampleRate ? `${contextSampleRate} Hz` : "—"} />
            <Row
              label="mic id"
              value={
                granted
                  ? granted.deviceId === "not reported" || granted.deviceId === "default"
                    ? granted.deviceId
                    : granted.deviceId.slice(0, 12)
                  : "—"
              }
            />
            <Row label="mic sample rate" value={granted ? String(granted.sampleRate) : "—"} />
            <Row label="sent as" value="16000 Hz mono PCM16" />
            <Row
              label="duration"
              value={capture ? `${capture.durationSeconds.toFixed(2)} s` : "—"}
            />
            <Row label="SNR" value={capture ? `${capture.snrDb.toFixed(1)} dB` : "—"} />
            <Row
              label="ended by"
              value={capture ? (capture.endpoint.autoStopped ? "auto (silence)" : "tap") : "—"}
            />
            <Row
              label="speech threshold"
              value={capture ? `${capture.endpoint.thresholdDb.toFixed(1)} dBFS` : "—"}
            />
            <Row
              label="noise floor"
              value={
                capture?.endpoint.noiseFloorDb == null
                  ? "—"
                  : `${capture.endpoint.noiseFloorDb.toFixed(1)} dBFS`
              }
            />
            <Row label="peak" value={capture ? `${capture.peakDbfs.toFixed(1)} dBFS` : "—"} />

            <Row
              label="gain control"
              value={granted ? describeConstraint(granted.autoGainControl) : "—"}
            />
            <Row
              label="noise suppression"
              value={granted ? describeConstraint(granted.noiseSuppression) : "—"}
            />
            <Row
              label="echo cancellation"
              value={granted ? describeConstraint(granted.echoCancellation) : "—"}
            />
            <Row
              label="granted channels"
              value={granted ? String(granted.channelCount) : "—"}
            />

            <Row label="provider" value={result?.provider ?? "—"} />
            <Row label="model version" value={result?.modelVersion ?? "not reported"} />
          </tbody>
        </table>
        </div>
        <p className="hint">
          &ldquo;not reported&rdquo; means the browser did not tell us — expected on Safari, and not
          the same as the constraint being off.
        </p>
      </div>
    </details>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{value}</td>
    </tr>
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
export const DebugPanel = memo(DebugPanelBase);
