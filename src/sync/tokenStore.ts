/**
 * The signed token that authorises a sync, and getting one.
 *
 * The learner id is minted locally and authorises nothing (learnerId.ts). The
 * server signs it and returns a token; that token is the credential. This
 * module holds it and re-registers when there is none.
 *
 * Registration is idempotent on the server — the same id posted twice returns
 * a fresh token for the same learner — so losing the token costs a round trip
 * rather than an identity. That is what makes it safe to simply re-register
 * whenever storage comes back empty.
 */

import { ensureLearnerId } from "../lib/learnerId.js";

const SCHEMA_VERSION = "v1";

/**
 * Keyed by learner, following learnerId.ts.
 *
 * A single token per browser would defeat the per-learner id entirely: the
 * second learner on a shared device would present the first learner's
 * credential and be merged straight back into their record.
 */
function storageKey(learnerName: string | null): string {
  return `sonare.sync.token.${SCHEMA_VERSION}.${learnerName ?? "anonymous"}`;
}

/**
 * Held in memory as well, so a session where storage is blocked still makes
 * exactly one registration call instead of one per sync.
 */
const inMemory = new Map<string, string>();

/** Three dot-separated parts. Not verified here — only the server can do that. */
const TOKEN_SHAPE = /^[^.]+\.[^.]+\.[^.]+$/;

export function readToken(learnerName: string | null): string | null {
  const key = storageKey(learnerName);
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null && TOKEN_SHAPE.test(raw)) return raw;
  } catch {
    // Storage disabled. Fall through to this session's copy.
  }
  return inMemory.get(key) ?? null;
}

export function saveToken(learnerName: string | null, token: string): void {
  const key = storageKey(learnerName);
  inMemory.set(key, token);
  try {
    localStorage.setItem(key, token);
  } catch {
    // Quota or private browsing. The token holds for this session.
  }
}

export function clearToken(learnerName: string | null): void {
  const key = storageKey(learnerName);
  inMemory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Best effort.
  }
}

export interface RegisterOptions {
  displayName?: string | null;
  locale?: string;
  /** Injected in tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * Registers this device's learner id and stores the token it is given.
 *
 * Returns null on any failure — network, a 4xx, an unparseable body, identity
 * being disabled server-side. Never throws, because every caller is on a path
 * where the learner is doing something else and sync is the background task.
 */
export async function register(options: RegisterOptions = {}): Promise<string | null> {
  const learnerName = options.displayName ?? null;
  const learnerId = ensureLearnerId(learnerName);
  const doFetch = options.fetchImpl ?? fetch;

  try {
    const response = await doFetch("/api/v1/learners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        learnerId,
        // Only sent when there is one. The server treats an absent name as
        // "leave what you have" rather than "clear it".
        ...(options.displayName != null && options.displayName !== ""
          ? { displayName: options.displayName }
          : {}),
        ...(options.locale !== undefined ? { locale: options.locale } : {}),
      }),
    });

    if (!response.ok) return null;

    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== "string" || !TOKEN_SHAPE.test(body.token)) return null;

    saveToken(learnerName, body.token);
    return body.token;
  } catch {
    // Offline, blocked, aborted. Sync simply does not happen this time.
    return null;
  }
}

/** The stored token, registering for one if there is none. */
export async function ensureToken(options: RegisterOptions = {}): Promise<string | null> {
  return readToken(options.displayName ?? null) ?? (await register(options));
}
