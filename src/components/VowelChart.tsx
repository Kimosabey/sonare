/**
 * The vowel chart — Session board 1j.
 *
 * Where a vowel actually landed against the one being aimed at. The axes are
 * the phonetician's: F1 rising downward is openness (how far the jaw drops),
 * F2 rising leftward is frontness (how far forward the tongue sits). That is
 * why the board labels them **Front/Back** and **Close/Open** rather than by
 * frequency — a learner moves their mouth, not a number.
 *
 * ## It is a measurement, not a grade
 *
 * The board says so twice, and the distinction is the whole justification for
 * showing it: a position is something a learner can act on, a score is
 * something they can only feel. So nothing here is banded, coloured by
 * accuracy, or called good — the point is drawn where it was measured and the
 * target is drawn where it should be, and the gap between them is the
 * instruction.
 *
 * ## When it does not draw
 *
 * Whenever `estimateFormants` refuses. That includes a voice pitched above
 * what the method can measure — most women and all children — where F1 comes
 * back confidently wrong by hundreds of Hz. A chart that drew that point would
 * tell a learner to move their mouth toward the wrong vowel, which is worse
 * than showing nothing, and is the same judgement R8 makes about a take the
 * system could not score.
 */

import type { FormantOutcome } from "../speech/capture/formants.js";

/** Where a target vowel sits, in the same units the estimate arrives in. */
export interface VowelTarget {
  /** IPA symbol, for the label beside the cross. */
  ipa: string;
  f1Hz: number;
  f2Hz: number;
}

export interface VowelChartProps {
  /** What the estimator said about the learner's slice. */
  outcome: FormantOutcome;
  /** The vowel being aimed at, or null when the content names none. */
  target: VowelTarget | null;
  /** The syllable this is about, for the heading. */
  grapheme: string;
  /** How the sound is made — authored, and the actionable half. */
  howItIsMade?: string | null;
}

/**
 * The drawn range, in Hz.
 *
 * Wide enough for a child's tract and a deep male one, so a real measurement
 * never falls outside the box and gets clamped to an edge — a point pinned to
 * the border would read as "as far forward as possible" rather than as "off
 * the scale", which are different claims.
 */
const F1_LOW = 200;
const F1_HIGH = 900;
const F2_LOW = 700;
const F2_HIGH = 2600;

const WIDTH = 320;
const HEIGHT = 240;
const PAD = 28;

/** F2 rises to the *left*, which is what makes the left edge "front". */
function xOf(f2Hz: number): number {
  const t = (f2Hz - F2_LOW) / (F2_HIGH - F2_LOW);
  return PAD + (1 - Math.min(1, Math.max(0, t))) * (WIDTH - PAD * 2);
}

/** F1 rises *downward*, which is what makes the bottom edge "open". */
function yOf(f1Hz: number): number {
  const t = (f1Hz - F1_LOW) / (F1_HIGH - F1_LOW);
  return PAD + Math.min(1, Math.max(0, t)) * (HEIGHT - PAD * 2);
}

/** The four corner vowels, as the board draws them: i, e, a, o. */
const LANDMARKS: VowelTarget[] = [
  { ipa: "i", f1Hz: 280, f2Hz: 2250 },
  { ipa: "e", f1Hz: 400, f2Hz: 2100 },
  { ipa: "a", f1Hz: 750, f2Hz: 1200 },
  { ipa: "o", f1Hz: 450, f2Hz: 900 },
];

/** What to say when there is no point to draw. One sentence per reason. */
function refusalCopy(reason: string): string {
  switch (reason) {
    case "pitch-too-high":
      return "This measurement only works for lower-pitched voices at the moment, so there is nothing to plot here. Nothing is wrong with your take.";
    case "not-voiced":
    case "no-resonance":
      return "That slice did not have a clear enough vowel in it to place on the chart.";
    case "unstable":
      return "The sound moved too much across the slice to put a single point on it — that usually means a glide rather than a single vowel.";
    case "too-short":
      return "That syllable was too short to measure.";
    default:
      return "There was nothing measurable in that slice.";
  }
}

