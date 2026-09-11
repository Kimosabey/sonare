/**
 * Sonare's service worker. A classic worker, plain JS, served verbatim out of
 * `public/` — no build step, no plugin, no new dependency.
 *
 * ## What this does NOT have to do
 *
 * It does not have to make the app work offline. The app is already
 * offline-first at the data layer: progress, skills and streak are written to
 * local storage and reconciled in the background (src/sync/), and a whole
 * session — record, score, report — completes with no network today. So the
 * only thing missing offline is the *delivery*: the shell that boots the app
 * and the model-voice audio a learner listens back to.
 *
 * That is why runtime caching is enough here, and why there is no build-time
 * precache manifest. Generating one would mean knowing Vite's content hashes
 * at build time, which is the part that needs a plugin.
 *
 * ## The trade, stated rather than glossed
 *
 * With runtime caching only, **the first offline visit requires a prior online
 * load.** Nothing is in any cache until it has been fetched once. That is
 * acceptable because the app cannot be used at all without a first load —
 * there is no install media, no bundled copy, nothing to fall back to. A
 * precache manifest would move the line from "one prior load" to "zero", and
 * the app still could not be *installed* without that load.
 *
 * ## Four caches, one version, one job each
 *
 * Split by lifetime and by eviction policy rather than lumped together, so no
 * cap can evict something another strategy depends on. In particular the
 * navigation document sits alone: it is the offline fallback for every route,
 * and a shared FIFO cap would eventually evict the one entry the whole offline
 * story rests on.
 *
 * ## Boundaries that matter more than the caching
 *
 * A learner's audio (`POST /api/v1/pronunciation`) and the sync engine's
 * batches (`POST /api/v1/sync`) must pass through untouched. Both are handled
 * by the blanket non-GET rule in the fetch handler, and the reasoning is
 * written there because that is where someone would break it.
 */

/**
 * Bump to invalidate every cache below. `activate` deletes any `sonare-`
 * cache that is not in OWNED_CACHES, so a bump is the whole eviction
 * mechanism for a breaking change in what or how we store.
 */
const VERSION = "v1";

/** The navigation document. Exactly one entry, by construction — see below. */
const SHELL_CACHE = `sonare-shell-${VERSION}`;
/** Same-origin static assets: the hashed JS/CSS chunks, the brand images. */
const ASSET_CACHE = `sonare-assets-${VERSION}`;
/** API GET responses, network-first. */
const API_CACHE = `sonare-api-${VERSION}`;
/** Model-voice audio, fetched on demand. */
const VOICE_CACHE = `sonare-voice-${VERSION}`;

const OWNED_CACHES = [SHELL_CACHE, ASSET_CACHE, API_CACHE, VOICE_CACHE];

/**
 * Every cache this worker may delete carries this prefix.
 *
 * `activate` deletes by exclusion — anything not in OWNED_CACHES — and without
 * a prefix guard that means "every cache on this origin", including one put
 * there by something that is not us.
 */
const CACHE_PREFIX = "sonare-";

/**
 * The one URL the navigation fallback reads.
 *
 * The app uses a HashRouter, so every route — `#/fr`, `#/settings` — is the
 * same document at `/`, and a fragment is never sent to the server. One
 * navigation while online therefore caches the shell for every screen. Stored
 * and read under this literal rather than under the navigation Request, whose
 * `mode: "navigate"` and `Vary` interactions are not worth depending on.
 */
const SHELL_URL = "/";

/**
 * Caps, in entries.
 *
 * ASSET: one deploy's initial payload is about six files. 96 is roughly a
 * dozen deploys' worth of hashed chunks, and because a cache-first hit does
 * not re-store, insertion order is deploy order — so the FIFO trim below
 * drops the oldest deploy's stale chunks first, which is exactly right.
 *
 * API: one content document and one model-voice manifest per language, plus
 * whatever the internal diagnostics screen polls — that one is keyed on a
 * query string and would otherwise grow without limit.
 *
 * VOICE: the model-voice corpus is ~40 phrases per language, at roughly 10-30
 * kB of mp3 each. 64 holds one language comfortably and, on a second
 * language, evicts the first language's audio rather than accumulating both.
 * A French learner never pays to store Hindi audio, and nothing is
 * precached — every file arrives because a learner asked to hear that phrase.
 */
