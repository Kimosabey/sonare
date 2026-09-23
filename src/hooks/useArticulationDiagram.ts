/**
 * Resolves a sound to its diagram file name, which is an async hash.
 *
 * The generator names each file by SHA-256 of the sound's IPA, and the only
 * SHA-256 a browser offers without shipping an implementation is
 * `crypto.subtle`, which is asynchronous. So the name arrives a tick after the
 * render that wants it.
 *
 * That is fine and is why `ArticulationDiagram` renders nothing for a null
 * file: the first frame has no diagram, and so does every frame on a build
 * where none shipped, which is most of them. A learner sees the advice
 * immediately either way — the picture is the thing that can be late.
 */

import { useEffect, useState } from "react";
import { diagramForGrapheme } from "../activities/diagramFor.js";

export function useArticulationDiagram(
  targetLocale: string,
  grapheme: string,
): string | null {
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void diagramForGrapheme(targetLocale, grapheme)
      .then((name) => {
        if (live) setFile(name);
      })
      // A hash that cannot be computed is a diagram that is not shown. Nothing
      // about a sound's advice depends on it.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [targetLocale, grapheme]);

  return file;
}