export function VowelChart({ outcome, target, grapheme, howItIsMade = null }: VowelChartProps) {
  if (outcome.kind === "refused") {
    return (
      <div className="vowel-chart" role="status">
        <h3 className="today-heading">From your take · {grapheme}</h3>
        <p className="what">{refusalCopy(outcome.reason)}</p>
      </div>
    );
  }

  const you = { x: xOf(outcome.f2Hz), y: yOf(outcome.f1Hz) };
  const aim = target === null ? null : { x: xOf(target.f2Hz), y: yOf(target.f1Hz) };

  return (
    <div className="vowel-chart">
      <h3 className="today-heading">From your take · {grapheme}</h3>

      <svg
        className="vowel-plot"
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        role="img"
        /**
         * The whole point, in one sentence, for anyone who cannot see it. A
         * chart with no accessible description is a decoration to a screen
         * reader — and this one carries the only actionable information on the
         * screen.
         */
        aria-label={
          aim === null
            ? `Your ${grapheme} plotted on a vowel chart.`
            : `Your ${grapheme} plotted against ${target?.ipa ?? "the target"}. ` +
              `${describeGap(outcome.f1Hz, outcome.f2Hz, target)}`
        }
      >
        <rect
          x={PAD}
          y={PAD}
          width={WIDTH - PAD * 2}
          height={HEIGHT - PAD * 2}
          className="vowel-frame"
        />

        {/* The four landmarks, so the space means something before any point
            is read. Decorative to assistive technology — the label above says
            what matters. */}
        {LANDMARKS.map((v) => (
          <text
            key={v.ipa}
            x={xOf(v.f2Hz)}
            y={yOf(v.f1Hz)}
            className="vowel-landmark"
            textAnchor="middle"
            aria-hidden="true"
          >
            {v.ipa}
          </text>
        ))}

        <text x={PAD} y={16} className="vowel-axis" aria-hidden="true">
          Front
        </text>
        <text x={WIDTH - PAD} y={16} className="vowel-axis" textAnchor="end" aria-hidden="true">
          Back
        </text>
        <text x={4} y={PAD + 4} className="vowel-axis" aria-hidden="true">
          CLOSE
        </text>
        <text x={4} y={HEIGHT - PAD + 4} className="vowel-axis" aria-hidden="true">
          OPEN
        </text>

        {/* The line between them is the instruction — it is the gap a learner
            is being asked to close, drawn rather than described. */}
        {aim !== null && (
          <line x1={aim.x} y1={aim.y} x2={you.x} y2={you.y} className="vowel-gap" />
        )}

        {aim !== null && (
          <>
            <path
              d={`M ${String(aim.x - 6)} ${String(aim.y)} h 12 M ${String(aim.x)} ${String(aim.y - 6)} v 12`}
              className="vowel-target"
            />
            <text x={aim.x} y={aim.y - 10} className="vowel-label" textAnchor="middle">
              model /{target?.ipa ?? ""}/
            </text>
          </>
        )}

        {/*
          An **area**, not a dot — and the estimator's own documentation says
          why: "an estimate presented as a point is presented as exact".
          `f1SpreadHz` and `f2SpreadHz` are the median absolute deviation of
          the per-frame estimates, so half the frames that produced this landed
          inside the ellipse. Drawing a 5px dot over a 40 Hz spread would claim
          a precision the method does not have, on a screen whose entire
          justification is that it measures rather than grades.

          A floor of 4 units keeps a very tight estimate visible as a shape
          rather than collapsing it to the dot this replaces.
        */}
        <ellipse
          cx={you.x}
          cy={you.y}
          rx={Math.max(4, Math.abs(xOf(outcome.f2Hz + outcome.f2SpreadHz) - you.x))}
          ry={Math.max(4, Math.abs(yOf(outcome.f1Hz + outcome.f1SpreadHz) - you.y))}
          className="vowel-you-spread"
        />
        <circle cx={you.x} cy={you.y} r={3} className="vowel-you" />
        <text x={you.x} y={you.y + 18} className="vowel-label" textAnchor="middle">
          you
        </text>
      </svg>

      {/*
        Said in words as well as drawn, because the drawing is the half a
        screen reader cannot use and the half a learner in a hurry does not
        stop to read.
      */}
      <p className="hint">Measured from your own recording. It is a position, not a mark.</p>

      {howItIsMade !== null && (
        <>
          <h4>How the sound is made</h4>
          <p className="what">{howItIsMade}</p>
        </>
      )}
    </div>
  );
}

/**
 * The gap, as a sentence — "further forward and a little more open".
 *
 * Exported for the accessible label and for anyone who wants the instruction
 * without the picture. Thresholds are in Hz rather than in chart pixels: a
 * difference too small to say out loud is too small to draw an instruction
 * from, whatever size the chart happens to be rendered at.
 */
export function describeGap(f1Hz: number, f2Hz: number, target: VowelTarget | null): string {
  if (target === null) return "";

  const parts: string[] = [];
  // F2 higher means further forward.
  const frontness = f2Hz - target.f2Hz;
  if (Math.abs(frontness) > 120) parts.push(frontness < 0 ? "further forward" : "further back");

  // F1 higher means more open.
  const openness = f1Hz - target.f1Hz;
  if (Math.abs(openness) > 60) parts.push(openness < 0 ? "a little more open" : "a little tighter");

  if (parts.length === 0) return "That is very close to the target.";
  return `Aim ${parts.join(" and ")}.`;
}
