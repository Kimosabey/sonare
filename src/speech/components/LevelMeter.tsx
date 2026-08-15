/** FR-06 — level meter. Fed at ~30 Hz from the capture layer. */

interface LevelMeterProps {
  /** dBFS. Silence sits near -90. */
  level: number;
  active: boolean;
}

/** Maps a useful speech range (-70..0 dBFS) onto the bar. */
function toPercent(dbfs: number): number {
  return Math.max(0, Math.min(100, ((dbfs + 70) / 70) * 100));
}

export function LevelMeter({ level, active }: LevelMeterProps) {
  return (
    <div className="meter">
      <i style={{ width: active ? `${toPercent(level)}%` : "0%" }} />
      <em>level</em>
      <span>{active ? `${level.toFixed(1)} dBFS` : "—"}</span>
    </div>
  );
}
