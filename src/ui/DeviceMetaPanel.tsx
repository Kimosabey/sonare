/**
 * Home-page transparency panel: exactly what Sonare can see about this
 * device before any microphone permission is granted. Requested so a visitor
 * (or the person testing on their own phone) can confirm what's captured
 * without having to open #/diagnostics or make an attempt first.
 *
 * Deliberately mic-free — DebugPanel (src/speech/components/DebugPanel.tsx)
 * covers the capture-time signals (granted DSP constraints, SNR, mic id)
 * that only exist after a recording; this is the subset visible on load.
 */

import { parseUserAgent } from "./parseUserAgent.js";
import { useOnlineStatus } from "./useOnlineStatus.js";

interface NetworkInformation {
  effectiveType?: string;
}

export function DeviceMetaPanel() {
  const online = useOnlineStatus();
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;

  return (
    <details>
      <summary>What Sonare can see about this device</summary>
      <div className="body">
        <div className="scroll-x">
          <table>
            <tbody>
              <Row label="device" value={parseUserAgent(navigator.userAgent)} />
              <Row label="user agent" value={navigator.userAgent} />
              <Row label="screen" value={`${screen.width}×${screen.height} @${window.devicePixelRatio}x`} />
              <Row label="viewport" value={`${window.innerWidth}×${window.innerHeight}`} />
              <Row label="language" value={navigator.language} />
              <Row label="connection" value={connection?.effectiveType ?? "not reported"} />
              <Row label="online" value={online ? "yes" : "NO — recordings can't be scored"} />
              <Row label="secure context" value={window.isSecureContext ? "yes" : "NO — mic will not open"} />
            </tbody>
          </table>
        </div>
        <p className="hint">
          Nothing here is collected until you start an activity and grant microphone access — this
          is only what your browser already reports on page load.
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
