/**
 * Whether this app can be installed, and how — which is not one question.
 *
 * Sonare is a web app competing with native ones, and that is mostly an
 * advantage: it runs on locked-down school fleets and on Chromebooks, where a
 * native app is not an option at all. The one real cost is that nobody is ever
 * *told* they can keep it. A browser tab is easy to lose; an installed app is
 * on the home screen next to everything else the learner uses.
 *
 * Installing is also in the learner's interest rather than only ours, and the
 * copy should be able to say so honestly:
 *
 *  - **Storage survives.** Safari evicts script-writable storage from sites it
 *    considers unused. An installed app is not treated that way, so a streak
 *    and a sound history stop being something a browser can quietly bin.
 *  - **It works with no network**, from the home screen, with no address to
 *    remember and no tab to find.
 *
 * ## Why this is three paths and not one
 *
 * **Chromium** fires `beforeinstallprompt`, which can be captured and replayed
 * later from a user gesture. That is the only path where the app can offer a
 * real button.
 *
 * **iOS Safari fires nothing.** There is no API, and there never has been: the
 * only route is Share → Add to Home Screen, done by hand. An app that shows a
 * button there is lying about what the button does, so it shows instructions
 * instead. This is the majority path for this product — an installed iOS PWA
 * is WebKit, which is the engine the whole capture pipeline is aimed at.
 *
 * **Everything else** gets neither, and is told plainly that its browser
 * decides rather than being walked into a dead end.
 *
 * ## Why there is no popup
 *
 * This lives on a screen somebody chose to open, and nowhere else. A product
 * built on not nagging — no streak to protect, no league to fall out of,
 * nothing to chase a learner about — does not get to make its first
 * interruption an ad for itself. The install banner is the single most
 * disliked pattern on the mobile web and it would be the one nag in a product
 * whose whole position is the absence of them.
 */

/** The Chromium-only event. Not in lib.dom, because it is not standardised. */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallRoute =
  /** Already on the home screen. Nothing to offer. */
  | { kind: "installed" }
  /** A real button, because the browser gave us a real prompt to replay. */
  | { kind: "prompt" }
  /** Instructions, because iOS has no API and never had one. */
  | { kind: "ios" }
  /** Neither. Say so rather than invent a route. */
  | { kind: "unsupported" };

/**
 * Already installed?
 *
 * Two checks because the platforms disagree. `display-mode: standalone`
 * matches the manifest's declared display on Chromium and modern iOS;
 * `navigator.standalone` is the older iOS-only flag and is still the reliable
 * answer on some versions. Either one being true is enough.
 */
export function isInstalled(win: Window = window): boolean {
  const legacy = (win.navigator as Navigator & { standalone?: boolean }).standalone;
  if (legacy === true) return true;
  // Guarded: matchMedia is absent in some embedded webviews, and a thrown
  // TypeError here would take the whole You tab down over a nicety.
  try {
    return win.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

/**
 * iOS, by the only signal that distinguishes it.
 *
 * `maxTouchPoints` is what separates an iPad on iPadOS 13+ from a Mac: both
 * report "Macintosh" in the user agent, and only the iPad reports touch
 * points. Without that check an iPad is told it has no install route, which is
 * exactly the device most likely to be in a classroom.
 */
export function isIOS(win: Window = window): boolean {
  const ua = win.navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return true;
  if (/iPad/.test(ua)) return true;
  return /Macintosh/.test(ua) && win.navigator.maxTouchPoints > 1;
}

/**
 * Which route this browser actually has.
 *
 * `installed` wins over everything: a learner who already has it on their home
 * screen should be told that, not offered it again.
 */
export function installRoute(
  captured: InstallPromptEvent | null,
  win: Window = window,
): InstallRoute {
  if (isInstalled(win)) return { kind: "installed" };
  if (captured !== null) return { kind: "prompt" };
  if (isIOS(win)) return { kind: "ios" };
  return { kind: "unsupported" };
}

/**
 * Capture `beforeinstallprompt` so it can be replayed from a user gesture.
 *
 * The event must be prevented or Chromium shows its own mini-infobar, which is
 * the nag this screen exists to avoid. Returns its own teardown.
 */
export function watchForInstallPrompt(
  onCaptured: (event: InstallPromptEvent) => void,
  win: Window = window,
): () => void {
  const handler = (event: Event): void => {
    event.preventDefault();
    onCaptured(event as InstallPromptEvent);
  };
  win.addEventListener("beforeinstallprompt", handler);
  return () => void win.removeEventListener("beforeinstallprompt", handler);
}
