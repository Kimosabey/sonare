/**
 * T19's platform split, and the only device information a browser will give us.
 *
 * PRD §3 S2 names iPhone Safari and desktop Chrome as the minimum pair the
 * fixture must cover, and the analysis groups every recording by what this
 * function returns. So a misparse does not show up as a wrong label on a debug
 * panel — it shows up as a platform comparison drawn from two buckets that
 * were never what they claimed, which is a conclusion, not a bug report.
 *
 * The specific trap the module was written around: every Chromium derivative
 * embeds "Chrome" *and* "Safari" in its UA string for compatibility, so a
 * leftmost-match check reports most browsers as one of those two. The module's
 * header records that Edge, Chrome-on-iOS and Samsung Internet all silently
 * misreported before it was ordered most-specific-first — which is exactly the
 * kind of fix that regresses the next time a branch is reordered.
 */

import { describe, expect, it } from "vitest";
import { parsePlatform, parseUserAgent } from "./parseUserAgent.js";

/** Real strings, not invented ones — the ordering bug only shows in real UAs. */
const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  iphoneFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  iphoneEdge:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/126.0.2592.87 Mobile/15E148 Safari/605.1.15",
  ipadSafari:
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  winChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  winEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87",
  winFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  androidOpera:
    "Mozilla/5.0 (Linux; Android 14; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 OPR/82.0.0.0",
} as const;

describe("the Chromium-derivative trap", () => {
  it.each([
    ["winEdge", "Edge 126"],
    ["iphoneEdge", "Edge 126"],
    ["androidSamsung", "Samsung Internet 25"],
    ["androidOpera", "Opera 82"],
    ["iphoneChrome", "Chrome 126"],
    ["iphoneFirefox", "Firefox 127"],
  ] as const)("does not report %s as plain Chrome or Safari", (key, expected) => {
    /**
     * Every one of these carries "Chrome" or "Safari" in its own UA string.
     * This is the regression the branch ordering exists to prevent, and it is
     * the test to run after touching that ordering.
     */
    expect(parseUserAgent(UA[key])).toContain(expected);
  });

  it("still reports real Chrome as Chrome", () => {
    // The other half — specificity that swallowed the general case would be
    // just as wrong, and would produce "?" for the commonest browser there is.
    expect(parseUserAgent(UA.winChrome)).toBe("Windows 10.0 · Chrome 126");
    expect(parseUserAgent(UA.androidChrome)).toBe("Android 14 · Chrome 126");
    expect(parseUserAgent(UA.macChrome)).toBe("Macintosh 10.15.7 · Chrome 126");
  });
});

describe("Safari's version number", () => {
  it("reads Version/, not the WebKit build after Safari/", () => {
    /**
     * These are unrelated numbers. Reporting the build number would label an
     * iOS 17 phone as "Safari 604", which is not a version of anything and
     * makes the fixture's iOS bucket unreadable.
     */
    expect(parseUserAgent(UA.iphoneSafari)).toBe("iPhone 17.5.1 · Safari 17");
    expect(parseUserAgent(UA.macSafari)).toBe("Macintosh 10.15.7 · Safari 17");
  });

  it("still names Safari when no Version token is present", () => {
    // A WebView. Better to say "Safari" with no number than "?".
    expect(parseUserAgent("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Safari/604.1")).toBe("iPhone · Safari");
  });
});

describe("platform and OS version", () => {
  it("normalises Apple's underscored versions to dots", () => {
    // "17_5_1" is not a version string anyone reads. The fixture export is
    // read by a person deciding whether a platform difference is real.
    expect(parseUserAgent(UA.iphoneSafari)).toContain("iPhone 17.5.1");
    expect(parseUserAgent(UA.macSafari)).toContain("Macintosh 10.15.7");
  });

  it("separates iPad from iPhone", () => {
    // Different microphone hardware and a different audio session. Merging
    // them would hide exactly the kind of platform effect T19 is looking for.
    expect(parsePlatform(UA.ipadSafari)).toBe("iPad");
    expect(parsePlatform(UA.iphoneSafari)).toBe("iPhone");
  });

  it("reads the iPad's OS from its own token, which omits the word iPad", () => {
    // iPadOS reports "CPU OS 17_5", not "iPad OS 17_5" — a real asymmetry in
    // Apple's strings rather than a typo in the regex.
    expect(parseUserAgent(UA.ipadSafari)).toBe("iPad · Safari 17");
  });

  it("reports each shipped platform distinctly", () => {
    const platforms = [UA.iphoneSafari, UA.ipadSafari, UA.macChrome, UA.winChrome, UA.androidChrome].map(
      parsePlatform,
    );

    expect(platforms).toEqual(["iPhone", "iPad", "Macintosh", "Windows", "Android"]);
    expect(new Set(platforms).size).toBe(5);
  });
});

describe("degrading rather than guessing", () => {
  it("returns a marker, not a wrong answer, for an unrecognised platform", () => {
    /**
     * A Linux desktop or a curl. "?" is honest and groups separately in the
     * analysis; silently bucketing it as one of the five real platforms would
     * contaminate whichever bucket it landed in.
     */
    expect(parsePlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("?");
    expect(parseUserAgent("curl/8.4.0")).toBe("? · ?");
  });

  it("does not throw on an empty or nonsense agent", () => {
    // navigator.userAgent can be stripped by a privacy extension. The debug
    // panel renders this on the activity page, so throwing here would take
    // down the recording screen over a label.
    expect(parseUserAgent("")).toBe("? · ?");
    expect(parseUserAgent(" �")).toBe("? · ?");
  });

  it("shows only the major browser version, not the full four-part build", () => {
    // "126.0.6478.54" is noise in a grouped analysis; "126" is the number a
    // person compares.
    expect(parseUserAgent(UA.iphoneChrome)).toBe("iPhone 17.5.1 · Chrome 126");
  });

  it("formats every real agent as 'platform · browser'", () => {
    // The analysis splits on this separator, so its presence is contractual.
    for (const [name, ua] of Object.entries(UA)) {
      expect(parseUserAgent(ua), name).toMatch(/^.+ · .+$/);
    }
  });
});
