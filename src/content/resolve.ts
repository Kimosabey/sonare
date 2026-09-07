/**
 * The activity sets the app actually uses: served content where there is any,
 * the bundle everywhere else.
 *
 * Every screen imports from here instead of `src/activities/languages/`. That
 * indirection is the whole feature — it is what lets a phrase be corrected by
 * publishing a version rather than shipping a build, without any screen
 * knowing that content can come from two places.
 *
 * **Synchronous, deliberately.** The cache is `localStorage`, so resolving is
 * a read rather than a fetch, and no screen has to grow a loading state for
 * content it might already have. The network fetch happens separately and
 * only updates the cache; nothing ever waits on it.
 *
 * The bundle is the floor, not a legacy path. A learner who has never been
 * online, or whose storage is blocked, gets a working app with real
 * activities — which is the property that makes serving content safe to add
 * at all.
 */

import { LANGUAGES, getLanguage as bundledLanguage } from "../activities/languages/index.js";
import type { LanguageActivitySet } from "../activities/types.js";
import { readCache } from "./cache.js";

/**
 * One language, preferring served content.
 *
 * Falls back per language rather than all-or-nothing: French having a
 * published set does not mean Spanish must, and a learner who has fetched one
 * should not lose the other three.
 */
export function resolveLanguage(slug: string | undefined): LanguageActivitySet | undefined {
  const bundled = bundledLanguage(slug);
  if (slug === undefined) return bundled;

  const cached = readCache()[slug];
  if (cached === undefined) return bundled;

  /**
   * A cached set for a language the bundle has never heard of is ignored.
   *
   * Serving a new language would need routing, a picker entry and a locale the
   * capture layer supports — none of which arrive with a content document. So
   * content can correct and extend what ships; it cannot introduce a language
   * the rest of the app has no idea how to handle.
   */
  if (bundled === undefined) return undefined;

  return { slug: cached.slug, code: cached.code, label: cached.label, activities: cached.activities };
}

/**
 * Every language, in the bundle's order.
 *
 * Order comes from the bundle rather than the cache because it is display
 * order on the picker, and a learner should not see the languages rearrange
 * themselves because a fetch completed.
 */
export function resolveLanguages(): LanguageActivitySet[] {
  const cache = readCache();

  return LANGUAGES.map((bundled) => {
    const cached = cache[bundled.slug];
    if (cached === undefined) return bundled;
    return {
      slug: cached.slug,
      code: cached.code,
      label: cached.label,
      activities: cached.activities,
    };
  });
}

/** Which languages are being served rather than bundled. For diagnostics. */
export function servedVersions(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [slug, set] of Object.entries(readCache())) {
    if (bundledLanguage(slug) !== undefined) out[slug] = set.version;
  }
  return out;
}
