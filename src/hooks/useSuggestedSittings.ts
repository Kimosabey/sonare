/**
 * What a learner's classes have suggested, if any.
 *
 * Fetched rather than synced, and failing quietly on purpose. A class
 * suggestion is an extra prompt on Today, so a learner who is offline, in no
 * class, or whose server is down sees the screen they would have seen anyway.
 * Nothing here is allowed to be the reason Today does not render.
 */

import { useEffect, useState } from "react";
import { readToken } from "../sync/tokenStore.js";

export interface SuggestedSitting {
  classId: string;
  className: string;
  teacherName: string;
  slug: string;
  lessonId: number;
  /** One of the three windows a teacher chose. Never a date. */
  window: string;
}

export function useSuggestedSittings(learnerName: string | null): SuggestedSitting[] {
  const [suggestions, setSuggestions] = useState<SuggestedSitting[]>([]);

  useEffect(() => {
    const token = readToken(learnerName);
    // No credential means no class, because joining one is what mints it.
    if (token === null) {
      setSuggestions([]);
      return;
    }

    let live = true;
    void (async () => {
      try {
        const response = await fetch("/api/v1/classes/mine/suggestions", {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) return;

        const body = (await response.json()) as { suggestions?: unknown };
        if (!live || !Array.isArray(body.suggestions)) return;

        // Read defensively: each field is checked rather than trusted, because
        // a half-formed suggestion would render as a prompt from nobody.
        const usable: SuggestedSitting[] = [];
        for (const raw of body.suggestions as unknown[]) {
          const s = raw as Partial<SuggestedSitting>;
          if (
            typeof s.classId !== "string" ||
            typeof s.className !== "string" ||
            typeof s.teacherName !== "string" ||
            typeof s.slug !== "string" ||
            typeof s.lessonId !== "number" ||
            typeof s.window !== "string"
          ) {
            continue;
          }
          usable.push({
            classId: s.classId,
            className: s.className,
            teacherName: s.teacherName,
            slug: s.slug,
            lessonId: s.lessonId,
            window: s.window,
          });
        }
        setSuggestions(usable);
      } catch {
        // Offline, or no server. Today renders without this.
      }
    })();

    return () => {
      live = false;
    };
  }, [learnerName]);

  return suggestions;
}
