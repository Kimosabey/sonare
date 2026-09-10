/**
 * The load-and-soak run a human starts: `npm run soak`.
 *
 * Everything it drives lives in `server/services/load.test.ts`. That file has two
 * tiers — the default one that runs in `npm test`, and a `describe.skipIf`
 * block that only wakes up when SOAK=1. This script is what sets SOAK=1, turns
 * on a real garbage collector so the heap series means something, and passes
 * the wave and burst widths through.
 *
 * Why a driver rather than a standalone load generator
 * ---------------------------------------------------
 * Two things have to be substituted for any of this to be runnable at all: the
 * Azure SDK, because a load test must never spend money or need a key, and
 * `getDb`, because it must not need a mongod. This repository's only seam for
 * either is `vi.mock`, and `vi.mock` only exists inside a test file. A
 * standalone script could avoid both only by assembling its own copy of the
 * route stack — and a load test against a copy of the code is a load test of
 * the copy.
 *
 * So the load is generated exactly as the task asked — Node's own `fetch`
 * against a real Express server on an ephemeral port — and the thing that
 * stands that server up is the runner already in the repository. No new
 * dependency, no second implementation of the app.
 *
 * Usage
 * -----
 *   npm run soak
 *   npm run soak -- --waves 40 --requests 1000 --concurrency 4000
 *
 *   --waves N        heap-series waves                     (default 30)
 *   --requests N     scored requests per wave            (default 1000)
 *   --concurrency N  width of the simultaneous bursts       (default 2000)
 *
 * What it proves, and what it does not, is written at the top of the soak
 * block in load.test.ts. The short version: the counter exactness and the
 * refusal behaviour are exact, and the heap series is an order-of-magnitude
 * guard against retention that scales with request count — not a proof that
 * nothing leaks.
 */

import { spawn } from "node:child_process";
import process from "node:process";

const FLAGS = {
  waves: "SOAK_WAVES",
  requests: "SOAK_REQUESTS_PER_WAVE",
  concurrency: "SOAK_CONCURRENCY",
};

const knobs = {};
const argv = process.argv.slice(2);

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (!arg.startsWith("--")) {
    console.error(`soak: unexpected argument ${JSON.stringify(arg)}`);
    process.exit(2);
  }
  // Both `--waves 40` and `--waves=40`, because both get typed.
  const [rawName, inlineValue] = arg.slice(2).split("=", 2);
  const envName = FLAGS[rawName];
  if (envName === undefined) {
    console.error(`soak: unknown flag --${rawName}. Known: ${Object.keys(FLAGS).join(", ")}`);
    process.exit(2);
  }
  const value = inlineValue ?? argv[++i];
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    // Refused rather than defaulted. A soak that silently ran at 500 when 5000
    // was asked for would report a pass about a load nobody chose — the same
    // reasoning server/env.ts applies to a malformed numeric setting.
    console.error(`soak: --${rawName} needs a positive whole number, got ${JSON.stringify(value)}`);
    process.exit(2);
  }
  knobs[envName] = String(parsed);
}

const env = {
  ...process.env,
  SOAK: "1",
  ...knobs,
  /**
   * A forced collection, so the heap series is a level rather than a pile of
   * uncollected garbage. Measured on the development machine, forcing takes
   * the run-to-run spread on the same workload from about ten megabytes to
   * about two kilobytes.
   *
   * The test does not depend on this — it reaches the same collector through
   * node:v8 and node:vm when the flag is absent, and loosens its own ceiling
   * if neither works. Setting it here is belt and braces, and it also covers
   * the vitest worker processes, which is where the measurement actually runs.
   */
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --expose-gc`.trim(),
};

const described = Object.entries(knobs)
  .map(([k, v]) => `${k}=${v}`)
  .join(" ");

console.log("soak: driving server/services/load.test.ts with SOAK=1");
console.log(`soak: ${described === "" ? "default widths (30 waves x 1000, bursts of 2000)" : described}`);
console.log("soak: no network, no key, no mongod — the vendor SDK and getDb are substituted\n");

const child = spawn(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "server/services/load.test.ts", "--reporter=verbose"],
  { env, stdio: "inherit" },
);

child.on("error", (err) => {
  console.error(`soak: could not start vitest: ${err.message}`);
  process.exit(1);
});

// The runner's exit code is the result. Forwarded rather than translated, so a
// CI step or a shell `&&` reads the same thing a human does.
child.on("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`soak: vitest terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
