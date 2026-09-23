/**
 * Which diagram file belongs to a sound, and whether it is there.
 *
 * The client half of `scripts/generate-diagrams.ts`. The generator names each
 * file by a hash of the sound's IPA; this recomputes that name from the same
 * input so the two cannot drift — a renamed file and a changed IPA are the
 * same event, and both produce a miss rather than a stale picture.
 *
 * ## Why it returns a name and not a promise that one exists
 *
 * Nothing here can know whether the file shipped. The diagrams are generated
 * into `diagram-cache/` and move into `public/diagrams/` only once a reviewer
 * has passed them, so for most builds the answer is "no diagrams at all".
 * `ArticulationDiagram` renders nothing when the image is absent, and a
 * missing image is the normal state rather than an error.
 */

import { adviceForGrapheme } from "./difficulty.js";

/**
 * The same hash the generator uses, in the browser's own crypto.
 *
 * Async because `crypto.subtle.digest` is, which is the only SHA-256 a browser
 * offers without shipping an implementation. A synchronous version would mean
 * a hashing library in the bundle to name a file that usually does not exist.
 */
export async function diagramFileFor(ipa: string): Promise<string | null> {
  if (ipa.trim() === "") return null;
  const subtle = globalThis.crypto?.subtle;
  // Absent in an insecure context, which is exactly where a LAN-IP dev server
  // runs. A missing diagram there is correct rather than a failure.
  if (subtle === undefined) return null;

  const bytes = new TextEncoder().encode(ipa);
  const digest = await subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 16)}.png`;
}

/** The diagram for a syllable the scorer named, or null when there is none. */
export async function diagramForGrapheme(
  targetLocale: string,
  grapheme: string,
): Promise<string | null> {
  const entry = adviceForGrapheme("en", targetLocale, grapheme);
  if (entry === null) return null;
  return diagramFileFor(entry.ipa);
}
