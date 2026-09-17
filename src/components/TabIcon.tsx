/**
 * The four destination marks, drawn rather than typed.
 *
 * They used to be characters — `▣ ☰ △ ⚙` — and one of them was a bug rather
 * than a style choice. **U+2699 GEAR defaults to *emoji* presentation on iOS
 * and Android**, and nothing carried the U+FE0E text-presentation selector. So
 * on a phone, which is this product's primary surface, three tabs rendered as
 * thin monochrome outlines and the fourth as a full-colour gear.
 *
 * Worse than the mismatch: a colour emoji ignores `color`. The bar's current
 * state is deliberately "a colour *and* a weight *and* a top rule", because
 * colour alone fails the constraint the product keeps everywhere — and on that
 * one tab the colour third simply never applied to the glyph.
 *
 * Drawn marks fix all of it. They take `currentColor`, so the current state
 * reaches them; they cannot fall back to tofu on a font that lacks a
 * codepoint; and they are the same optical weight as each other on every
 * platform, which four characters from four different Unicode blocks never
 * were.
 *
 * Still decorative. Every tab renders a visible text label beside or beneath
 * the mark, so these are `aria-hidden` and announcing them would read each
 * destination twice.
 */

export interface TabIconProps {
  /** Which destination. Matches the tab's own label. */
  name: "Today" | "Journey" | "Progress" | "You";
}

/**
 * One geometry, four marks: a 24-unit box, a 2-unit stroke, round joins.
 *
 * Shared so the four cannot drift apart the way the characters had. `round`
 * caps matter at this size — a butt cap on a 2px stroke reads as a slightly
 * different weight depending on the angle it ends at.
 */
const SHARED = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function TabIcon({ name }: TabIconProps) {
  if (name === "Today") {
    // A day on a calendar: the sheet, its binding, and today marked on it.
    return (
      <svg {...SHARED} className="tab-icon" aria-hidden="true" focusable="false">
        <rect x="3" y="5" width="18" height="16" rx="2.5" />
        <path d="M3 10h18M8 3v4M16 3v4" />
        <circle cx="12" cy="15.5" r="1.6" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (name === "Journey") {
    // A route with stops on it — the course spine, which is what Journey shows.
    return (
      <svg {...SHARED} className="tab-icon" aria-hidden="true" focusable="false">
        <path d="M6 20c0-4 12-4 12-8S8 8 8 4" />
        <circle cx="8" cy="4" r="2" />
        <circle cx="6" cy="20" r="2" />
      </svg>
    );
  }

  if (name === "Progress") {
    // Sounds measured over time: three bars, rising, on a baseline.
    return (
      <svg {...SHARED} className="tab-icon" aria-hidden="true" focusable="false">
        <path d="M4 20h16" />
        <path d="M7.5 20v-5M12 20v-9M16.5 20v-13" />
      </svg>
    );
  }

  // You: a person, not a gear. The tab is the learner's own record — export,
  // transfer, erase — rather than application settings, and the mark should
  // say whose record it is.
  return (
    <svg {...SHARED} className="tab-icon" aria-hidden="true" focusable="false">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}
