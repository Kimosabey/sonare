/** A score-grid cell whose number counts up to its value rather than popping in. */

import { useCountUp } from "../../ui/useCountUp.js";

interface AnimatedCellProps {
  value: number | null | undefined;
  label: string;
}

export function AnimatedCell({ value, label }: AnimatedCellProps) {
  const displayed = useCountUp(value);

  return (
    <div>
      <div className="n">{displayed === null || displayed === undefined ? "—" : Math.round(displayed)}</div>
      <div className="l">{label}</div>
    </div>
  );
}
