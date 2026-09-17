/**
 * A pupil row as the teacher's screens render it — the client's mirror of
 * `server/domain/classRoster.ts`.
 *
 * The type is duplicated across the boundary for the reason the class summary
 * already is: the server build sets `rootDir: server`, and the function that
 * *builds* these rows is the one place a pupil's accuracies are read, so it
 * belongs where they live.
 *
 * The two helpers below are here rather than there because they are not part
 * of that boundary. They read a row that already contains no figure and decide
 * how to present it — whether a device is worth mentioning, and how long since
 * somebody practised. That is a screen's judgement, and the screens are here.
 */

export interface PupilRow {
  /** A shared first name, or a positional label like "Pupil 4". Never an id. */
  label: string;
  anonymous: boolean;
  /** Days practised, most recent first. */
  days: string[];
  lastPractised: string | null;
  /** The sounds they are working on. Graphemes, never a figure. */
  workingOn: string[];
  /** Unusable takes out of total, or null when the sample is too small. */
  capture: { unusable: number; total: number } | null;
}

/**
 * The share of unusable takes at which a teacher should look at the device.
 *
 * Half. Not tuned — the number exists to separate "a couple of bad takes,
 * which everybody has" from "this microphone is not working", and anything
 * approaching half of all attempts is the second. Set lower, it would put a
 * device warning on the screen of every pupil who has ever recorded in a noisy
 * room, which is the way to make a teacher stop reading it.
 */
export const CAPTURE_CONCERN_RATIO = 0.5;

/** Whether a row's capture health is worth a teacher's attention. */
export function captureNeedsAttention(row: PupilRow): boolean {
  if (row.capture === null) return false;
  return row.capture.unusable / row.capture.total >= CAPTURE_CONCERN_RATIO;
}

/**
 * Days since a pupil last practised, or null if they never have.
 *
 * Null rather than a large number, because "has not practised in 9,000 days"
 * is what an epoch default produces and it reads as a bug rather than as a
 * pupil who has not started.
 */
export function daysSincePractice(row: PupilRow, today: Date): number | null {
  if (row.lastPractised === null) return null;
  const last = Date.parse(`${row.lastPractised}T00:00:00.000Z`);
  if (Number.isNaN(last)) return null;
  const day = Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return Math.max(0, Math.round((day - last) / 86_400_000));
}
