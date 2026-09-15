/**
 * Linking a second device — the You tab's half of what `server/linkCodes.ts`
 * and `src/sync/deviceLink.ts` already built.
 *
 * Two directions, on one screen, because a learner does not know which one
 * they are until they read both: **show a code** on the device that has the
 * history, **type it** on the one that does not.
 *
 * ## Link, not transfer
 *
 * Both devices end up sharing an id and the merge layer combines their
 * records, so nothing is invalidated. "I bought a new phone" and "I also use a
 * tablet" are the same flow, and a learner who links a tablet and then picks
 * their phone back up finds everything still there. The copy says so, because
 * the word "transfer" would make people hesitate to link the device they still
 * use.
 *
 * ## How the code is treated
 *
 * A link code grants full read, write and delete of a learner's record for ten
 * minutes. So:
 *
 *  - Nothing here logs it, not even a prefix, not even on failure.
 *  - It lives in React state until this screen is done with it, and is cleared
 *    when the countdown reaches zero — a code on screen after it has expired
 *    is one a learner will type and be refused by, with no way to tell whether
 *    they mistyped it.
 *  - The countdown runs on **elapsed time from this device's clock**, not on a
 *    server timestamp, so a phone whose clock is a day out does not show
 *    "expires in 23:59:41" over a code that dies in ten minutes.
 */

import { useCallback, useEffect, useState } from "react";
import { claimCode, mintCode, type MintedCode } from "../sync/deviceLink.js";
import { formatLinkCode } from "../lib/linkCode.js";
import { readToken } from "../sync/tokenStore.js";

export interface DeviceLinkProps {
  /** Which learner on this device is being linked. */
  learnerName: string | null;
  /** Called after a successful claim, so the screen around this can re-read. */
  onLinked?: () => void;
}

function secondsLeft(minted: MintedCode, now: number): number {
  return Math.max(0, Math.ceil((minted.expiresAt - now) / 1000));
}

export function DeviceLink({ learnerName, onLinked }: DeviceLinkProps) {
  const [minted, setMinted] = useState<MintedCode | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  const [typed, setTyped] = useState("");
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const [now, setNow] = useState(() => Date.now());

  /**
   * A tick while a code is on screen, and only then. A countdown is the one
   * thing here that has to keep moving, and a timer running when there is no
   * code would be a render every second on a settings screen nobody is
   * watching.
   */
  useEffect(() => {
    if (minted === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [minted]);

  const left = minted === null ? 0 : secondsLeft(minted, now);

  /**
   * Cleared the moment it expires rather than left on screen greyed out. An
   * expired code a learner types is refused by the server with a message they
   * cannot distinguish from a typo, so the honest thing is for it to stop
   * existing here.
   */
  useEffect(() => {
    if (minted !== null && left === 0) setMinted(null);
  }, [minted, left]);

  const mint = useCallback(async () => {
    setMintError(null);
    setMinting(true);

    const token = readToken(learnerName);
    if (token === null) {
      // No credential yet — this device has nothing to hand a second one.
      setMintError("This device has no practice history to share yet. Say a phrase first.");
      setMinting(false);
      return;
    }

    const result = await mintCode(token);
    setMinting(false);
    if (result.ok) {
      setMinted(result.minted);
      setNow(Date.now());
    } else {
      setMintError(result.message);
    }
  }, [learnerName]);

  const claim = useCallback(async () => {
    setClaimError(null);
    setClaiming(true);

    const result = await claimCode(typed, learnerName);
    setClaiming(false);
    if (result.ok) {
      setClaimed(true);
      setTyped("");
      onLinked?.();
    } else {
      setClaimError(result.message);
    }
  }, [typed, learnerName, onLinked]);

  return (
    <div className="device-link">
      <h3 className="today-heading">Use this on another device</h3>
      <p className="what">
        Your practice lives on this device. Linking a second one lets both see the same history —
        and it is a link rather than a move, so nothing here stops working.
      </p>

      <h4>On the device you already use</h4>
      {minted === null ? (
        <>
          <div className="row">
            <button type="button" onClick={() => void mint()} disabled={minting}>
              {minting ? "Making a code…" : "Show me a code"}
            </button>
          </div>
          {mintError !== null && (
            <p className="verdict v-fail" role="alert">
              {mintError}
            </p>
          )}
        </>
      ) : (
        <>
          {/*
            Grouped for reading aloud, which is how a code actually travels
            between two devices in the same room.
          */}
          <p className="link-code" aria-label="Your link code">
            {formatLinkCode(minted.code)}
          </p>
          <p className="hint" role="status" aria-live="polite">
            Type it on the other device within {Math.floor(left / 60)}:
            {String(left % 60).padStart(2, "0")}.
          </p>
          <div className="row">
            <button type="button" className="ghost" onClick={() => setMinted(null)}>
              Hide it
            </button>
          </div>
        </>
      )}

      <h4>On the new device</h4>
      {claimed ? (
        <p className="verdict v-pass" role="status">
          <span className="tag">LINKED</span>
          <span>This device now shares your practice history. It may take a moment to appear.</span>
        </p>
      ) : (
        <>
          <p className="row authoring-field">
            <label htmlFor="device-link-code">The code from your other device</label>
            <input
              id="device-link-code"
              type="text"
              /* Codes are read off a screen and typed; neither correction is
                 ever wanted, and autocapitalise fights the alphabet. */
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </p>
          <div className="row">
            <button type="button" onClick={() => void claim()} disabled={claiming}>
              {claiming ? "Linking…" : "Link this device"}
            </button>
          </div>
          {claimError !== null && (
            <p className="verdict v-fail" role="alert">
              {claimError}
            </p>
          )}
        </>
      )}
    </div>
  );
}