const MAX_ASSET_ENTRIES = 96;
const MAX_API_ENTRIES = 32;
const MAX_VOICE_ENTRIES = 64;

/**
 * Model-voice audio, matched on the exact shape the server's cache writes:
 * `/api/v1/model-voice/<language>/<32 hex>.mp3` (server/routes/modelVoice.ts,
 * and the same regex the client validates a manifest entry with in
 * src/modelVoice/manifest.ts).
 *
 * Deliberately narrow. `manifest.json` lives under the same prefix and is the
 * *index* of what exists — the server serves it `no-cache` precisely so a
 * client never works from yesterday's list of files that have since been
 * pruned. Cache-first on that would break the feature in the one way that is
 * hard to diagnose: audio requested for files that are gone.
 */
const VOICE_AUDIO_PATH = /^\/api\/v1\/model-voice\/[^/]+\/[0-9a-f]{32}\.mp3$/;

/** Same-origin static assets, by extension. */
const STATIC_PATH = /\.(?:js|mjs|css|png|jpe?g|svg|gif|webp|avif|ico|woff2?|ttf|otf|webmanifest)$/;

/**
 * Install: warm the navigation document, and nothing else.
 *
 * One fixed, hash-free URL — not a precache manifest. It closes a real gap:
 * the navigation that *installs* this worker is not itself intercepted,
 * because nothing controls the page yet. Without this line the shell is only
 * cached on the second visit, so a learner who loads Sonare once and then
 * loses signal gets a browser error page rather than an app.
 *
 * The failure is swallowed on purpose. A rejected `waitUntil` fails the
 * install and the worker never activates, which would mean one flaky request
 * costs the app its whole service worker.
 *
 * There is deliberately NO `self.skipWaiting()` here. See the `message`
 * handler.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(SHELL_URL))
      .catch(() => undefined),
  );
});

/**
 * Activate: drop previous versions, then take over the open pages.
 *
 * `clients.claim()` matters on a first install — without it the page that
 * registered this worker runs uncontrolled until the next navigation, so a
 * learner's first session gets no caching at all and the shell warmed above
 * is never read.
 */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && !OWNED_CACHES.includes(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * The update handshake, and the reason it is a handshake.
 *
 * A hand-rolled service worker fails in one of two ways: `skipWaiting()` in
 * `install`, which swaps the running version out from under whoever is using
 * the page — here, a learner mid-take, whose recording and unscored attempt go
 * with it — or no `skipWaiting()` at all, which pins everyone to the version
 * they first loaded until they happen to close every tab.
 *
 * So this worker installs, waits, and activates only when a learner has been
 * told a new version exists and has said yes. src/pwa/register.ts surfaces
 * that as a non-blocking toast and posts this message when the button is
 * pressed; it then reloads on `controllerchange`.
 */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data !== null && typeof data === "object" && data.type === "SONARE_SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  /**
   * (1) Never intercept a non-GET request. The single most important line in
   * this file.
   *
   * `POST /api/v1/pronunciation` carries a learner's recorded audio to be
   * scored. A service worker that queued, retried or cached it would either
   * charge the provider twice for one take or hand back a stale score for a
   * different recording — and a *wrong* score is worse than no score, because
   * the learner acts on it.
   *
   * `POST /api/v1/sync` is the same shape of mistake one layer up: the sync
   * engine already defers and retries its own batches (src/sync/engine.ts), so
   * a second retry ladder here would double-send.
   *
   * Returning without calling `respondWith` hands the request back to the
   * browser untouched — not "fetch it ourselves", which would already be a
   * behaviour change.
   */
  if (request.method !== "GET") return;

  /**
   * (2) A ranged request is never intercepted and its reply is never stored.
   *
   * A 206 is a fragment. Cached under the resource's own URL it would be
   * served whole to the next caller, who asked for all of it — a truncated
   * mp3 that decodes to silence part-way through. Slicing cached bodies to
   * satisfy ranges is the alternative, and it is more moving parts than this
   * worker should carry.
   *
   * The consequence, stated: Safari's media element always sends `Range`, so
   * on iOS the model-voice audio goes around this worker. That audio is served
   * `max-age=1y, immutable` under a content-hashed name, so the browser's own
   * HTTP cache keeps it — which is why this is a tolerable gap rather than a
   * missing feature.
   */
  if (request.headers.has("range")) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  /**
   * (3) Cross-origin requests are never touched.
   *
   * The webfonts are the real case (fonts.googleapis.com,
   * fonts.gstatic.com). A no-cors fetch of those comes back *opaque*: status
   * 0, body unreadable, indistinguishable from an error. Storing one in a
   * versioned cache means possibly caching a failure permanently under a name
   * that says it is valid. The browser's HTTP cache handles them correctly
   * already, and `display=swap` means a slow font never blanks the phrase.
   */
  if (url.origin !== self.location.origin) return;

  /**
   * (4) This file itself.
   *
   * The browser fetches its own worker script outside this handler, but a page
   * can request `/sw.js` too, and it matches STATIC_PATH. Caching a service
   * worker inside its own cache is how a worker becomes impossible to update.
   */
  if (url.pathname === self.location.pathname) return;

  // Navigation: network-first, cached shell as the fallback.
  if (request.mode === "navigate") {
    event.respondWith(navigationFirst(request));
    return;
  }

  // Model-voice audio: cache-first, capped, on demand.
  if (VOICE_AUDIO_PATH.test(url.pathname)) {
    event.respondWith(cacheFirst(request, VOICE_CACHE, MAX_VOICE_ENTRIES));
    return;
  }

  // Any other API GET: network-first, cache as the fallback. Fresh data wins;
  // a stale answer is only ever better than no answer.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request, API_CACHE, MAX_API_ENTRIES));
    return;
  }

  // Same-origin static assets: cache-first. Content-hashed names make this
  // safe — a chunk's bytes cannot change under its name.
  if (STATIC_PATH.test(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE, MAX_ASSET_ENTRIES));
    return;
  }

  // Anything else is somebody else's business.
});

