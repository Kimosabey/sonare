/**
 * "Not here yet" — the planned list, on the You tab.
 *
 * Every entry says what a learner will be able to do and why it is not here,
 * and none of them carries a date. See `src/planned.ts` for why.
 *
 * It sits low on the screen, below the things a learner came for. A roadmap
 * above somebody's own data is an advertisement on a page they opened to check
 * something about themselves.
 */

import { PLANNED } from "../planned.js";

export function Planned() {
  if (PLANNED.length === 0) return null;

  return (
    <div className="planned">
      <h3 className="today-heading">Not here yet</h3>
      <p className="hint">
        Things that are being worked on. Nothing here has a date, because a date
        is the part of a promise that breaks first.
      </p>

      <ul className="planned-list">
        {PLANNED.map((feature) => (
          <li key={feature.title}>
            <b>{feature.title}</b>
            <span className="hint">{feature.because}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
