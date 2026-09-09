/**
 * T33 — a deterministic pseudo-random source for the property sweeps.
 *
 * Hand-rolled rather than pulled in, and that is the point rather than a
 * concession. A property test earns its keep by running thousands of cases,
 * which only helps if a failure can be *reproduced*: the sweep that finds the
 * bug and the sweep that proves it fixed have to be the same sweep. So every
 * generator here is a pure function of an explicit integer seed, the seeds are
 * written into the tests as literals, and a failing case prints the seed and
 * the index that produced it.
 *
 * `Math.random()` would have been one line and would have made every failure
 * a story about a case nobody can reproduce.
 *
 * mulberry32: 32-bit state, one multiply-xor-shift round. Not
 * cryptographically anything — it does not need to be. What it needs is to be
 * fast, to be identical on every machine (all arithmetic forced through
 * `| 0` and `>>>` so it stays in 32-bit integer space rather than drifting
 * into float land), and to spread values evenly enough that a sweep actually
 * visits the edges. It does those three things in six lines.
 */

/** A seeded generator: successive calls return values in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32, seeded. The same seed always yields the same stream, on any
 * platform and any Node version.
 */
export function makeRng(seed: number): Rng {
  // Coerced into the 32-bit integer domain up front, so a caller passing 1.5
  // or 2**40 gets a defined stream rather than a subtly different one per
  // engine.
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [min, max], inclusive at both ends. */
export function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** A float in [min, max). */
export function floatBetween(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/**
 * One element of `items`.
 *
 * Throws on an empty list rather than returning `undefined`: a generator that
 * silently produces nothing turns a sweep of a thousand cases into a sweep of
 * a thousand `undefined`s, which passes everything and proves nothing. That
 * failure mode is exactly what property tests are supposed to catch, so it is
 * not allowed to hide in the generator itself.
 */
export function pickFrom<T>(rng: Rng, items: readonly T[]): T {
  const chosen = items[intBetween(rng, 0, items.length - 1)];
  if (chosen === undefined) throw new Error("pickFrom: empty or sparse list");
  return chosen;
}

/** True with probability `p`. */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/**
 * A list of `length` generated items.
 *
 * `length` is passed rather than randomised here so the caller decides the
 * shape of its own distribution — the attempt sweeps want zero-to-five
 * weighted towards the interesting sizes, not a uniform 0..100.
 */
export function listOf<T>(length: number, make: (index: number) => T): T[] {
  return Array.from({ length }, (_, i) => make(i));
}

/**
 * The values that break arithmetic, as a list worth walking deliberately.
 *
 * A uniform random float in [0, 100] essentially never produces 0, 60, 80 or
 * a NaN, and those are the only inputs where a banding or gating decision has
 * ever actually been wrong. So the sweeps mix these in explicitly instead of
 * hoping to stumble on them.
 */
export const NASTY_NUMBERS: readonly number[] = [
  0,
  -0,
  1,
  -1,
  59,
  59.5,
  59.999999999999,
  60,
  60.000000000001,
  79,
  79.5,
  79.999999999999,
  80,
  80.000000000001,
  99,
  99.9,
  100,
  100.000001,
  -100,
  Number.MIN_VALUE,
  Number.EPSILON,
  Number.MAX_SAFE_INTEGER,
];
