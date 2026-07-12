import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { readCoordinationState } from "../src/server/state/readCoordinationState";
import { DEMO_REPO, initializeDemoState, tickDemoState } from "./demo";

const roots: string[] = [];

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address for the demo test server.");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

type DemoChild = ChildProcessByStdio<null, Readable, Readable>;

function captureOutput(child: DemoChild): { text: string } {
  const output = { text: "" };
  child.stdout.on("data", (chunk) => {
    output.text += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.text += String(chunk);
  });
  return output;
}

async function waitForOutput(
  child: DemoChild,
  output: { text: string },
  pattern: RegExp,
  timeoutMs = 10_000
): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = output.text.match(pattern);
    if (match) {
      return match;
    }
    if (child.exitCode !== null) {
      throw new Error(`Demo exited with ${child.exitCode} before ${pattern}:\n${output.text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern}:\n${output.text}`);
}

describe("demo coordination state", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("generates a two-batch operator scenario across four machines", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-demo-test-"));
    roots.push(root);
    const now = new Date("2026-07-09T20:00:00.000Z");

    await initializeDemoState(root, now);
    const state = await readCoordinationState(root, now);

    expect(new Set(state.heartbeats.map((heartbeat) => heartbeat.machineId))).toEqual(
      new Set(["demo-m1", "demo-m2", "demo-m3", "demo-m4"])
    );
    expect(state.batches).toHaveLength(2);
    expect(state.batches.every((batch) => batch.repo === DEMO_REPO)).toBe(true);
    expect(state.batches.flatMap((batch) => batch.lanes).map((lane) => lane.dependsOn)).toEqual(
      expect.arrayContaining([["demo-platform:api"], ["demo-platform:ui"], ["demo-release:package"], ["demo-release:qa"]])
    );
    expect(state.heartbeats.map((heartbeat) => heartbeat.status)).toEqual(
      expect.arrayContaining(["running", "wedged", "paused", "blocked", "stale", "dead"])
    );
    expect(state.heartbeats.map((heartbeat) => heartbeat.liveness)).toEqual(expect.arrayContaining(["live", "stale", "dead"]));
    expect(state.claims.filter((claim) => claim.target === "101")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "demo-api-initial", status: "released", generation: 1 }),
        expect.objectContaining({ agentId: "demo-api", status: "active", generation: 2 })
      ])
    );
    expect(state.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: "101", type: "phase", status: "implementing" })])
    );
    expect(state.warnings).toEqual([]);
  });

  it("atomically refreshes active heartbeats and appends phase events", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-demo-test-"));
    roots.push(root);
    const startedAt = new Date("2026-07-09T20:00:00.000Z");
    const tickedAt = new Date("2026-07-09T20:00:03.000Z");
    await initializeDemoState(root, startedAt);

    const before = await readCoordinationState(root, startedAt);
    await tickDemoState(root, 1, tickedAt);
    const after = await readCoordinationState(root, tickedAt);

    expect(after.heartbeats.find((heartbeat) => heartbeat.agentId === "demo-api")?.updatedAt).toBe(tickedAt.toISOString());
    expect(after.heartbeats.find((heartbeat) => heartbeat.agentId === "demo-qa")?.updatedAt).toBe(
      before.heartbeats.find((heartbeat) => heartbeat.agentId === "demo-qa")?.updatedAt
    );
    expect(after.events).toHaveLength(5);
    expect(after.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "demo-api",
          batchId: "demo-platform",
          laneName: "api",
          status: "validating",
          timestamp: tickedAt.toISOString()
        })
      ])
    );
    expect(after.warnings).toEqual([]);
  });

  it("serves the disposable scenario locally and removes it on termination", async () => {
    const port = await unusedPort();
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/demo.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = captureOutput(child);
    let root = "";

    try {
      const rootMatch = await waitForOutput(child, output, /Demo coordination state: (.+)\n/);
      root = rootMatch[1].trim();
      roots.push(root);
      await waitForOutput(child, output, /listening on http:\/\/127\.0\.0\.1:/);

      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.ok).toBe(true);
      await expect(health.json()).resolves.toEqual({ ok: true });

      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.ok).toBe(true);
      await expect(page.text()).resolves.toContain('<div id="root"></div>');

      const settings = await fetch(`http://127.0.0.1:${port}/api/settings`);
      await expect(settings.json()).resolves.toEqual({ targetRepos: [DEMO_REPO], refreshIntervalMs: 2000 });

      const dashboard = (await (
        await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers: { "X-Dashboard-Refresh": "foreground" } })
      ).json()) as { agents: Array<{ machineId?: string }>; batches: unknown[]; stateRoot: string; warnings: Array<{ message: string; target?: string }>; workItems: Array<{ target: string; terminalState?: string; terminalProvenance?: { source: string }; github?: { branchState?: string } }>; trulyOpenCountStatus: string };
      expect(new Set(dashboard.agents.map((agent) => agent.machineId))).toEqual(
        new Set(["demo-m1", "demo-m2", "demo-m3", "demo-m4"])
      );
      expect(dashboard.batches).toHaveLength(2);
      expect(dashboard.stateRoot).toBe(root);
      expect(dashboard.workItems.find((item) => item.target === "202")).toMatchObject({ terminalState: "done", terminalProvenance: { source: "github" } });
      expect(dashboard.workItems.find((item) => item.target === "203")).toMatchObject({ terminalState: "closed", terminalProvenance: { source: "github" }, github: { branchState: "deleted" } });
      expect(dashboard.trulyOpenCountStatus).toBe("available");
      expect(dashboard.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("demo-platform:ui is blocked") })
        ])
      );
      expect(dashboard.warnings.some((warning) =>
        ["202", "203"].includes(warning.target || "") && warning.message.includes("holder is not currently live or stale")
      )).toBe(false);

      child.kill("SIGTERM");
      const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      expect(exitCode).toBe(0);
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });

  it("serves an explicit degraded API scenario for failure demos", async () => {
    const port = await unusedPort();
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/demo.ts", "--degraded"], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = captureOutput(child);
    let root = "";

    try {
      const rootMatch = await waitForOutput(child, output, /Demo coordination state: (.+)\n/);
      root = rootMatch[1].trim();
      roots.push(root);
      await waitForOutput(child, output, /Degraded demo mode: coordination API returns 401/);
      await waitForOutput(child, output, /listening on http:\/\/127\.0\.0\.1:/);

      const dashboard = (await (
        await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers: { "X-Dashboard-Refresh": "foreground" } })
      ).json()) as { coordinationTokenEnvVar?: string; sourceStatus?: Array<{ status: string; httpStatus?: number }> };
      expect(dashboard.coordinationTokenEnvVar).toBe("AGENT_COORD_API_TOKEN");
      expect(dashboard.sourceStatus).toHaveLength(4);
      expect(dashboard.sourceStatus?.every((status) => status.status === "auth_error" && status.httpStatus === 401)).toBe(true);

      const doctor = (await (await fetch(`http://127.0.0.1:${port}/api/doctor`)).json()) as {
        tokenEnvVar?: string;
        perResource?: Array<{ status: string }>;
      };
      expect(doctor.tokenEnvVar).toBe("AGENT_COORD_API_TOKEN");
      expect(doctor.perResource?.every((status) => status.status === "auth_error")).toBe(true);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    }
  }, 15_000);
});
