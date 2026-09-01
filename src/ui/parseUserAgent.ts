/**
 * Browser/platform detection has to check the most-specific tokens first —
 * Chromium derivatives (Edge, Samsung Internet, Opera, Chrome-on-iOS) all
 * embed "Chrome" or "Safari" in their UA string for compatibility, so a
 * single leftmost-match check misidentifies most of them. Verified against
 * real UA strings for Edge, Chrome-iOS (CriOS), and Samsung Internet before
 * fixing — all three silently showed as "Chrome" or "Safari" under a naive
 * check.
 *
 * No browser exposes a human-readable device name ("Harshan's iPhone",
 * "Realtek Audio") to a website — that's deliberate fingerprinting
 * protection, not a gap here. Platform + OS version + browser + browser
 * version is the most identifying information actually available.
 *
 * Shared between the Debug Panel (src/speech/components/DebugPanel.tsx,
 * visible on the activity page for every recording) and the internal
 * #/diagnostics screen (src/pages/Diagnostics.tsx) — same parsing, two
 * places it needs to show up.
 */
/** Just the coarse platform token, e.g. for grouping attempts by device family. */
export function parsePlatform(ua: string): string {
  return /iPhone|iPad|Android|Windows|Macintosh/.exec(ua)?.[0] ?? "?";
}

export function parseUserAgent(ua: string): string {
  const platform = parsePlatform(ua);

  const platformVersion =
    /(?:iPhone|iPad) OS ([\d_]+)/.exec(ua)?.[1]?.replace(/_/g, ".") ??
    /Android ([\d.]+)/.exec(ua)?.[1] ??
    /Windows NT ([\d.]+)/.exec(ua)?.[1] ??
    /Mac OS X ([\d_]+)/.exec(ua)?.[1]?.replace(/_/g, ".") ??
    null;

  const [browser, browserVersion] = (() => {
    let m;
    if ((m = /Edg(?:iOS)?\/([\d.]+)/.exec(ua))) return ["Edge", m[1]];
    if ((m = /SamsungBrowser\/([\d.]+)/.exec(ua))) return ["Samsung Internet", m[1]];
    if ((m = /OPR\/([\d.]+)/.exec(ua))) return ["Opera", m[1]];
    // Chrome on iOS — Apple requires WebKit underneath, but it's still Chrome.
    if ((m = /CriOS\/([\d.]+)/.exec(ua))) return ["Chrome", m[1]];
    if ((m = /(?:FxiOS|Firefox)\/([\d.]+)/.exec(ua))) return ["Firefox", m[1]];
    if ((m = /Chrome\/([\d.]+)/.exec(ua))) return ["Chrome", m[1]];
    // Safari's real version is "Version/X.Y", not the WebKit build number
    // after "Safari/" — those two are unrelated numbers.
    if ((m = /Version\/([\d.]+).*Safari\//.exec(ua))) return ["Safari", m[1]];
    if (ua.includes("Safari/")) return ["Safari", null];
    return ["?", null];
  })();

  const majorVersion = browserVersion?.split(".")[0] ?? null;
  const platformLabel = platformVersion ? `${platform} ${platformVersion}` : platform;
  const browserLabel = majorVersion ? `${browser} ${majorVersion}` : browser;
  return `${platformLabel} · ${browserLabel}`;
}
