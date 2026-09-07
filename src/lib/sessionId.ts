/**
 * A session id, grouping one learner's attempt and diagnostic records so a
 * funnel is readable (server/attempts.ts).
 *
 * A collision mislabels analysis data rather than breaking a learner's take,
 * which is why a degraded-entropy fallback is acceptable here at all — see
 * uuid.ts, which carries the insecure-context reasoning and is shared with the
 * learner id.
 */

import { newUuid } from "./uuid.js";

export function newSessionId(): string {
  return newUuid();
}
