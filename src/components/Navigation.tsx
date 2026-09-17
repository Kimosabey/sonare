/**
 * The four destinations — board D7, at every width.
 *
 * Today · Journey · Progress · You. **Four, and never five.** Every screen the
 * product has either belongs under one of them or is reached from inside one;
 * a fifth would mean the set had stopped being a map of what the learner is
 * doing and started being a list of what the app contains.
 *
 * ## One component, three shapes
 *
 * Bottom bar on a phone, a rail on a tablet, a labelled sidebar on a desktop.
 * The switch is CSS — a container-driven layout in the stylesheet, not a
 * JavaScript breakpoint — because a JS breakpoint has to guess before the
 * first paint and gets it wrong on a rotation, and because the markup that
 * changes between widths is the part a screen reader has no opinion about
 * anyway. The order and the labels are identical at all three.
 *
 * ## Why it disappears during a sitting
 *
 * A sitting has a finish line, and a tab bar beside it is a standing
 * invitation to leave it half-done. The board is explicit that the session
 * runs *over* the tabs with its own back and close as the only two ways out.
 * `hidden` is passed by the shell rather than decided here, because "is a
 * sitting in progress" is the session's fact, not navigation's.
 */

import { TabIcon, type TabIconProps } from "./TabIcon.js";
import { NavLink } from "react-router-dom";

export interface NavigationProps {
  /** The learner's current language, for the two per-language destinations. */
  slug: string | null;
  /** True while a sitting is running — the bar is gone, not merely dimmed. */
  hidden?: boolean;
}

interface Destination {
  to: string;
  label: TabIconProps["name"];
}

export function Navigation({ slug, hidden = false }: NavigationProps) {
  if (hidden) return null;

  /**
   * Journey and Progress are per-language and need a slug. Without one — a
   * learner who has never practised — they point at the picker, which is the
   * screen that supplies the missing fact. Hiding them instead would make the
   * bar change shape on the second visit, and a navigation that grows as you
   * use it is one nobody can learn.
   */
  const destinations: Destination[] = [
    { to: "/", label: "Today" },
    { to: slug === null ? "/languages" : `/${slug}/journey`, label: "Journey" },
    { to: slug === null ? "/languages" : `/${slug}/progress`, label: "Progress" },
    { to: "/settings", label: "You" },
  ];

  return (
    <nav className="tabs" aria-label="Main">
      <ul>
        {destinations.map((destination) => (
          <li key={destination.label}>
            <NavLink
              to={destination.to}
              /**
               * `end` only on Today, which is "/" and would otherwise match
               * every route in the app — the whole bar would render as
               * current, everywhere.
               */
              end={destination.to === "/"}
              className={({ isActive }) => (isActive ? "tab is-current" : "tab")}
            >
              {/*
                Decorative, and drawn rather than typed — see TabIcon. The
                label below carries the name, so announcing the mark as well
                would read every destination twice.
              */}
              <TabIcon name={destination.label} />
              {/*
                Always rendered, never hidden at narrow widths. An icon-only
                tab bar is a guessing game for anyone who does not already know
                the app, and the labels are four short words.
              */}
              <span className="tab-label">{destination.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
