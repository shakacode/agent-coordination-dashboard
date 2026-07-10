#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Usage: agent-coordination-dashboard [--demo]

Start the dashboard server using local coordination state.

Options:
  --demo     Start with disposable synthetic ticking coordination state.
  -h, --help Show this help.
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}

const unknownArgs = args.filter((arg) => arg !== "--demo");
if (unknownArgs.length > 0) {
  process.stderr.write(`Unknown option: ${unknownArgs.join(", ")}\n\n${HELP}`);
  process.exit(1);
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const demo = args.includes("--demo");
const target = demo ? join(packageRoot, "scripts", "demo.ts") : join(packageRoot, "src", "server", "index.ts");
const env = { ...process.env };
if (demo) {
  env.AGENT_COORD_DASHBOARD_DEMO_NODE_ENV = "production";
} else {
  env.NODE_ENV = "production";
}

const child = spawn(
  process.execPath,
  [fileURLToPath(import.meta.resolve("tsx/cli")), target],
  { cwd: packageRoot, detached: process.platform !== "win32", env, stdio: "inherit" }
);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  });
}

child.once("error", (error) => {
  process.stderr.write(`Failed to start agent-coordination-dashboard: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0));
});
