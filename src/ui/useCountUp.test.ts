// @vitest-environment jsdom

/**
 * The score reveal — the highest-stakes moment in the flow, since the learner
 * has just spoken and is waiting to find out how it went.
 *
 * The `from` parameter is the part worth testing. Counting up from zero states
 * the score; counting up from the learner's previous best states the
 * *improvement*, which is what they actually want to know on attempt two. The
 * motion carries a comparison the number does not have to explain — and if
 * `from` were ignored, or defaulted wrongly on a repeat, the animation would
 * quietly stop saying anything.
 *
 * The other half is reduced motion. This one cannot lean on the global CSS
 * kill-switch in styles.css because the animation is numeric, driven from
 * requestAnimationFrame — so the preference has to be honoured in JS or it is
 * not honoured at all, on the one screen where a learner is most likely to be
 * watching intently.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCountUp } from "./useCountUp.js";

const DURATION = 650;

let now = 0;
let frames: ((t: number) => void)[] = [];
let cancelled: number[] = [];

/** Drives requestAnimationFrame by hand so the easing curve is inspectable. */
function installClock(): void {
  now = 0;
  frames = [];
  cancelled = [];
  vi.stubGlobal("performance", { now: () => now });
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void cancelled.push(id));
}

function reduceMotion(reduce: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  );
}

/**
 * Advances to an absolute `ms` and runs whatever frame is pending. Never
 * moves backwards, because `performance.now()` never does — and the hook
 * captures its own start time from that clock, so a backwards step would
 * produce a negative progress value and an easing curve that runs the wrong
 * way. That is a property of this harness, not of the hook.
 */
function advance(ms: number): void {
  now = Math.max(now, ms);
  const pending = frames.splice(0);
  act(() => {
    for (const frame of pending) frame(now);
  });
}

