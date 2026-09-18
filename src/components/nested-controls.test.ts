/**
 * No control wraps another control, checked in the JSX rather than the DOM.
 *
 * Eight places shipped `<Link><button>Back to today</button></Link>`, which
 * renders `<a><button></a>`. It is invalid HTML, it is **two tab stops for one
 * action**, a screen reader announces "link, Back to today, button, Back to
 * today", and Enter on the inner button does nothing because the anchor is
 * what navigates.
 *
 * ── why this is not left to axe ────────────────────────────────────────────
 *
 * The browser suite runs `nested-interactive`, and that rule was added when
 * this was found. It does **not** flag this shape: a nested control was put
 * back deliberately, the build rebuilt, and all eight screens passed. Axe
 * catches other nestings and earns its place, but not this one — so the check
 * that actually protects it reads the source.
 *
 * Which is also where the mistake is made. A developer writing a link that
 * should look like a button reaches for `<Link><button>` because it is the
 * obvious thing; the replacement — `a.enter-cta` and `a.ghost`, anchors that
 * restate the button rule and say so in `base.css` — is one they have to know
 * about. Failing at author time is what tells them.
 */

import { describe, expect, test } from "vitest";

const modules = import.meta.glob("../**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Source files that ship. A test fixture may render whatever it likes. */
function shipping(): [string, string][] {
  return Object.entries(modules).filter(([path]) => !/\.test\.tsx$/.test(path));
}

/**
 * An opening `<Link …>` or `<a …>` followed, before its close, by an opening
 * `<button` or another anchor.
 *
 * Deliberately a shallow scan rather than a parse: JSX that nests a control
 * more than a couple of lines deep inside a link is doing something unusual
 * enough to be read by a person, and a regex that tried to handle it would
 * mostly produce false confidence.
 */
function nestings(): string[] {
  const found: string[] = [];

  for (const [path, source] of shipping()) {
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!/<(Link|a)\s/.test(line) && !/<(Link|a)>/.test(line)) continue;

      // Look ahead until the link closes, or five lines, whichever is first.
      for (let j = i; j < Math.min(i + 6, lines.length); j += 1) {
        const ahead = lines[j] ?? "";
        if (j > i && /<\/(Link|a)>/.test(ahead)) break;
        if (/<button[\s>]/.test(ahead)) {
          found.push(`${path}:${i + 1} ${line.trim()} … ${ahead.trim()}`);
          break;
        }
      }
    }
  }

  return found;
}

describe("no control wraps another", () => {
  test("has files to read, so this cannot pass on an empty glob", () => {
    expect(shipping().length).toBeGreaterThan(20);
  });

  test("no link contains a button", () => {
    const found = nestings();
    expect(found, found.join("\n")).toEqual([]);
  });

  /**
   * Non-vacuity. The scan has to find a planted nesting, or the rule above
   * would pass just as happily with a broken regex — which is the shape of
   * mistake that let eight of these ship under a working accessibility suite.
   */
  test("recognises a nested control when there is one", () => {
    const planted = ['<Link to="/">', "  <button type=\"button\">Back</button>", "</Link>"];
    let hit = false;

    for (let i = 0; i < planted.length; i += 1) {
      const line = planted[i] ?? "";
      if (!/<(Link|a)\s/.test(line)) continue;
      for (let j = i; j < Math.min(i + 6, planted.length); j += 1) {
        const ahead = planted[j] ?? "";
        if (j > i && /<\/(Link|a)>/.test(ahead)) break;
        if (/<button[\s>]/.test(ahead)) hit = true;
      }
    }

    expect(hit).toBe(true);
  });

  /**
   * And does not fire on the shape that replaced it — an anchor carrying the
   * button's class, with a sibling button somewhere further down the file.
   */
  test("does not fire on an anchor styled as a button", () => {
    const fine = ['<Link to="/" className="ghost">', "  Back to today", "</Link>", "", "<button>Elsewhere</button>"];
    let hit = false;

    for (let i = 0; i < fine.length; i += 1) {
      const line = fine[i] ?? "";
      if (!/<(Link|a)\s/.test(line)) continue;
      for (let j = i; j < Math.min(i + 6, fine.length); j += 1) {
        const ahead = fine[j] ?? "";
        if (j > i && /<\/(Link|a)>/.test(ahead)) break;
        if (/<button[\s>]/.test(ahead)) hit = true;
      }
    }

    expect(hit).toBe(false);
  });
});
