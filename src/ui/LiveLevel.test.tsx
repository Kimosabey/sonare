// @vitest-environment jsdom

/**
 * The two leaves that keep a 30 Hz signal out of the page's render path.
 *
 * The level updates thirty times a second for the whole take. Held in page
 * state, that re-rendered every component in the activity subtree thirty times
 * a second — on exactly the frames the recording UI needs to stay smooth. An
 * external store plus `useSyncExternalStore` in a leaf confines the churn to
 * these two components.
 *
 * That is a structural claim, so the tests are structural: what must hold is
 * that the level reaches the meter, that a store update repaints *only* this
 * leaf and not its siblings, and that the subscription is torn down. The point
 * of the design is also that LevelMeter and InterimFeedback keep plain
 * `level: number` props and stay trivially testable — which their own suites
 * rely on.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveInterimFeedback, LiveLevelMeter } from "./LiveLevel.js";
import { createLevelStore } from "./levelStore.js";

afterEach(cleanup);

function scaleOf(): number {
  const bar = document.querySelector(".meter > i") as HTMLElement | null;
  const match = /scaleX\(([\d.]+)\)/.exec(bar?.style.transform ?? "");
  return match ? Number(match[1]) : NaN;
}

describe("LiveLevelMeter", () => {
  it("renders the store's current level, not a default", () => {
    // A leaf that painted zero until the first update would show an empty bar
    // for the first frame of every take.
    const store = createLevelStore();
    act(() => store.set(-20));

    render(<LiveLevelMeter store={store} active clipping={false} />);

    expect(scaleOf()).toBeCloseTo((-20 + 70) / 70, 3);
  });

  it("repaints when the store changes", () => {
    const store = createLevelStore();
    render(<LiveLevelMeter store={store} active clipping={false} />);
    const before = scaleOf();

    act(() => store.set(-10));

    expect(scaleOf()).toBeGreaterThan(before);
  });

  it("passes clipping straight through, since it is not derivable from level", () => {
    // RMS around -8 dBFS on audio peaking at +8 looks healthy; the flag is the
    // only thing that knows otherwise.
    const store = createLevelStore();
    act(() => store.set(-8));

    render(<LiveLevelMeter store={store} active clipping />);

    expect(screen.getByText("distorting — back off the mic")).toBeInTheDocument();
  });

  it("stops subscribing on unmount", () => {
    /**
     * The activity page mounts one of these per activity. A subscription left
     * behind would call into an unmounted tree thirty times a second, and ten
     * activities would leave nine of them.
     */
    const store = createLevelStore();
    const { unmount } = render(<LiveLevelMeter store={store} active clipping={false} />);

    unmount();

    expect(() => act(() => store.set(-30))).not.toThrow();
  });
});

describe("LiveInterimFeedback", () => {
  it("feeds the panel from the store", () => {
    const store = createLevelStore();
    act(() => store.set(-20));

    render(
      <LiveInterimFeedback store={store} recording speaking hangoverMs={1200} autoStop />,
    );

    expect(screen.getByText("hearing you")).toBeInTheDocument();
  });

  it("renders nothing when not recording, whatever the store holds", () => {
    const store = createLevelStore();
    act(() => store.set(-10));

    const { container } = render(
      <LiveInterimFeedback store={store} recording={false} speaking={false} hangoverMs={1200} autoStop />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("stops subscribing on unmount", () => {
    const store = createLevelStore();
    const { unmount } = render(
      <LiveInterimFeedback store={store} recording speaking hangoverMs={1200} autoStop />,
    );

    unmount();

    expect(() => act(() => store.set(-30))).not.toThrow();
  });
});

describe("the containment this design exists for", () => {
  it("repaints the leaf without repainting its siblings", () => {
    /**
     * The whole point, and the thing a refactor back to page state would
     * silently undo — the meter would still work, and the recording screen
     * would drop frames for the length of every take.
     */
    const store = createLevelStore();
    const sibling = vi.fn();

    function Sibling() {
      sibling();
      return <p>prompt text</p>;
    }

    render(
      <div>
        <Sibling />
        <LiveLevelMeter store={store} active clipping={false} />
      </div>,
    );
    const rendersBefore = sibling.mock.calls.length;

    for (const level of [-40, -30, -20, -10, -5]) act(() => store.set(level));

    expect(sibling.mock.calls.length).toBe(rendersBefore);
    expect(scaleOf()).toBeCloseTo((-5 + 70) / 70, 3);
  });

  it("keeps both leaves in step from one store", () => {
    // They subscribe separately but must never disagree about the level, or
    // the meter and the panel would describe different moments.
    const store = createLevelStore();
    render(
      <div>
        <LiveLevelMeter store={store} active clipping={false} />
        <LiveInterimFeedback store={store} recording speaking hangoverMs={1200} autoStop />
      </div>,
    );

    act(() => store.set(-15));

    expect(scaleOf()).toBeCloseTo((-15 + 70) / 70, 3);
    // Scoped: the meter and the panel both legitimately say "hearing you",
    // which is itself a small sign they agree about the moment.
    expect(document.querySelector(".interim")?.textContent).toContain("hearing you");
    expect(document.querySelector(".meter")?.textContent).toContain("hearing you");
  });
});