beforeEach(() => {
  installClock();
  reduceMotion(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the animation", () => {
  it("starts at the origin, not at the target", () => {
    // Popping straight to the number is the thing this exists to replace.
    const { result } = renderHook(() => useCountUp(87));

    advance(0);

    expect(result.current).toBeCloseTo(0, 5);
  });

  it("arrives exactly on the target, not near it", () => {
    /**
     * Easing that ends at 86.97 renders as 87 today and as 86 the moment
     * someone changes Math.round to Math.floor. The final frame must be the
     * real value.
     */
    const { result } = renderHook(() => useCountUp(87));

    advance(DURATION);

    expect(result.current).toBe(87);
  });

  it("stops requesting frames once it arrives", () => {
    // An animation that keeps scheduling forever is a background repaint on
    // the report screen for as long as it is open.
    renderHook(() => useCountUp(87));
    advance(DURATION);
    const after = frames.length;

    advance(DURATION * 2);

    expect(after).toBe(0);
  });

  it("eases out — most of the distance early, a gentle settle", () => {
    /**
     * ease-out-cubic, matching the entrance motion in styles.css. Asserted as
     * a shape rather than a magic number: at the halfway point a cubic ease-out
     * has covered 87.5% of the distance, so anything near 50% means the easing
     * was dropped and the motion no longer matches the rest of the product.
     */
    const { result } = renderHook(() => useCountUp(100));

    advance(DURATION / 2);

    expect(result.current).toBeGreaterThan(80);
    expect(result.current).toBeLessThan(95);
  });

  it("never overshoots the target on the way", () => {
    // An ease with a back-out curve would show a learner 103 out of 100.
    const { result } = renderHook(() => useCountUp(100));

    for (const t of [0, 100, 200, 400, 600, DURATION]) {
      advance(t);
      expect(result.current as number, `${t}ms`).toBeLessThanOrEqual(100);
    }
  });
});

describe("counting from the previous best", () => {
  it("starts at the previous best on a repeat attempt", () => {
    /**
     * The reason `from` exists. On attempt two the learner already knows they
     * scored 71; the useful information is the distance from there to 84, and
     * the motion is what carries it.
     */
    const { result } = renderHook(() => useCountUp(84, 71));

    advance(0);

    expect(result.current).toBeCloseTo(71, 5);
  });

  it("still lands on the new score", () => {
    const { result } = renderHook(() => useCountUp(84, 71));

    advance(DURATION);

    expect(result.current).toBe(84);
  });

  it("counts downwards when the attempt was worse", () => {
    /**
     * A learner whose second attempt is worse should see that, and see it as a
     * movement. Clamping to upward-only would show a still number and imply
     * nothing happened.
     */
    const { result } = renderHook(() => useCountUp(62, 88));

    advance(DURATION / 2);
    const mid = result.current as number;
    advance(DURATION);

    expect(mid).toBeLessThan(88);
    expect(mid).toBeGreaterThan(62);
    expect(result.current).toBe(62);
  });

  it("defaults to zero, which is right for a first attempt", () => {
    const { result } = renderHook(() => useCountUp(87));

    advance(0);

    expect(result.current).toBeCloseTo(0, 5);
  });

  it("re-runs when a new score arrives", () => {
    // Attempt three must animate, not sit at attempt two's number.
    const { result, rerender } = renderHook(({ target, from }) => useCountUp(target, from), {
      initialProps: { target: 71, from: 0 },
    });
    advance(DURATION);

    // The clock sits at DURATION, and the re-run effect takes its start time
    // from there — so running the next frame at the same instant is progress
    // zero, i.e. the origin of the new animation.
    rerender({ target: 84, from: 71 });
    advance(DURATION);

    expect(result.current).toBeCloseTo(71, 5);
  });
});

describe("reduced motion", () => {
  it("shows the number immediately, with no animation at all", () => {
    /**
     * Numeric animation cannot be stopped by the CSS kill-switch, so this is
     * the only place the preference can be honoured. A learner who asked the
     * OS for no motion should not have the most important number on the screen
     * animate anyway.
     */
    reduceMotion(true);

    const { result } = renderHook(() => useCountUp(87, 71));

    expect(result.current).toBe(87);
    expect(frames).toHaveLength(0);
  });

  it("honours it on a repeat attempt too", () => {
    reduceMotion(true);

    const { result } = renderHook(() => useCountUp(62, 88));

    expect(result.current).toBe(62);
  });
});

describe("nothing to count", () => {
  it("passes null straight through for an indeterminate result", () => {
    /**
     * R8: an unusable take has no score. Animating up to zero would be a
     * fabricated number with motion attached, which is worse than no number
     * because it looks deliberate.
     */
    const { result } = renderHook(() => useCountUp(null));

    expect(result.current).toBeNull();
    expect(frames).toHaveLength(0);
  });

  it("passes undefined through as well", () => {
    const { result } = renderHook(() => useCountUp(undefined));

    expect(result.current).toBeUndefined();
  });

  it("clears back to null when a scored take is followed by an unclear one", () => {
    // Attempt two returning indeterminate must not leave attempt one's number
    // on screen, attributed to a take that was never scored.
    const { result, rerender } = renderHook(({ target }) => useCountUp(target), {
      initialProps: { target: 87 as number | null },
    });
    advance(DURATION);

    rerender({ target: null });

    expect(result.current).toBeNull();
  });

  it("animates from zero to zero without dividing by anything", () => {
    // A genuine zero is a legal score. It must not become NaN.
    const { result } = renderHook(() => useCountUp(0, 0));

    advance(DURATION / 2);

    expect(result.current).toBe(0);
  });
});

describe("cleanup", () => {
  it("cancels a frame in flight on unmount", () => {
    // Leaving the report screen mid-animation must not leave a callback that
    // calls setState on an unmounted component.
    const { unmount } = renderHook(() => useCountUp(87));
    advance(100);

    unmount();

    expect(cancelled.length).toBeGreaterThan(0);
  });
});
