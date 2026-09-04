// @vitest-environment jsdom

/**
 * The upload path, which decides three things a learner feels directly: how
 * long they wait, whether a flaky connection costs them a take, and whether a
 * failure costs them money.
 *
 * The retry policy is the part most worth pinning. Re-sending audio the server
 * already refused just earns the same refusal, and re-sending a request we
 * abandoned on a deadline may double-bill Azure — so what is retried, and what
 * deliberately is not, is a decision rather than an accident.
 *
 * `fetch` is stubbed per test. Timers are faked so the 600/1800ms backoff does
 * not make the suite wait for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoreRecording, ScoringError } from "./client.js";
import type { ScoreRequest } from "./client.js";
import type { PronunciationResult } from "./types.js";

const SCORED: PronunciationResult = {
  indeterminate: false,
  provider: "azure",
  recognized: "Bonjour",
  overall: 93,
  accuracy: 95,
  fluency: 90,
  completeness: 100,
  words: [],
};

function request(): ScoreRequest {
  return {
    wav: new Blob([new Uint8Array(64)], { type: "audio/wav" }),
    referenceText: "Bonjour, comment allez-vous",
    language: "fr-FR",
    contextSampleRate: 48000,
    granted: {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
      channelCount: 1,
      sampleRate: 48000,
      deviceId: "abc",
    },
    sessionId: "session-1",
    activityId: 3,
    snrDb: 24,
    peakDbfs: -6,
    endpoint: { thresholdDb: -40, noiseFloorDb: -60, peakDb: -8, autoStopped: true },
  };
}

/** Scoring calls; the fire-and-forget diagnostics pings are filtered out. */
function scoringCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes("/pronunciation"));
}

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  fetchMock = vi.fn();
  // A default, because every path fires a fire-and-forget diagnostics ping and
  // a bare vi.fn() returns undefined — on which the code's own `.catch()`
  // throws. Tests override this for the scoring call they care about.
  fetchMock.mockResolvedValue(json({}));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("scoreRecording — success", () => {
  it("returns the provider result and sends the take once", async () => {
    fetchMock.mockResolvedValue(json(SCORED));

    const result = await scoreRecording(request());

    expect(result).toEqual(SCORED);
    expect(scoringCalls(fetchMock)).toHaveLength(1);
  });

  it("sends the reference text, language and session as multipart fields", async () => {
    fetchMock.mockResolvedValue(json(SCORED));

    await scoreRecording(request());

    const [, init] = scoringCalls(fetchMock)[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get("referenceText")).toBe("Bonjour, comment allez-vous");
    expect(form.get("language")).toBe("fr-FR");
    expect(form.get("sessionId")).toBe("session-1");
    // Every field multer sees is a string, including the numeric one.
    expect(form.get("activityId")).toBe("3");
  });

  it("omits the learner name entirely when there isn't one", async () => {
    fetchMock.mockResolvedValue(json(SCORED));

    await scoreRecording(request());

    const [, init] = scoringCalls(fetchMock)[0] as [string, RequestInit];
    expect((init.body as FormData).get("learnerName")).toBeNull();
  });
});

describe("scoreRecording — offline", () => {
  it("fails immediately rather than waiting for the network stack to notice", async () => {
    // A browser can take 10s+ to reject a fetch while offline, which is 10s
    // of the learner watching "Scoring…" for a request that cannot succeed.
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });

    await expect(scoreRecording(request())).rejects.toMatchObject({
      code: "OFFLINE",
      domain: "network",
    });
    expect(scoringCalls(fetchMock)).toHaveLength(0);
  });
});

describe("scoreRecording — retries", () => {
  it("retries a dropped connection and succeeds on the second attempt", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(json(SCORED));

    const promise = scoreRecording(request());
    await vi.advanceTimersByTimeAsync(600);

    await expect(promise).resolves.toEqual(SCORED);
    expect(scoringCalls(fetchMock)).toHaveLength(2);
  });

  it("gives up after two retries rather than retrying forever", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const promise = scoreRecording(request());
    const assertion = expect(promise).rejects.toMatchObject({ code: "NETWORK_FAILED" });
    await vi.advanceTimersByTimeAsync(600 + 1800);
    await assertion;

    // Initial attempt plus two retries.
    expect(scoringCalls(fetchMock)).toHaveLength(3);
  });

  it("does NOT retry a rejection the server reasoned about", async () => {
    // Re-sending audio the server already refused earns the same refusal and
    // costs another round trip on a connection that is evidently working.
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            code: "BAD_AUDIO_FORMAT",
            domain: "client",
            message: "unexpected format",
            userMessage: "That recording was in an unexpected format.",
          },
        },
        400,
      ),
    );

    await expect(scoreRecording(request())).rejects.toMatchObject({ code: "BAD_AUDIO_FORMAT" });
    expect(scoringCalls(fetchMock)).toHaveLength(1);
  });

  it("surfaces the server's own user-facing message", async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            code: "PROVIDER_TIMEOUT",
            domain: "provider",
            message: "Scoring timed out. Please try again.",
            userMessage: "Scoring timed out. Please try again.",
          },
        },
        502,
      ),
    );

    await expect(scoreRecording(request())).rejects.toBeInstanceOf(ScoringError);
    await expect(scoreRecording(request())).rejects.toMatchObject({
      domain: "provider",
      userMessage: "Scoring timed out. Please try again.",
    });
  });
});

describe("scoreRecording — the upload deadline", () => {
  it("aborts a stalled upload instead of hanging forever", async () => {
    // A dropped connection rejects fast; a *stalled* one does not, and
    // stalling is the normal failure on a train or in a lift. Without a
    // deadline the promise simply never settles.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (String(_url).includes("/diagnostics")) return Promise.resolve(json({}));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const promise = scoreRecording(request());
    const assertion = expect(promise).rejects.toMatchObject({ code: "UPLOAD_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
  });

  it("does not retry after a timeout, so a slow network cannot double-bill", async () => {
    // A fetch that rejects immediately never reached the scorer. One still
    // pending after 25s may already have been billed by Azure, and
    // auto-resending would charge twice on exactly the flaky connections
    // where it happens most.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (String(_url).includes("/diagnostics")) return Promise.resolve(json({}));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const promise = scoreRecording(request());
    const assertion = expect(promise).rejects.toMatchObject({ code: "UPLOAD_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(25_000 + 600 + 1800);
    await assertion;

    expect(scoringCalls(fetchMock)).toHaveLength(1);
  });
});

describe("scoreRecording — timing diagnostics", () => {
  it("reports the outcome and retry count without failing the take", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(json(SCORED));

    const promise = scoreRecording(request());
    await vi.advanceTimersByTimeAsync(600);
    await promise;

    const ping = fetchMock.mock.calls.find((c) => String(c[0]).includes("/diagnostics"));
    expect(ping).toBeDefined();
    const body = JSON.parse((ping?.[1] as RequestInit).body as string) as {
      code: string;
      context: { retryCount: number; outcome: string };
    };
    expect(body.code).toBe("SCORE_TIMING");
    expect(body.context.outcome).toBe("success");
    expect(body.context.retryCount).toBe(1);
  });

  it("still returns the score when the diagnostics ping itself fails", async () => {
    // Fire-and-forget means exactly that: a learner's result must never
    // depend on a telemetry write.
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("/diagnostics")
        ? Promise.reject(new Error("diagnostics down"))
        : Promise.resolve(json(SCORED)),
    );

    await expect(scoreRecording(request())).resolves.toEqual(SCORED);
  });
});
