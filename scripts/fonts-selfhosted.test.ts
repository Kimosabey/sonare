/**
 * The brand faces are served from this origin, and stay that way.
 *
 * `docs/PROCUREMENT.md` tells schools this application makes no third-party
 * request. That was untrue for as long as the fonts came from Google's CDN:
 * every learner's browser sent its IP address to Google before the page
 * rendered, which a German court has already found to be a transfer requiring
 * consent.
 *
 * The fix is easy to undo by accident — a copied snippet from a font service
 * is two lines and looks like an improvement — so this is the thing that
 * notices. It also holds the two halves in step: a stylesheet naming a file
 * that is not there produces no error, just text in a fallback face nobody
 * meant to ship.
 *
 * ## Why this lives in scripts/
 *
 * It reads `index.html` and the `public/` directory from disk. `src/` is
 * typechecked without Node types on purpose, so a test there cannot use
 * `node:fs`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", ROOT), "utf8");
const css = readFileSync(new URL("public/brand-fonts.css", ROOT), "utf8");

/** Every file the stylesheet actually asks for. */
const referenced = [...css.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map((m) => m[1] ?? "");

describe("no third-party font request", () => {
  it("does not reach Google from the document", () => {
    // Comments explaining the history are fine; a link or preconnect is not.
    const markup = html.replace(/<!--[\s\S]*?-->/g, "");

    expect(markup).not.toMatch(/fonts\.googleapis\.com/);
    expect(markup).not.toMatch(/fonts\.gstatic\.com/);
  });

  it("does not reach Google from the stylesheet either", () => {
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/gstatic|googleapis/);
  });

  it("links the local stylesheet", () => {
    expect(html).toMatch(/href="\/brand-fonts\.css"/);
  });
});

describe("the stylesheet and the files agree", () => {
  it("names at least one face", () => {
    // Non-vacuity: every check below passes against an empty stylesheet.
    expect(referenced.length).toBeGreaterThan(4);
  });

  it("references only files that exist", () => {
    for (const file of referenced) {
      expect(existsSync(new URL(`public/fonts/${file}`, ROOT)), file).toBe(true);
    }
  });

  /**
   * And ships nothing it does not reference. An orphan is 121 KB of Devanagari
   * in the deployment that no rule can ever load.
   */
  it("ships no font the stylesheet never asks for", () => {
    const onDisk = readdirSync(new URL("public/fonts", ROOT)).filter((f) => f.endsWith(".woff2"));

    for (const file of onDisk) {
      expect(referenced.includes(file), `${file} is shipped and never referenced`).toBe(true);
    }
  });
});

describe("the subsetting that makes this affordable", () => {
  /**
   * Every face keeps a `unicode-range`. Without them a French learner
   * downloads all 297 KB instead of the 39 KB Latin file — and the regression
   * is invisible, because the page looks identical and simply costs eight
   * times more on the connections a school is likeliest to have.
   */
  it("keeps a range on every face", () => {
    const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];

    expect(faces.length).toBe(referenced.length);
    for (const face of faces) {
      expect(face, face.slice(0, 60)).toMatch(/unicode-range:/);
    }
  });

  /**
   * And Devanagari stays behind its own range. It is the largest file by a
   * distance and is needed by no language the product currently offers.
   */
  it("keeps Devanagari out of the Latin path", () => {
    const devanagari = (css.match(/@font-face\s*\{[^}]*\}/g) ?? []).filter((face) =>
      /devanagari/i.test(face),
    );

    expect(devanagari.length).toBeGreaterThan(0);
    for (const face of devanagari) {
      if (/noto-sans-devanagari-devanagari/.test(face)) expect(face).toMatch(/U\+0900/);
    }
  });

  /** Text stays readable while a face is arriving. */
  it("keeps font-display: swap on every face", () => {
    for (const face of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
      expect(face, face.slice(0, 60)).toMatch(/font-display:\s*swap/);
    }
  });
});
