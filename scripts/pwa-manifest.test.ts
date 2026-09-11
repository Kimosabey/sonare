/**
 * The install surface: `public/manifest.webmanifest` and the head of
 * `index.html`.
 *
 * A web app manifest is the only artefact in this repository that nothing
 * validates. It is not imported, not typechecked, not rendered by any test —
 * a trailing comma makes it unparseable and the app still loads, still passes
 * every gate, and simply stops being installable. An icon path that points at
 * nothing shows an empty square on a learner's home screen. So: parse it,
 * resolve every file it names, and tie its two colours back to the tokens they
 * came from.
 *
 * ## The two colours, and why they are not interchangeable
 *
 * `theme_color` paints *chrome* — the Android status bar, a desktop PWA's
 * title bar. Brand violet is right there.
 *
 * `background_color` paints the splash screen Chromium *generates* from the
 * manifest and shows before the first frame. It has to equal the app's real
 * page background, or the learner sees a colour jump between splash and first
 * paint. Violet there would flash the whole screen the wrong colour. Both
 * values are read out of src/styles/tokens.css below rather than restated, so
 * moving the palette fails a test instead of shipping a flash.
 *
 * ## What iOS does with none of this
 *
 * Safari ignores the manifest for splash purposes and wants an explicit
 * `apple-touch-startup-image` per device resolution, each with its own `media`
 * query. Five of them now exist, from the design handoff. A `<link>` pointing
 * at a missing file is a *broken* splash rather than no splash, so every local
 * URL in the head is resolved against disk below.
 *
 * The interesting failure is subtler than a missing file: a link whose `media`
 * query does not describe the device the artwork was drawn for. iOS picks by
 * the query and then stretches whatever it finds, so the mismatch is silent —
 * the splash simply looks wrong on one model of phone and nowhere else. The
 * arithmetic is checkable, so it is checked: a query's `device-width` times
 * its `-webkit-device-pixel-ratio` must equal the file's real pixel width, out
 * of the PNG's own IHDR chunk, and the same for height. That ties the query,
 * the filename and the bytes together, and no two of the three can drift apart
 * without failing here.
 *
 * Lives in scripts/ because it reads the filesystem; see vitest.config.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(ROOT, "public", "manifest.webmanifest");
const RAW = readFileSync(MANIFEST_PATH, "utf8");
const HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const TOKENS = readFileSync(join(ROOT, "src", "styles", "tokens.css"), "utf8");

/**
 * Comments stripped before anything structural is asked of the HTML.
 *
 * src/styles/focus.test.ts learned this the hard way on the stylesheets: the
 * comments in this repository quote the very things being checked for. The
 * head's own comment block names `apple-touch-startup-image` while explaining
 * why there isn't one, and mentions `src/styles/tokens.css` — both of which a
 * naive scan would read as markup.
 */
const HEAD = HTML.replace(/<!--[\s\S]*?-->/g, "");

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface Manifest {
  name?: string;
  short_name?: string;
  description?: string;
  lang?: string;
  dir?: string;
  categories?: string[];
  start_url?: string;
  scope?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  orientation?: string;
  icons?: Icon[];
}

/** A token's value, read from the stylesheet that defines it. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(TOKENS);
  return (match?.[1] ?? "").trim();
}

/**
 * Where a root-relative URL in index.html or the manifest actually lands.
 *
 * `public/` is copied to the build root verbatim, and Vite resolves `/src/...`
 * from the project root, so both roots are tried.
 */
