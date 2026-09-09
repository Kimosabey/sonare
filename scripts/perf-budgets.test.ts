/**
 * T40 — performance budgets, asserted rather than observed.
 *
 * The repository already has performance *numbers*: resample.ts's header
 * records 25ms for a 15s take, vite.config.ts explains the vendor split in
 * kilobytes, and scripts/resample-bench.ts prints three measurements. Not one
 * of them fails on regression. A number in a comment is a claim about the day
 * it was written; the bench is a script nobody is required to run. So the
 * bundle can double, the resampler can go back to the naive kernel that cost
 * 460ms, and every gate stays green.
 *
 * A budget nothing fails on is not a budget, so each ceiling below is set
 * from a real measurement plus stated headroom, and each is shown — in the
 * commit that added it — rejecting the regression it exists to reject.
 *
 * ## Three budgets
 *
 * 1. **Bundle size.** Measured off the real `vite build`, not an estimate.
 * 2. **Resample throughput.** Absolute *and* relative, because an absolute
 *    wall-clock floor on a shared CI box fails for the wrong reason.
 * 3. **The client's deadline.** Verifier rule T15 proves the provider's worst
 *    case plus a 5s margin fits inside the client's 25s per-attempt deadline;
 *    this extends the same arithmetic outwards to the client's *own* retry
 *    ladder, which nothing currently bounds.
 *
 * ## Why this file lives in scripts/
 *
 * It runs a build (`node:child_process`), reads its output (`node:fs`) and
 * reads timeout constants out of two source files. `src/` is typechecked by
 * tsconfig.json, which carries no Node types on purpose. tsconfig.scripts.json
 * covers `scripts/**` and does.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resampleTo16k, concatFrames, TARGET_SAMPLE_RATE } from "../src/speech/capture/resample.js";
import { encodeWav } from "../src/speech/capture/wav.js";

const ROOT = join(import.meta.dirname, "..");
const KIB = 1024;

/* ── the bundle ─────────────────────────────────────────────────────────────
 *
 * Every ceiling is `measured now + honest headroom`, and the reasoning for
 * each is written next to it rather than left as a round number. The measured
 * figures were taken from `npx vite build` on 2026-09-09 at
 * commit 0378bef.
 *
 * Headroom is not uniform on purpose. The app chunk is where features land,
 * so it gets the most room. The vendor chunk should only ever change when a
 * dependency is upgraded, so it gets the least — which is exactly what makes
 * it fail when someone adds a runtime dependency, the change most worth
 * noticing.
 */

/** Render-blocking JS + CSS, gzipped. Measured 113,120 B; +19% headroom. */
const INITIAL_GZIP_CEILING = 132 * KIB;

/** Same payload ungzipped, which is what a low-end phone has to parse and
    compile — a cost gzip hides entirely. Measured 368,195 B; +17%. */
const INITIAL_RAW_CEILING = 420 * KIB;

/** React + ReactDOM + router, gzipped. Measured 72,683 B; +13%. */
const VENDOR_GZIP_CEILING = 80 * KIB;

/** The app's own entry chunk, gzipped. Measured 34,231 B; +35%. */
const APP_ENTRY_GZIP_CEILING = 45 * KIB;

/** Everything emitted, lazy routes included, gzipped. Measured 127,304 B; +21%. */
const ALL_CHUNKS_GZIP_CEILING = 150 * KIB;

/** Files copied verbatim out of public/. Measured 175,550 B; +17%. */
const STATIC_ASSET_CEILING = 205 * KIB;

interface Emitted {
  /** Path relative to the build output directory, POSIX-separated. */
  name: string;
  bytes: number;
  gzipBytes: number;
  /** Referenced directly by index.html, so downloaded before anything renders. */
  initial: boolean;
  text: string;
}

let outDir = "";
let emitted: Emitted[] = [];
let staticBytes = 0;

