// @vitest-environment jsdom

/**
 * The live feedback shown while recording, and what it deliberately is not.
 *
 * Everything on this panel is computed locally from audio we already have. No
 * network, no partial hypotheses from the recogniser: R6 keeps the scoring
 * path batch-only, and a plausible-looking live transcript would be worse than
 * none, because a learner would read it as what the scorer heard. So the first
 * group asserts an absence — that nothing here can be mistaken for
 * transcription — which is the kind of property that erodes quietly when
 * somebody adds "just a preview".
 *
 * What it does provide is the thing a partial transcript is usually wanted
 * for: proof the microphone is hearing you, and warning that the take is about
 * to end on its own.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InterimFeedback } from "./InterimFeedback.js";

const HANGOVER = 1200;

let now = 0;

beforeEach(() => {
  now = 0;
  vi.useFakeTimers();
  vi.stubGlobal("performance", { now: () => now });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Moves the shared clock and lets the 100ms interval catch up. */
function advance(ms: number): void {
  act(() => {
    now += ms;
    vi.advanceTimersByTime(ms);
  });
}

function panel(props: Partial<Parameters<typeof InterimFeedback>[0]> = {}) {
  return render(
    <InterimFeedback
      recording
      speaking={false}
      level={-20}
      hangoverMs={HANGOVER}
      autoStop
      {...props}
    />,
  );
}

describe("it is not transcription", () => {
  it("renders nothing at all when not recording", () => {
    // No residue between takes: a panel left on screen after a take would
    // describe a recording that has ended.
    const { container } = panel({ recording: false });

    expect(container).toBeEmptyDOMElement();
  });

  it("says only whether it is hearing you, never what it heard", () => {
    /**
     * The absence that matters. "waiting for speech" and "hearing you" are
     * claims about the microphone; a word of the learner's phrase would be a
     * claim about the scorer, which nothing here is in a position to make.
     */
    panel({ speaking: true });

    expect(screen.getByText("hearing you")).toBeInTheDocument();
    expect(screen.queryByText(/bonjour|café|voudrais/i)).not.toBeInTheDocument();
  });

  it("stays out of the screen-reader queue entirely", () => {
    /**
     * A region that updated politely would announce the elapsed-time figure
     * ten times a second over a learner who is mid-phrase. The panel is
     * glanceable by design and silent to a reader; the level meter carries the
     * one announcement worth interrupting for.
     */
    panel();

    expect(document.querySelector(".interim")).toHaveAttribute("aria-live", "off");
  });
});

describe("proof the microphone is hearing you", () => {
  it("waits for speech before claiming to hear any", () => {
    // Claiming to hear a learner who has not started is the one thing that
    // would make them distrust the panel for the rest of the session.
    panel({ speaking: false });

    expect(screen.getByText("waiting for speech")).toBeInTheDocument();
    expect(screen.queryByText("hearing you")).not.toBeInTheDocument();
  });

  it("marks the indicator once speech is detected", () => {
    panel({ speaking: true });

    expect(document.querySelector(".listening")).toHaveClass("heard");
  });

  it("counts elapsed time from the start of the take", () => {
    // The learner's own sense of how long they have been talking, against a
    // 15-second ceiling they cannot see.
    panel();

    advance(2500);

    expect(screen.getByText("2.5s")).toBeInTheDocument();
  });

  it("restarts the clock on a new take rather than accumulating", () => {
    /**
     * Three attempts per activity, ten activities. A timer that carried across
     * takes would read 40s on the third attempt of the first activity and make
     * the auto-stop look broken.
     */
    const { rerender } = panel();
    advance(3000);

    rerender(
      <InterimFeedback recording={false} speaking={false} level={-20} hangoverMs={HANGOVER} autoStop />,
    );
    rerender(<InterimFeedback recording speaking={false} level={-20} hangoverMs={HANGOVER} autoStop />);
    advance(500);

    expect(screen.getByText("0.5s")).toBeInTheDocument();
    expect(screen.queryByText("3.5s")).not.toBeInTheDocument();
  });
});