function resolves(url: string): boolean {
  const relative = url.replace(/^\//, "").split("?")[0] ?? "";
  if (relative === "") return false;
  return existsSync(join(ROOT, "public", relative)) || existsSync(join(ROOT, relative));
}

/** A PNG's real dimensions, straight out of its IHDR chunk. */
function pngSize(url: string): { width: number; height: number } {
  const relative = url.replace(/^\//, "");
  const path = existsSync(join(ROOT, "public", relative))
    ? join(ROOT, "public", relative)
    : join(ROOT, relative);
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the manifest is readable at all", () => {
  it("was found on disk and is not empty", () => {
    // Guards everything below: an unreadable file would make every field check
    // fail for the wrong reason, and an empty one would parse as nothing.
    expect(RAW.length, `${MANIFEST_PATH} read as empty`).toBeGreaterThan(100);
  });

  it("is valid JSON", () => {
    // A `.webmanifest` is strict JSON — no comments, no trailing commas — and
    // a browser that cannot parse it silently declines to offer the install.
    expect(() => JSON.parse(RAW) as unknown).not.toThrow();
  });
});

describe("the fields a browser needs to offer an install", () => {
  const manifest = JSON.parse(RAW) as Manifest;

  it("carries a name and a short name", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    // Home-screen labels are truncated around a dozen characters; a long
    // short_name means the learner sees an ellipsis where the app's identity
    // should be.
    expect((manifest.short_name ?? "").length).toBeLessThanOrEqual(12);
  });

  it("says what it is, in a stated language and direction", () => {
    expect(manifest.description).toBeTruthy();
    expect(manifest.lang).toBe("en");
    expect(manifest.dir).toBe("ltr");
    expect(manifest.categories).toEqual(["education"]);
  });

  it("starts at / and scopes to /, because routes live after the #", () => {
    /**
     * The app uses a HashRouter (see the header of src/App.tsx), so every
     * route is `/#/something` and the document is always `/`. A `start_url`
     * with a fragment would also make the installed app's start URL differ
     * from the scope root for no gain.
     */
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
  });

  it("displays standalone", () => {
    expect(manifest.display).toBe("standalone");
  });

  it("does not lock orientation", () => {
    // A learner with a tablet in landscape should not be fought. The app's
    // layout is responsive either way.
    expect(manifest.orientation).toBeUndefined();
  });
});

