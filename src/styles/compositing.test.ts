/**
 * Nothing animates a property the browser has to lay out for.
 *
 * The design system's motion spec states it flatly: every animation is
 * `transform` or `opacity`. The reason is not tidiness. `transform` and
 * `opacity` are composited — the browser hands them to the GPU and the page's
 * layout is untouched — while `width`, `height` and the offsets force layout
 * and paint on *every frame of the animation*, on the main thread, competing
 * with whatever else is running.
 *
 * On this product the thing running is usually audio capture. Three fills used
 * to transition `width`, and the worst of them was the silence countdown,
 * which ticks about ten times a second with the microphone open. The live
 * level meter had been written correctly from the start — `LevelMeter.tsx` has
 * a comment explaining exactly this, and a test pinning `scaleX` — so the rule
 * was understood and simply not enforced anywhere. Four sheets drifted off it.
 *
 * This is the enforcement. It reads the stylesheets rather than the rendered
 * page, which makes it the kind of check that can only see what the source
 * *says* — so it is deliberately paired with the `scaleX` assertions in
 * `LevelMeter.test.tsx`, `InterimFeedback.test.tsx` and `ActivityTest.test.tsx`,
 * which watch what the components actually set.
 */

import { describe, expect, test } from "vitest";

const sheets = import.meta.glob("./**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Properties whose animation forces layout or a full repaint.
 *
 * `background-position` is here for paint rather than layout — it is named in
 * the motion spec because a sweeping gradient is the usual way a skeleton
 * shimmer gets written, and the right way is a transformed pseudo-element.
 */
const LAYOUT_PROPERTIES = [
  "width",
  "height",
  "top",
  "right",
  "bottom",
  "left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "flex-basis",
  "flex-grow",
  "background-position",
  "inset",
];

interface Offence {
  sheet: string;
  line: number;
  text: string;
}

/** Every `transition:` declaration, flattened across multi-line values. */
function transitionOffences(): Offence[] {
  const found: Offence[] = [];

  for (const [path, source] of Object.entries(sheets)) {
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!/^\s*transition:/.test(line)) continue;

      // A transition value may wrap over several lines until its semicolon.
      let value = line;
      let j = i;
      while (!value.includes(";") && j < lines.length - 1) {
        j += 1;
        value += ` ${lines[j] ?? ""}`;
      }

      for (const property of LAYOUT_PROPERTIES) {
        // Word-bounded, so `width` does not match `max-width` and `top` does
        // not match `background-position`'s own words.
        const pattern = new RegExp(`(^|[\\s,:])${property}(\\s|,|;|$)`);
        const body = value.slice(value.indexOf(":") + 1);
        if (pattern.test(body)) {
          found.push({ sheet: path, line: i + 1, text: value.trim().replace(/\s+/g, " ") });
          break;
        }
      }
    }
  }

  return found;
}

/** Every declaration inside a `@keyframes` block, with its block name. */
function keyframeOffences(): Offence[] {
  const found: Offence[] = [];

  for (const [path, source] of Object.entries(sheets)) {
    const lines = source.split("\n");
    let depth = 0;
    let inKeyframes = false;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";

      if (/@keyframes/.test(line)) {
        inKeyframes = true;
        depth = 0;
      }

      if (inKeyframes) {
        depth += (line.match(/\{/g) ?? []).length;
        depth -= (line.match(/\}/g) ?? []).length;

        /**
         * Every `property:` on the line, not just one at its start. A keyframe
         * written inline — `from { height: 0; }` — is valid CSS and carries
         * its declarations mid-line; an earlier version of this anchored to
         * the line start and let exactly that through, which a planted offence
         * caught.
         */
        for (const match of line.matchAll(/([a-z-]+)\s*:/g)) {
          if (!LAYOUT_PROPERTIES.includes(match[1] ?? "")) continue;
          found.push({ sheet: path, line: i + 1, text: line.trim() });
          break;
        }

        if (depth <= 0 && /\}/.test(line)) inKeyframes = false;
      }
    }
  }

  return found;
}

function describeOffences(offences: Offence[]): string {
  return offences.map((o) => `${o.sheet}:${o.line} ${o.text}`).join("\n");
}

