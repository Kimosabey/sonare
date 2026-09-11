// @vitest-environment jsdom

/**
 * Registration, and the update handshake that is the risky half of a
 * hand-rolled service worker.
 *
 * Two failures are being ruled out here, and they pull in opposite directions:
 *
 * 1. **A version swap mid-session.** `skipWaiting()` on install, or a reload
 *    fired on any `controllerchange`, replaces the running app under whoever
 *    is on the page. For this app that is a learner mid-take — the recording
 *    and the unscored attempt go with it.
 * 2. **Nobody ever getting the update.** A worker that waits and is never
 *    accepted pins every learner to the version they first loaded until they
 *    happen to close every tab.
 *
 * jsdom has no service worker API at all, so the container, the registration
 * and the workers are fakes. What is *not* faked is the module under test: the
 * gates, the "is this an update or a first install" distinction, the message
 * it posts, and the single condition under which it reloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canRegister, currentPlatform, registerServiceWorker } from "./register.js";
import type { Platform } from "./register.js";

/** Let the `register().then(...)` microtask chain settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeWorker extends EventTarget {
  state = "installing";
  readonly posted: unknown[] = [];
  throwOnPost = false;

  postMessage(message: unknown): void {
    if (this.throwOnPost) throw new Error("worker is gone");
    this.posted.push(message);
  }

  becomes(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;

  /** What the browser does when it finds a new worker script. */
  updateFound(worker: FakeWorker): void {
    this.installing = worker;
    this.dispatchEvent(new Event("updatefound"));
  }
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  readonly registered: string[] = [];
  registration = new FakeRegistration();
  rejectWith: Error | null = null;

  register(url: string): Promise<FakeRegistration> {
    this.registered.push(url);
    return this.rejectWith === null
      ? Promise.resolve(this.registration)
      : Promise.reject(this.rejectWith);
  }
}

let container: FakeContainer;
let reload: () => void;
let updates: (() => void)[];

/** A platform where all three gates pass, so a test can vary exactly one. */
function platform(overrides: Partial<Platform> = {}): Platform {
  return {
    production: true,
    secureContext: true,
    container: container as unknown as ServiceWorkerContainer,
    reload,
    ...overrides,
  };
}

/** Options that record each "apply" handed to the caller. */
function options() {
  return {
    onUpdateReady: (apply: () => void) => {
      updates.push(apply);
    },
  };
}

beforeEach(() => {
  container = new FakeContainer();
  reload = vi.fn();
  updates = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the three gates", () => {
  it("does not register outside a production build", async () => {
    /**
     * The gate no test can reach by faking the environment, because
     * `import.meta.env.PROD` is false under vitest and cannot be made true.
     * So it is reached from the other side: the real platform is used, with
     * the other two gates satisfied, and the only thing left to block
     * registration is production.
     *
     * In development Vite serves modules from memory and rewrites them on
     * every save; a cache-first worker in front of that serves yesterday's
     * chunk and makes HMR look broken.
     */
    Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });

    const real = currentPlatform();
    expect(real.production, "vitest is not a production build").toBe(false);
    expect(real.secureContext).toBe(true);
    expect(real.container).toBe(container as unknown as ServiceWorkerContainer);
    // Everything except production is in place, so production is what blocks.
    expect(canRegister(real)).toBe(false);
    expect(canRegister({ ...real, production: true })).toBe(true);

    registerServiceWorker(options());
    await flush();

    expect(container.registered).toEqual([]);
  });

  it("does not register in an insecure context, and says nothing about it", async () => {
    /**
     * A LAN IP is an insecure context: no service worker there, and no
     * microphone either. A developer testing on `http://192.168.x.x` already
     * knows why the mic is off — a console warning on every load would be
     * noise, so this fails silently.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    registerServiceWorker(options(), platform({ secureContext: false }));
    await flush();

    expect(container.registered).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("does nothing where the browser has no service worker", async () => {
    const dispose = registerServiceWorker(options(), platform({ container: null }));
    await flush();

    expect(container.registered).toEqual([]);
    // And still returns a disposer, so a caller's cleanup is never undefined.
    expect(() => dispose()).not.toThrow();
  });

  it("registers the worker when all three gates pass", async () => {
    registerServiceWorker(options(), platform());
    await flush();

    expect(container.registered).toEqual(["/sw.js"]);
  });
});

describe("a first install is not an update", () => {
  it("says nothing when a worker is waiting but nothing is controlling the page", async () => {
    /**
     * `waiting` with no `controller` is a first install, not a replacement.
     * "New version ready" on a learner's first ever visit is a lie, and one
     * that invites them to reload for no reason.
     */
    container.controller = null;
    container.registration.waiting = new FakeWorker();

    registerServiceWorker(options(), platform());
    await flush();

    expect(updates).toEqual([]);
  });

  it("says nothing when a first install finishes while the page is open", async () => {
    container.controller = null;
    registerServiceWorker(options(), platform());
    await flush();

    const worker = new FakeWorker();
    container.registration.updateFound(worker);
    worker.becomes("installed");

    expect(updates).toEqual([]);
  });

  it("does not reload when the first worker claims the page", async () => {
    /**
     * The worker calls `clients.claim()` in `activate`, which fires
     * `controllerchange` on a first install. A reload on every
     * `controllerchange` would therefore reload every learner's first visit —
     * which looks exactly like a crash.
     */
    container.controller = null;
    registerServiceWorker(options(), platform());
    await flush();

    container.controller = new FakeWorker();
    container.dispatchEvent(new Event("controllerchange"));

    expect(reload).not.toHaveBeenCalled();
  });
});