/** Every file under `dir`, relative and POSIX-separated. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix))) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

beforeAll(() => {
  /**
   * The real build, into a temporary directory.
   *
   * Not `dist/`: a test that overwrites a developer's build output as a side
   * effect of measuring it is a rude test, and the measurement does not need
   * it. `--emptyOutDir` because the directory is outside the project root and
   * Vite otherwise refuses to touch it.
   *
   * This is the slowest thing in the suite by design — a ceiling measured
   * against a stale build is a ceiling measured against nothing. The build
   * itself takes ~200ms (rolldown); process startup is most of the rest.
   */
  outDir = mkdtempSync(join(tmpdir(), "sonare-bundle-"));
  execFileSync(
    process.execPath,
    [
      join(ROOT, "node_modules/vite/bin/vite.js"),
      "build",
      "--outDir",
      outDir,
      "--emptyOutDir",
      "--logLevel",
      "warn",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      /**
       * `NODE_ENV=production`, explicitly, because vitest sets `NODE_ENV=test`
       * in this process and the child inherits it.
       *
       * That is not a detail. Vite substitutes `process.env.NODE_ENV` into the
       * bundle, and React ships two builds behind that check — so with
       * `test` leaking through, the vendor chunk came out as *development*
       * React: 126.5 KiB gzipped instead of 71.0, with the full error text
       * instead of the minified error URLs. The first run of this file
       * measured that bundle. A budget against a build nobody ships is
       * fiction, and it fails in the alarming direction, which is the only
       * reason it got noticed.
       */
      env: { ...process.env, NODE_ENV: "production" },
    },
  );

  const html = readFileSync(join(outDir, "index.html"), "utf8");
  const files = walk(outDir);

  emitted = files
    .filter((f) => /\.(js|css)$/.test(f) && f.startsWith("assets/"))
    .map((name) => {
      const buffer = readFileSync(join(outDir, name));
      return {
        name,
        bytes: buffer.length,
        // Level 9 to match what Vite's own size report uses. zlib output can
        // shift by a few bytes across zlib versions; every ceiling here has
        // percentage-scale headroom, not byte-scale.
        gzipBytes: gzipSync(buffer, { level: 9 }).length,
        initial: html.includes(name),
        text: buffer.toString("utf8"),
      };
    });

  staticBytes = files
    .filter((f) => !/\.(js|css|map)$/.test(f) && f !== "index.html")
    .reduce((total, f) => total + statSync(join(outDir, f)).size, 0);
});

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

function sum(files: Emitted[], field: "bytes" | "gzipBytes"): number {
  return files.reduce((total, f) => total + f[field], 0);
}

/** A one-line summary, so a failure says what it measured rather than only that it failed. */
function describeSizes(files: Emitted[]): string {
  return files
    .map((f) => `${f.name} ${(f.gzipBytes / KIB).toFixed(1)}KiB gz`)
    .sort()
    .join(", ");
}

