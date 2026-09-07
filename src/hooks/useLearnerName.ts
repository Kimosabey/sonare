/**
 * Asked once, on first use, then remembered — same localStorage-plus-fallback
 * pattern Diagnostics.tsx already uses for its access token.
 */

import { useCallback, useState } from "react";

const STORAGE_KEY = "sonare.learnerName";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing or storage disabled — falls back to asking every visit.
    return null;
  }
}

export function useLearnerName(): [string | null, (name: string) => void] {
  const [name, setNameState] = useState<string | null>(readStored);

  const setName = useCallback((next: string) => {
    setNameState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Still works for the rest of this visit via state; just won't be
      // remembered next time.
    }
  }, []);

  return [name, setName];
}
