#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Usage: agent-coordination-dashboard [--demo]
       agent-coordination-dashboard doctor --stack-json [--deep] [--url <loopback-http-url>]

Start the dashboard server using local coordination state.

Options:
  --demo       Start with disposable synthetic ticking coordination state.
  --stack-json Emit the versioned component diagnostic contract.
  --url URL    Probe a loopback HTTP dashboard URL (default http://127.0.0.1:4319).
  --deep       Include coordination resource diagnostics.
  -h, --help   Show this help.
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCTOR_TIMEOUT_MS = 10_000;
const MAX_DOCTOR_BODY_BYTES = 256 * 1024;
const DOCTOR_RESOURCES = ["claims", "heartbeats", "batches", "events"];
const DOCTOR_RESOURCE_MODES = new Set(["fs", "api"]);
const DOCTOR_RESOURCE_STATES = new Set(["ok", "empty", "auth_error", "unreachable"]);
const CHECK_STATUS_RANK = { skipped: 0, healthy: 0, degraded: 1, failed: 2 };

function usage(message, exitCode = 64) {
  process.stderr.write(`${message}\n\n${HELP}`);
  process.exitCode = exitCode;
}

function doctorCheck(id, status, summary, details = {}, guidance = null) {
  return { id, status, summary, details, guidance };
}

function aggregateStatus(checks) {
  const rank = checks.reduce((highest, check) => Math.max(highest, CHECK_STATUS_RANK[check.status]), 0);
  return rank === 2 ? "failed" : rank === 1 ? "degraded" : "healthy";
}

function exitForStatus(status) {
  return status === "failed" ? 2 : status === "degraded" ? 1 : 0;
}

function parseDashboardUrl(rawUrl) {
  const exactLoopbackUrl = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/i;
  // Check the raw spelling before URL parsing because WHATWG URL normalizes
  // decimal and shorthand IPv4 forms such as 2130706433 and 127.1 to loopback.
  // The parsed checks below then validate the constrained URL's semantic fields.
  if (typeof rawUrl !== "string" || !exactLoopbackUrl.test(rawUrl)) {
    throw new Error("--url must be a loopback HTTP URL without credentials, query, fragment, or endpoint path.");
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("--url must be a loopback HTTP URL without credentials, query, fragment, or endpoint path.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    parsed.protocol !== "http:" ||
    !loopbackHosts.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error("--url must be a loopback HTTP URL without credentials, query, fragment, or endpoint path.");
  }
  return parsed.origin;
}

async function readBoundedJson(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_DOCTOR_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error("oversized");
  }
  if (!response.body) {
    throw new Error("malformed");
  }
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOCTOR_BODY_BYTES) {
      await reader.cancel();
      throw new Error("oversized");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("malformed");
  }
}

async function fetchDoctorJson(url, path, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("timeout");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    const response = await fetch(`${url}${path}`, {
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return { response, error: "redirect" };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { response };
    }
    let payload;
    try {
      payload = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      return { response, error: error instanceof Error ? error.message : "malformed" };
    }
    return { response, payload };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("timeout");
    }
    throw new Error("unreachable");
  } finally {
    clearTimeout(timeout);
  }
}

async function packageContractCheck() {
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const validVersion = typeof manifest.version === "string" &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version);
    if (
      manifest.name === "agent-coordination-dashboard" &&
      validVersion &&
      manifest.bin?.["agent-coordination-dashboard"] === "bin/agent-coordination-dashboard.js"
    ) {
      return doctorCheck(
        "dashboard.package",
        "healthy",
        "Dashboard package contract is valid",
        { version: manifest.version }
      );
    }
  } catch {
    // Normalize all unreadable or malformed package metadata below.
  }
  return doctorCheck(
    "dashboard.package",
    "failed",
    "Dashboard package contract is missing or malformed",
    {},
    "Reinstall agent-coordination-dashboard, then rerun doctor."
  );
}

async function serviceHealthCheck(url, deadline) {
  let result;
  try {
    result = await fetchDoctorJson(url, "/api/health", deadline);
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "timeout";
    return doctorCheck(
      "dashboard.health",
      "degraded",
      timedOut ? "Dashboard service health probe timed out" : "Dashboard service is not running",
      { url },
      "Start the dashboard with `npx agent-coordination-dashboard`, then rerun doctor."
    );
  }
  const validPayload = isRecord(result.payload) && result.payload.ok === true;
  if (result.response.status === 200 && validPayload) {
    return doctorCheck("dashboard.health", "healthy", "Dashboard service is healthy", { url });
  }
  const summary = result.error === "redirect"
    ? "Dashboard health endpoint returned a redirect"
    : result.response.status !== 200
      ? `Dashboard health endpoint returned HTTP ${result.response.status}`
      : result.error === "oversized"
        ? "Dashboard health payload exceeded the size limit"
        : "Dashboard health payload is malformed";
  return doctorCheck(
    "dashboard.health",
    "failed",
    summary,
    { url, http_status: result.response.status },
    "Inspect or upgrade the dashboard service, then rerun doctor."
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeResourceEvidence(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.perResource)) {
    return null;
  }
  const resources = [];
  let malformed = payload.perResource.some(
    (entry) => !isRecord(entry) || typeof entry.resource !== "string"
  );
  for (const id of DOCTOR_RESOURCES) {
    const matches = payload.perResource.filter((entry) => isRecord(entry) && entry.resource === id);
    if (matches.length !== 1) {
      malformed = true;
      continue;
    }
    const entry = matches[0];
    if (!DOCTOR_RESOURCE_MODES.has(entry.mode) || !DOCTOR_RESOURCE_STATES.has(entry.status)) {
      malformed = true;
      continue;
    }
    if (entry.httpStatus !== undefined && (!Number.isInteger(entry.httpStatus) || entry.httpStatus < 100 || entry.httpStatus > 599)) {
      malformed = true;
      continue;
    }
    const reportsHealthy = entry.status === "ok" || entry.status === "empty";
    const contradictoryApiStatus = reportsHealthy && entry.mode === "api" && entry.httpStatus !== 200;
    if (contradictoryApiStatus) {
      malformed = true;
    }
    const healthy = reportsHealthy && !contradictoryApiStatus;
    resources.push({
      id,
      status: healthy ? "healthy" : "degraded",
      mode: entry.mode,
      ...(!healthy && entry.httpStatus !== undefined ? { http_status: entry.httpStatus } : {})
    });
  }
  return { resources, malformed };
}

