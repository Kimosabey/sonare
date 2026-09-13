/**
 * What the browser will allow before a learner is asked to speak.
 *
 * Three facts, each of which the microphone check needs and none of which
 * requires audio: whether the address is a secure one, whether the permission
 * is already settled, and how many audio inputs there are. `availabilityFrom`
 * turns them into the one answer a screen renders.
 *
 * Re-enumerable on demand, because two of the states are recoverable without a
 * reload and the screens for both offer exactly that: plugging in a headset
 * with a microphone, or flipping the permission in browser settings and coming
 * back. A screen that could only find out by reloading would be telling the
 * learner to do something the page can do for them.
 */

import { useCallback, useEffect, useState } from "react";
import { availabilityFrom, type MicAvailability } from "../speech/capture/micCheck.js";
import { useMicrophonePermission } from "./useMicrophonePermission.js";

export interface MicEnvironment {
  availability: MicAvailability;
  /** Audio inputs, or null before the browser has been asked. */
  inputCount: number | null;
  /** The origin the page was opened on, for the insecure-address screen. */
  origin: string;
  /** Ask the browser again — after a headset is plugged in, or settings change. */
  recheck: () => void;
}

/**
 * Audio inputs the browser admits to.
 *
 * Returns null rather than 0 when it cannot ask, and the distinction decides a
 * screen: before permission is granted, `enumerateDevices` legitimately
 * reports nothing on some engines, and calling that "no hardware" tells a
 * learner with a working microphone that their device has none.
 */
async function countInputs(): Promise<number | null> {
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices();
    if (!devices) return null;
    return devices.filter((device) => device.kind === "audioinput").length;
  } catch {
    // Unsupported, or refused. Not an answer, so not zero.
    return null;
  }
}

export function useMicEnvironment(): MicEnvironment {
  const permission = useMicrophonePermission();
  const [inputCount, setInputCount] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void countInputs().then((count) => {
      if (!cancelled) setInputCount(count);
    });
    return () => {
      cancelled = true;
    };
    // `permission` is a dependency because the device list is only trustworthy
    // once it is settled — a granted permission is what puts labels and, on
    // some engines, entries at all into `enumerateDevices`.
  }, [permission, nonce]);

  /**
   * The browser's own notification that the device list moved: a headset
   * plugged in, AirPods connected, a dock removed. Without it the "no
   * microphone" screen would sit there after the learner had fixed it, and its
   * own "look again" button would be the only way out of a state the page
   * already knew had ended.
   */
  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (!devices?.addEventListener) return;
    const onChange = () => recheck();
    devices.addEventListener("devicechange", onChange);
    return () => devices.removeEventListener("devicechange", onChange);
  }, [recheck]);

  const secureContext = typeof window !== "undefined" && window.isSecureContext === true;
  const hasMediaDevices =
    typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";

  return {
    availability: availabilityFrom({
      secureContext,
      hasMediaDevices,
      inputCount,
      permission,
    }),
    inputCount,
    origin: typeof window === "undefined" ? "" : window.location.origin,
    recheck,
  };
}
