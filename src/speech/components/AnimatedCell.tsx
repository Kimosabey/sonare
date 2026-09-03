/** A score-grid cell whose number counts up to its value rather than popping in. */

import { useCountUp } from "../../ui/useCountUp.js";

interface AnimatedCellProps {
  value: number | null | undefined;
  label: string;
  /**
   * Where the count-up starts. Given the learner's previous best, the rise
   * itself shows the gain — see useCountUp. Omitted for a first attempt,
   * where there is nothing to compare against.
   */
  from?: number;
}

export function AnimatedCell({ value, label, from }: AnimatedCellProps) {
  const displayed = useCountUp(value, from);

  /**
   * Only when it actually improved. A negative delta on a worse retry is
   * true, and rubbing it in is not what a learner needs mid-session — the
   * score itself already says it, and `best` is what the gate uses anyway.
   */
  const gain =
    from !== undefined && value !== null && value !== undefined && value > from
      ? Math.round(value) - Math.round(from)
      : null;

  return (
    <div>
      <div className="n">
        {displayed === null || displayed === undefined ? "—" : Math.round(displayed)}
        {gain !== null && gain > 0 && <span className="gain">+{gain}</span>}
      </div>
      <div className="l">{label}</div>
    </div>
  );
}
