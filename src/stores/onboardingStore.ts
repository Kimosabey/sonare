/**
 * Whether this learner has been through onboarding.
 *
 * One flag, and it exists for one reason: the first-run flow has to be shown
 * **once**. Without a record of having seen it, any redirect into it is either
 * a loop — a learner who skips is sent straight back — or it fires on every
 * visit until they happen to finish a phrase.
 *
 * ## Why not infer it from progress
 *
 * "Has practised anything" looks like the same question and is not. A learner
 * who reads the microphone explanation and taps *"Not yet — start with
 * listening only"* has been onboarded and has no progress; sending them back
 * through it would ignore the answer they just gave. The two facts are
 * different and only one of them is about onboarding.
 *
 * Per learner, like everything else on a shared device: a family tablet
 * onboards each person the first time they use it, because the explanation of
 * what happens to a recording is owed to each of them, not to the device.
 */

/** In the key, so a bump re-onboards rather than misreading an old flag. */
const SCHEMA_VERSION = "v1";

function storageKey(learnerName: string | null): string {
  return `sonare.onboarded.${SCHEMA_VERSION}.${learnerName ?? "anonymous"}`;
}

/**
 * True when this learner has been through it.
 *
 * Any failure reads as **true** — the opposite of the usual fail-closed
 * posture, and deliberate. If storage is unavailable (private browsing, a
 * blocked origin) a false answer would redirect into onboarding on every
 * single navigation, which is a loop with no way out. Missing the explanation
 * once is recoverable; a trap is not.
 */
export function hasOnboarded(learnerName: string | null): boolean {
  try {
    return localStorage.getItem(storageKey(learnerName)) !== null;
  } catch {
    return true;
  }
}

/** Recorded when the learner leaves onboarding — by either route. */
export function markOnboarded(learnerName: string | null): void {
  try {
    localStorage.setItem(storageKey(learnerName), new Date().toISOString());
  } catch {
    // Nothing depends on it having worked: `hasOnboarded` reads a failure as
    // "already onboarded", so the worst case is the flow is not shown again.
  }
}

/** Forgotten when a learner's record is erased, so a fresh start is fresh. */
export function clearOnboarded(learnerName: string | null): void {
  try {
    localStorage.removeItem(storageKey(learnerName));
  } catch {
    // Nothing to do.
  }
}
