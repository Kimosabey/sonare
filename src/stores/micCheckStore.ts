/**
 * The last sound check's verdict, so the first activity can say something
 * true about an unclear take instead of leaving the learner to guess.
 *
 * Board 1m: the check's result travels with the learner as one quiet line.
 * Passed, and an unclear result is the take rather than their setup — which is
 * worth knowing, because a learner whose first take comes back indeterminate
 * otherwise concludes the app cannot hear them. Quiet, and the same line says
 * *that* instead, so the unclear result is already half-explained.
 *
 * ## What is kept, and what deliberately is not
 *
 * The verdict, the device label the browser reported, and when. **No audio, no
 * levels, no sample.** The check's own screen promises that nothing it hears
 * leaves the device or is kept, and a store that quietly retained a waveform
 * would make that promise false — so this holds only what the screen already
 * showed the learner about their own setup.
 *
 * Per learner, like the streak, because a shared tablet has one microphone and
 * several people: the device is common but "did *your* check pass" is not the
 * same question as "did anyone's".
 *
 * ## Why it expires
 *
 * A verdict is about a device in a room at a moment. A month later the learner
 * is somewhere else, possibly on other headphones, and a line saying "your
 * check passed" would be an assurance based on nothing. Stale is treated as
 * absent, which renders no line at all — the honest answer when the app has
 * not measured anything recently.
 */

import type { CheckVerdict } from "../speech/capture/micCheck.js";

/** In the key, so a bump orphans old data rather than misreading it. */
const SCHEMA_VERSION = "v1";

/**
 * How long a verdict is worth repeating.
 *
 * Fourteen days is roughly a fortnight of the same commute and the same
 * kitchen table. Beyond it the claim is about a setup the learner may not be
 * using any more, and an assurance that is merely probably true is worse than
 * silence — it is exactly the sentence that stops someone re-running a check
 * they should.
 */
export const VERDICT_TTL_DAYS = 14;

export interface StoredCheck {
  verdict: CheckVerdict;
  /** What the browser called the input, or null when it reported no label. */
  deviceLabel: string | null;
  /** ISO timestamp of the check. */
  at: string;
}

function storageKey(learnerName: string | null): string {
  return `sonare.micCheck.${SCHEMA_VERSION}.${learnerName ?? "anonymous"}`;
}

function isVerdict(value: unknown): value is CheckVerdict {
  return value === "good" || value === "quiet" || value === "silent";
}

/**
 * The stored verdict, or null when there is none or it has expired.
 *
 * Null for anything unreadable, on purpose. A malformed record is not worth
 * repairing — the check takes a few seconds to re-run, and a half-restored
 * verdict would be a claim about a device nobody measured.
 */
export function readCheck(
  learnerName: string | null,
  now: Date = new Date(),
): StoredCheck | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(learnerName));
  } catch {
    // Private browsing, or storage disabled. No verdict is a valid state.
    return null;
  }
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<StoredCheck>;
    if (!isVerdict(parsed.verdict) || typeof parsed.at !== "string") return null;

    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime())) return null;

    const ageDays = (now.getTime() - at.getTime()) / 86_400_000;
    // Negative ages happen: a device clock moved backwards, or the record was
    // written in another timezone's future. Treated as stale rather than
    // trusted, since neither is a measurement of now.
    if (ageDays < 0 || ageDays > VERDICT_TTL_DAYS) return null;

    return {
      verdict: parsed.verdict,
      deviceLabel: typeof parsed.deviceLabel === "string" ? parsed.deviceLabel : null,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

export function writeCheck(
  learnerName: string | null,
  check: Omit<StoredCheck, "at"> & { at?: string },
): void {
  const record: StoredCheck = {
    verdict: check.verdict,
    deviceLabel: check.deviceLabel,
    at: check.at ?? new Date().toISOString(),
  };
  try {
    localStorage.setItem(storageKey(learnerName), JSON.stringify(record));
  } catch {
    // Full, or disabled. The check still told the learner its verdict on the
    // screen they were looking at; only the reminder is lost.
  }
}

/** Forgets the verdict — used when a learner's record is erased. */
export function clearCheck(learnerName: string | null): void {
  try {
    localStorage.removeItem(storageKey(learnerName));
  } catch {
    // Nothing to do, and nothing depends on it having worked.
  }
}
