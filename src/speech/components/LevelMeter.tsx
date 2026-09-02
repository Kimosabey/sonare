/** FR-06 — level meter. Fed at ~30 Hz from the capture layer. */

interface LevelMeterProps {
  /** dBFS, RMS. Silence sits near -90. */
  level: number;
  active: boolean;
  /**
   * Peak is above full scale right now. Not derivable from `level`: RMS stays
   * around -8 dBFS on audio peaking at +8, so the bar looks perfectly healthy
   * while the take is being destroyed.
   */
  clipping?: boolean;
}

/** Maps a useful speech range (-70..0 dBFS) onto the bar. */
function toPercent(dbfs: number): number {
  return Math.max(0, Math.min(100, ((dbfs + 70) / 70) * 100));
}

export function LevelMeter({ level, active, clipping = false }: LevelMeterProps) {
  const hot = active && clipping;
  return (
    <div className={`meter${hot ? " meter-hot" : ""}`}>
      <i style={{ width: active ? `${toPercent(level)}%` : "0%" }} />
      <em>{hot ? "too loud" : "level"}</em>
      {/* assertive: this is worth interrupting for — it is the difference
          between finishing the take and having it rejected. */}
      <span aria-live={hot ? "assertive" : "off"}>
        {hot ? "distorting — back off the mic" : active ? `${level.toFixed(1)} dBFS` : "—"}
      </span>
    </div>
  );
}
