/**
 * "No microphone here" — board 1g, mid-session.
 *
 * A first-class screen rather than a toast, and the reason is what a toast
 * does: it appears, it is missed, and it leaves the learner on a screen whose
 * record button does nothing. This state is not an aside about the session, it
 * *is* the session for as long as it lasts.
 *
 * ## Two causes, two different instructions
 *
 * They look identical from the learner's side — the microphone does not work —
 * and the correct advice is completely different, which is why they are not
 * one screen with one list of steps:
 *
 *  - **Blocked.** Recoverable, and the fix is in the browser: padlock, allow,
 *    reload. Worth giving steps for.
 *  - **An insecure address.** There is no microphone to grant over `http`, by
 *    the browser's design. Nothing is broken and nothing on the device can be
 *    changed to fix it, so steps here would be instructions to do something
 *    impossible — and a learner who followed them and failed would conclude
 *    they had broken something.
 *
 * Either way the listening activities still work, and that is offered rather
 * than mentioned: this must not be a dead end.
 */

import { Link } from "react-router-dom";
import type { MicAvailability } from "../speech/capture/micCheck.js";

export interface MicUnavailableProps {
  /** Which of the blocking states applies. `available` renders nothing. */
  availability: MicAvailability;
  /** Where the listening activities are, for this language. */
  listeningHref: string;
  /** Ask the browser again — after a settings change, or a headset plugged in. */
  onRetry: () => void;
}

export function MicUnavailable({ availability, listeningHref, onRetry }: MicUnavailableProps) {
  if (availability.state === "available") return null;

  const insecure = availability.state === "insecure";
  const noHardware = availability.state === "no-hardware";

  return (
    <section className="enter-1 mic-unavailable">
      <h2>No microphone here</h2>

      {availability.state === "denied" && (
        <>
          <p className="what">
            This site is blocked from using your microphone, so a take can&rsquo;t be recorded or
            scored.
          </p>
          <ol className="what">
            <li>Open the padlock icon beside the address.</li>
            <li>Allow the microphone.</li>
            <li>Reload this page.</li>
          </ol>
        </>
      )}

      {insecure && (
        <p className="what">
          Browsers only hand out a microphone over a secure connection. On an{" "}
          <code>http://</code> address there is no microphone at all — nothing on this screen is
          broken, and nothing on your device needs changing.
        </p>
      )}

      {noHardware && (
        <p className="what">
          The browser reports no input device at all. Nothing is switched off and nothing is
          blocked — plugging in headphones with a microphone is all it takes.
        </p>
      )}

      {/*
        Offered, not mentioned. A learner who cannot record has not run out of
        things to do, and a screen that only explains why something is broken
        is a dead end wearing an explanation.
      */}
      <p className="hint">You can still do today&rsquo;s listening — it needs no microphone.</p>

      <div className="row">
        <Link className="enter-cta" to={listeningHref}>
          Practise listening instead
        </Link>
        {/*
          Absent on the insecure address, deliberately. There, "try again"
          would fail every time however many times it is tapped — the fix is a
          different URL, and a button that cannot work is worse than no button.
        */}
        {!insecure && (
          <button type="button" onClick={onRetry}>
            {noHardware ? "Look for a microphone again" : "Try the microphone again"}
          </button>
        )}
      </div>
    </section>
  );
}