async function resourceEvidenceCheck(url, deadline) {
  let result;
  try {
    result = await fetchDoctorJson(url, "/api/doctor", deadline);
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "timeout";
    return doctorCheck(
      "dashboard.resources",
      "degraded",
      timedOut ? "Dashboard resource probe timed out" : "Dashboard resource diagnostics are unavailable",
      {},
      "Start or repair the dashboard, then rerun with --deep."
    );
  }
  if (result.response.status !== 200) {
    return doctorCheck(
      "dashboard.resources",
      "degraded",
      result.error === "redirect"
        ? "Dashboard resource endpoint returned a redirect"
        : `Dashboard resource endpoint returned HTTP ${result.response.status}`,
      { http_status: result.response.status },
      "Inspect or upgrade the dashboard, then rerun with --deep."
    );
  }
  if (result.error) {
    const summary = result.error === "oversized"
      ? "Dashboard resource payload exceeded the size limit"
      : "Dashboard resource payload is malformed";
    return doctorCheck(
      "dashboard.resources",
      "degraded",
      summary,
      {},
      "Inspect or upgrade the dashboard, then rerun with --deep."
    );
  }
  const normalized = normalizeResourceEvidence(result.payload);
  if (!normalized || normalized.malformed || normalized.resources.length !== DOCTOR_RESOURCES.length) {
    return doctorCheck(
      "dashboard.resources",
      "degraded",
      "Dashboard resource payload is incomplete or malformed",
      normalized ? { resources: normalized.resources } : {},
      "Upgrade the dashboard to a compatible diagnostic contract, then rerun with --deep."
    );
  }
  const degradedCount = normalized.resources.filter((resource) => resource.status === "degraded").length;
  if (degradedCount > 0) {
    return doctorCheck(
      "dashboard.resources",
      "degraded",
      `${degradedCount} dashboard coordination ${degradedCount === 1 ? "resource is" : "resources are"} unavailable`,
      { resources: normalized.resources },
      "Restore access to the affected coordination resources, then rerun with --deep."
    );
  }
  return doctorCheck(
    "dashboard.resources",
    "healthy",
    "Dashboard coordination resources are readable",
    { resources: normalized.resources }
  );
}

async function runDoctor(options) {
  const deadline = Date.now() + DOCTOR_TIMEOUT_MS;
  const checks = [
    await packageContractCheck(),
    await serviceHealthCheck(options.url, deadline),
    options.deep
      ? await resourceEvidenceCheck(options.url, deadline)
      : doctorCheck(
          "dashboard.resources",
          "skipped",
          "Deep resource diagnostics were not requested",
          {},
          "Rerun with --deep to inspect coordination resources."
        )
  ];
  const status = aggregateStatus(checks);
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    component: "agent-coordination-dashboard",
    status,
    checks
  })}\n`);
  process.exitCode = exitForStatus(status);
}

function parseDoctorArgs(doctorArgs) {
  let stackJson = false;
  let deep = false;
  let url = "http://127.0.0.1:4319";
  let urlSeen = false;
  for (let index = 0; index < doctorArgs.length; index += 1) {
    const arg = doctorArgs[index];
    if (arg === "--stack-json" && !stackJson) {
      stackJson = true;
    } else if (arg === "--deep" && !deep) {
      deep = true;
    } else if (arg === "--url" && !urlSeen) {
      const value = doctorArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--url requires a value.");
      }
      url = value;
      urlSeen = true;
      index += 1;
    } else {
      throw new Error("Unknown or repeated doctor option.");
    }
  }
  if (!stackJson) {
    throw new Error("doctor requires --stack-json.");
  }
  return { deep, url: parseDashboardUrl(url) };
}

if (args[0] === "doctor") {
  try {
    await runDoctor(parseDoctorArgs(args.slice(1)));
  } catch (error) {
    usage(error instanceof Error ? error.message : "Invalid doctor arguments.");
  }
} else {
  const unknownArgs = args.filter((arg) => arg !== "--demo");
  const demoCount = args.filter((arg) => arg === "--demo").length;
  if (unknownArgs.length > 0) {
    usage(`Unknown option: ${unknownArgs.join(", ")}`, 1);
  } else if (demoCount > 1) {
    usage("Repeated option: --demo.", 1);
  } else {
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
  }
}
