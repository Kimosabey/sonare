// @vitest-environment jsdom

/**
 * A learner practises with no network, and then the network comes back.
 *
 * `engine.test.ts` and `dirty.test.ts` already pin the contract at the unit
 * level: a failure defers, the flags survive, the merge keeps local attempts.
 * What none of them can see is the *journey* — that with `fetch` rejecting on
 * every call the learner is not blocked at any point and is not told anything
 * failed, and that when the connection returns the deferred work leaves
 * exactly once, through the app's own trigger rather than a direct call into
 * the engine, and folds back into what the screens then show.
 *
 * The design being asserted, from engine.ts's own contract:
 *
 *   **The local write has already happened.** So a failed push costs nothing
 *   and there is nothing on the critical path of finishing an activity.
 *
 *   **A failure is silent and costs nothing.** No error is surfaced, because
 *   there is nothing for the learner to do about it and telling them their
 *   progress failed to save would be false — it is saved, locally.
 *
 *   **Nothing local is lost to a merge.** Attempts in particular, because the
 *   server has no copy of them.
 *
 * Two things are deliberately *not* silent and are asserted as such: the
 * pre-emptive "you're offline" warning, which is about the take the learner is
 * about to make rather than about work already done, and its disappearance the
 * moment the connection returns.
 *
 * One thing the journey found and did not fix: a merge that lands while the
 * activity screen is open is overwritten by that screen's next save. Pinned at
 * the foot of this file, with the two lines that cause it.
 *
 * `src/sync/wire.ts` is a sibling's file this week and is used here only
 * through the app — the snapshot below is a JSON body over the stubbed
 * network, exactly as the server would send it, so nothing here depends on
 * that module's internals.
 */

import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGES } from "../activities/languages/index.js";
import { localDay } from "../stores/streakStore.js";
import {
  LEARNER_NAME_KEY,
  follow,
  installBrowserGlobals,
  installFetch,
  installStorage,
  makeRecorderStub,
  onScreen,
  press,
  renderApp,
  scored,
  speak,
  visit,
} from "./harness.js";
import type { FetchLog } from "./harness.js";

const { useRecorder, driver } = makeRecorderStub();
vi.mock("../speech/react/useRecorder.js", () => ({ useRecorder }));
vi.mock("../hooks/useCaptureToasts.js", () => ({
  useCaptureToasts: () => undefined,
  HEARD_SPEECH_SNR_DB: 10,
}));
vi.mock("../hooks/useSyllablePlayback.js", () => ({
  useSyllablePlayback: () => ({ playingOffsetTicks: null, play: vi.fn(), available: false }),
}));
vi.mock("../hooks/useModelSpeech.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useModelSpeech.js")>(
    "../hooks/useModelSpeech.js",
  );
  return {
    phraseTokens: actual.phraseTokens,
    useModelSpeech: () => ({
      speak: vi.fn(),
      cancel: vi.fn(),
      speaking: false,
      available: false,
      wordIndex: null,
    }),
  };
});
vi.mock("../hooks/useWakeLock.js", () => ({ useWakeLock: () => undefined }));

const FRENCH = (() => {
  const set = LANGUAGES.find((l) => l.slug === "fr");
  if (!set) throw new Error("French is no longer a shipped language");
  return set;
})();

/** Flipped by the test to bring the network back mid-run. */
let reachable = false;
let log: FetchLog;
let store: Map<string, string>;

const TOKEN = "header.payload.signature";

function yesterday(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return localDay(date);
}

/** Five samples of one syllable, so the merged history can show a real trend. */
function samples(values: number[]): Array<{ at: string; accuracy: number }> {
  return values.map((accuracy, i) => ({
    at: new Date(Date.now() - (values.length - i) * 86_400_000).toISOString(),
    accuracy,
  }));
}