describe("the bundle a learner downloads", () => {
  it("emitted a build worth measuring", () => {
    /**
     * The check that stops every ceiling below from passing vacuously. A
     * build that emitted nothing — a config change, a failed plugin — would
     * otherwise be under budget by a wide margin.
     */
    expect(emitted.length, "the build emitted no JS or CSS").toBeGreaterThanOrEqual(6);
    expect(emitted.filter((f) => f.initial).length, describeSizes(emitted)).toBeGreaterThanOrEqual(3);
    expect(emitted.some((f) => f.name.endsWith(".css"))).toBe(true);
    for (const file of emitted) expect(file.bytes, file.name).toBeGreaterThan(0);
  });

  it(`keeps the render-blocking payload under ${INITIAL_GZIP_CEILING / KIB} KiB gzipped`, () => {
    /**
     * The number that decides how long a learner stares at nothing on a
     * hotel connection. Only the files `index.html` actually references
     * count: the lazy route chunks are real bytes but nobody waits for them
     * to see the first screen.
     */
    const initial = emitted.filter((f) => f.initial);
    const gzipBytes = sum(initial, "gzipBytes");
    expect(gzipBytes, describeSizes(initial)).toBeLessThanOrEqual(INITIAL_GZIP_CEILING);
    // And the floor: a payload suddenly a third of its size means the split
    // broke and something is no longer being loaded.
    expect(gzipBytes, describeSizes(initial)).toBeGreaterThan(60 * KIB);
  });

  it(`keeps the render-blocking payload under ${INITIAL_RAW_CEILING / KIB} KiB unzipped`, () => {
    // Parse and compile cost scales with the *decompressed* size, and on a
    // low-end Android that is the larger half of the wait. A dependency that
    // gzips well can pass the ceiling above and fail here, which is the point
    // of having both.
    const initial = emitted.filter((f) => f.initial);
    expect(sum(initial, "bytes"), describeSizes(initial)).toBeLessThanOrEqual(INITIAL_RAW_CEILING);
  });

  it(`keeps the vendor chunk under ${VENDOR_GZIP_CEILING / KIB} KiB gzipped`, () => {
    /**
     * The tightest ceiling here, deliberately. This chunk is React, ReactDOM
     * and the router and nothing else; it changes when a dependency is
     * upgraded and at no other time. 13% of headroom passes a React patch
     * release and fails a new runtime dependency, which is the notification
     * this budget exists to send.
     */
    const vendor = emitted.filter((f) => /\/vendor-/.test(f.name));
    expect(vendor, describeSizes(emitted)).toHaveLength(1);
    expect(sum(vendor, "gzipBytes"), describeSizes(vendor)).toBeLessThanOrEqual(
      VENDOR_GZIP_CEILING,
    );
  });

  it(`keeps the app's own entry chunk under ${APP_ENTRY_GZIP_CEILING / KIB} KiB gzipped`, () => {
    // The loosest ceiling, because this is where features land. 35% of
    // headroom is roughly six or seven more screens' worth of app code.
    const entry = emitted.filter((f) => f.initial && /\/index-[^/]*\.js$/.test(f.name));
    expect(entry, describeSizes(emitted)).toHaveLength(1);
    expect(sum(entry, "gzipBytes"), describeSizes(entry)).toBeLessThanOrEqual(
      APP_ENTRY_GZIP_CEILING,
    );
  });

  it(`keeps everything emitted under ${ALL_CHUNKS_GZIP_CEILING / KIB} KiB gzipped`, () => {
    // The lazy chunks are not free — a learner who opens the diagnostics
    // screen pays for it — so the whole build has a ceiling too.
    expect(sum(emitted, "gzipBytes"), describeSizes(emitted)).toBeLessThanOrEqual(
      ALL_CHUNKS_GZIP_CEILING,
    );
  });

  it(`keeps the copied static assets under ${STATIC_ASSET_CEILING / KIB} KiB`, () => {
    /**
     * Everything Vite copies out of `public/` verbatim: the brand icon and
     * wordmark. Not render-blocking, but downloaded, and not compressed by
     * the build — a PNG dropped in here at export resolution is invisible to
     * every other budget on this page.
     */
    expect(staticBytes).toBeGreaterThan(0);
    expect(staticBytes / KIB).toBeLessThanOrEqual(STATIC_ASSET_CEILING / KIB);
  });

  it("keeps React out of the app chunk, which is what makes the split real", () => {
    /**
     * Structural, not a size — but the two size ceilings above only mean
     * something while the split holds. `manualChunks` is a function in
     * vite.config.ts; a change that made it return `undefined` for React
     * would fold ~73 KiB gzipped into the app chunk, bust the app ceiling for
     * a reason that has nothing to do with app code, and leave a returning
     * visitor re-downloading React on every deploy.
     *
     * `react.dev/errors` is React's own error-URL prefix, present in its
     * production build and in nobody else's code.
     */
    const withReact = emitted.filter((f) => f.text.includes("react.dev/errors"));
    expect(withReact.map((f) => f.name)).toHaveLength(1);
    expect(withReact[0]?.name, "React is not in the vendor chunk").toMatch(/\/vendor-/);
  });

  it("keeps the four secondary screens out of the initial payload", () => {
    /**
     * Settings, Diagnostics, Authoring and the fixture runner are lazy
     * routes. A stray eager `import` of any of them adds its whole chunk to
     * the render-blocking payload — which the ceiling above would catch, but
     * only once the total crossed it, and this says *which* thing moved.
     */
    const lazy = emitted.filter((f) => !f.initial && f.name.endsWith(".js"));
    const names = lazy.map((f) => f.name).join(", ");
    for (const screen of ["Settings", "Diagnostics", "Authoring", "FixtureRunner"]) {
      expect(names, `${screen} is no longer a lazy chunk`).toContain(screen);
    }
    expect(lazy.length).toBeGreaterThanOrEqual(4);
  });

  it("does not advertise its source maps to a visitor's devtools", () => {
    // `sourcemap: "hidden"` in vite.config.ts. The maps are ~1.9 MB and are
    // emitted for post-mortem work; a `sourceMappingURL` comment would offer
    // every visitor the app's full original source, and the download with it.
    for (const file of emitted) {
      expect(file.text, `${file.name} references its source map`).not.toContain(
        "sourceMappingURL",
      );
    }
    // The maps are still emitted — otherwise the setting has changed to
    // something else and this test is vouching for the wrong thing.
    expect(walk(outDir).some((f) => f.endsWith(".map"))).toBe(true);
  });

  it("reports what it measured, so the ceilings can be revised on evidence", () => {
    // Not an assertion so much as a record. When a ceiling needs raising,
    // this is the line that says what it was raised from.
    const initial = emitted.filter((f) => f.initial);
    const summary = [
      `initial gzip ${(sum(initial, "gzipBytes") / KIB).toFixed(1)} KiB of ${INITIAL_GZIP_CEILING / KIB}`,
      `initial raw ${(sum(initial, "bytes") / KIB).toFixed(1)} KiB of ${INITIAL_RAW_CEILING / KIB}`,
      `all gzip ${(sum(emitted, "gzipBytes") / KIB).toFixed(1)} KiB of ${ALL_CHUNKS_GZIP_CEILING / KIB}`,
      `static ${(staticBytes / KIB).toFixed(1)} KiB of ${STATIC_ASSET_CEILING / KIB}`,
    ].join(" | ");
    expect(summary, summary).toContain("initial gzip");
  });
});

