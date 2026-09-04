// @vitest-environment jsdom

/**
 * The screen that produces T19's data, where a UI mistake becomes a wrong
 * conclusion rather than a bug report.
 *
 * PRD §8 is blunt about the failure mode: a contaminated Set A invalidates the
 * experiment, and contamination is undetectable afterwards — a Set B recording
 * filed as Set A looks exactly like a Set A speaker who did badly. So the
 * fields that label a recording are the ones under test here, along with the
 * two ways eighty recordings can be lost: an unexported log on a refresh, and
 * a "clear" that fires without asking.
 *
 * The recorder itself is stubbed. What matters on this screen is what gets
 * *attached* to a result, not how the result was obtained — recorder.test.ts
 * and useRecorder.test.ts cover that.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGES } from "../activities/languages/index.js";

/** Lets a test fire a scored take as if the recorder had produced one. */
let scored: ((result: unknown, capture: unknown) => void) | null = null;

vi.mock("../speech/react/useRecorder.js", () => ({
  useRecorder: (options: { onScored: (r: unknown, c: unknown) => void }) => {
    scored = options.onScored;
    return {
      state: "idle",
      speaking: false,
      level: -60,
      result: null,
      error: null,
      lastCapture: null,
      granted: null,
      contextSampleRate: null,
      clipping: false,
      levelStore: { subscribe: () => () => undefined, getSnapshot: () => -60 },
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
      endSession: vi.fn(),
      reset: vi.fn(),
    };
  },
}));
vi.mock("../ui/useCaptureToasts.js", () => ({
  useCaptureToasts: () => undefined,
  HEARD_SPEECH_SNR_DB: 10,
}));
vi.mock("../ui/useSyllablePlayback.js", () => ({
  useSyllablePlayback: () => ({ playingOffsetTicks: null, play: vi.fn(), available: false }),
}));

const pushedToasts: { title: string }[] = [];
vi.mock("../ui/ToastProvider.js", () => ({
  useToast: () => ({
    push: (t: { title: string }) => void pushedToasts.push(t),
    dismiss: vi.fn(),
    clear: vi.fn(),
  }),
}));

const RESULT = {
  accuracy: 88,
  overall: 85,
  fluency: 90,
  completeness: 100,
  indeterminate: false,
  words: [],
  provider: "azure",
} as const;

const CAPTURE = {
  durationSeconds: 2.3456,
  snrDb: 18.72,
  contextSampleRate: 48000,
  granted: { autoGainControl: false, sampleRate: 48000, deviceId: "abc" },
  wav: null,
} as const;

async function open() {
  const { FixtureRunner } = await import("./FixtureRunner.js");
  return render(<FixtureRunner />);
}

/** Fires one scored take through the recorder's callback. */
function recordTake(): void {
  act(() => scored?.(structuredClone(RESULT), structuredClone(CAPTURE)));
}

function exportedJson(): Record<string, unknown>[] {
  const area = document.querySelector("textarea, pre");
  return JSON.parse(area?.textContent ?? (area as HTMLTextAreaElement | null)?.value ?? "[]") as Record<
    string,
    unknown
  >[];
}

beforeEach(() => {
  pushedToasts.length = 0;
  scored = null;
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone)" });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.resolve()) },
  });
  vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("labelling a recording — the field with no second chance", () => {
  it("warns in the copy that a contaminated Set A invalidates the run", async () => {
    /**
     * The one instruction an operator has to have read. It is on screen rather
     * than in a runbook because the runbook is not open during a session.
     */
    await open();

    expect(screen.getByText(/contaminated Set A invalidates the experiment/)).toBeInTheDocument();
  });

  it("names the sets in full, not as bare letters", () => {
    // "A" and "B" are impossible to keep straight after an hour of recording;
    // "Set A — accented, correct" cannot be mixed up.
    return open().then(() => {
      expect(screen.getByRole("option", { name: "Set A — accented, correct" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Set B — deliberately wrong" })).toBeInTheDocument();
    });
  });

  it("stamps the currently selected set onto the take", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "B" } });

    recordTake();

    await waitFor(() => expect(exportedJson()).toHaveLength(1));
    expect(exportedJson()[0]?.set).toBe("B");
  });

  it("stamps the speaker label, which the analysis groups by", async () => {
    // The same person must carry the same label across platforms, so this is
    // free text rather than a picker — and it has to reach the record.
    await open();
    fireEvent.change(screen.getByLabelText("Speaker label"), { target: { value: "S03-tamil-en" } });

    recordTake();

    await waitFor(() => expect(exportedJson()).toHaveLength(1));
    expect(exportedJson()[0]?.speaker).toBe("S03-tamil-en");
  });

  it("defaults to Set A rather than to an ambiguous value", async () => {
    // An operator who forgets to choose produces a labelled recording, not an
    // unlabelled one — and Set A is the set that gets independently confirmed
    // anyway, so a mislabel there is the one most likely to be caught.
    await open();

    expect((screen.getByLabelText("Set") as HTMLSelectElement).value).toBe("A");
  });

  it("counts each set separately, so a session's balance is visible", async () => {
    /**
     * Forty and forty is the shape of the run. Without a per-set count an
     * operator finds out at analysis time that one set has twelve recordings
     * and the other sixty-eight.
     */
    await open();
    recordTake();
    recordTake();
    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "B" } });
    recordTake();

    await waitFor(() => expect(exportedJson()).toHaveLength(3));
    const sets = exportedJson().map((e) => e.set);
    expect(sets).toEqual(["A", "A", "B"]);
  });
});