describe("the two colours come from the palette, not from memory", () => {
  const manifest = JSON.parse(RAW) as Manifest;

  it("reads the tokens it is being compared against", () => {
    // Without this, a failed parse would compare "" to "" and pass.
    expect(token("signal")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(token("ground")).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("paints chrome with the brand violet", () => {
    // --signal, the brand purple. This is the app's identity in the OS.
    expect(manifest.theme_color?.toLowerCase()).toBe(token("signal").toLowerCase());
  });

  it("paints the generated splash with the app's real page background", () => {
    /**
     * The whole point. Chromium generates an Android splash from `name`,
     * `background_color` and a >=512px icon, and hands over to the first
     * paint. If this value is not --ground there is a visible colour jump at
     * that handover — a flash that reads as a bug and costs nothing to avoid.
     */
    expect(manifest.background_color?.toLowerCase()).toBe(token("ground").toLowerCase());
  });

  it("does not use the same colour for both", () => {
    // They answer different questions. Violet as the background_color would
    // flash the entire screen; --ground as the theme_color would leave the
    // status bar unbranded near-white.
    expect(manifest.theme_color).not.toBe(manifest.background_color);
  });

  it("matches the theme-color meta tag in index.html", () => {
    // Two declarations of one colour, in two files, and nothing else connects
    // them.
    const meta = /<meta name="theme-color" content="([^"]+)"/.exec(HEAD)?.[1];
    expect(meta, "index.html declares no theme-color").toBeTruthy();
    expect(meta?.toLowerCase()).toBe(manifest.theme_color?.toLowerCase());
  });
});

describe("the icons", () => {
  const manifest = JSON.parse(RAW) as Manifest;
  const icons = manifest.icons ?? [];

  it("declares at least one", () => {
    expect(icons.length).toBeGreaterThan(0);
  });

  it("names files that exist", () => {
    // The failure this catches is an empty square on a home screen — visible
    // to a learner, invisible to every other gate.
    for (const icon of icons) {
      expect(resolves(icon.src), `${icon.src} does not resolve to a file`).toBe(true);
    }
  });

  it("declares the size the artwork actually is", () => {
    /**
     * A `sizes` that lies is worse than one that is absent: a browser picking
     * an icon for a 192px slot trusts the declaration, and Chromium needs a
     * real >=512px icon to generate the Android splash at all.
     */
    for (const icon of icons) {
      const real = pngSize(icon.src);
      expect(icon.sizes, icon.src).toBe(`${real.width}x${real.height}`);
      expect(real.width).toBeGreaterThanOrEqual(512);
    }
  });

  it("declares a type", () => {
    for (const icon of icons) expect(icon.type).toBe("image/png");
  });

  it("does not claim the un-padded brand icon is maskable", () => {
    /**
     * Measured, not assumed. `public/brand/icon.png` is the mortarboard mark
     * on a pale circular plate, and the brim runs almost the full width: the
     * violet ink's smallest margin is 23px of 512, i.e. 4.5% per side, where a
     * maskable icon needs roughly 10% per side (the ~20% total safe-zone
     * padding). 4,524 ink pixels — 6.3% of the mark — sit outside the central
     * 80% safe circle Android is allowed to crop to.
     *
     * So declaring `purpose: "maskable"` on this file would have Android crop
     * into the logo on any device using a circular or squircle mask. It is
     * declared `"any"` instead, and a padded maskable variant is a design
     * task, not something to relabel.
     *
     * Written as a rule rather than a flat "nothing is maskable": adding a
     * genuinely padded second asset later passes, and relabelling this one
     * fails.
     */
    const maskable = icons.filter((icon) => (icon.purpose ?? "").split(/\s+/).includes("maskable"));
    expect(
      maskable.map((icon) => icon.src),
      "this artwork has 4.5% edge padding; a maskable icon needs ~10% per side",
    ).not.toContain("/brand/icon.png");
  });

  it("declares exactly one maskable icon, and it is the padded export", () => {
    /**
     * The other half of the rule above, which on its own is satisfied by
     * declaring nothing maskable at all — and that is what shipped until the
     * padded artwork existed. Android's adaptive icon crops to a circle or a
     * squircle; with no maskable icon declared it does not crop, it *shrinks*
     * the icon into the mask and puts a grey plate behind it. So the absence
     * is visible on a home screen too, and now that a file drawn for the crop
     * exists, its declaration is worth holding in place.
     *
     * `/splash/icon-maskable-512.png` has its art at 60% of the canvas, inside
     * the 40% safe circle, so every mask shape Android applies lands on ground
     * rather than on the mortarboard. Exactly one, because a second maskable
     * entry means a browser is choosing between them on size alone and the
     * padding is no longer something this file has checked.
     */
    const maskable = icons.filter((icon) => (icon.purpose ?? "").split(/\s+/).includes("maskable"));
    expect(maskable.map((icon) => icon.src)).toEqual(["/splash/icon-maskable-512.png"]);
  });

  it("offers Android a 1024 source for the splash it generates", () => {
    /**
     * Chromium generates the Android splash from `name`, `background_color`
     * and the largest suitable icon. 512 is the documented floor and is what
     * the brand icon gives it; 1024 is what the handoff exported so the
     * generated splash is drawn from real pixels rather than upscaled ones on
     * a 3x phone.
     *
     * Declared `"any"`, not maskable: it is full-bleed artwork, the same shape
     * as /brand/icon.png and subject to the same crop problem.
     */
    const large = icons.filter((icon) => pngSize(icon.src).width >= 1024);
    expect(large.map((icon) => icon.src)).toContain("/splash/icon-1024.png");
    for (const icon of large) {
      expect((icon.purpose ?? "").split(/\s+/), icon.src).not.toContain("maskable");
    }
  });

  it("states a purpose on every icon", () => {
    // The default is "any", so this is redundant to a browser and not to a
    // reader: the maskable decision above is the interesting one, and it
    // should be visible in the file rather than inferred from an omission.
    for (const icon of icons) expect(icon.purpose).toBeTruthy();
  });
});

describe("index.html's install surface", () => {
  it("links the manifest", () => {
    expect(HEAD).toContain('rel="manifest" href="/manifest.webmanifest"');
  });

  it("carries both spellings of the standalone flag", () => {
    /**
     * `mobile-web-app-capable` is the standard one, read by Chromium and by
     * Safari from 17. `apple-mobile-web-app-capable` is the older Apple-only
     * name and is still the only one iOS 16 and earlier understands — without
     * it those iPhones open Sonare as a Safari tab with an address bar rather
     * than standalone. Chrome logs a deprecation notice for the Apple one,
     * which is cheaper than losing standalone mode on the older half of iOS.
     */
    expect(HEAD).toContain('<meta name="mobile-web-app-capable" content="yes" />');
    expect(HEAD).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
  });

  it("declares an apple-touch-icon, since iOS ignores the manifest's list", () => {
    const href = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(HEAD)?.[1];
    expect(href, "no apple-touch-icon").toBeTruthy();
    expect(resolves(href ?? ""), `${href} does not resolve`).toBe(true);
  });

  it("sets an iOS status-bar style compatible with viewport-fit=cover", () => {
    // `black-translucent` would slide the app under the status bar, and
    // viewport-fit=cover is already set — the header would land behind the
    // notch.
    expect(HEAD).toContain('name="apple-mobile-web-app-status-bar-style" content="default"');
  });

  it("points every local URL at a file that exists", () => {
    /**
     * The general form of the broken-splash bug. An `apple-touch-startup-image`
     * whose file is missing gives iOS a *broken* splash, which is worse than
     * the plain one it falls back to — and the same is true of any icon or
     * manifest href. Checked across the whole head rather than per tag, so a
     * future addition is covered without anyone remembering to extend this.
     */
    const urls = [...HEAD.matchAll(/(?:href|src)="(\/[^"]*)"/g)]
      .map((m) => m[1])
      .filter((url): url is string => url !== undefined);

    // A parse that found nothing would report that every one of nothing
    // resolves.
    expect(urls.length).toBeGreaterThanOrEqual(4);
    for (const url of urls) {
      expect(resolves(url), `${url} is referenced by index.html and does not exist`).toBe(true);
    }
  });

});

/**
 * Every `<link rel="apple-touch-startup-image">` in the head, with its `media`
 * query broken into the three values Safari selects on.
 *
 * Parsed off HEAD, which has had comments stripped — the block above these
 * links explains the arithmetic using the same words and would otherwise be
 * read as five more links.
 */
interface StartupImage {
  href: string;
  media: string;
  deviceWidth: number | undefined;
  deviceHeight: number | undefined;
  ratio: number | undefined;
}

function startupImages(): StartupImage[] {
  const tags = HEAD.match(/<link\b[^>]*rel="apple-touch-startup-image"[^>]*>/g) ?? [];
  return tags.map((tag) => {
    const number = (property: string): number | undefined => {
      const found = new RegExp(`${property}:\\s*([0-9.]+)`).exec(tag)?.[1];
      return found === undefined ? undefined : Number(found);
    };
    return {
      href: /href="([^"]+)"/.exec(tag)?.[1] ?? "",
      media: /media="([^"]+)"/.exec(tag)?.[1] ?? "",
      deviceWidth: number("device-width"),
      deviceHeight: number("device-height"),
      ratio: number("-webkit-device-pixel-ratio"),
    };
  });
}