/* ── throughput ─────────────────────────────────────────────────────────────
 *
 * A wall-clock floor is a measurement of the machine as much as of the code,
 * so there are two assertions here and the load-bearing one is the ratio.
 *
 * Measured on the development box (Apple silicon, Node 26): a 15s take at
 * 48 kHz resamples in 19.8ms best-of-20, ~750x realtime, and the full capture
 * pipeline — join the worklet's 5,625 frames, resample, encode the WAV —
 * takes 25.3ms. The naive per-output-sample kernel the polyphase table
 * replaced measures 207ms in the same process: 10.4x slower.
 */

const BENCH_INPUT_RATE = 48_000;
const BENCH_SECONDS = 15;
const BENCH_RUNS = 12;

/** Wall-clock ceiling for one 15s resample. Measured 19.8ms; 7.6x headroom. */
const RESAMPLE_CEILING_MS = 150;

/**
 * Ceiling for the whole capture-side pipeline, as a share of NFR-02's 2.5s
 * upload-to-result budget. Measured 25.3ms; 10x headroom.
 *
 * A tenth of the budget for the work that happens before the upload even
 * starts is generous — the network and the provider need the rest.
 */
const PIPELINE_CEILING_MS = 250;

/**
 * How much faster the polyphase table must be than computing the kernel per
 * output sample. Measured 10.4x; a floor of 4x still fails decisively if the
 * table is ever removed, and — unlike a wall-clock number — it does not care
 * how fast the machine is, because both sides are timed on the same one.
 */
const MIN_SPEEDUP_OVER_NAIVE = 4;

