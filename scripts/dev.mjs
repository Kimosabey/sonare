#!/usr/bin/env node
/**
 * Runs the API and the Vite dev server together, without adding a dependency
 * just to run two processes. Ctrl-C stops both — a stray API process holding
 * the port is a confusing way to start a debugging session.
 */

import { spawn } from "node:child_process";

const children = [];

function run(name, command, args) {
  const child = spawn(command, args, { stdio: "inherit", shell: false });
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code !== 0) console.error(`[${name}] exited with code ${code}`);
    shutdown();
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 200);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("api", "npx", ["tsx", "watch", "--env-file=.env", "server/index.ts"]);
run("web", "npx", ["vite"]);
