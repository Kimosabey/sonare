/**
 * The way back from a screen inside a tab — board 1e, the part of D7 that is a
 * rule rather than a picture.
 *
 * **An installed iOS PWA has no browser back button.** In standalone display
 * mode Safari's chrome is gone entirely, so a screen with no in-app way back
 * is a dead end reachable only by force-quitting. That is the reason this
 * exists, and the reason it is a real control rather than a breadcrumb: the
 * one it replaces was an 11px link, well under the tap floor, which NFR-03
 * could not see because it was not sized like a target in the first place.
 *
 * 44px, top left, always present. Not conditional on history depth — a screen
 * reached by a typed URL or a shared link has no history to go back through,
 * and a back control that vanished in exactly that case would be missing
 * whenever it was most needed.
 */

import { Link } from "react-router-dom";

export interface BackLinkProps {
  /** Where back goes. An explicit destination, never `history.back()`. */
  to: string;
  /**
   * What is being returned to, for the accessible name. "Back" alone gives a
   * screen-reader user no idea where they are about to land.
   */
  label: string;
}

export function BackLink({ to, label }: BackLinkProps) {
  return (
    <Link className="back-link" to={to}>
      <span className="back-chevron" aria-hidden="true">
        ‹
      </span>
      <span>Back to {label}</span>
    </Link>
  );
}