describe("every animation is composited", () => {
  test("has stylesheets to read, so this cannot pass on an empty glob", () => {
    // The same guard the other style tests carry. A check that vouches for
    // nothing is worse than no check, because it reports a pass.
    expect(Object.keys(sheets).length).toBeGreaterThan(10);
  });

  /**
   * The one that caught the real drift: three fills transitioning `width`,
   * including the silence countdown that runs while the microphone is open.
   */
  test("no transition animates a property that forces layout", () => {
    const offences = transitionOffences();
    expect(offences, describeOffences(offences)).toEqual([]);
  });

  test("no keyframe animates a property that forces layout", () => {
    const offences = keyframeOffences();
    expect(offences, describeOffences(offences)).toEqual([]);
  });

  /**
   * Non-vacuity, in the only form that means anything here: the matcher must
   * find a planted offence. Without this the two tests above would pass just
   * as happily with a broken regex, and nothing would ever say so.
   */
  test("recognises a layout-animating transition when there is one", () => {
    const planted = ".x {\n  transition: width var(--dur-slow) var(--ease);\n}";
    expect(/^\s*transition:/m.test(planted)).toBe(true);

    const body = planted.slice(planted.indexOf("transition:") + "transition:".length);
    const matched = LAYOUT_PROPERTIES.filter((p) =>
      new RegExp(`(^|[\\s,:])${p}(\\s|,|;|$)`).test(body),
    );
    expect(matched).toContain("width");
    // And does not fire on the properties that are fine.
    expect(matched).not.toContain("padding");
  });

  test("does not mistake max-width or a transform for a layout animation", () => {
    for (const body of [" transform 350ms", " opacity 150ms, transform 350ms", " box-shadow 200ms"]) {
      const matched = LAYOUT_PROPERTIES.filter((p) =>
        new RegExp(`(^|[\\s,:])${p}(\\s|,|;|$)`).test(body),
      );
      expect(matched, `${body} should be composited`).toEqual([]);
    }
  });
});

/**
 * The loops that run forever, and why there are four rather than three.
 *
 * The motion spec says "only three loops: level meter, mic-open pulse,
 * playing-syllable ring". A literal count of `animation: … infinite` across the
 * stylesheet returns five, and both extras are sanctioned rather than drift:
 *
 * - **The skeleton sweep** is named by the spec on its own line — "a
 *   pseudo-element transform, never styled as progress" — so it is a fourth
 *   permitted loop, not a fourth unexplained one.
 * - **The diagnostics poll pulse** is on an internal operator screen, linked
 *   from nowhere and token-gated. It says a poll is live, which is the whole
 *   job of that screen, and no learner ever meets it. Same reasoning as the
 *   perf budget, which holds the internal screens to their own ceiling.
 *
 * Written as an allowlist rather than a count, because a count passes when one
 * loop is swapped for another — and the question is never "how many" but
 * "which".
 */
describe("only the sanctioned animations loop", () => {
  /** Sheets a learner can actually reach. */
  const INTERNAL_SHEETS = ["./diagnostics.css", "./authoring.css", "./teacher.css"];

  const PERMITTED = {
    "meter-hot-pulse": "the level meter, while the microphone is open",
    "rec-pulse": "the mic-open pulse on the record control",
    "sy-sound": "the ring on a syllable being played back",
    "sk-sweep": "the scoring skeleton — named separately by the spec",
  } as const;

  /** Every `animation: … infinite`, with the name it runs and its sheet. */
  function loops(): { sheet: string; name: string }[] {
    const found: { sheet: string; name: string }[] = [];
    for (const [path, source] of Object.entries(sheets)) {
      const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const line of css.split("\n")) {
        if (!/animation:.*\binfinite\b/.test(line)) continue;
        const name = /animation:\s*([A-Za-z][\w-]*)/.exec(line)?.[1] ?? "(unnamed)";
        found.push({ sheet: path, name });
      }
    }
    return found;
  }

  test("finds the loops, so the rules below are not vouching for nothing", () => {
    expect(loops().length).toBeGreaterThan(2);
  });

  test("every loop a learner can reach is one of the four permitted", () => {
    const unexpected = loops()
      .filter((loop) => !INTERNAL_SHEETS.includes(loop.sheet))
      .filter((loop) => !(loop.name in PERMITTED))
      .map((loop) => `${loop.sheet} → ${loop.name}`);

    expect(unexpected, unexpected.join("\n")).toEqual([]);
  });

  /**
   * And each permitted one is actually there. An allowlist protecting nothing
   * is how a list becomes a place to put anything — the same rule the clamp
   * exceptions in `scale.test.ts` are held to.
   */
  test("every permitted loop is still in use", () => {
    const running = new Set(loops().map((loop) => loop.name));
    for (const name of Object.keys(PERMITTED)) {
      expect(running.has(name), `${name} is permitted but no longer runs`).toBe(true);
    }
  });

  /**
   * The three the spec names are learner-facing. If one moved to an internal
   * sheet the rule above would still pass, and the learner would have lost a
   * loop the spec requires.
   */
  test("the three named loops are on sheets a learner reaches", () => {
    for (const name of ["meter-hot-pulse", "rec-pulse", "sy-sound"]) {
      const sheets_ = loops().filter((loop) => loop.name === name);
      expect(sheets_.length, `${name} does not run anywhere`).toBeGreaterThan(0);
      for (const loop of sheets_) {
        expect(INTERNAL_SHEETS, `${name} runs only on an internal screen`).not.toContain(loop.sheet);
      }
    }
  });
});