function tone(freqHz: number, seconds: number, sampleRate: number): Float32Array {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

/**
 * The fastest of `runs` timings.
 *
 * Best-of, not mean. Noise on a loaded box only ever makes a run slower, so
 * the minimum is the closest thing to a measurement of the code rather than
 * of the machine's mood — and it gives a contended box twelve chances to
 * find one quiet slot.
 */
function fastestMs(runs: number, work: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * The resampler OQ-4 replaced, in the shape that made it slow: the same
 * windowed-sinc kernel, evaluated per output sample instead of once into a
 * polyphase table. Kept here rather than described, because a ratio against a
 * described implementation is a ratio against nothing.
 */
function naiveResample(input: Float32Array, inputRate: number): Float32Array {
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const halfWidth = 8 * ratio;
  const cutoff = 0.5 / ratio;
  const taps = Math.ceil(halfWidth);
  const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  const blackman = (x: number): number =>
    x <= -1 || x >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);

  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const base = Math.floor(pos);
    let sum = 0;
    let weightSum = 0;
    for (let n = base - taps; n <= base + taps; n += 1) {
      const t = n - pos;
      const weight = 2 * cutoff * sinc(2 * cutoff * t) * blackman(t / halfWidth);
      weightSum += weight;
      if (n >= 0 && n < input.length) sum += (input[n] ?? 0) * weight;
    }
    out[i] = weightSum !== 0 ? sum / weightSum : 0;
  }
  return out;
}

describe("the resampler's throughput", () => {
  const take = tone(220, BENCH_SECONDS, BENCH_INPUT_RATE);

  it("has a take worth timing", () => {
    // 15s is the capture ceiling (MAX_AUDIO_SECONDS), so this is the longest
    // take the product can produce — the case the budget has to hold for.
    expect(take.length).toBe(BENCH_SECONDS * BENCH_INPUT_RATE);
  });

  it(`resamples a 15s take in under ${RESAMPLE_CEILING_MS}ms`, () => {
    // Warm the kernel cache first, as a real session does: the table is built
    // once per input rate and every take after the first shares it.
    resampleTo16k(take, BENCH_INPUT_RATE);
    const ms = fastestMs(BENCH_RUNS, () => void resampleTo16k(take, BENCH_INPUT_RATE));
    expect(
      ms,
      `${ms.toFixed(1)}ms for ${BENCH_SECONDS}s of audio (${(BENCH_SECONDS / (ms / 1000)).toFixed(0)}x realtime)`,
    ).toBeLessThan(RESAMPLE_CEILING_MS);
  });

  it(`is at least ${MIN_SPEEDUP_OVER_NAIVE}x faster than computing the kernel per sample`, () => {
    /**
     * The assertion that actually protects OQ-4's fix, and the one that is
     * safe on a loaded box: both implementations are timed in the same
     * process, on the same data, moments apart, so a slow machine slows both
     * and the ratio holds.
     *
     * A change that removed the polyphase table — reverting to per-sample
     * trig, or invalidating the cache per take — collapses this to about 1.
     */
    const shorter = tone(220, 3, BENCH_INPUT_RATE);
    resampleTo16k(shorter, BENCH_INPUT_RATE);
    naiveResample(shorter, BENCH_INPUT_RATE);

    const fast = fastestMs(BENCH_RUNS, () => void resampleTo16k(shorter, BENCH_INPUT_RATE));
    const slow = fastestMs(BENCH_RUNS, () => void naiveResample(shorter, BENCH_INPUT_RATE));
    const speedup = slow / fast;

    expect(
      speedup,
      `polyphase ${fast.toFixed(2)}ms vs naive ${slow.toFixed(2)}ms = ${speedup.toFixed(1)}x`,
    ).toBeGreaterThanOrEqual(MIN_SPEEDUP_OVER_NAIVE);
  });

  it("agrees with the naive kernel it is a faster version of", () => {
    /**
     * A speed ratio is worthless if the fast path is fast because it is doing
     * something else. Same kernel, same window, same cutoff — so the outputs
     * must match away from the edges, where the two normalise differently.
     */
    const signal = tone(1_000, 0.5, BENCH_INPUT_RATE);
    const fast = resampleTo16k(signal, BENCH_INPUT_RATE);
    const slow = naiveResample(signal, BENCH_INPUT_RATE);
    expect(fast.length).toBe(slow.length);

    let worst = 0;
    for (let i = 32; i < fast.length - 32; i += 1) {
      worst = Math.max(worst, Math.abs((fast[i] ?? 0) - (slow[i] ?? 0)));
    }
    // The table quantises the fractional position to 1/512 of a sample, which
    // is the entire difference between the two.
    expect(worst, `worst interior difference ${worst.toExponential(2)}`).toBeLessThan(0.01);
  });

  it(`runs the whole capture pipeline in under ${PIPELINE_CEILING_MS}ms`, async () => {
    /**
     * What NFR-02 actually cares about: everything between the learner
     * letting go of the button and the upload starting. The worklet delivers
     * 128-sample frames, so a 15s take is 5,625 of them to join before
     * anything else can happen.
     */
    const frames: Float32Array[] = [];
    for (let i = 0; i < take.length; i += 128) frames.push(take.subarray(i, i + 128));
    expect(frames.length).toBe(Math.ceil((BENCH_SECONDS * BENCH_INPUT_RATE) / 128));

    const run = (): void => {
      const joined = concatFrames(frames);
      const resampled = resampleTo16k(joined, BENCH_INPUT_RATE);
      encodeWav(resampled, TARGET_SAMPLE_RATE);
    };
    run(); // warm

    const ms = fastestMs(BENCH_RUNS, run);
    expect(
      ms,
      `${ms.toFixed(1)}ms of NFR-02's 2500ms budget for join + resample + encode`,
    ).toBeLessThan(PIPELINE_CEILING_MS);

    // And the blob is real, so the timing is not of a discarded computation.
    const wav = encodeWav(resampleTo16k(concatFrames(frames), BENCH_INPUT_RATE), TARGET_SAMPLE_RATE);
    expect((await wav.arrayBuffer()).byteLength).toBe(44 + BENCH_SECONDS * TARGET_SAMPLE_RATE * 2);
  });
});

