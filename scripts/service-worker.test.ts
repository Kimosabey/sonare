/**
 * The shipped service worker, driven as the shipped file.
 *
 * `public/sw.js` is a classic worker served verbatim — not a module, so
 * vitest cannot import it. The tempting alternative is to restate the routing
 * table in the test and assert on that, and it is worse than having no test:
 * it passes whatever `public/sw.js` actually does, including nothing. This
 * repository has caught that vacuous shape more than once (see the header of
 * src/styles/scale.test.ts, and `RouteFallback` in src/App.tsx).
 *
 * So: read the file off disk, evaluate it with `self`, `caches` and `fetch`
 * supplied as parameters — which shadow the globals the worker reads — and
 * call the handlers it registers. Every assertion below runs the real
 * strategies. The first one is that the file was found and is non-empty, so a
 * path mistake fails loudly instead of passing over an empty string.
 *
 * ## Why this file lives in scripts/
 *
 * It reads the filesystem. `src/` is typechecked by tsconfig.json, which
 * carries no Node types on purpose — a `src/` file that can `import
 * "node:fs"` is a `src/` file that can reach the filesystem, and that is a
 * boundary worth keeping. See the note in vitest.config.ts.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SW_PATH = join(ROOT, "public", "sw.js");
const SOURCE = readFileSync(SW_PATH, "utf8");

/** The worker's own origin, so a "cross-origin" case has something to be across from. */
const ORIGIN = "https://sonare.example";

/**
 * Constants read out of the worker rather than restated here.
 *
 * A second copy of the cap is a second thing to keep in step, and the one that
 * drifts is always the copy in the test — which then asserts a ceiling the
 * shipped file no longer has.
 */
function constant(name: string): number {
  const match = new RegExp(`const ${name} = (\\d+)`).exec(SOURCE);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

const MAX_VOICE_ENTRIES = constant("MAX_VOICE_ENTRIES");

/* ── the fakes ───────────────────────────────────────────────────────────── */

type Fetchable = string | Request;

function keyOf(request: Fetchable): string {
  return typeof request === "string" ? new URL(request, `${ORIGIN}/`).toString() : request.url;
}

/**
 * Enough of `Cache` for these strategies, with the two behaviours the worker
 * actually depends on: `put` replaces by re-inserting (so insertion order is
 * store order, which is what the FIFO trim reads), and `add` rejects a non-ok
 * response the way the real one does.
 */
class FakeCache {
  readonly entries = new Map<string, Response>();

  constructor(private readonly net: FakeNetwork) {}

  match(request: Fetchable): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(keyOf(request)));
  }

  put(request: Fetchable, response: Response): Promise<void> {
    const key = keyOf(request);
    this.entries.delete(key);
    this.entries.set(key, response);
    return Promise.resolve();
  }

  delete(request: Fetchable): Promise<boolean> {
    return Promise.resolve(this.entries.delete(keyOf(request)));
  }

  keys(): Promise<Request[]> {
    return Promise.resolve([...this.entries.keys()].map((url) => new Request(url)));
  }

  async add(request: Fetchable): Promise<void> {
    const response = await this.net.fetch(request);
    if (!response.ok) throw new TypeError(`Cache.add failed: ${response.status}`);
    await this.put(request, response);
  }

  /** Test helper: the stored URLs, oldest first. */
  urls(): string[] {
    return [...this.entries.keys()];
  }
}

class FakeCacheStorage {
  readonly opened = new Map<string, FakeCache>();

  constructor(private readonly net: FakeNetwork) {}

