/**
 * Animates a displayed number rising to its target rather than popping in —
 * the score reveal is the single highest-stakes moment in the flow (the
 * learner just spoke, waiting to find out how it went), and it currently
 * gets no motion treatment at all.
 *
 * Respects prefers-reduced-motion by jumping straight to the target — this
 * one can't rely on the global CSS kill-switch (styles.css) since the
 * animation is numeric/JS-driven, not a CSS transition.
 */

import { useEffect, useRef, useState } from "react";

const DURATION_MS = 650;

export function useCountUp(target: number | null | undefined): number | null | undefined {
  const [displayed, setDisplayed] = useState(target);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    if (target === null || target === undefined) {
      setDisplayed(target);
      return;
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setDisplayed(target);
      return;
    }

    const from = 0;
    const startedAt = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / DURATION_MS);
      // ease-out-cubic — fast start, gentle settle, matching the rest of the
      // entrance motion in styles.css.
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayed(from + (target - from) * eased);
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target]);

  return displayed;
}