/**
 * The merged record as the server would return it.
 *
 * Shaped to make every half of the merge observable at once: activity 1 is
 * known to both sides with a *higher* best than this device has, activity 5 is
 * known only to the server, the syllable history is longer than this device
 * could have built, and the streak carries a day this device never recorded
 * plus a best run it has never reached.
 */
function snapshot(): unknown {
  return {
    progress: [
      {
        slug: FRENCH.slug,
        entries: [
          {
            activityId: 1,
            passed: true,
            bestAccuracy: 91,
            attemptsUsed: 5,
            skipped: false,
            at: new Date().toISOString(),
          },
          {
            activityId: 5,
            passed: true,
            bestAccuracy: 77,
            attemptsUsed: 2,
            skipped: false,
            at: new Date().toISOString(),
          },
        ],
      },
    ],
    skills: [
      {
        slug: FRENCH.slug,
        skills: [
          { grapheme: "jour", samples: samples([40, 42, 44, 60, 62, 64, 66]) },
          { grapheme: "bon", samples: samples([70, 72, 74]) },
        ],
      },
    ],
    streak: { days: [yesterday(), localDay()], longest: 4 },
  };
}

function respond(url: string): unknown {
  if (!reachable) throw new TypeError("Failed to fetch");
  if (url.includes("/api/v1/learners")) return { token: TOKEN };
  if (url.includes("/api/v1/sync")) return snapshot();
  // Nothing published for any language, which is the ordinary answer.
  return {};
}

function syncCalls(): string[] {
  return log.to("POST /api/v1/sync");
}

/** The persisted progress for French, read behind the app's back. */
function persistedProgress(): {
  index: number;
  progress: Array<{ activityId: number; best: number | null; passed: boolean; attempts: unknown[] }>;
} {
  const key = [...store.keys()].find((k) => k.startsWith("sonare.progress."));
  return JSON.parse(store.get(key ?? "") ?? '{"index":0,"progress":[]}') as never;
}

/** The dirty flags, which is the whole record that work is still unsent. */
function dirty(): { progress: string[]; skills: string[]; streak: boolean } {
  const key = [...store.keys()].find((k) => k.startsWith("sonare.sync.dirty."));
  return JSON.parse(
    store.get(key ?? "") ?? '{"progress":[],"skills":[],"streak":false}',
  ) as never;
}

/** Every announcement on screen that a screen reader would be given. */
function announcements(): string[] {
  return [...document.querySelectorAll('[role="alert"], [role="status"], .toast')]
    .map((node) => node.textContent ?? "")
    .filter((text) => text.trim().length > 0);
}

function nextButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /Next activity|Finish and see report/i });
}

/**
 * Practises three activities with the network refusing every call.
 *
 * Each activity is passed on one take, which is enough: the point is not the
 * scoring but that three rounds of local writes and three failed pushes leave
 * the learner exactly where a connected learner would be.
 */
async function practiseOffline(activities = 3): Promise<void> {
  await renderApp(`#/${FRENCH.slug}`);
  press(/^Start$/);
  for (let i = 0; i < activities; i += 1) {
    speak(driver, scored(70 + i));
    await waitFor(() => expect(nextButton()).not.toBeNull());
    press(/Next activity|Finish and see report/);
  }
}

/** Brings the connection back and fires the event the browser would. */
async function reconnect(events = 1): Promise<void> {
  reachable = true;
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  await act(async () => {
    for (let i = 0; i < events; i += 1) window.dispatchEvent(new Event("online"));
  });
}

