/**
 * Registering the service worker, and the update handshake that goes with it.
 *
 * The worker itself is `public/sw.js` — a classic worker served verbatim, with
 * the caching strategies and their reasoning in its own header. This module is
 * the page's half: when to register at all, and what to do about a *second*
 * version of the worker arriving while a learner is using the first one.
 *
 * ## Three gates before anything is registered
 *
 * **Production only.** In development Vite serves modules from memory and
 * rewrites them on every save; a cache-first worker in front of that serves
 * yesterday's chunk and makes HMR look broken.
 *
 * **Secure context only.** `navigator.serviceWorker` does not exist on an
 * insecure origin, and the LAN address this app is tested from on-device is
 * exactly that — the same reason the microphone is unavailable there. This
 * fails *silently*: a developer on `http://192.168.x.x` already knows why the
 * mic is off, and a console warning on every load of a screen that works fine
 * is noise, not information.
 *
 * **Support.** A browser without `serviceWorker` loses nothing here: every
 * strategy in the worker is a cache in front of a network the app can already
 * do without.
 *
 * ## Why the update flow is a handshake
 *
 * A new worker installs and then *waits*, by default, until every page using
 * the old one is gone. The two ways to get this wrong are both worse than
 * doing nothing:
 *
 * - `skipWaiting()` unconditionally, which swaps the running version out from
 *   under whoever is on the page. Here that is a learner mid-take, whose
 *   recording and unscored attempt go with it.
 * - leaving it waiting forever, which pins a learner to the version they first
 *   loaded until they happen to close every tab — so a fix ships and nobody
 *   receives it.
 *
 * So: detect the waiting worker, tell the learner in a way they can ignore
 * (a toast — see src/pwa/UpdatePrompt.tsx), and only then `skipWaiting` and
 * reload. Nothing here reloads a page the learner did not ask to reload.
 */

/** The script path, matching where Vite copies it from `public/`. */
const WORKER_URL = "/sw.js";

/** The message `public/sw.js` answers by calling `skipWaiting()`. */
export const SKIP_WAITING_MESSAGE = { type: "SONARE_SKIP_WAITING" } as const;

/**
 * Everything about the running environment this module reads.
 *
 * One seam rather than four, so a test drives the real logic instead of a
 * second copy of it. `import.meta.env.PROD` in particular is *false* under
 * vitest and cannot be made true, so without this the production gate would
 * be the one rule no test could reach.
 */
export interface Platform {
  /** `import.meta.env.PROD` — a real build, not the dev server. */
  production: boolean;
  /** `window.isSecureContext`. A LAN IP is not one. */
  secureContext: boolean;
  /** `navigator.serviceWorker`, or null where the browser has none. */
  container: ServiceWorkerContainer | null;
  /** How to apply an accepted update. Separated so a test can observe it. */
  reload: () => void;
}

export interface RegisterOptions {
  /**
   * Called when a *replacement* worker is installed and waiting, with the
   * function that applies it. Not called on a first install: there is nothing
   * to update from, and "New version ready" on a learner's first ever visit is
   * a lie.
   */
  onUpdateReady: (apply: () => void) => void;
}

/** The three gates, as one readable predicate. */
export function canRegister(platform: Platform): boolean {
  return platform.production && platform.secureContext && platform.container !== null;
}

/** The real environment. Every read is guarded — this runs before the app. */
export function currentPlatform(): Platform {
  const container =
    typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : null;

  return {
    production: import.meta.env.PROD,
    secureContext: typeof window !== "undefined" && window.isSecureContext === true,
    container,
    reload: () => {
      window.location.reload();
    },
  };
}

/**
 * Register the worker and watch for a replacement.
 *
 * Returns a disposer that detaches the listeners. Every failure path is
 * swallowed: a service worker is an optimisation, and an optimisation that can
 * take the app down with it is not one. `register()` rejects for reasons
 * entirely outside this code — a 404 on the script after a bad deploy, a
 * browser with storage disabled, an enterprise policy — and none of them
 * should stop the app rendering.
 */
export function registerServiceWorker(
  options: RegisterOptions,
  platform: Platform = currentPlatform(),
): () => void {
  if (!canRegister(platform)) return () => undefined;

  // Narrowed by canRegister, but re-read into a local so the closures below
  // do not depend on that narrowing surviving.
  const container = platform.container;
  if (container === null) return () => undefined;

  /** Set only by the learner pressing the button in the toast. */
  let accepted = false;
  let disposed = false;

  /**
   * The controller changed — but that is not on its own a reason to reload.
   *
   * It also fires on a first install, because the worker calls
   * `clients.claim()` in `activate` so the page it was registered from is
   * actually controlled. Reloading there would reload every learner's first
   * visit, which looks exactly like a crash. So the reload is gated on the
   * learner having accepted: this is the flag that keeps a swap from ever
   * happening unasked, and the one that stops a reload loop.
   */
  const onControllerChange = (): void => {
    if (!accepted || disposed) return;
    platform.reload();
  };

  const announce = (worker: ServiceWorker): void => {
    options.onUpdateReady(() => {
      accepted = true;
      try {
        worker.postMessage(SKIP_WAITING_MESSAGE);
      } catch {
        // A worker that has already been discarded throws here. Reload
        // anyway: whatever happened, the learner asked for the new version and
        // a fresh load is the way to get it.
        platform.reload();
      }
    });
  };

  const watch = (registration: ServiceWorkerRegistration): void => {
    if (disposed) return;

    /**
     * A worker already installed and waiting when this page loaded — the
     * learner opened Sonare after a deploy had been picked up in a previous
     * session. `controller` distinguishes that from a first install: with no
     * controller there is no old version to replace.
     */
    if (registration.waiting !== null && container.controller !== null) {
      announce(registration.waiting);
    }

    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (installing === null) return;

      installing.addEventListener("statechange", () => {
        // "installed" is the waiting state. Anything earlier is still
        // downloading, and "activated" would mean it already took over.
        if (installing.state !== "installed") return;
        if (container.controller === null) return;
        if (disposed) return;
        announce(installing);
      });
    });
  };

  try {
    container.addEventListener("controllerchange", onControllerChange);
    void container
      .register(WORKER_URL)
      .then(watch)
      .catch(() => undefined);
  } catch {
    return () => undefined;
  }

  return () => {
    disposed = true;
    try {
      container.removeEventListener("controllerchange", onControllerChange);
    } catch {
      // Nothing to do and nothing worth reporting.
    }
  };
}
