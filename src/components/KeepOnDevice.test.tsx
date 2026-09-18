// @vitest-environment jsdom

/**
 * The install section, per route.
 *
 * The property worth holding is not that it renders — it is that **each
 * platform is offered only what it can actually do**. A button on iOS would be
 * a control that cannot perform its own label, which is the specific failure
 * this component's three-way split exists to prevent.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { KeepOnDevice } from "./KeepOnDevice.js";

afterEach(cleanup);

const add = () => screen.queryByRole("button", { name: /add to home screen/i });

describe("what each platform is offered", () => {
  it("gives a real button only where there is a real prompt", () => {
    render(<KeepOnDevice route={{ kind: "prompt" }} />);

    expect(add()).toBeInTheDocument();
  });

  /**
   * The load-bearing one. iOS has no install API, so a button there would be a
   * control that cannot do what its label says.
   */
  it("gives iOS the steps and no button", () => {
    render(<KeepOnDevice route={{ kind: "ios" }} />);

    expect(add()).toBeNull();
    expect(screen.getByText(/Add to Home Screen/i)).toBeInTheDocument();
    // Named as they appear. "Use the share menu" is not findable when the menu
    // is a square with an arrow in it.
    expect(document.body.textContent).toMatch(/square with an arrow/i);
  });

  it("admits when it has no route, rather than showing a dead control", () => {
    render(<KeepOnDevice route={{ kind: "unsupported" }} />);

    expect(add()).toBeNull();
    expect(document.body.textContent).toMatch(/your browser decides/i);
  });

  /**
   * Already installed is said, not hidden. A learner who installed it should
   * see that this screen knows, rather than meeting the same offer again and
   * wondering whether the first attempt worked.
   */
  it("tells an installed device that it is installed", () => {
    render(<KeepOnDevice route={{ kind: "installed" }} />);

    expect(add()).toBeNull();
    expect(screen.getByRole("heading")).toHaveTextContent(/on your home screen/i);
  });
});

describe("what it never does", () => {
  /**
   * No route may claim installing is required. Sonare works in a tab, and the
   * offline floor is bundled — a section that implied otherwise would be
   * selling the install with something untrue.
   */
  it.each(["prompt", "ios", "unsupported", "installed"] as const)(
    "does not tell a %s learner they must install it",
    (kind) => {
      render(<KeepOnDevice route={{ kind }} />);

      expect(document.body.textContent ?? "").not.toMatch(/you must|required|you need to install/i);
    },
  );

  /**
   * And no route nags. This product has nothing to chase anybody about, and
   * the words below are how that would start.
   */
  it.each(["prompt", "ios", "unsupported"] as const)(
    "does not push a %s learner with streak or reminder language",
    (kind) => {
      render(<KeepOnDevice route={{ kind }} />);

      /**
       * Apostrophe-agnostic, and `streak` on its own.
       *
       * The first version of this read `don't` with a straight apostrophe.
       * This product writes `don’t` with a curly one everywhere, so a planted
       * "Don’t lose your streak" sailed through a check whose entire job was
       * catching it. `streak` alone is the reliable signal: this section has
       * no legitimate reason to mention one.
       */
      expect(document.body.textContent ?? "").not.toMatch(
        /streak|do[n’']?.?t lose|remind|every ?day|come back|keep it up/i,
      );
    },
  );

  /**
   * Non-vacuity: the two checks above pass against a component that rendered
   * nothing at all, which is exactly the shape of mistake this repository has
   * hit repeatedly.
   */
  it.each(["prompt", "ios", "unsupported", "installed"] as const)(
    "actually renders something for %s",
    (kind) => {
      render(<KeepOnDevice route={{ kind }} />);

      expect(screen.getByRole("heading")).toBeInTheDocument();
      expect((document.body.textContent ?? "").length).toBeGreaterThan(40);
    },
  );
});
