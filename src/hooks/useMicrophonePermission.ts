/**
 * Whether the microphone is already blocked, before the learner finds out the
 * hard way.
 *
 * Without this the only way to discover a standing block is to tap Start and
 * be refused. constraints.ts detects it *afterwards* — a permission prompt
 * answered in under 250ms was not answered by a person — and reports it
 * honestly, but by then the learner has committed to an attempt and been
 * turned away, which reads as the app failing rather than as a setting they
 * can change.
 *
 * Deliberately advisory, never a gate. The Permissions API is not available
 * everywhere and its microphone descriptor is rejected outright by some
 * browsers — Safari among them, which is a target platform. So "unknown" is a
 * normal answer and the only correct response to it is to carry on exactly as
 * before: getUserMedia remains the authority on whether recording can start,
 * and this only ever adds a warning ahead of it.
 */

import { useEffect, useState } from "react";

export type MicrophonePermission = "granted" | "denied" | "prompt" | "unknown";

export function useMicrophonePermission(): MicrophonePermission {
  const [permission, setPermission] = useState<MicrophonePermission>("unknown");

  useEffect(() => {
    let cancelled = false;
    let status: PermissionStatus | null = null;
    const onChange = () => {
      // The learner may unblock it in browser settings without reloading, and
      // the warning has to disappear when they do — otherwise it becomes
      // advice that is wrong and cannot be dismissed.
      if (status && !cancelled) setPermission(status.state as MicrophonePermission);
    };

    void (async () => {
      try {
        // `microphone` is not a universally accepted descriptor: some engines
        // throw a TypeError rather than resolving, which is why this is
        // wrapped rather than feature-detected on `navigator.permissions`
        // alone.
        const result = await navigator.permissions?.query({
          name: "microphone" as PermissionName,
        });
        if (!result || cancelled) return;
        status = result;
        setPermission(result.state as MicrophonePermission);
        result.addEventListener("change", onChange);
      } catch {
        // Unsupported, or the descriptor was rejected. "unknown" is correct
        // and the app behaves exactly as it did before.
      }
    })();

    return () => {
      cancelled = true;
      status?.removeEventListener("change", onChange);
    };
  }, []);

  return permission;
}
