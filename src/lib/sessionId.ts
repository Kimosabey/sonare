/**
 * A session id that survives an insecure context.
 *
 * `crypto.randomUUID()` is secure-context-only. On `http://<lan-ip>:5180` —
 * the exact URL the README's on-device testing section sends you to — it is
 * `undefined`, so calling it during render threw `crypto.randomUUID is not a
 * function` and took the whole screen down through main.tsx's ErrorBoundary.
 * That failure was actively misleading: the real problem is the origin, but
 * the app died before the capture layer's own INSECURE_CONTEXT message
 * ("Recording needs a secure connection (HTTPS)") could say so.
 *
 * `crypto.getRandomValues()` carries no such restriction — it is available and
 * working on a plain-HTTP LAN origin (verified in Chrome: `isSecureContext
 * false`, `randomUUID undefined`, `getRandomValues function`) — so a real
 * RFC 4122 v4 UUID is still cheap to build by hand.
 *
 * `Math.random()` is the last resort only. A session id groups attempt and
 * diagnostic records for funnel analysis (server/attempts.ts), so a collision
 * mislabels analysis data rather than breaking a learner's take — but real
 * entropy is free wherever the API exists, so we only degrade when it doesn't.
 */

function randomBytes16(): Uint8Array {
  const bytes = new Uint8Array(16);
  const c = typeof crypto !== "undefined" ? crypto : undefined;

  if (typeof c?.getRandomValues === "function") {
    c.getRandomValues(bytes);
    return bytes;
  }

  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export function newSessionId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (typeof c?.randomUUID === "function") return c.randomUUID();

  const bytes = randomBytes16();

  // RFC 4122 §4.4 — pin the version (4) and variant (10xx) nibbles. Read via
  // `?? 0` rather than `!` because noUncheckedIndexedAccess types a typed-array
  // read as possibly-undefined; a fixed-length Uint8Array never actually is.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
