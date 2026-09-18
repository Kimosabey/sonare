/**
 * What the shipped PNGs are encoded as, which is a size question and a
 * correctness one.
 *
 * Every splash frame and both splash icons arrived as 8-bit **RGBA with every
 * pixel fully opaque** — an alpha channel carrying one value across a
 * megabyte. A splash is a wordmark on a flat ground and has nothing to be
 * transparent for. Re-encoded as RGB they are 47% smaller and not one pixel
 * differs.
 *
 * The brand images are the opposite case and must stay RGBA: the favicon sits
 * on nothing so it takes the colour of whatever chrome is behind it, and
 * flattening it would put a square in a browser tab. So this cannot be "no PNG
 * has an alpha channel" — it has to name which is which, and why.
 *
 * `scripts/strip-png-alpha.mjs` is what does the conversion, and it refuses
 * any file with a single non-opaque pixel. This is the check that the refusal
 * was not simply never run.
 */

import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Colour type from a PNG's IHDR: 2 is RGB, 6 is RGBA. */
function colourType(path: string): number {
  const buf = readFileSync(path);
  // IHDR is always the first chunk: 8 signature + 4 length + 4 type, then the
  // header, whose ninth byte is the colour type.
  return buf[8 + 8 + 9] ?? -1;
}

function bytes(path: string): number {
  return readFileSync(path).length;
}

const SPLASH = join(ROOT, "public", "splash");
const BRAND = join(ROOT, "public", "brand");

describe("the splash assets carry no alpha channel", () => {
  const files = readdirSync(SPLASH).filter((f) => f.endsWith(".png"));

  it("has splash files to check, so this cannot pass on an empty directory", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(readdirSync(SPLASH).filter((f) => f.endsWith(".png")))(
    "%s is RGB, not RGBA",
    (file) => {
      expect(
        colourType(join(SPLASH, file)),
        `${file} is RGBA; run scripts/strip-png-alpha.mjs`,
      ).toBe(2);
    },
  );

  /**
   * The size that alpha was costing, pinned so a re-export cannot quietly hand
   * it back. 1.09 MiB became 594 KiB; the ceiling here is generous enough to
   * allow a genuine art change and tight enough to fail a re-added channel,
   * which would roughly double it.
   */
  it("weighs about half what it did with the channel", () => {
    const total = files.reduce((sum, f) => sum + bytes(join(SPLASH, f)), 0);
    expect(total).toBeLessThan(800_000);
  });
});

describe("the brand images keep theirs", () => {
  /**
   * The favicon is 66% transparent by design — the mark takes the colour of
   * the chrome behind it, which is what lets one artwork serve a light tab and
   * a dark one. Flattening it is the failure this asserts against.
   */
  it.each(["favicon.png", "favicon-white.png", "wordmark-purple.png"])(
    "%s is still RGBA",
    (file) => {
      expect(colourType(join(BRAND, file)), `${file} lost its alpha channel`).toBe(6);
    },
  );
});
