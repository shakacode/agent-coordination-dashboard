import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDashboardApp } from "../src/server/app";

async function unusedPort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address for the CLI test server.");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

interface DoctorCheck {
  id: string;
  status: "healthy" | "degraded" | "failed" | "skipped";
  summary: string;
  details: Record<string, unknown>;
  guidance: string | null;
}

interface DoctorContract {
  schema_version: number;
  component: string;
  status: "healthy" | "degraded" | "failed";
  checks: DoctorCheck[];
}

async function listenDoctorFixture(
  handler: RequestListener
): Promise<{ baseUrl: string; server: Server }> {
  const server = createHttpServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address for the doctor fixture.");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function runExecutable(
  executable: string,
  args: string[],
  cwd = process.cwd()
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [executable, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [status] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  return { status, stdout, stderr };
}

async function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return runExecutable("bin/agent-coordination-dashboard.js", args);
}

describe("agent-coordination-dashboard CLI", () => {
  it("preserves legacy server-mode invalid-argument exit 1", async () => {
    const result = await runCli(["--bogus"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown option: --bogus");
  });

  it("reports a repeated demo option distinctly", () => {
    const result = spawnSync(
      process.execPath,
      ["bin/agent-coordination-dashboard.js", "--demo", "--demo"],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Repeated option: --demo");
    expect(result.stderr).not.toContain("Unknown option");
  });

  it.each([
    { label: "missing --stack-json", args: ["doctor"], message: "doctor requires --stack-json" },
    {
      label: "repeated doctor flag",
      args: ["doctor", "--stack-json", "--stack-json"],
      message: "Unknown or repeated doctor option"
    },
    {
      label: "invalid doctor flag",
      args: ["doctor", "--stack-json", "--bogus"],
      message: "Unknown or repeated doctor option"
    }
  ])("keeps $label at usage exit 64", async ({ args, message }) => {
    const result = await runCli(args);

    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });

  it.each([
    {
      label: "positional URL",
      rejected: "http://user:sentinel-positional@localhost:4319/?token=sentinel-query"
    },
    {
      label: "attached URL option",
      rejected: "--url=http://user:sentinel-attached@localhost:4319/?token=sentinel-query"
    }
  ])("does not echo secrets from a rejected $label", async ({ rejected }) => {
    const result = await runCli(["doctor", "--stack-json", rejected]);

    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown or repeated doctor option");
    expect(result.stderr).not.toContain(rejected);
    expect(result.stderr).not.toContain("sentinel-");
  });

  it.each([
    { label: "omitted value", args: ["doctor", "--stack-json", "--url"] },
    { label: "empty value", args: ["doctor", "--stack-json", "--url", ""] }
  ])("reports a missing URL value for $label", async ({ args }) => {
    const result = await runCli(args);

    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--url requires a value");
    expect(result.stderr).not.toContain("Unknown or repeated doctor option");
  });

  it("emits the shallow component contract with exit parity", async () => {
    const { baseUrl, server } = await listenDoctorFixture((req, res) => {
      expect(req.url).toBe("/api/health");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, ignored: "endpoint-only" }));
    });

    try {
      const result = await runCli(["doctor", "--stack-json", "--url", baseUrl]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract).toEqual({
        schema_version: 1,
        component: "agent-coordination-dashboard",
        status: "healthy",
        checks: [
          {
            id: "dashboard.package",
            status: "healthy",
            summary: "Dashboard package contract is valid",
            details: { version: "0.1.0" },
            guidance: null
          },
          {
            id: "dashboard.health",
            status: "healthy",
            summary: "Dashboard service is healthy",
            details: { url: baseUrl },
            guidance: null
          },
          {
            id: "dashboard.resources",
            status: "skipped",
            summary: "Deep resource diagnostics were not requested",
            details: {},
            guidance: "Rerun with --deep to inspect coordination resources."
          }
        ]
      });
      expect(result.stdout).not.toContain("endpoint-only");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("probes a wildcard-bound dashboard over loopback when ALLOWED_HOSTS is external", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-wildcard-doctor-test-"));
    const app = await createDashboardApp({
      port: 0,
      host: "0.0.0.0",
      allowedHosts: ["dashboard.local"],
      stateRoot: root,
      refreshIntervalMs: 0,
      targetRepos: [],
      settingsPath: join(root, "settings.json"),
      nodeEnv: "test"
    }, {
      serveFrontend: false
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP address for the wildcard dashboard fixture.");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const result = await runCli(["doctor", "--stack-json", "--url", baseUrl]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.checks.find((check) => check.id === "dashboard.health")?.status).toBe("healthy");
      expect(contract.checks.find((check) => check.id === "dashboard.health")?.details).toEqual({ url: baseUrl });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    }
  });

  it("normalizes deep resource evidence without exposing endpoint-only fields", async () => {
    const { baseUrl, server } = await listenDoctorFixture((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      expect(req.url).toBe("/api/doctor");
      res.end(JSON.stringify({
        apiUrl: "https://user:sentinel-secret@example.test/state?token=sentinel-secret",
        tokenEnvVar: "SENTINEL_SECRET_TOKEN",
        stateRoot: "/private/sentinel-secret/root",
        perResource: [
          { resource: "claims", mode: "fs", status: "ok", checkedAt: "2026-07-13T00:00:00Z", private: "sentinel-secret" },
          { resource: "heartbeats", mode: "fs", status: "empty", checkedAt: "2026-07-13T00:00:00Z" },
          { resource: "batches", mode: "api", status: "ok", httpStatus: 200 },
          { resource: "events", mode: "api", status: "empty", httpStatus: 200 },
          { resource: "unregistered-secret", mode: "api", status: "ok", value: "sentinel-secret" }
        ],
        additive: "sentinel-secret"
      }));
    });

    try {
      const result = await runCli(["doctor", "--stack-json", "--deep", "--url", baseUrl]);

      expect(result.status).toBe(0);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.status).toBe("healthy");
      expect(contract.checks[2]).toEqual({
        id: "dashboard.resources",
        status: "healthy",
        summary: "Dashboard coordination resources are readable",
        details: {
          resources: [
            { id: "claims", status: "healthy", mode: "fs" },
            { id: "heartbeats", status: "healthy", mode: "fs" },
            { id: "batches", status: "healthy", mode: "api" },
            { id: "events", status: "healthy", mode: "api" }
          ]
        },
        guidance: null
      });
      expect(result.stdout).not.toContain("sentinel-secret");
      expect(result.stdout).not.toContain("unregistered-secret");
      expect(result.stdout).not.toContain("checkedAt");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("treats a stopped optional dashboard as degraded", async () => {
    const port = await unusedPort();

    const result = await runCli([
      "doctor",
      "--stack-json",
      "--url",
      `http://127.0.0.1:${port}`
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const contract = JSON.parse(result.stdout) as DoctorContract;
    expect(contract.status).toBe("degraded");
    expect(contract.checks.find((check) => check.id === "dashboard.health")).toEqual({
      id: "dashboard.health",
      status: "degraded",
      summary: "Dashboard service is not running",
      details: { url: `http://127.0.0.1:${port}` },
      guidance: "Start the dashboard with `npx agent-coordination-dashboard`, then rerun doctor."
    });
    expect(contract.checks.find((check) => check.id === "dashboard.resources")?.status).toBe("skipped");
  });

  it("fails closed on a malformed health payload", async () => {
    const { baseUrl, server } = await listenDoctorFixture((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: "yes", status: "healthy", secret: "sentinel-secret" }));
    });

    try {
      const result = await runCli(["doctor", "--stack-json", "--url", baseUrl]);

      expect(result.status).toBe(2);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.status).toBe("failed");
      expect(contract.checks.find((check) => check.id === "dashboard.health")).toEqual({
        id: "dashboard.health",
        status: "failed",
        summary: "Dashboard health payload is malformed",
        details: { url: baseUrl, http_status: 200 },
        guidance: "Inspect or upgrade the dashboard service, then rerun doctor."
      });
      expect(result.stdout).not.toContain("sentinel-secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not accept an unexpected success status as service health", async () => {
    const { baseUrl, server } = await listenDoctorFixture((_req, res) => {
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });

    try {
      const result = await runCli(["doctor", "--stack-json", "--url", baseUrl]);

      expect(result.status).toBe(2);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.checks.find((check) => check.id === "dashboard.health")?.summary).toBe(
        "Dashboard health endpoint returned HTTP 201"
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("classifies a non-200 health response without waiting for its streaming body", async () => {
    let markResponseClosed: (() => void) | undefined;
    const responseClosed = new Promise<void>((resolve) => {
      markResponseClosed = resolve;
    });
    const { baseUrl, server } = await listenDoctorFixture((_req, res) => {
      res.statusCode = 503;
      res.setHeader("content-type", "text/plain");
      res.write("unavailable");
      const stream = setInterval(() => res.write("still-unavailable"), 25);
      res.on("close", () => {
        clearInterval(stream);
        markResponseClosed?.();
      });
    });
    const startedAt = Date.now();

    try {
      const result = await runCli(["doctor", "--stack-json", "--url", baseUrl]);

      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.checks.find((check) => check.id === "dashboard.health")?.summary).toBe(
        "Dashboard health endpoint returned HTTP 503"
      );
      const closedPromptly = await Promise.race([
        responseClosed.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))
      ]);
      expect(closedPromptly).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it("does not follow health redirects", async () => {
    let redirectedRequests = 0;
    const { baseUrl, server } = await listenDoctorFixture((req, res) => {
      if (req.url === "/redirected-health") {
        redirectedRequests += 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 302;
      res.setHeader("location", `${baseUrl}/redirected-health`);
      res.end();
    });

    try {
      const result = await runCli(["doctor", "--stack-json", "--url", baseUrl]);

      expect(result.status).toBe(2);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.status).toBe("failed");
      expect(contract.checks.find((check) => check.id === "dashboard.health")?.summary).toBe(
        "Dashboard health endpoint returned a redirect"
      );
      expect(redirectedRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("cancels a streaming redirect body and exits within the doctor deadline", async () => {
    const { baseUrl, server } = await listenDoctorFixture((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", `${baseUrl}/redirected-health`);
      const stream = setInterval(() => res.write("redirect-body"), 25);
      res.on("close", () => clearInterval(stream));
    });
    const child = spawn(
      process.execPath,
      ["bin/agent-coordination-dashboard.js", "doctor", "--stack-json", "--url", baseUrl],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const completion = await Promise.race([
        exit.then(([status]) => ({ timedOut: false, status })),
        new Promise<{ timedOut: true; status: null }>((resolve) => {
          timeout = setTimeout(() => resolve({ timedOut: true, status: null }), 13_000);
        })
      ]);
      if (completion.timedOut) {
        child.kill("SIGKILL");
        await exit;
      }

      expect(completion.timedOut).toBe(false);
      expect(completion.status).toBe(2);
      expect(stderr).toBe("");
      const contract = JSON.parse(stdout) as DoctorContract;
      expect(contract.status).toBe("failed");
      expect(contract.checks.find((check) => check.id === "dashboard.health")?.summary).toBe(
        "Dashboard health endpoint returned a redirect"
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it("cancels a streaming body with an oversized advertised content length", async () => {
    let markResponseClosed: (() => void) | undefined;
    const responseClosed = new Promise<void>((resolve) => {
      markResponseClosed = resolve;
    });
    const { baseUrl, server } = await listenDoctorFixture((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("content-length", String((256 * 1024) + 1));
      res.flushHeaders();
      const stream = setInterval(() => res.write("oversized-body"), 25);
      res.on("close", () => {
        clearInterval(stream);
        markResponseClosed?.();
      });
    });
    const child = spawn(
      process.execPath,
      ["bin/agent-coordination-dashboard.js", "doctor", "--stack-json", "--url", baseUrl],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const completion = await Promise.race([
        exit.then(([status]) => ({ timedOut: false, status })),
        new Promise<{ timedOut: true; status: null }>((resolve) => {
          timeout = setTimeout(() => resolve({ timedOut: true, status: null }), 13_000);
        })
      ]);
      if (completion.timedOut) {
        child.kill("SIGKILL");
        await exit;
      }

      expect(completion.timedOut).toBe(false);
      expect(completion.status).toBe(2);
      expect(stderr).toBe("");
      const contract = JSON.parse(stdout) as DoctorContract;
      expect(contract.status).toBe("failed");
      expect(contract.checks.find((check) => check.id === "dashboard.health")?.summary).toBe(
        "Dashboard health payload exceeded the size limit"
      );
      const closedPromptly = await Promise.race([
        responseClosed.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))
      ]);
      expect(closedPromptly).toBe(true);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it.each([
    "https://127.0.0.1:4319",
    "http://192.0.2.10:4319",
    "http://localhost:4319/api/health",
    "http://localhost:4319/?probe=health",
    "http://localhost:4319?",
    "http://localhost:4319/#health",
    "http://localhost:4319#",
    "http://2130706433:4319",
    "http://127.1:4319",
    "http://user:sentinel-secret@localhost:4319"
  ])("rejects unsafe dashboard URL %s with usage exit 64", async (url) => {
    const result = await runCli(["doctor", "--stack-json", "--url", url]);

    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--url must be a loopback HTTP URL");
    expect(result.stderr).not.toContain("sentinel-secret");
  });

  it("accepts an IPv6 loopback dashboard URL", async () => {
    const server = createHttpServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "::1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an IPv6 TCP address for the doctor fixture.");
    }
    const baseUrl = `http://[::1]:${address.port}`;

    try {
      const result = await runCli(["doctor", "--stack-json", "--url", baseUrl]);

      expect(result.status).toBe(0);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.status).toBe("healthy");
      expect(contract.checks.find((check) => check.id === "dashboard.health")?.details).toEqual({ url: baseUrl });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("degrades on unavailable deep resource evidence while preserving healthy service evidence", async () => {
    const { baseUrl, server } = await listenDoctorFixture((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.end(JSON.stringify({
        perResource: [
          { resource: "claims", mode: "api", status: "auth_error", httpStatus: 401, error: "sentinel-secret" },
          { resource: "heartbeats", mode: "api", status: "ok", httpStatus: 200 },
          { resource: "batches", mode: "api", status: "empty", httpStatus: 200 },
          { resource: "events", mode: "api", status: "ok", httpStatus: 200 }
        ]
      }));
    });

    try {
      const result = await runCli(["doctor", "--stack-json", "--deep", "--url", baseUrl]);

      expect(result.status).toBe(1);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.status).toBe("degraded");
      expect(contract.checks.find((check) => check.id === "dashboard.health")?.status).toBe("healthy");
      expect(contract.checks.find((check) => check.id === "dashboard.resources")).toEqual({
        id: "dashboard.resources",
        status: "degraded",
        summary: "1 dashboard coordination resource is unavailable",
        details: {
          resources: [
            { id: "claims", status: "degraded", mode: "api", http_status: 401 },
            { id: "heartbeats", status: "healthy", mode: "api" },
            { id: "batches", status: "healthy", mode: "api" },
            { id: "events", status: "healthy", mode: "api" }
          ]
        },
        guidance: "Restore access to the affected coordination resources, then rerun with --deep."
      });
      expect(result.stdout).not.toContain("sentinel-secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("degrades on an unexpected deep endpoint success status", async () => {
    const { baseUrl, server } = await listenDoctorFixture((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 201;
      res.end(JSON.stringify({
        perResource: [
          { resource: "claims", mode: "fs", status: "empty" },
          { resource: "heartbeats", mode: "fs", status: "empty" },
          { resource: "batches", mode: "fs", status: "empty" },
          { resource: "events", mode: "fs", status: "empty" }
        ]
      }));
    });

    try {
      const result = await runCli(["doctor", "--stack-json", "--deep", "--url", baseUrl]);

      expect(result.status).toBe(1);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.checks.find((check) => check.id === "dashboard.resources")?.summary).toBe(
        "Dashboard resource endpoint returned HTTP 201"
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not round malformed deep evidence up to healthy", async () => {
    const { baseUrl, server } = await listenDoctorFixture((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.end(JSON.stringify({
        perResource: [
          { resource: "claims", mode: "fs", status: "healthy", raw: "sentinel-secret" },
          { resource: "heartbeats", mode: "fs", status: "ok" },
          { resource: "batches", mode: "fs", status: "empty" }
        ],
        guidance: "leak sentinel-secret"
      }));
    });

    try {
      const result = await runCli(["doctor", "--stack-json", "--deep", "--url", baseUrl]);

      expect(result.status).toBe(1);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.status).toBe("degraded");
      expect(contract.checks.find((check) => check.id === "dashboard.resources")).toEqual({
        id: "dashboard.resources",
        status: "degraded",
        summary: "Dashboard resource payload is incomplete or malformed",
        details: {
          resources: [
            { id: "heartbeats", status: "healthy", mode: "fs" },
            { id: "batches", status: "healthy", mode: "fs" }
          ]
        },
        guidance: "Upgrade the dashboard to a compatible diagnostic contract, then rerun with --deep."
      });
      expect(result.stdout).not.toContain("sentinel-secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("marks contradictory API success evidence degraded in malformed details", async () => {
    const { baseUrl, server } = await listenDoctorFixture((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.end(JSON.stringify({
        perResource: [
          { resource: "claims", mode: "api", status: "ok", httpStatus: 503 },
          { resource: "heartbeats", mode: "api", status: "ok", httpStatus: 200 },
          { resource: "batches", mode: "api", status: "empty", httpStatus: 200 },
          { resource: "events", mode: "api", status: "ok", httpStatus: 200 }
        ]
      }));
    });

    try {
      const result = await runCli(["doctor", "--stack-json", "--deep", "--url", baseUrl]);

      expect(result.status).toBe(1);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.checks.find((check) => check.id === "dashboard.resources")).toEqual({
        id: "dashboard.resources",
        status: "degraded",
        summary: "Dashboard resource payload is incomplete or malformed",
        details: {
          resources: [
            { id: "claims", status: "degraded", mode: "api", http_status: 503 },
            { id: "heartbeats", status: "healthy", mode: "api" },
            { id: "batches", status: "healthy", mode: "api" },
            { id: "events", status: "healthy", mode: "api" }
          ]
        },
        guidance: "Upgrade the dashboard to a compatible diagnostic contract, then rerun with --deep."
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("degrades when a resource list contains an unsafe non-record entry", async () => {
    const { baseUrl, server } = await listenDoctorFixture((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.end(JSON.stringify({
        perResource: [
          { resource: "claims", mode: "fs", status: "empty" },
          { resource: "heartbeats", mode: "fs", status: "empty" },
          { resource: "batches", mode: "fs", status: "empty" },
          { resource: "events", mode: "fs", status: "empty" },
          "sentinel-secret"
        ]
      }));
    });

    try {
      const result = await runCli(["doctor", "--stack-json", "--deep", "--url", baseUrl]);

      expect(result.status).toBe(1);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.checks.find((check) => check.id === "dashboard.resources")?.summary).toBe(
        "Dashboard resource payload is incomplete or malformed"
      );
      expect(result.stdout).not.toContain("sentinel-secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds endpoint response bodies", async () => {
    const { baseUrl, server } = await listenDoctorFixture((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, padding: "x".repeat(300 * 1024), secret: "sentinel-secret" }));
    });

    try {
      const result = await runCli(["doctor", "--stack-json", "--url", baseUrl]);

      expect(result.status).toBe(2);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.checks.find((check) => check.id === "dashboard.health")?.summary).toBe(
        "Dashboard health payload exceeded the size limit"
      );
      expect(result.stdout).not.toContain("sentinel-secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves timeout classification for a stalled body at the shared deep-probe deadline", async () => {
    let requests = 0;
    const { baseUrl, server } = await listenDoctorFixture((_req, res) => {
      requests += 1;
      res.setHeader("content-type", "application/json");
      res.write('{"ok":');
      // Intentionally leave the partial body open until the CLI deadline aborts it.
    });
    const startedAt = Date.now();

    try {
      const result = await runCli(["doctor", "--stack-json", "--deep", "--url", baseUrl]);
      const elapsedMs = Date.now() - startedAt;

      expect(result.status).toBe(1);
      expect(elapsedMs).toBeGreaterThanOrEqual(9_000);
      expect(elapsedMs).toBeLessThan(13_500);
      expect(requests).toBe(1);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.checks.find((check) => check.id === "dashboard.health")?.summary).toBe(
        "Dashboard service health probe timed out"
      );
      expect(contract.checks.find((check) => check.id === "dashboard.resources")?.summary).toBe(
        "Dashboard resource probe timed out"
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it("fails an invalid installed package contract without exposing package metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-doctor-package-test-"));
    const packageRoot = join(root, "node_modules", "agent-coordination-dashboard");
    const executable = join(packageRoot, "bin", "agent-coordination-dashboard.js");
    const port = await unusedPort();
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await Promise.all([
      copyFile("bin/agent-coordination-dashboard.js", executable),
      writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          type: "module",
          name: "agent-coordination-dashboard",
          version: "sentinel-secret",
          bin: { "agent-coordination-dashboard": "bin/agent-coordination-dashboard.js" }
        }),
        "utf8"
      )
    ]);

    try {
      const result = await runExecutable(
        executable,
        ["doctor", "--stack-json", "--url", `http://127.0.0.1:${port}`],
        root
      );

      expect(result.status).toBe(2);
      const contract = JSON.parse(result.stdout) as DoctorContract;
      expect(contract.status).toBe("failed");
      expect(contract.checks[0]).toEqual({
        id: "dashboard.package",
        status: "failed",
        summary: "Dashboard package contract is missing or malformed",
        details: {},
        guidance: "Reinstall agent-coordination-dashboard, then rerun doctor."
      });
      expect(result.stdout).not.toContain("sentinel-secret");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("documents normal and demo modes", () => {
    const result = spawnSync(process.execPath, ["bin/agent-coordination-dashboard.js", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agent-coordination-dashboard [--demo]");
    expect(result.stdout).toContain("Start the dashboard server");
    expect(result.stdout).toContain("synthetic ticking coordination state");
    expect(result.stdout).toContain("doctor --stack-json [--deep] [--url <loopback-http-url>]");
  });

  it("forces an isolated installed server into production mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-cli-package-test-"));
    const packageRoot = join(root, "node_modules", "agent-coordination-dashboard");
    const fakeTsxRoot = join(packageRoot, "node_modules", "tsx");
    await Promise.all([
      mkdir(join(packageRoot, "bin"), { recursive: true }),
      mkdir(join(fakeTsxRoot, "dist"), { recursive: true })
    ]);
    await Promise.all([
      copyFile("bin/agent-coordination-dashboard.js", join(packageRoot, "bin", "agent-coordination-dashboard.js")),
      writeFile(join(packageRoot, "package.json"), '{"type":"module"}\n', "utf8"),
      writeFile(
        join(fakeTsxRoot, "package.json"),
        '{"type":"module","exports":{"./cli":"./dist/cli.mjs"}}\n',
        "utf8"
      ),
      writeFile(
        join(fakeTsxRoot, "dist", "cli.mjs"),
        'process.stdout.write(JSON.stringify({ nodeEnv: process.env.NODE_ENV, demoNodeEnv: process.env.AGENT_COORD_DASHBOARD_DEMO_NODE_ENV, target: process.argv[2] }));\n',
        "utf8"
      )
    ]);

    try {
      const result = spawnSync(process.execPath, [join(packageRoot, "bin", "agent-coordination-dashboard.js")], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "development" }
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { nodeEnv: string; target: string };
      expect(output.nodeEnv).toBe("production");
      expect(output.target).toMatch(/agent-coordination-dashboard\/src\/server\/index\.ts$/);

      const demoResult = spawnSync(
        process.execPath,
        [join(packageRoot, "bin", "agent-coordination-dashboard.js"), "--demo"],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, NODE_ENV: "development" }
        }
      );
      expect(demoResult.status).toBe(0);
      const demoOutput = JSON.parse(demoResult.stdout) as { nodeEnv: string; demoNodeEnv: string; target: string };
      expect(demoOutput.nodeEnv).toBe("development");
      expect(demoOutput.demoNodeEnv).toBe("production");
      expect(demoOutput.target).toMatch(/agent-coordination-dashboard\/scripts\/demo\.ts$/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("stops the normal server cleanly when the launcher is terminated", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-cli-test-"));
    const port = await unusedPort();
    const child = spawn(process.execPath, ["bin/agent-coordination-dashboard.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_COORD_STATE_ROOT: root,
        DASHBOARD_SETTINGS_PATH: join(root, "settings.json"),
        NODE_ENV: "development",
        PORT: String(port)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    try {
      const deadline = Date.now() + 10_000;
      while (!output.includes(`listening on http://127.0.0.1:${port}`) && Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`CLI exited before listening:\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(output).toContain(`listening on http://127.0.0.1:${port}`);

      child.kill("SIGTERM");
      const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await rm(root, { force: true, recursive: true });
    }
  });
});