/* ── the deadline budget ────────────────────────────────────────────────────
 *
 * T15 in scripts/verify.mjs proves the *provider's* worst case fits inside
 * the client's per-attempt deadline. What nothing checks is the layer above
 * it: the client retries the whole exchange, so a learner's real worst case
 * is that ladder, not one rung of it.
 *
 * The constants are read out of the source files as text, exactly as T15 does
 * them, rather than imported — `UPLOAD_TIMEOUT_MS` is not exported, and more
 * importantly a text read means a change to *either* file moves this test.
 */

/** Same margin T15 uses, and not a smaller one — see the assertions below. */
const OVERHEAD_MARGIN_MS = 5_000;

/**
 * Ceiling on the client's whole-exchange worst case.
 *
 * Measured today: 3 attempts x 25,000ms + 600 + 1,800 = 77,400ms. This is set
 * to 80,000 — 3.4% of headroom, which is the tightest budget in this file and
 * deliberately so. It permits the ladder as it stands and nothing longer:
 * a fourth attempt takes it past 100s, and lengthening the per-attempt
 * deadline to 27s takes it to 83.4s. Either change is one edited number with
 * no other consequence any gate would notice.
 *
 * 77 seconds is a long time to leave a learner watching "Scoring…", and that
 * is a product question rather than something a test can settle — it is
 * reported alongside this change rather than quietly blessed. What the budget
 * does is make the number visible and stop it growing by accident.
 */
const CLIENT_WORST_CASE_CEILING_MS = 80_000;

/** Reads `NAME = 12_345` out of a source file, the way T15 does. */
function readNumber(file: string, name: string): number {
  const text = readFileSync(join(ROOT, file), "utf8");
  const match = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(text);
  const raw = match?.[1];
  if (raw === undefined) throw new Error(`${file} does not declare ${name}`);
  return Number(raw.replace(/_/g, ""));
}