describe("warning that the take is about to end", () => {
  it("counts down once speech has been heard and then stops", () => {
    /**
     * The countdown is the panel's most useful output: a learner who pauses
     * mid-phrase can see they have a moment left, instead of being cut off
     * and not knowing why.
     */
    const { rerender } = panel({ speaking: true, level: -20 });
    advance(200);

    // Silence: the level drops below the display heuristic.
    rerender(<InterimFeedback recording speaking level={-80} hangoverMs={HANGOVER} autoStop />);
    advance(600);

    expect(screen.getByText(/stops in 0\.[0-9]s if you stay quiet/)).toBeInTheDocument();
  });

  it("keeps the silence budget near full while the learner is audible", () => {
    /**
     * I first wrote this expecting no bar at all during speech, and that was
     * wrong about the design. `closing` is true from the first tick after
     * speech is detected, so the bar is a persistent silence *budget* rather
     * than a warning that fires late: full while you are talking, draining
     * when you pause. That is the more useful shape — a learner can see how
     * much pause they have before the take ends, instead of finding out.
     *
     * The level is varied here rather than held constant because that is what
     * a microphone produces, and it has to be, which is worth recording: the
     * effect refreshing the last-loud timestamp is keyed on `[level,
     * recording]`, so it fires when the level *value changes*, not while the
     * level is loud. Real audio at 30 Hz varies on essentially every frame, so
     * this is sound in practice; a perfectly steady tone would read as
     * silence. Worth knowing before anyone quantises or memoises the level
     * upstream.
     */
    const { rerender } = panel({ speaking: true, level: -20 });

    for (const level of [-19, -21, -18, -22, -20, -17, -23, -20]) {
      rerender(<InterimFeedback recording speaking level={level} hangoverMs={HANGOVER} autoStop />);
      advance(100);
    }

    const width = (document.querySelector(".interim-bar > i") as HTMLElement | null)?.style.width ?? "";
    expect(Number(width.replace("%", ""))).toBeGreaterThan(85);
  });

  it("drains the budget once the learner stops", () => {
    // The half that carries the information: a pause visibly costs something.
    const { rerender } = panel({ speaking: true, level: -20 });
    advance(100);
    const before = (document.querySelector(".interim-bar > i") as HTMLElement).style.width;

    rerender(<InterimFeedback recording speaking level={-80} hangoverMs={HANGOVER} autoStop />);
    advance(600);
    const after = (document.querySelector(".interim-bar > i") as HTMLElement).style.width;

    expect(Number(after.replace("%", ""))).toBeLessThan(Number(before.replace("%", "")));
    expect(Number(after.replace("%", ""))).toBeGreaterThan(0);
  });

  it("says it is finishing rather than showing a negative countdown", () => {
    const { rerender } = panel({ speaking: true, level: -20 });
    advance(100);
    rerender(<InterimFeedback recording speaking level={-80} hangoverMs={HANGOVER} autoStop />);

    advance(HANGOVER + 400);

    expect(screen.getByText("finishing…")).toBeInTheDocument();
  });

  it("promises no auto-stop when auto-stop is off", () => {
    /**
     * With manual stop the take ends when the learner taps, so a countdown
     * would be a promise the recorder is not going to keep — and they would
     * stop talking waiting for it.
     */
    const { rerender } = panel({ speaking: true, autoStop: false, level: -20 });
    advance(100);
    rerender(
      <InterimFeedback recording speaking level={-80} hangoverMs={HANGOVER} autoStop={false} />,
    );
    advance(700);

    expect(screen.queryByText(/stops in/)).not.toBeInTheDocument();
  });

  it("does not count down before any speech has been heard", () => {
    // Before the first word there is nothing to end. A countdown from the
    // moment recording starts would expire before a learner drew breath.
    panel({ speaking: false, level: -80 });

    advance(1000);

    expect(screen.queryByText(/stops in/)).not.toBeInTheDocument();
  });

  it("scales the bar to the time actually remaining", () => {
    const { rerender } = panel({ speaking: true, level: -20 });
    advance(100);
    rerender(<InterimFeedback recording speaking level={-80} hangoverMs={HANGOVER} autoStop />);
    advance(600);

    const width = (document.querySelector(".interim-bar > i") as HTMLElement | null)?.style.width ?? "";
    const percent = Number(width.replace("%", ""));
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThan(100);
  });
});

describe("the interval", () => {
  it("stops ticking when recording ends", () => {
    // Left running, it would keep calling setState on a panel that renders
    // null, once every 100ms, for as long as the page is open.
    const { rerender } = panel();
    advance(300);

    rerender(
      <InterimFeedback recording={false} speaking={false} level={-20} hangoverMs={HANGOVER} autoStop />,
    );

    expect(() => advance(5000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops ticking on unmount", () => {
    const { unmount } = panel();
    advance(300);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
