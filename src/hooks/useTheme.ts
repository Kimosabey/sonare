/**
 * The theme choice as React state, kept in step with the document.
 *
 * The initial value is read from storage rather than defaulted, so the control
 * shows the choice already in force on the first render — index.html's inline
 * script has stamped the document by then, and a control that started at
 * "system" while the page rendered dark would be lying about its own state.
 *
 * Nothing here applies the theme on mount. The inline script did that before
 * the first paint, and re-stamping the same value would be a no-op with one
 * bad edge: for "system" it would removeAttribute, which is also correct, but
 * only by coincidence. The attribute is written when the learner changes it,
 * which is the only moment it needs writing.
 */

import { useCallback, useState } from "react";
import { applyTheme, readTheme, writeTheme, type Theme } from "../lib/theme.js";

export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    // Document first, so the change is visible even if storage throws.
    applyTheme(next, document.documentElement);
    writeTheme(next);
  }, []);

  return [theme, setTheme];
}
