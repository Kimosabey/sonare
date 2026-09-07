/**
 * Every migration, in the order it runs.
 *
 * Empty, and that is the honest state: every collection here was introduced
 * with its current shape, so there is nothing yet to migrate. The runner
 * exists ahead of the first migration deliberately — the moment one is needed
 * is the worst moment to be writing the machinery for it, and a learner's
 * server-side record cannot be orphaned by a version bump the way a
 * localStorage key can.
 *
 * To add one: append `{ id: "0001-what-it-does", description, up }` with a
 * four-digit prefix one higher than the last, keep the list sorted, and make
 * `up` safe to run twice — the runner records each success as it goes, but a
 * process killed between the write and the record will run it again.
 */

import type { Migration } from "./index.js";

export const MIGRATIONS: Migration[] = [];
