/**
 * Fetching published content into the cache, once, in the background.
 *
 * Nothing waits on this. The resolver reads the cache synchronously, so a
 * screen renders with whatever it already has — served content from a previous
 * visit, or the bundle — and a completed fetch simply means the *next* render
 * has newer words. That is why there is no loading state anywhere: content is
 * never absent, only sometimes older.
 *
 * Deliberately not a poll. Content changes when somebody publishes, which is
 * rare, and a learner reloads far more often than that. A fetch on mount is
 * already more frequent than the thing it is watching for.
 */

import { useEffect, useRef } from "react";
import { LANGUAGES } from "../activities/languages/index.js";
import { readCachedSet, writeCachedSet } from "./cache.js";

export interface UseContentSyncOptions {
  /** Injected in tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Called once every language has been attempted. */
  onDone?: (updated: string[]) => void;
}

/**
 * Fetches one language, returning its slug if the cache changed.
 *
 * Every failure is silent and returns null: a 404 means nothing is published
 * and the bundle is correct, a network error means offline, and a malformed
 * body means a set not worth trusting. All three have the same right answer —
 * keep using what we have.
 */
async function fetchOne(slug: string, doFetch: typeof fetch): Promise<string | null> {
  try {
    const response = await doFetch(`/api/v1/content/${slug}`);
    if (!response.ok) return null;

    const set = readCachedSet(await response.json());
    if (set === null) return null;
    // Refuse a body that answers for a different language than the one asked
    // for — a misrouted response must not overwrite the wrong set.
    if (set.slug !== slug) return null;

    writeCachedSet(set);
    return slug;
  } catch {
    return null;
  }
}

export function useContentSync(options: UseContentSyncOptions = {}): void {
  /**
   * Held in a ref so a changing callback identity does not re-run the effect
   * and refetch on every render of the parent.
   */
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    let cancelled = false;

    void (async (): Promise<void> => {
      const doFetch = latest.current.fetchImpl ?? fetch;

      /**
       * All four at once. They are independent documents on an endpoint that
       * does no work, and four sequential round trips would take four times as
       * long to reach the same place — while a learner is already using the
       * app with the bundle.
       */
      const results = await Promise.all(LANGUAGES.map((set) => fetchOne(set.slug, doFetch)));

      if (cancelled) return;
      latest.current.onDone?.(results.filter((slug): slug is string => slug !== null));
    })();

    return () => {
      // The cache writes already happened; this only stops the callback firing
      // into a component that has gone.
      cancelled = true;
    };
  }, []);
}
