/**
 * T12 banding: ≥80 pass, 60–79 warn, <60 fail.
 *
 * One definition shared by word chips and phoneme detail — two thresholds that
 * drift apart would make the same score read differently in two places.
 */
export function band(score: number): "hi" | "mid" | "lo" {
  if (score >= 80) return "hi";
  if (score >= 60) return "mid";
  return "lo";
}