beforeEach(() => {
  reachable = false;
  store = installStorage({ [LEARNER_NAME_KEY]: "Marie" });
  installBrowserGlobals();
  log = installFetch(respond);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("practising with nothing to practise against", () => {
  it("does not block the learner anywhere in the session", async () => {
    /**
     * Every screen transition a session has, with `fetch` rejecting on every
     * call: Start, three scored takes, three advances, and the report. Nothing
     * in this path is allowed to wait on the network, and the assertion is
     * simply that the path completes.
     */
    await practiseOffline(FRENCH.activities.length);

    await waitFor(() => expect(screen.getByText("Today’s practice")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Start again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download report JSON" })).toBeInTheDocument();
  });

  it("does not block the learner when the browser itself says it is offline", async () => {
    /**
     * The learner on a train, which is the case the whole offline-first design
     * is for — and a different one from the test above, because
     * `navigator.onLine` being false is a condition the *screen* can see and
     * could act on. It must not: the warning above is the only thing that
     * state is allowed to change. `speak` asserts the record button is enabled
     * before it clicks, so a change that locked recording behind connectivity
     * fails here rather than shipping.
     */
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await renderApp(`#/${FRENCH.slug}`);
    await screen.findByText("You’re offline");
    press(/^Start$/);

    for (let i = 0; i < 3; i += 1) {
      speak(driver, scored(70 + i));
      await waitFor(() => expect(nextButton()).not.toBeNull());
      press(/Next activity|Finish and see report/);
    }

    expect(persistedProgress().progress).toHaveLength(3);
    expect(dirty().progress).toEqual([FRENCH.slug]);
  });

  it("says nothing about a failure, because nothing failed for the learner", async () => {
    /**
     * The one that matters. `navigator.onLine` is true throughout — the
     * captive-wifi case, where the browser believes it is connected and every
     * request dies anyway — so the pre-emptive warning is deliberately not in
     * play and any message on screen would be sync reporting itself.
     *
     * Checked over the live regions and toasts rather than over the whole
     * document, because those are the places a message would actually be
     * announced, and asserting on `document.body.textContent` would pass on a
     * banner rendered somewhere silent.
     */
    await practiseOffline();

    expect(log.to("/api/v1/learners").length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    for (const text of announcements()) {
      expect(text).not.toMatch(/could not|couldn’t|failed|offline|sync|not saved|try again later/i);
    }
  });

  it("keeps every take on the device, so nothing is waiting on a push", async () => {
    await practiseOffline();

    const stored = persistedProgress();
    expect(stored.progress).toHaveLength(3);
    expect(stored.progress.every((entry) => entry.passed)).toBe(true);
    expect(stored.progress[0]?.attempts).toHaveLength(1);
    // The screens agree with the disk.
    follow("Sonare");
    await onScreen("Today");
    expect(screen.getByText("Streak").closest("div")).toHaveTextContent("1day");
  });

  it("records that the work is unsent, in storage rather than in memory", async () => {
    /**
     * The flag has to outlive the tab. A learner who finishes an activity on a
     * train and closes the browser before the push succeeds must still have it
     * pushed tomorrow, and an in-memory flag loses exactly the work that was
     * hardest to do.
     */
    await practiseOffline();

    expect(dirty()).toEqual({
      progress: [FRENCH.slug],
      skills: [FRENCH.slug],
      streak: true,
    });
  });

  it("warns before a take rather than after one when the browser knows it is offline", async () => {
    /**
     * The deliberate exception to the silence. This is not sync reporting a
     * failure — it is the screen telling the learner, before they speak, that
     * a recording cannot be scored yet. The distinction is the whole point:
     * one is about work already safely on the device, the other is about the
     * next thirty seconds.
     */
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await renderApp(`#/${FRENCH.slug}`);

    const warning = await screen.findByText("You’re offline");
    expect(warning).toBeInTheDocument();
    expect(screen.getByText(/Recordings can’t be scored until you reconnect/)).toBeInTheDocument();
    // And it goes when the connection does.
    await reconnect();
    await waitFor(() => expect(screen.queryByText("You’re offline")).not.toBeInTheDocument());
  });
});

describe("when the network comes back", () => {
  it("pushes the deferred work exactly once", async () => {
    /**
     * Once, not once per event. `useSync` guards overlapping runs with a ref
     * that is set synchronously before the first await, so two `online` events
     * in the same tick — a real pattern when a phone reassociates with a
     * network — produce one request rather than two racing read-modify-writes
     * against the same document.
     */
    await practiseOffline();
    expect(syncCalls()).toHaveLength(0);

    await reconnect(2);

    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    // And nothing further arrives on its own afterwards.
    await act(async () => undefined);
    expect(syncCalls()).toHaveLength(1);
  });

  it("does not try to sync before there is a token to sync with", async () => {
    // Registration is a separate request and the sync is not sent without it,
    // so an offline session spends one failed call rather than two.
    await practiseOffline();

    expect(log.to("POST /api/v1/learners").length).toBeGreaterThan(0);
    expect(syncCalls()).toHaveLength(0);
  });

  it("clears the flags for what it sent, and only that", async () => {
    await practiseOffline();
    await reconnect();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    expect(dirty()).toEqual({ progress: [], skills: [], streak: false });
  });

  it("sends the language that was practised and nothing else", async () => {
    await practiseOffline();
    await reconnect();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    const call = log.mock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/api/v1/sync") && (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as {
      progress: Array<{ slug: string }>;
      skills: Array<{ slug: string }>;
      streak?: { days: string[] };
    };
    expect(body.progress.map((p) => p.slug)).toEqual([FRENCH.slug]);
    expect(body.skills.map((s) => s.slug)).toEqual([FRENCH.slug]);
    expect(body.streak?.days).toContain(localDay());
  });
});

describe("folding the merged record back", () => {
  it("keeps the local attempts the server has no copy of", async () => {
    /**
     * The server is sent a per-activity *summary*, not the takes — the full
     * provider result for every attempt is telemetry the attempts collection
     * already holds. So the reply cannot carry them back, and anything other
     * than keeping the local list deletes a learner's own take history from
     * the device that recorded it. The snapshot deliberately claims five
     * attempts on activity 1 where this device made one.
     */
    await practiseOffline();
    expect(persistedProgress().progress[0]?.attempts).toHaveLength(1);

    await reconnect();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    const merged = persistedProgress().progress.find((p) => p.activityId === 1);
    expect(merged?.attempts).toHaveLength(1);
    // And the better of the two bests survives, rather than either winning by
    // being the one written last.
    expect(merged?.best).toBe(91);
  });

  it("adds an activity this device has never seen without inventing takes for it", async () => {
    await practiseOffline();
    await reconnect();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    const added = persistedProgress().progress.find((p) => p.activityId === 5);
    expect(added).toMatchObject({ activityId: 5, passed: true, best: 77 });
    expect(added?.attempts).toEqual([]);
  });

  it("leaves this device's position in the session alone", async () => {
    // Where another device left off is not where this one is. The index is
    // deliberately not synced.
    await practiseOffline();
    const before = persistedProgress().index;

    await reconnect();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    expect(persistedProgress().index).toBe(before);
  });

  it("shows the merged record on the learner's own screens", async () => {
    /**
     * The half no unit test reaches. Nothing waits on a sync and nothing
     * re-renders for one, so the merged record becomes visible on the next
     * navigation — which is the design, and is worth pinning as such: the
     * learner sees the union of their devices without ever having waited for
     * it.
     */
    await practiseOffline();
    await reconnect();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    follow("Sonare");
    await onScreen("Today");

    // Two days now — yesterday came from the other device — and a best run of
    // four that this device has never seen.
    expect(screen.getByText("Streak").closest("div")).toHaveTextContent("2days");
    expect(screen.getByText("Best run").closest("div")).toHaveTextContent("4days");
    expect(screen.getByText("This week").closest("div")).toHaveTextContent("2of 7 days");

    await visit(`#/${FRENCH.slug}/progress`);
    await onScreen(`${FRENCH.label} progress`);
    // Three activities were passed here and activity 5 elsewhere.
    expect(screen.getByText(`4 of ${FRENCH.activities.length} passed`)).toBeInTheDocument();
  });

  it("can show a trend the device alone had no history for", async () => {
    /**
     * Seven samples of "jour" arrive where this device recorded one, which is
     * the first moment `trendFor` has history either side of its window. A
     * learner who practises on a phone and a laptop gets one record, and this
     * is the visible consequence.
     */
    await practiseOffline();
    await reconnect();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    await visit(`#/${FRENCH.slug}/progress`);
    await onScreen(`${FRENCH.label} progress`);

    const table = screen.getByRole("columnheader", { name: "Syllable" }).closest("table");
    if (table === null) throw new Error("the sounds table lost its own header");
    const row = within(table).getByText("jour").closest("tr");
    // now = mean of the last five (44,60,62,64,66) = 59; before = mean of
    // (40,42) = 41. Rising, so it is reported as a gain rather than a dash.
    expect(row).toHaveTextContent("59");
    expect(row).toHaveTextContent("41");
    expect(row?.querySelector(".gain")).not.toBeNull();
  });

  it("still says nothing to the learner about any of it", async () => {
    // A successful sync is as silent as a failed one. There is nothing for
    // the learner to do about either.
    await practiseOffline();
    await reconnect();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    for (const text of announcements()) {
      expect(text).not.toMatch(/sync|synced|uploaded|saved to the server/i);
    }
  });
});

describe("a merge that lands while the learner is still practising", () => {
  /**
   * A real defect, pinned rather than described.
   *
   * `useSync` fires on the `online` event whether or not a screen is open, and
   * the activity screen holds its progress in React state and writes the whole
   * thing to storage on every change:
   *
   *   src/pages/ActivityTest.tsx:117
   *     useEffect(() => {
   *       progressStore.save({ index, progress, finished });
   *     }, [index, progress, finished, progressStore.save]);
   *
   * So a merge that lands mid-session is written to storage by the engine and
   * then wiped by the screen's next save, which knows nothing about it. The
   * other device's activity disappears from this device's record the moment
   * the learner presses "Next activity".
   *
   * `useSync` already has the hook for the fix — `onSynced`, documented in
   * `src/sync/useSync.ts:35` as "called after each attempt, for a screen that
   * wants to refresh" — and `src/App.tsx:253` passes only `learnerName`, so
   * nothing is ever told.
   *
   * Bounded rather than catastrophic, which is why it is pinned and not
   * escalated: the server's copy is untouched, the merge is monotonic, and the
   * next sync pulls the entry back. The cost is a learner who looks at
   * Progress in between and is under-told what they have done.
   *
   * Marked `.fails` so it records today's behaviour without going green on it,
   * and starts failing the moment somebody wires `onSynced` up — which is the
   * signal to delete it.
   */
  it.fails("keeps another device's activity when the learner advances", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, scored(80));
    await waitFor(() => expect(nextButton()).not.toBeNull());

    await reconnect();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    // The engine did write it.
    expect(persistedProgress().progress.map((p) => p.activityId)).toContain(5);

    press(/Next activity/);
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
        FRENCH.activities[1]?.title ?? "",
      ),
    );

    expect(persistedProgress().progress.map((p) => p.activityId)).toContain(5);
  });
});

describe("a reply that is not a record", () => {
  it("keeps the local record and keeps the work marked unsent", async () => {
    /**
     * A captive portal, a proxy or a stale service worker can all answer with
     * something shaped like JSON. Writing that over a learner's practice would
     * be worse than doing nothing, so the flags stay and the next attempt
     * sends the same work again.
     */
    await practiseOffline();
    const before = persistedProgress();

    reachable = true;
    log.mock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      log.calls.push(`${init?.method ?? "GET"} ${url}`);
      return {
        ok: true,
        status: 200,
        json: async () => (url.includes("/api/v1/learners") ? { token: TOKEN } : { nonsense: true }),
      } as unknown as Response;
    });
    await act(async () => void window.dispatchEvent(new Event("online")));

    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    expect(persistedProgress()).toEqual(before);
    expect(dirty()).toEqual({ progress: [FRENCH.slug], skills: [FRENCH.slug], streak: true });
  });
});