describe("the iOS splash screens", () => {
  const images = startupImages();

  it("declares one per device the handoff exported artwork for", () => {
    /**
     * Five iPhone resolutions, deliberately rather than exhaustively — see the
     * comment on the links themselves. The count is asserted so that a parse
     * returning nothing cannot make every check below pass by having nothing
     * to check, which is the failure this file's own header calls out.
     */
    expect(images.length, "no apple-touch-startup-image links were parsed").toBe(5);
  });

  it("gives every one a media query, since a bare one would claim every device", () => {
    /**
     * `<link rel="apple-touch-startup-image">` with no `media` matches
     * everything. Ship one alongside four targeted ones and iOS may pick the
     * untargeted file for a phone that has its own, so the designed splash is
     * stretched from the wrong resolution on exactly the devices this list
     * exists to serve.
     */
    for (const image of images) {
      expect(image.media, `${image.href} has no media query`).toBeTruthy();
      expect(image.deviceWidth, `${image.href}: media names no device-width`).toBeGreaterThan(0);
      expect(image.deviceHeight, `${image.href}: media names no device-height`).toBeGreaterThan(0);
      expect(image.ratio, `${image.href}: media names no -webkit-device-pixel-ratio`).toBeGreaterThan(0);
    }
  });

  it("points every one at a file that exists", () => {
    // A startup-image href that resolves to nothing gives iOS a *broken*
    // splash, which is worse than the plain one it falls back to. Also covered
    // by the whole-head check above; stated here too so the failure names the
    // splash rather than "some URL".
    for (const image of images) {
      expect(resolves(image.href), `${image.href} does not resolve to a file`).toBe(true);
    }
  });

  it("pairs each media query with artwork at exactly that pixel size", () => {
    /**
     * The check this whole describe block exists for. iOS selects on the query
     * and then draws whatever the href names, scaled to fit — so a link that
     * points at the wrong file produces a stretched or letterboxed splash on
     * one model of phone and looks perfect everywhere else. Nothing else in
     * this repository would notice.
     *
     * CSS size times pixel ratio is the device's real pixel size, and the PNG
     * knows its own: 430 x 3 = 1290 and 932 x 3 = 2796 is the Pro Max, and the
     * file named for it has to be 1290x2796 in its IHDR chunk.
     */
    for (const image of images) {
      const real = pngSize(image.href);
      expect(
        (image.deviceWidth ?? 0) * (image.ratio ?? 0),
        `${image.href}: media says ${image.deviceWidth}px @${image.ratio}x, artwork is ${real.width}px wide`,
      ).toBe(real.width);
      expect(
        (image.deviceHeight ?? 0) * (image.ratio ?? 0),
        `${image.href}: media says ${image.deviceHeight}px @${image.ratio}x, artwork is ${real.height}px tall`,
      ).toBe(real.height);
    }
  });

  it("names each file after the pixels actually in it", () => {
    // The filename is how a human matches a link to an export, and it is the
    // only part of the chain a person reads. A rename that drifts from the
    // bytes turns every review of this list into a lie.
    for (const image of images) {
      const declared = /-(\d+)x(\d+)\.png$/.exec(image.href);
      expect(declared, `${image.href} does not state its size in its name`).toBeTruthy();
      const real = pngSize(image.href);
      expect(Number(declared?.[1]), image.href).toBe(real.width);
      expect(Number(declared?.[2]), image.href).toBe(real.height);
    }
  });

  it("does not shadow one device with two links", () => {
    /**
     * Two links with the same `media` are not an error to a browser — the
     * later one simply wins — so a copy-paste that changed the href and not
     * the query leaves one device permanently served the wrong artwork and one
     * export permanently unused. Both halves are asserted: no repeated query,
     * and no repeated file.
     */
    const queries = images.map((image) => image.media);
    expect(new Set(queries).size, `duplicate media query: ${queries.join(" | ")}`).toBe(
      images.length,
    );
    const files = images.map((image) => image.href);
    expect(new Set(files).size, `duplicate href: ${files.join(" | ")}`).toBe(images.length);
  });
});