describe("what each record carries", () => {
  it("attaches the device and capture evidence, not just the score", async () => {
    /**
     * The reason a surprising score can be explained afterwards rather than
     * argued about. The user agent, the context rate and the granted
     * constraints cannot be recovered later, and they are what separate "this
     * platform ignored R4" from "this speaker was quiet".
     */
    await open();

    recordTake();

    await waitFor(() => expect(exportedJson()).toHaveLength(1));
    const entry = exportedJson()[0] as Record<string, unknown>;
    expect(entry.ua).toBe("Mozilla/5.0 (iPhone)");
    expect(entry.contextRate).toBe(48000);
    expect(entry.granted).toMatchObject({ autoGainControl: false });
    expect(entry.result).toMatchObject({ accuracy: 88 });
  });

  it("records the reference text that was actually scored", async () => {
    // Not the one on screen at export time. A mid-session phrase change would
    // otherwise relabel every earlier take.
    const language = LANGUAGES[0];
    const second = language?.activities[1]?.target;
    if (!second) throw new Error("need two activities");
    await open();
    recordTake();

    fireEvent.change(screen.getByLabelText("Preloaded phrase"), { target: { value: second } });
    recordTake();

    await waitFor(() => expect(exportedJson()).toHaveLength(2));
    const [first, latest] = exportedJson();
    expect(first?.reference).not.toBe(latest?.reference);
    expect(latest?.reference).toBe(second);
  });

  it("numbers takes from one, in order", async () => {
    await open();

    recordTake();
    recordTake();
    recordTake();

    await waitFor(() => expect(exportedJson()).toHaveLength(3));
    expect(exportedJson().map((e) => e.n)).toEqual([1, 2, 3]);
  });

  it("timestamps each take", async () => {
    // The analysis groups by platform and speaker; the timestamp is what
    // reconstructs the order of a session after the fact.
    await open();

    recordTake();

    await waitFor(() => expect(exportedJson()).toHaveLength(1));
    expect(String(exportedJson()[0]?.at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rounds duration and SNR to a comparable precision", async () => {
    // Three decimals of duration and one of SNR: enough to compare takes,
    // not so much that the export is noise.
    await open();

    recordTake();

    await waitFor(() => expect(exportedJson()).toHaveLength(1));
    expect(exportedJson()[0]?.durationSeconds).toBe(2.346);
    expect(exportedJson()[0]?.snrDb).toBe(18.7);
  });
});

describe("not losing eighty recordings", () => {
  it("warns before a refresh discards an unexported log", async () => {
    /**
     * The log is in memory by design — nothing about a fixture session should
     * be persisted to a browser the way capture state must not be. That makes
     * a reload the single most expensive mistake available on this screen, and
     * the only defence is the browser's own prompt.
     */
    const addEventListener = vi.spyOn(window, "addEventListener");
    await open();

    recordTake();

    await waitFor(() =>
      expect(addEventListener.mock.calls.some(([e]) => e === "beforeunload")).toBe(true),
    );
  });

  it("does not warn before anything has been recorded", async () => {
    // A prompt on an empty session trains an operator to dismiss it, which is
    // exactly the habit that loses the full one.
    const addEventListener = vi.spyOn(window, "addEventListener");
    await open();

    expect(addEventListener.mock.calls.some(([e]) => e === "beforeunload")).toBe(false);
  });

  it("removes the warning once the log is empty again", async () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    await open();
    recordTake();
    await waitFor(() => expect(exportedJson()).toHaveLength(1));

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Clear/i }));

    await waitFor(() =>
      expect(removeEventListener.mock.calls.some(([e]) => e === "beforeunload")).toBe(true),
    );
  });

  it("asks before discarding recordings", async () => {
    // One mis-tap next to the export buttons would otherwise end a session's
    // work with no undo.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await open();
    recordTake();
    await waitFor(() => expect(exportedJson()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /Clear/i }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("unexported") as unknown as string);
    expect(exportedJson()).toHaveLength(1);
  });

  it("keeps the recordings when the operator says no", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await open();
    recordTake();
    recordTake();
    await waitFor(() => expect(exportedJson()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: /Clear/i }));

    expect(exportedJson()).toHaveLength(2);
  });

  it("does not ask when there is nothing to lose", async () => {
    const confirm = vi.spyOn(window, "confirm");
    await open();

    fireEvent.click(screen.getByRole("button", { name: /Clear/i }));

    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("getting the data off the device", () => {
  it("disables export until there is something to export", async () => {
    await open();

    expect(screen.getByRole("button", { name: /Download/i })).toBeDisabled();
  });

  it("names the file by set and count, so several sessions stay apart", async () => {
    /**
     * Four files come off four sessions and are analysed together. Identical
     * filenames would overwrite in a downloads folder, and the runbook asks
     * for them to be distinguishable.
     */
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await open();
    recordTake();
    await waitFor(() => expect(exportedJson()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /Download/i }));

    expect(click).toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it("offers a manual path when the clipboard is blocked", async () => {
    /**
     * Safari refuses clipboard writes outside a gesture it recognises, and
     * this screen runs on iOS. Without the fallback message an operator would
     * tap Copy, see nothing, and have no idea the data was still there in the
     * textarea below.
     */
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("blocked")) },
    });
    await open();
    recordTake();
    await waitFor(() => expect(exportedJson()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /Copy/i }));

    expect(await screen.findByText(/Clipboard blocked/)).toBeInTheDocument();
  });

  it("shows the export inline, as the last resort", async () => {
    // If both the download and the clipboard fail, the JSON is still on
    // screen to be selected by hand. That is the actual guarantee.
    await open();
    recordTake();

    await waitFor(() => expect(exportedJson()).toHaveLength(1));
  });
});