  open(name: string): Promise<FakeCache> {
    let cache = this.opened.get(name);
    if (cache === undefined) {
      cache = new FakeCache(this.net);
      this.opened.set(name, cache);
    }
    return Promise.resolve(cache);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.opened.keys()]);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.opened.delete(name));
  }

  /** Test helper: seed a cache without going through a strategy. */
  seed(name: string, url: string, response: Response): void {
    let cache = this.opened.get(name);
    if (cache === undefined) {
      cache = new FakeCache(this.net);
      this.opened.set(name, cache);
    }
    cache.entries.set(new URL(url, `${ORIGIN}/`).toString(), response);
  }

  /** Test helper: every stored URL across every cache. */
  everything(): string[] {
    return [...this.opened.values()].flatMap((cache) => cache.urls());
  }
}

class FakeNetwork {
  readonly calls: string[] = [];
  offline = false;
  private readonly routes = new Map<string, () => Response>();

  route(url: string, factory: () => Response): void {
    this.routes.set(new URL(url, `${ORIGIN}/`).toString(), factory);
  }

  /** Arrow property: the worker receives this as a bare `fetch`. */
  fetch = (request: Fetchable): Promise<Response> => {
    const url = keyOf(request);
    this.calls.push(url);
    if (this.offline) return Promise.reject(new TypeError("Failed to fetch"));
    const factory = this.routes.get(url);
    if (factory === undefined) return Promise.reject(new TypeError(`unrouted: ${url}`));
    return Promise.resolve(factory());
  };

  callsTo(url: string): number {
    const key = new URL(url, `${ORIGIN}/`).toString();
    return this.calls.filter((c) => c === key).length;
  }
}

/* ── the harness ─────────────────────────────────────────────────────────── */

/** Every shape of event these handlers are given. */
interface SwEvent {
  request?: Request;
  data?: unknown;
  respondWith?: (response: Response | Promise<Response>) => void;
  waitUntil?: (promise: Promise<unknown>) => void;
}

type Handler = (event: SwEvent) => void;

class Worker {
  readonly handlers = new Map<string, Handler[]>();
  readonly net = new FakeNetwork();
  readonly caches = new FakeCacheStorage(this.net);
  skipWaitingCalls = 0;
  claimCalls = 0;

  constructor() {
    const self = {
      location: new URL(`${ORIGIN}/sw.js`),
      addEventListener: (type: string, handler: Handler): void => {
        const list = this.handlers.get(type) ?? [];
        list.push(handler);
        this.handlers.set(type, list);
      },
      skipWaiting: (): void => {
        this.skipWaitingCalls += 1;
      },
      clients: {
        claim: (): Promise<void> => {
          this.claimCalls += 1;
          return Promise.resolve();
        },
      },
    };

    /**
     * `self`, `caches` and `fetch` are parameters, so the worker's bare
     * references to them resolve to these fakes while `URL`, `Request` and
     * `Response` still come from the real globals — which means a Response the
     * worker stores is the same class the assertions read.
     */
    const factory = new Function("self", "caches", "fetch", SOURCE) as (
      self: unknown,
      caches: unknown,
      fetch: unknown,
    ) => void;
    factory(self, this.caches, this.net.fetch);
  }

  /** Drive the fetch handler. `undefined` means the request was not intercepted. */
  handleFetch(request: Request): Response | Promise<Response> | undefined {
    let answer: Response | Promise<Response> | undefined;
    const event: SwEvent = {
      request,
      respondWith: (response) => {
        answer = response;
      },
      waitUntil: () => undefined,
    };
    for (const handler of this.handlers.get("fetch") ?? []) handler(event);
    return answer;
  }

  /** Drive install or activate, awaiting whatever it passed to waitUntil. */
  async lifecycle(type: "install" | "activate"): Promise<void> {
    const waits: Promise<unknown>[] = [];
    const event: SwEvent = { waitUntil: (promise) => void waits.push(promise) };
    for (const handler of this.handlers.get(type) ?? []) handler(event);
    await Promise.all(waits);
  }

  message(data: unknown): void {
    for (const handler of this.handlers.get("message") ?? []) handler({ data });
  }
}

/* ── request builders ────────────────────────────────────────────────────── */

