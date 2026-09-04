// @vitest-environment jsdom

/**
 * The transparency panel, which is a privacy claim rendered as a table.
 *
 * It says, in text, that nothing is collected until an activity starts and
 * the microphone is granted. That sentence is only true if the panel itself
 * touches no microphone API — so the test that matters here asserts an
 * absence: rendering this must not call getUserMedia, enumerateDevices, or
 * construct an AudioContext. A well-meant addition of "microphone: available"
 * would trigger a permission prompt on the home screen and make the
 * reassurance beside it false.
 *
 * The two rows carrying warnings are the other half. "secure context: NO"
 * is the single most useful diagnostic this product has — it is the reason a
 * phone pointed at a LAN address cannot record, and without it that failure
 * looks like a broken microphone.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceMetaPanel } from "./DeviceMetaPanel.js";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const getUserMedia = vi.fn();
const enumerateDevices = vi.fn();
const audioContext = vi.fn();

function stubEnvironment(options: {
  userAgent?: string;
  online?: boolean;
  secure?: boolean;
  effectiveType?: string | undefined;
  language?: string;
} = {}): void {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: options.userAgent ?? IPHONE });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: options.online ?? true });
  Object.defineProperty(navigator, "language", { configurable: true, value: options.language ?? "en-GB" });
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: options.effectiveType === undefined ? undefined : { effectiveType: options.effectiveType },
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices },
  });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: options.secure ?? true });
  vi.stubGlobal("AudioContext", audioContext);
}

/** The value cell for a labelled row. */
function rowValue(label: string): string {
  const cells = [...document.querySelectorAll("tr")];
  const row = cells.find((tr) => tr.querySelector("td")?.textContent === label);
  if (!row) throw new Error(`no row labelled "${label}"`);
  return row.querySelectorAll("td")[1]?.textContent ?? "";
}

beforeEach(() => {
  getUserMedia.mockClear();
  enumerateDevices.mockClear();
  audioContext.mockClear();
  stubEnvironment();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the privacy claim it makes in text", () => {
  it("touches no microphone API at all", () => {
    /**
     * The assertion the panel's own promise depends on. Adding a
     * "microphone: available" row would fire a permission prompt on the home
     * screen — before a learner has chosen to do anything — and make the
     * sentence underneath it untrue.
     */
    render(<DeviceMetaPanel />);

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(audioContext).not.toHaveBeenCalled();
  });

  it("states plainly that nothing is collected yet", () => {
    // The reassurance is the point of the panel; the table is the evidence.
    render(<DeviceMetaPanel />);

    expect(screen.getByText(/Nothing here is collected until you start an activity/)).toBeInTheDocument();
  });

  it("starts collapsed, so it informs without confronting", () => {
    // A wall of device detail as the first thing on the home screen reads as
    // a warning rather than as transparency.
    render(<DeviceMetaPanel />);

    expect(document.querySelector("details")).not.toHaveAttribute("open");
    expect(screen.getByText("What Sonare can see about this device")).toBeInTheDocument();
  });
});

describe("the two rows that are diagnostics", () => {
  it("warns that an insecure context will not open the microphone", () => {
    /**
     * The single most useful diagnostic in the product. A phone pointed at
     * http://<lan-ip> is not a secure context, so getUserMedia is simply
     * unavailable — and without this row that presents as a broken
     * microphone, which has cost real debugging time on this project.
     */
    stubEnvironment({ secure: false });

    render(<DeviceMetaPanel />);

    expect(rowValue("secure context")).toBe("NO — mic will not open");
  });

  it("says yes without alarm when the context is secure", () => {
    render(<DeviceMetaPanel />);

    expect(rowValue("secure context")).toBe("yes");
  });

  it("warns that being offline means nothing can be scored", () => {
    // Scoring is a network round trip. Recording a phrase that cannot be
    // scored wastes the learner's effort, so the warning has to precede it.
    stubEnvironment({ online: false });

    render(<DeviceMetaPanel />);

    expect(rowValue("online")).toBe("NO — recordings can't be scored");
  });

  it("names the consequence rather than just the state", () => {
    /**
     * "secure context: false" is true and useless to everyone who does not
     * already know what a secure context is. Both warning rows say what will
     * happen, which is what makes this panel worth reading on someone else's
     * phone.
     */
    stubEnvironment({ secure: false, online: false });

    render(<DeviceMetaPanel />);

    expect(rowValue("secure context")).toContain("mic will not open");
    expect(rowValue("online")).toContain("can't be scored");
  });
});

describe("what it reports", () => {
  it("shows the parsed device alongside the raw agent", () => {
    // The parsed line is readable; the raw string is what gets pasted into a
    // bug report, and one is not a substitute for the other.
    render(<DeviceMetaPanel />);

    expect(rowValue("device")).toBe("iPhone 17.5.1 · Safari 17");
    expect(rowValue("user agent")).toBe(IPHONE);
  });

  it("reports the connection type when the browser offers one", () => {
    // Chrome and Android do; it is the closest thing to a bandwidth signal
    // available when a slow upload needs explaining.
    stubEnvironment({ effectiveType: "4g" });

    render(<DeviceMetaPanel />);

    expect(rowValue("connection")).toBe("4g");
  });

  it("says 'not reported' rather than guessing when it does not", () => {
    /**
     * Safari has no Network Information API. The same distinction R5 draws
     * about capture constraints applies here: "not reported" and a value are
     * different facts, and inventing one would be worse than the gap.
     */
    stubEnvironment({ effectiveType: undefined });

    render(<DeviceMetaPanel />);

    expect(rowValue("connection")).toBe("not reported");
  });

  it("reports the browser's language, not the language being taught", () => {
    // These differ for every learner, and it is the browser's that steers
    // fonts and input behaviour.
    stubEnvironment({ language: "hi-IN" });

    render(<DeviceMetaPanel />);

    expect(rowValue("language")).toBe("hi-IN");
  });

  it("reports screen and viewport separately", () => {
    /**
     * Not redundant on the device that matters: an iPhone's viewport is much
     * shorter than its screen once Safari's chrome is counted, and a layout
     * bug reported from a phone is usually about the viewport.
     */
    render(<DeviceMetaPanel />);

    expect(rowValue("screen")).toMatch(/^\d+×\d+ @\d+(\.\d+)?x$/);
    expect(rowValue("viewport")).toMatch(/^\d+×\d+$/);
  });

  it("keeps a long user agent scrollable instead of stretching the page", () => {
    // These strings are ~150 characters and this panel renders on a phone.
    render(<DeviceMetaPanel />);

    expect(document.querySelector(".scroll-x")).toBeInTheDocument();
  });
});

describe("degrading on an unusual browser", () => {
  it("renders when the browser reports no connection object", () => {
    stubEnvironment({ effectiveType: undefined });

    expect(() => render(<DeviceMetaPanel />)).not.toThrow();
  });

  it("renders with a stripped user agent", () => {
    // A privacy extension can empty it. The panel is the wrong place to fail.
    stubEnvironment({ userAgent: "" });

    expect(() => render(<DeviceMetaPanel />)).not.toThrow();
    expect(rowValue("device")).toBe("? · ?");
  });
});
