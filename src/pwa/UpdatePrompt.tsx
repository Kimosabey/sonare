/**
 * The one piece of UI the PWA adds, and it is deliberately not new UI.
 *
 * Registration is a side effect with no rendered output, so this component
 * returns null. It exists because the *answer* to "a new version is waiting"
 * has to come from the learner, and the app already has an announcement
 * channel with the right semantics: ToastProvider is its `aria-live` region,
 * so a learner who is looking at the prompt rather than the corner of the
 * screen still hears about it.
 *
 * Non-blocking on purpose. No modal, no banner that pushes the layout, no
 * automatic reload — a learner mid-take can ignore this until the take is
 * finished, and the toast is pinned (`duration: 0`) so ignoring it does not
 * lose it.
 */

import { useEffect } from "react";
import { useToast } from "../components/ToastProvider.js";
import { registerServiceWorker } from "./register.js";

export function UpdatePrompt(): null {
  const { push } = useToast();

  useEffect(() => {
    /**
     * Every gate that decides whether anything happens at all — production,
     * secure context, browser support — lives in register.ts. This mounts
     * unconditionally and registerServiceWorker returns a no-op disposer when
     * the environment is not one a worker belongs in.
     */
    return registerServiceWorker({
      onUpdateReady: (apply) => {
        push({
          kind: "info",
          key: "sw-update",
          title: "New version ready",
          // What pressing it does, said plainly. A learner who has just
          // recorded something needs to know a reload is coming, and that the
          // session they are in is not the thing being risked.
          detail: "Reload when you're ready — your progress is already saved.",
          duration: 0,
          action: { label: "Update now", onClick: apply },
        });
      },
    });
  }, [push]);

  return null;
}