/**
 * Whether a response may be written to a versioned cache.
 *
 * Three separate refusals, and the overlap between them is deliberate:
 *
 * - `ok` is 200-299, so a 404 or a 500 is never stored. A cached 404 is worse
 *   than a miss, because it persists past the deploy that fixed it.
 * - `206` passes `ok`. It is a fragment; see rule (2) in the fetch handler.
 * - an opaque response has status 0 and would already fail `ok` — the check is
 *   here to *state* the rule, because "never store an opaque response as
 *   though it were valid" must not depend on a coincidence of the status code.
 */
function isStorable(response) {
  if (!response || !response.ok) return false;
  if (response.status === 206) return false;
  if (response.type === "opaque" || response.type === "opaqueredirect") return false;
  return true;
}

/**
 * Keep a cache under `max` entries, oldest stored first.
 *
 * `cache.keys()` is insertion-ordered and `put` re-inserts, so this is FIFO
 * by *store* time — not LRU. Stated rather than implied: a cache-first hit
 * does not re-store, so a much-loved phrase can still be evicted by 64 newer
 * ones. Real LRU would mean a cache write on every hit, which is a worse trade
 * for audio that costs one request to get back.
 */
async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) {
    await cache.delete(keys[i]);
  }
}

/** Cache-first: the cached copy wins outright, and a miss is stored. */
async function cacheFirst(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (isStorable(response)) {
    await cache.put(request, response.clone());
    await trim(cache, max);
  }
  return response;
}

/** Network-first: the cache answers only when the network could not. */
async function networkFirst(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (isStorable(response)) {
      await cache.put(request, response.clone());
      await trim(cache, max);
    }
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    // Nothing cached and no network: let the browser report it as the network
    // failure it is, rather than inventing an offline page the app does not
    // have.
    throw error;
  }
}

/**
 * Navigation: network-first onto the single shell entry.
 *
 * Stored under SHELL_URL rather than under the request, so every route that
 * navigates writes and reads the same one entry — and that entry can never be
 * evicted by another strategy's cap, because nothing else lives in this cache.
 */
async function navigationFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (isStorable(response)) await cache.put(SHELL_URL, response.clone());
    return response;
  } catch (error) {
    const shell = await cache.match(SHELL_URL);
    if (shell) return shell;
    throw error;
  }
}