function get(path: string, init?: RequestInit): Request {
  return new Request(new URL(path, `${ORIGIN}/`), init);
}

/**
 * A navigation request.
 *
 * `mode: "navigate"` is not constructible — the spec reserves it for the
 * browser, and `new Request(url, { mode: "navigate" })` throws in Node exactly
 * as it does in a browser. Overriding the accessor is how a test reaches the
 * branch a real navigation takes.
 */
function navigate(path: string): Request {
  const request = get(path);
  Object.defineProperty(request, "mode", { value: "navigate", configurable: true });
  return request;
}

/** An mp3 name in the shape the server's voice cache writes: 32 hex chars. */
function voicePath(index: number, language = "fr"): string {
  return `/api/v1/model-voice/${language}/${index.toString(16).padStart(32, "0")}.mp3`;
}

function ok(body = "payload", init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

let worker: Worker;

beforeEach(() => {
  worker = new Worker();
});

/* ── tests ───────────────────────────────────────────────────────────────── */

describe("the file under test is the file that ships", () => {
  it("was found on disk and is not empty", () => {
    // Guards every other assertion here. An empty string evaluates fine,
    // registers no handlers, and makes every "passed through untouched" case
    // below pass for the wrong reason.
    expect(SOURCE.length, `${SW_PATH} read as empty`).toBeGreaterThan(500);
  });

  it("registers the four handlers the rest of this file drives", () => {
    expect([...worker.handlers.keys()].sort()).toEqual(["activate", "fetch", "install", "message"]);
  });

  it("states its caps as readable constants", () => {
    // The eviction test below loops to this number; NaN would make it loop
    // zero times and assert nothing.
    expect(MAX_VOICE_ENTRIES).toBeGreaterThan(0);
  });
});

describe("a learner's audio and the sync batch are never touched", () => {
  it("passes POST /api/v1/pronunciation straight through", async () => {
    /**
     * The one that matters most. A worker that queued, retried or cached this
     * would charge the provider twice for one take, or hand back a score
     * belonging to a different recording — and a wrong score is worse than no
     * score, because the learner acts on it.
     */
    const request = get("/api/v1/pronunciation", { method: "POST", body: "wav bytes" });

    expect(worker.handleFetch(request)).toBeUndefined();
    expect(worker.net.calls).toEqual([]);
    expect(worker.caches.everything()).toEqual([]);
    await Promise.resolve();
  });

  it("passes POST /api/v1/sync straight through", () => {
    // The sync engine has its own deferral and retry ladder. A second one here
    // double-sends.
    const request = get("/api/v1/sync", { method: "POST", body: "{}" });

    expect(worker.handleFetch(request)).toBeUndefined();
    expect(worker.net.calls).toEqual([]);
    expect(worker.caches.everything()).toEqual([]);
  });

  it("passes every other write method through as well", () => {
    // The rule is about methods, not about two known paths.
    for (const method of ["PUT", "PATCH", "DELETE", "HEAD"]) {
      const request = get("/api/v1/learners/me", { method });
      expect(worker.handleFetch(request), method).toBeUndefined();
    }
    expect(worker.net.calls).toEqual([]);
  });
});

describe("same-origin static assets are cache-first", () => {
  it("serves a cached asset without touching the network", async () => {
    worker.caches.seed("sonare-assets-v1", "/assets/index-abc123.js", ok("cached js"));

    const response = await worker.handleFetch(get("/assets/index-abc123.js"));

    expect(await response?.text()).toBe("cached js");
    expect(worker.net.calls).toEqual([]);
  });

  it("fetches a miss and stores it", async () => {
    worker.net.route("/assets/index-abc123.js", () => ok("fresh js"));

    const response = await worker.handleFetch(get("/assets/index-abc123.js"));

    expect(await response?.text()).toBe("fresh js");
    const cache = await worker.caches.open("sonare-assets-v1");
    expect(cache.urls()).toEqual([`${ORIGIN}/assets/index-abc123.js`]);
    // And the stored copy is readable — a body consumed by the response
    // handed to the page would leave an empty entry behind.
    expect(await cache.entries.get(`${ORIGIN}/assets/index-abc123.js`)?.text()).toBe("fresh js");
  });

  it("does not cache a non-ok response", async () => {
    /**
     * A cached 404 outlives the deploy that fixed it: the asset comes back,
     * and the worker keeps answering "gone" from its own cache.
     */
    worker.net.route("/assets/missing.js", () => new Response("nope", { status: 404 }));

    const response = await worker.handleFetch(get("/assets/missing.js"));

    expect(response?.status).toBe(404);
    expect(worker.caches.everything()).toEqual([]);
  });

  it("does not cache a 5xx either", async () => {
    worker.net.route("/assets/broken.js", () => new Response("boom", { status: 503 }));

    await worker.handleFetch(get("/assets/broken.js"));

    expect(worker.caches.everything()).toEqual([]);
  });

  it("does not cache a 206, even though a 206 is `ok`", async () => {
    /**
     * `Response.ok` is 200-299, so a partial response passes it. Cached under
     * the resource's own URL, a fragment is then served whole to the next
     * caller — a truncated file that fails in a way nothing points at.
     */
    expect(new Response("half", { status: 206 }).ok).toBe(true);
    worker.net.route("/brand/icon.png", () => new Response("half", { status: 206 }));

    await worker.handleFetch(get("/brand/icon.png"));

    expect(worker.caches.everything()).toEqual([]);
  });

  it("does not store a response that claims to be opaque", async () => {
    /**
     * An opaque response has status 0 and would already fail `ok`, so this
     * drives the explicit `type` refusal rather than the coincidence. The rule
     * must not depend on that coincidence: storing an opaque reply in a
     * versioned cache caches a possible *error* under a name that says it is
     * valid.
     */
    const opaque = new Response("", { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaque", configurable: true });
    worker.net.route("/brand/icon.png", () => opaque);

    await worker.handleFetch(get("/brand/icon.png"));

    expect(worker.caches.everything()).toEqual([]);
  });

  it("leaves a ranged request alone", async () => {
    // A 206 cannot be cached, and slicing cached bodies to answer ranges is
    // more machinery than this worker carries. Safari's media element always
    // sends Range, which is the case this exists for.
    const request = get(voicePath(1), { headers: { Range: "bytes=0-1023" } });

    expect(worker.handleFetch(request)).toBeUndefined();
    expect(worker.net.calls).toEqual([]);
  });

  it("leaves cross-origin requests alone", () => {
    // The webfonts. A no-cors fetch of one comes back opaque, and the
    // browser's own HTTP cache already handles them correctly.
    const request = new Request("https://fonts.gstatic.com/s/nunito/v1/x.woff2");

    expect(worker.handleFetch(request)).toBeUndefined();
    expect(worker.net.calls).toEqual([]);
  });

  it("never caches its own script", () => {
    // `/sw.js` matches the static-asset pattern. A worker cached inside its
    // own cache is a worker that can no longer be updated.
    expect(worker.handleFetch(get("/sw.js"))).toBeUndefined();
    expect(worker.net.calls).toEqual([]);
  });

  it("leaves a path it has no strategy for alone", () => {
    // Not an API path, no static extension, not a navigation.
    expect(worker.handleFetch(get("/something/else"))).toBeUndefined();
    expect(worker.net.calls).toEqual([]);
  });
});

describe("model-voice audio is cache-first, capped, and on demand", () => {
  it("fetches a miss and stores it in the voice cache", async () => {
    worker.net.route(voicePath(1), () => ok("mp3 bytes"));

    const response = await worker.handleFetch(get(voicePath(1)));

    expect(await response?.text()).toBe("mp3 bytes");
    const voice = await worker.caches.open("sonare-voice-v1");
    expect(voice.urls()).toEqual([`${ORIGIN}${voicePath(1)}`]);
    // Separate cache, so the asset cap and the audio cap cannot evict each
    // other's entries.
    expect(worker.caches.opened.has("sonare-assets-v1")).toBe(false);
  });

  it("serves the second play from the cache", async () => {
    worker.net.route(voicePath(1), () => ok("mp3 bytes"));

    await worker.handleFetch(get(voicePath(1)));
    const again = await worker.handleFetch(get(voicePath(1)));

    expect(await again?.text()).toBe("mp3 bytes");
    expect(worker.net.callsTo(voicePath(1))).toBe(1);
  });

  it("caches nothing until a learner asks for it", async () => {
    // The reason this is cache-first rather than precached: a French learner
    // must not download the Hindi corpus. Install fetches the shell and
    // nothing else.
    worker.net.route("/", () => ok("<!doctype html>"));

    await worker.lifecycle("install");

    expect(worker.caches.everything()).toEqual([`${ORIGIN}/`]);
  });

  it(`evicts the oldest entry past the ${MAX_VOICE_ENTRIES}-entry cap`, async () => {
    for (let i = 0; i <= MAX_VOICE_ENTRIES; i += 1) {
      worker.net.route(voicePath(i), () => ok(`mp3 ${i}`));
      await worker.handleFetch(get(voicePath(i)));
    }

    const voice = await worker.caches.open("sonare-voice-v1");
    expect(voice.urls()).toHaveLength(MAX_VOICE_ENTRIES);
    // FIFO by store time: the first one stored is the first one dropped.
    expect(voice.urls()).not.toContain(`${ORIGIN}${voicePath(0)}`);
    expect(voice.urls()).toContain(`${ORIGIN}${voicePath(MAX_VOICE_ENTRIES)}`);
  });

  it("does not treat the voice manifest as immutable audio", async () => {
    /**
     * `manifest.json` sits under the same prefix and is the *index* of what
     * exists. The server serves it `no-cache` precisely so a client never
     * works from yesterday's list of files that have since been pruned —
     * cache-first there would have the app requesting audio that is gone.
     */
    const path = "/api/v1/model-voice/fr/manifest.json";
    worker.net.route(path, () => ok('{"language":"fr"}'));

    await worker.handleFetch(get(path));
    await worker.handleFetch(get(path));

    expect(worker.net.callsTo(path)).toBe(2);
    expect(worker.caches.opened.has("sonare-voice-v1")).toBe(false);
  });
});

describe("API GETs are network-first", () => {
  it("prefers a fresh answer over a cached one", async () => {
    worker.caches.seed("sonare-api-v1", "/api/v1/content/fr", ok("stale"));
    worker.net.route("/api/v1/content/fr", () => ok("fresh"));

    const response = await worker.handleFetch(get("/api/v1/content/fr"));

    expect(await response?.text()).toBe("fresh");
    expect(worker.net.callsTo("/api/v1/content/fr")).toBe(1);
  });

  it("falls back to the cache when the network is gone", async () => {
    worker.caches.seed("sonare-api-v1", "/api/v1/content/fr", ok("stale but readable"));
    worker.net.offline = true;

    const response = await worker.handleFetch(get("/api/v1/content/fr"));

    expect(await response?.text()).toBe("stale but readable");
  });

  it("rejects rather than inventing an answer when there is nothing cached", async () => {
    // The app has no offline error page, and a synthesised 503 would be
    // indistinguishable from the server having returned one.
    worker.net.offline = true;

    await expect(worker.handleFetch(get("/api/v1/content/fr"))).rejects.toThrow(/Failed to fetch/);
  });
});

describe("navigations are network-first onto one shell entry", () => {
  it("stores the document under / whatever route was navigated to", async () => {
    // HashRouter: every route is the same document, and a fragment is never
    // sent. One navigation therefore covers every screen.
    worker.net.route("/", () => ok("<!doctype html>"));

    await worker.handleFetch(navigate("/"));

    const shell = await worker.caches.open("sonare-shell-v1");
    expect(shell.urls()).toEqual([`${ORIGIN}/`]);
  });

  it("serves the cached shell when offline", async () => {
    worker.net.route("/", () => ok("<!doctype html>shell"));
    await worker.handleFetch(navigate("/"));
    worker.net.offline = true;

    const response = await worker.handleFetch(navigate("/"));

    expect(await response?.text()).toBe("<!doctype html>shell");
  });

  it("has a shell to serve after install alone, before any navigation", async () => {
    /**
     * The gap install exists to close: the navigation that *installs* the
     * worker is not intercepted, because nothing controls the page yet. Load
     * Sonare once, lose signal, and without this the second visit is a browser
     * error page.
     */
    worker.net.route("/", () => ok("<!doctype html>warmed"));
    await worker.lifecycle("install");
    worker.net.offline = true;

    const response = await worker.handleFetch(navigate("/"));

    expect(await response?.text()).toBe("<!doctype html>warmed");
  });

  it("rejects when offline with nothing warmed", async () => {
    worker.net.offline = true;

    await expect(worker.handleFetch(navigate("/"))).rejects.toThrow(/Failed to fetch/);
  });
});

describe("install and activate", () => {
  it("survives a failed shell warm-up", async () => {
    /**
     * A rejected `waitUntil` fails the install and the worker never
     * activates — so one flaky request would cost the app its whole service
     * worker, permanently, for that visitor.
     */
    worker.net.offline = true;

    await expect(worker.lifecycle("install")).resolves.toBeUndefined();
  });

  it("deletes older versions of its own caches", async () => {
    worker.caches.seed("sonare-assets-v0", "/assets/old.js", ok("old"));
    worker.caches.seed("sonare-voice-v0", voicePath(9), ok("old mp3"));
    worker.caches.seed("sonare-assets-v1", "/assets/new.js", ok("new"));

    await worker.lifecycle("activate");

    expect((await worker.caches.keys()).sort()).toEqual(["sonare-assets-v1"]);
  });

  it("leaves caches it does not own alone", async () => {
    // Deleting by exclusion without a prefix guard means deleting every cache
    // on the origin, including one put there by something that is not us.
    worker.caches.seed("some-other-app", "/x", ok("theirs"));

    await worker.lifecycle("activate");

    expect(await worker.caches.keys()).toContain("some-other-app");
  });

  it("claims the open pages", async () => {
    // Without this a first install controls nothing until the next
    // navigation, so the learner's first session gets no caching at all and
    // the warmed shell is never read.
    await worker.lifecycle("activate");

    expect(worker.claimCalls).toBe(1);
  });
});

describe("the waiting worker does not activate itself", () => {
  it("does not call skipWaiting on install", async () => {
    /**
     * The failure this whole handshake exists to prevent: an unconditional
     * `skipWaiting()` swaps the running version out from under whoever is on
     * the page. Here that is a learner mid-take, whose recording and unscored
     * attempt go with it.
     */
    worker.net.route("/", () => ok("<!doctype html>"));

    await worker.lifecycle("install");
    await worker.lifecycle("activate");

    expect(worker.skipWaitingCalls).toBe(0);
  });

  it("calls skipWaiting only when the page asks it to", () => {
    worker.message({ type: "SONARE_SKIP_WAITING" });

    expect(worker.skipWaitingCalls).toBe(1);
  });

  it("ignores any other message", () => {
    // A page, an extension or another library can post anything at a worker.
    for (const data of [null, undefined, "SONARE_SKIP_WAITING", {}, { type: "ping" }, 42]) {
      worker.message(data);
    }

    expect(worker.skipWaitingCalls).toBe(0);
  });
});
