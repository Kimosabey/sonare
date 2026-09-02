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

/**
 * Maps a useful speech range (-70..0 dBFS) onto the bar, as a 0..1 scale
 * factor rather than a percentage width.
 *
 * The distinction matters at this update rate: this element changes 30 times a
 * second for the whole take, and animating `width` puts layout and paint on
 * every one of those frames. `transform: scaleX()` is composited, so the same
 * visual result costs no layout at all. Everything else in styles.css already
 * animates transform/opacity only — this was the one hot path that did not.
 */
function toScale(dbfs: number): number {
  return Math.max(0, Math.min(1, (dbfs + 70) / 70));
}

export function LevelMeter({ level, active, clipping = false }: LevelMeterProps) {
  const hot = active && clipping;
  return (
    <div className={`meter${hot ? " meter-hot" : ""}`}>
      <i style={{ transform: `scaleX(${active ? toScale(level).toFixed(3) : 0})` }} />
      <em>{hot ? "too loud" : "level"}</em>
      {/* assertive: this is worth interrupting for — it is the difference
          between finishing the take and having it rejected. */}
      <span aria-live={hot ? "assertive" : "off"}>
        {hot ? "distorting — back off the mic" : active ? `${level.toFixed(1)} dBFS` : "—"}
      </span>
    </div>
  );
}
