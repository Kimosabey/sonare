/**
 * Which install route a browser actually has.
 *
 * Every assertion here is about a platform lying or staying silent, because
 * that is the whole difficulty:
 *
 *  - **iOS fires no event and never has.** An app that shows an install button
 *    there shows a button that cannot do what it says.
 *  - **An iPad reports itself as a Macintosh.** Only `maxTouchPoints`
 *    separates them, and getting it wrong tells the device most likely to be
 *    in a classroom that it has no route.
 *  - **`matchMedia` is missing in some embedded webviews**, where an
 *    unguarded call takes the whole screen down over a nicety.
 */

import { describe, expect, it, vi } from "vitest";
import {
  installRoute,
  isIOS,
  isInstalled,
  watchForInstallPrompt,
  type InstallPromptEvent,
} from "./install.js";

/** A window with only the parts this module reads. */
function fakeWindow(over: {
  ua?: string;
  touchPoints?: number;
  standalone?: boolean;
  displayMode?: boolean;
  noMatchMedia?: boolean;
}): Window {
  const navigator = {
    userAgent: over.ua ?? "Mozilla/5.0 (X11; Linux x86_64)",
    maxTouchPoints: over.touchPoints ?? 0,
    ...(over.standalone === undefined ? {} : { standalone: over.standalone }),
  };
  const win = {
    navigator,
    matchMedia: over.noMatchMedia
      ? undefined
      : () => ({ matches: over.displayMode ?? false }),
  };
  return win as unknown as Window;
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
const IPAD_MODERN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const ANDROID = "Mozilla/5.0 (Linux; Android 14)";

describe("is it already installed", () => {
  it("believes the display mode when the manifest's display is matched", () => {
    expect(isInstalled(fakeWindow({ displayMode: true }))).toBe(true);
  });

  /**
   * The older iOS-only flag, still the reliable answer on some versions. Kept
   * alongside the media query rather than instead of it, because each is the
   * only signal on some devices.
   */
  it("believes the legacy iOS flag on its own", () => {
    expect(isInstalled(fakeWindow({ standalone: true, displayMode: false }))).toBe(true);
  });

  it("says no when neither signal is present", () => {
    expect(isInstalled(fakeWindow({}))).toBe(false);
  });

  /**
   * A missing `matchMedia` must not throw. This screen is a convenience; a
   * TypeError here would take the whole You tab down with it — including
   * "leave the class" and "delete everything", which are not conveniences.
   */
  it("survives a browser with no matchMedia", () => {
    expect(() => isInstalled(fakeWindow({ noMatchMedia: true }))).not.toThrow();
    expect(isInstalled(fakeWindow({ noMatchMedia: true }))).toBe(false);
  });
});

describe("is it iOS", () => {
  it("recognises an iPhone", () => {
    expect(isIOS(fakeWindow({ ua: IPHONE }))).toBe(true);
  });

  /**
   * The one that matters most, and the one a naive check gets wrong: since
   * iPadOS 13 an iPad reports "Macintosh" exactly as a Mac does. Touch points
   * are the only separator — and an iPad is the device most likely to be in a
   * classroom.
   */
  it("recognises an iPad that claims to be a Macintosh", () => {
    expect(isIOS(fakeWindow({ ua: IPAD_MODERN, touchPoints: 5 }))).toBe(true);
  });

  it("does not mistake a real Mac for one", () => {
    expect(isIOS(fakeWindow({ ua: IPAD_MODERN, touchPoints: 0 }))).toBe(false);
  });

  it("does not mistake Android for it", () => {
    expect(isIOS(fakeWindow({ ua: ANDROID, touchPoints: 5 }))).toBe(false);
  });
});

describe("which route this browser has", () => {
  const event = {} as InstallPromptEvent;

  it("offers nothing when it is already on the home screen", () => {
    expect(installRoute(event, fakeWindow({ displayMode: true }))).toEqual({
      kind: "installed",
    });
  });

  /**
   * Installed wins over a captured prompt. A learner who already has it should
   * be told so, not offered it again and left wondering whether the first
   * attempt worked.
   */
  it("prefers installed over a prompt it happens to be holding", () => {
    expect(installRoute(event, fakeWindow({ ua: IPHONE, standalone: true })).kind).toBe(
      "installed",
    );
  });

  it("offers a real button only when it has a real prompt", () => {
    expect(installRoute(event, fakeWindow({ ua: ANDROID })).kind).toBe("prompt");
  });

  /**
   * And never on iOS, where there is no API to replay. This is the assertion
   * that stops a button appearing that cannot do what it says.
   */
  it("offers instructions on iOS, never a button", () => {
    expect(installRoute(null, fakeWindow({ ua: IPHONE })).kind).toBe("ios");
    expect(installRoute(null, fakeWindow({ ua: IPAD_MODERN, touchPoints: 5 })).kind).toBe("ios");
  });

  it("admits it has no route rather than inventing one", () => {
    expect(installRoute(null, fakeWindow({ ua: ANDROID })).kind).toBe("unsupported");
  });
});

describe("capturing the prompt", () => {
  it("prevents the browser's own banner and hands the event over", () => {
    const listeners: Record<string, (e: Event) => void> = {};
    const win = {
      addEventListener: (name: string, fn: (e: Event) => void) => void (listeners[name] = fn),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const captured = vi.fn();

    watchForInstallPrompt(captured, win);
    const preventDefault = vi.fn();
    listeners.beforeinstallprompt?.({ preventDefault } as unknown as Event);

    // Prevented, or Chromium shows its own mini-infobar — which is the nag
    // this whole section exists to avoid.
    expect(preventDefault).toHaveBeenCalled();
    expect(captured).toHaveBeenCalled();
  });

  it("removes its listener when torn down", () => {
    const remove = vi.fn();
    const win = {
      addEventListener: () => undefined,
      removeEventListener: remove,
    } as unknown as Window;

    watchForInstallPrompt(vi.fn(), win)();

    expect(remove).toHaveBeenCalledWith("beforeinstallprompt", expect.any(Function));
  });
});
