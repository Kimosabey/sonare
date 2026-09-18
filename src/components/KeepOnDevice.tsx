/**
 * Keeping Sonare on the home screen — the one real cost of being a web app.
 *
 * Running in a browser is mostly an advantage here: it works on locked-down
 * school fleets and on Chromebooks, where a native app is not an option at
 * all, and a fix reaches everyone the day it deploys. What it loses is that
 * nobody is ever *told* they can keep it. A tab is easy to lose; an icon is
 * not.
 *
 * ## Why this is a section and not a banner
 *
 * It sits on a screen somebody chose to open, and appears nowhere else. This
 * product has no streak to protect, no league to fall out of and nothing to
 * chase anybody about — an install banner would be its first interruption, and
 * it would be an advertisement for itself. That is a bad trade for a product
 * whose whole position is the absence of those tactics.
 *
 * ## Why the reasons given are the learner's, not ours
 *
 * Both are true and both are about them:
 *
 *  - **Practice survives.** Safari evicts stored data from sites it decides
 *    are unused. Installed, it is not treated that way, so a streak and a
 *    sound history stop being something a browser can quietly bin.
 *  - **It opens without a network**, from the home screen, with no address to
 *    remember.
 *
 * There is deliberately no third reason about engagement, because that would
 * be the real motive dressed as advice.
 */

import { useEffect, useState } from "react";
import {
  installRoute,
  watchForInstallPrompt,
  type InstallPromptEvent,
  type InstallRoute,
} from "../lib/install.js";

export interface KeepOnDeviceProps {
  /** Injected in tests. Defaults to the real detection. */
  route?: InstallRoute;
}

export function KeepOnDevice({ route }: KeepOnDeviceProps) {
  const [captured, setCaptured] = useState<InstallPromptEvent | null>(null);
  const [outcome, setOutcome] = useState<"accepted" | "dismissed" | null>(null);

  useEffect(() => watchForInstallPrompt(setCaptured), []);

  const resolved = route ?? installRoute(captured);

  /**
   * Already on the home screen. Said rather than hidden: a learner who
   * installed it should see that this screen knows, instead of finding the
   * same offer again and wondering whether it worked.
   */
  if (resolved.kind === "installed") {
    return (
      <>
        <h2>On your home screen</h2>
        <p className="what">
          Sonare is installed on this device. It opens without a network, and what you have
          practised is kept properly rather than treated as a browser's spare cache.
        </p>
      </>
    );
  }

  return (
    <>
      <h2>Keep Sonare on this device</h2>
      <p className="what">
        Added to your home screen, Sonare opens without a network and with no address to
        remember — and your practice is kept properly, rather than as data a browser may
        decide to clear.
      </p>

      {resolved.kind === "prompt" && (
        <p className="row">
          <button
            type="button"
            onClick={() => {
              if (captured === null) return;
              void captured.prompt();
              void captured.userChoice.then(({ outcome: chosen }) => {
                setOutcome(chosen);
                // A prompt can only be replayed once. Dropping it is what stops
                // a second press doing nothing with no explanation.
                if (chosen === "accepted") setCaptured(null);
              });
            }}
          >
            Add to home screen
          </button>
        </p>
      )}

      {/*
        iOS has no install API and never has had one. A button here would be a
        button that cannot do what it says, so this is the steps instead —
        named exactly as they appear, because "use the share menu" is not
        findable if the menu is a square with an arrow in it.
      */}
      {resolved.kind === "ios" && (
        <ol className="what">
          <li>Tap the Share button — the square with an arrow pointing up.</li>
          <li>
            Scroll down and choose <strong>Add to Home Screen</strong>.
          </li>
          <li>Tap Add.</li>
        </ol>
      )}

      {/*
        Neither route. Said plainly rather than left as an empty section, and
        without instructions that might be wrong for whatever browser this is.
      */}
      {resolved.kind === "unsupported" && (
        <p className="hint">
          Your browser decides whether this is offered. Look for “Install”, “Add to Home
          screen” or a small icon in the address bar. Nothing is lost if it is not there —
          Sonare works the same in a tab.
        </p>
      )}

      {outcome === "dismissed" && (
        <p className="hint" role="status">
          No problem. Sonare works the same in a tab, and this stays here if you change your
          mind.
        </p>
      )}
    </>
  );
}