describe("a replacement is offered, not applied", () => {
  it("announces a worker that was already waiting when the page loaded", async () => {
    // The learner opened Sonare after a deploy had been picked up in a
    // previous session.
    container.controller = new FakeWorker();
    container.registration.waiting = new FakeWorker();

    registerServiceWorker(options(), platform());
    await flush();

    expect(updates).toHaveLength(1);
  });

  it("announces one that finishes installing while the page is open", async () => {
    container.controller = new FakeWorker();
    registerServiceWorker(options(), platform());
    await flush();

    const replacement = new FakeWorker();
    container.registration.updateFound(replacement);
    expect(updates).toHaveLength(0);

    replacement.becomes("installed");

    expect(updates).toHaveLength(1);
  });

  it("waits for `installed` rather than announcing mid-download", async () => {
    // "installing" is still downloading; announcing then offers an update that
    // is not there yet, and pressing the button would post to a worker that
    // cannot activate.
    container.controller = new FakeWorker();
    registerServiceWorker(options(), platform());
    await flush();

    const replacement = new FakeWorker();
    container.registration.updateFound(replacement);
    replacement.becomes("installing");
    replacement.becomes("redundant");

    expect(updates).toEqual([]);
  });

  it("announces nothing on its own — the page is never swapped unasked", async () => {
    /**
     * The core of it. An announcement is made and then *nothing happens*: no
     * skipWaiting, no reload, until the learner acts. A learner mid-take can
     * ignore the toast for as long as the take lasts.
     */
    container.controller = new FakeWorker();
    const waiting = new FakeWorker();
    container.registration.waiting = waiting;

    registerServiceWorker(options(), platform());
    await flush();

    expect(updates).toHaveLength(1);
    expect(waiting.posted).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("accepting the update", () => {
  async function announced(): Promise<FakeWorker> {
    container.controller = new FakeWorker();
    const waiting = new FakeWorker();
    container.registration.waiting = waiting;
    registerServiceWorker(options(), platform());
    await flush();
    return waiting;
  }

  it("asks the waiting worker to take over", async () => {
    const waiting = await announced();

    updates[0]?.();

    expect(waiting.posted).toEqual([{ type: "SONARE_SKIP_WAITING" }]);
  });

  it("does not reload until the new worker is actually in charge", async () => {
    /**
     * Reloading immediately after `postMessage` races the activation: the new
     * page can load before the new worker is controlling, get served by the
     * old one, and show the old version anyway — with the toast now gone.
     */
    const waiting = await announced();

    updates[0]?.();

    expect(waiting.posted).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();

    container.dispatchEvent(new Event("controllerchange"));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads anyway if the waiting worker has already gone", async () => {
    // `postMessage` throws on a discarded worker. The learner asked for the
    // new version; a fresh load is the way to get it whatever happened here.
    const waiting = await announced();
    waiting.throwOnPost = true;

    expect(() => updates[0]?.()).not.toThrow();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stops listening once disposed", async () => {
    // React unmounts this on teardown; a surviving listener would reload a
    // page that no longer has the app on it.
    container.controller = new FakeWorker();
    container.registration.waiting = new FakeWorker();
    const dispose = registerServiceWorker(options(), platform());
    await flush();

    updates[0]?.();
    dispose();
    container.dispatchEvent(new Event("controllerchange"));

    expect(reload).not.toHaveBeenCalled();
  });
});

describe("nothing here can break the app", () => {
  it("swallows a registration that rejects", async () => {
    /**
     * `register()` rejects for reasons entirely outside this code: a 404 on
     * the script after a bad deploy, storage disabled, an enterprise policy.
     * None of them should stop the app rendering.
     */
    container.rejectWith = new Error("SecurityError");

    expect(() => registerServiceWorker(options(), platform())).not.toThrow();
    await flush();

    expect(updates).toEqual([]);
  });

  it("swallows a container that throws on subscription", () => {
    const hostile = {
      addEventListener: () => {
        throw new Error("no");
      },
      removeEventListener: () => undefined,
      register: () => Promise.resolve(container.registration),
    } as unknown as ServiceWorkerContainer;

    expect(() =>
      registerServiceWorker(options(), platform({ container: hostile })),
    ).not.toThrow();
  });

  it("returns a disposer that is safe to call twice", async () => {
    const dispose = registerServiceWorker(options(), platform());
    await flush();

    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });
});