/** Reads `NAME = [1, 2, 3]` out of a source file. */
function readNumberList(file: string, name: string): number[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(text);
  const raw = match?.[1];
  if (raw === undefined) throw new Error(`${file} does not declare ${name}`);
  return raw
    .split(",")
    .map((n) => Number(n.replace(/_/g, "").trim()))
    .filter((n) => !Number.isNaN(n));
}

const CLIENT = "src/speech/scoring/client.ts";
const PROVIDER = "server/services/azureSpeech.ts";

describe("the deadline budget", () => {
  it("can read every constant it reasons about", () => {
    /**
     * The vacuity guard T15 also carries. A rename that made one of these
     * unreadable would leave a regex matching nothing, and every arithmetic
     * assertion below would then be about `NaN` — which compares false
     * against everything and fails nothing.
     */
    const values = {
      uploadMs: readNumber(CLIENT, "UPLOAD_TIMEOUT_MS"),
      retryDelays: readNumberList(CLIENT, "RETRY_DELAYS_MS"),
      recogniseMs: readNumber(PROVIDER, "RECOGNITION_TIMEOUT_MS"),
      providerAttempts: readNumber(PROVIDER, "MAX_PROVIDER_ATTEMPTS"),
      backoffMs: readNumber(PROVIDER, "RETRY_BACKOFF_MS"),
    };
    for (const [name, value] of Object.entries(values)) {
      const numbers = Array.isArray(value) ? value : [value];
      expect(numbers.length, name).toBeGreaterThan(0);
      for (const n of numbers) {
        expect(Number.isFinite(n), `${name} read as ${String(n)}`).toBe(true);
        expect(n, name).toBeGreaterThan(0);
      }
    }
  });

  it("agrees with T15: the provider's worst case fits inside one client attempt", () => {
    /**
     * The same arithmetic as verify.mjs's T15, restated here so the two
     * cannot drift apart silently — and so a failure arrives from the test
     * suite as well as from the verifier.
     *
     * This deliberately does not use a smaller margin than T15's 5s. T15's
     * first version compared the provider budget against the raw deadline and
     * *passed* at three attempts: 24.8s against 25s, leaving 200ms for
     * uploading a WAV, parsing it, persisting and responding. A rule that
     * permits the change it exists to prevent is worse than no rule.
     */
    const uploadMs = readNumber(CLIENT, "UPLOAD_TIMEOUT_MS");
    const recogniseMs = readNumber(PROVIDER, "RECOGNITION_TIMEOUT_MS");
    const attempts = readNumber(PROVIDER, "MAX_PROVIDER_ATTEMPTS");
    const backoffMs = readNumber(PROVIDER, "RETRY_BACKOFF_MS");

    const providerWorstCase = attempts * recogniseMs + (attempts - 1) * backoffMs;
    expect(
      providerWorstCase + OVERHEAD_MARGIN_MS,
      `${attempts}x${recogniseMs}ms + ${attempts - 1}x${backoffMs}ms = ${providerWorstCase}ms, +${OVERHEAD_MARGIN_MS}ms margin vs ${uploadMs}ms deadline`,
    ).toBeLessThan(uploadMs);
  });

  it("bounds the client's own retry ladder, which nothing else does", () => {
    /**
     * T15 extended outwards. The client's deadline covers one attempt, and it
     * makes up to `RETRY_DELAYS_MS.length + 1` of them — so the exchange a
     * learner actually waits through is the whole ladder.
     *
     * Reachable, not theoretical: an upload that *times out* is excluded from
     * the retry loop on cost grounds (it may already have been billed), so
     * the stalled-connection case is one deadline. But a connection that
     * rejects slowly — 24 seconds in, then fails — is a network error, is
     * retryable, and stacks.
     */
    const uploadMs = readNumber(CLIENT, "UPLOAD_TIMEOUT_MS");
    const retryDelays = readNumberList(CLIENT, "RETRY_DELAYS_MS");
    const clientAttempts = retryDelays.length + 1;
    const backoffTotal = retryDelays.reduce((total, delay) => total + delay, 0);
    const worstCase = clientAttempts * uploadMs + backoffTotal;

    expect(
      worstCase,
      `${clientAttempts} attempts x ${uploadMs}ms + ${backoffTotal}ms of backoff = ${worstCase}ms`,
    ).toBeLessThanOrEqual(CLIENT_WORST_CASE_CEILING_MS);
    // The floor: a ladder that collapsed to a single attempt would pass the
    // ceiling and would have quietly removed the retry this budget is about.
    expect(clientAttempts, "the client no longer retries at all").toBeGreaterThanOrEqual(2);
  });

  it("keeps the backoff a small share of the deadline it sits between", () => {
    // Backoff exists to let a flaky connection recover, not to be the wait.
    // A delay comparable to the deadline would mean a learner spending most
    // of a failing exchange watching nothing happen at all.
    const uploadMs = readNumber(CLIENT, "UPLOAD_TIMEOUT_MS");
    const retryDelays = readNumberList(CLIENT, "RETRY_DELAYS_MS");
    const backoffTotal = retryDelays.reduce((total, delay) => total + delay, 0);

    expect(backoffTotal, `${backoffTotal}ms of backoff against a ${uploadMs}ms deadline`).toBeLessThan(
      uploadMs / 4,
    );
    // Increasing, so a second failure waits longer than the first.
    for (let i = 1; i < retryDelays.length; i += 1) {
      expect(retryDelays[i], `delay ${i}`).toBeGreaterThan(retryDelays[i - 1] ?? 0);
    }
  });

  it("leaves the server's whole exchange inside one client attempt, not just the provider call", () => {
    /**
     * The margin T15 sets aside, spent explicitly. Uploading a 15s take is
     * 480 kB of 16 kHz PCM16; parsing and validating the header, persisting
     * the attempt and writing the response all happen inside the same
     * deadline as the provider call.
     *
     * Stated as a decomposition rather than a second ceiling, so the numbers
     * that make up the 5s are visible instead of implied. If any of them
     * grows past its share, the sum stops fitting and this fails.
     */
    const uploadMs = readNumber(CLIENT, "UPLOAD_TIMEOUT_MS");
    const recogniseMs = readNumber(PROVIDER, "RECOGNITION_TIMEOUT_MS");
    const attempts = readNumber(PROVIDER, "MAX_PROVIDER_ATTEMPTS");
    const backoffMs = readNumber(PROVIDER, "RETRY_BACKOFF_MS");

    // A generous slice each, summing to T15's margin.
    const UPLOAD_BYTES_MS = 3_000; // 480 kB on a poor mobile uplink
    const VALIDATE_MS = 250; // header parse and duration check
    const PERSIST_MS = 1_000; // one Mongo write, or the fallback log
    const RESPOND_MS = 750; // JSON, on the same poor connection

    const overhead = UPLOAD_BYTES_MS + VALIDATE_MS + PERSIST_MS + RESPOND_MS;
    expect(overhead, "the decomposition must add up to T15's margin").toBe(OVERHEAD_MARGIN_MS);

    const providerWorstCase = attempts * recogniseMs + (attempts - 1) * backoffMs;
    expect(
      providerWorstCase + overhead,
      `provider ${providerWorstCase}ms + overhead ${overhead}ms vs ${uploadMs}ms`,
    ).toBeLessThan(uploadMs);
  });

  it("is checked against the file the verifier reads, not a copy of it", () => {
    // The constants live in two files and nothing links them. Named here so a
    // move — which would make both T15 and this test parse nothing — is a
    // failure rather than a silent pass.
    for (const file of [CLIENT, PROVIDER]) {
      const path = join(ROOT, file);
      expect(statSync(path).isFile(), file).toBe(true);
      expect(relative(ROOT, path).split(sep).join("/")).toBe(file);
    }
  });
});