describe("the worker the page registers", () => {
  it("is served from public/, at the path register.ts asks for", () => {
    /**
     * A scope mismatch is the classic silent PWA failure: a worker served from
     * `/assets/sw.js` can only control `/assets/`, so it registers, activates
     * and intercepts nothing. `public/` is copied to the build root verbatim,
     * which is what makes `/sw.js` — and therefore a scope of `/` — true.
     */
    const registerSource = readFileSync(join(ROOT, "src", "pwa", "register.ts"), "utf8");
    const url = /const WORKER_URL = "([^"]+)"/.exec(registerSource)?.[1];
    expect(url, "register.ts does not declare a WORKER_URL").toBe("/sw.js");
    expect(existsSync(join(ROOT, "public", "sw.js"))).toBe(true);
  });

  it("answers the exact message register.ts posts", () => {
    /**
     * The two halves of the update handshake live in different files and
     * different languages, and nothing else connects them. A renamed message
     * type means the button in the toast does nothing at all: the worker keeps
     * waiting, the page keeps waiting for a `controllerchange` that never
     * comes, and the learner presses "Update now" to no effect.
     */
    const registerSource = readFileSync(join(ROOT, "src", "pwa", "register.ts"), "utf8");
    const posted = /SKIP_WAITING_MESSAGE = \{ type: "([^"]+)" \}/.exec(registerSource)?.[1];
    expect(posted, "register.ts does not declare the message it posts").toBeTruthy();

    const workerSource = readFileSync(join(ROOT, "public", "sw.js"), "utf8");
    expect(workerSource).toContain(`data.type === "${posted}"`);
  });
});
