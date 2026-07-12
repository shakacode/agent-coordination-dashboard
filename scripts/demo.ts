import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { DEFAULT_PORT } from "../src/server/config";

export const DEMO_REPO = "demo/coordination-showcase";

interface DemoLane {
  batchId: string;
  batchLane: string;
  dependsOn: string[];
  agentId: string;
  machineId: string;
  target: string;
  status: "running" | "wedged" | "paused" | "blocked" | "stale" | "dead" | "done";
}

const DEMO_LANES: DemoLane[] = [
  {
    batchId: "demo-platform",
    batchLane: "api",
    dependsOn: [],
    agentId: "demo-api",
    machineId: "demo-m1",
    target: "101",
    status: "running"
  },
  {
    batchId: "demo-platform",
    batchLane: "ui",
    dependsOn: ["demo-platform:api"],
    agentId: "demo-ui",
    machineId: "demo-m2",
    target: "102",
    status: "blocked"
  },
  {
    batchId: "demo-platform",
    batchLane: "docs",
    dependsOn: ["demo-platform:ui"],
    agentId: "demo-docs",
    machineId: "demo-m3",
    target: "103",
    status: "paused"
  },
  {
    batchId: "demo-release",
    batchLane: "package",
    dependsOn: [],
    agentId: "demo-package",
    machineId: "demo-m4",
    target: "201",
    status: "wedged"
  },
  {
    batchId: "demo-release",
    batchLane: "qa",
    dependsOn: ["demo-release:package"],
    agentId: "demo-qa",
    machineId: "demo-m2",
    target: "202",
    status: "stale"
  },
  {
    batchId: "demo-release",
    batchLane: "publish",
    dependsOn: ["demo-release:qa"],
    agentId: "demo-publish",
    machineId: "demo-m3",
    target: "203",
    status: "dead"
  },
  {
    batchId: "demo-release",
    batchLane: "closeout",
    dependsOn: ["demo-release:publish"],
    agentId: "demo-closeout",
    machineId: "demo-m4",
    target: "204",
    status: "done"
  }
];

function isoAt(now: Date, offsetMs: number): string {
  return new Date(now.getTime() + offsetMs).toISOString();
}

function heartbeatTimes(status: DemoLane["status"], now: Date): { updated_at: string; expires_at: string } {
  if (status === "stale") {
    return { updated_at: isoAt(now, -20_000), expires_at: isoAt(now, -10_000) };
  }
  if (status === "dead" || status === "done") {
    return { updated_at: isoAt(now, -120_000), expires_at: isoAt(now, -110_000) };
  }
  return { updated_at: isoAt(now, -1_000), expires_at: isoAt(now, 9_000) };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonAtomic(path: string, value: unknown, suffix: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${suffix}.tmp`;
  await writeJson(temporaryPath, value);
  await rename(temporaryPath, path);
}

export async function initializeDemoState(root: string, now = new Date()): Promise<void> {
  const claimsDirectory = join(root, "claims", "demo", "coordination-showcase");
  const heartbeatsDirectory = join(root, "heartbeats");
  const batchesDirectory = join(root, "batches");
  const eventsDirectory = join(root, "events");
  await Promise.all(
    [claimsDirectory, heartbeatsDirectory, batchesDirectory, eventsDirectory].map((directory) =>
      mkdir(directory, { recursive: true })
    )
  );

  await Promise.all(
    DEMO_LANES.flatMap((lane) => [
      writeJson(join(claimsDirectory, `${lane.target}.json`), {
        schema_version: 1,
        repo: DEMO_REPO,
        target: lane.target,
        agent_id: lane.agentId,
        machine_id: lane.machineId,
        thread_handle: `demo-${lane.batchLane}`,
        host: "codex",
        operator: "demo-operator",
        batch_id: lane.batchId,
        branch: `demo/${lane.batchLane}`,
        status: "active",
        claimed_at: isoAt(now, -300_000),
        updated_at: isoAt(now, -1_000),
        expires_at: isoAt(now, 3_600_000)
      }),
      writeJson(join(heartbeatsDirectory, `${lane.agentId}.json`), {
        schema_version: 1,
        agent_id: lane.agentId,
        machine_id: lane.machineId,
        thread_handle: `demo-${lane.batchLane}`,
        host: "codex",
        operator: "demo-operator",
        repo: DEMO_REPO,
        target: lane.target,
        batch_id: lane.batchId,
        branch: `demo/${lane.batchLane}`,
        status: lane.status,
        ...heartbeatTimes(lane.status, now)
      })
    ])
  );

  const batches = [
    {
      batchId: "demo-platform",
      objective: "Deliver the dashboard platform slice.",
      lanes: DEMO_LANES.filter((lane) => lane.batchId === "demo-platform")
    },
    {
      batchId: "demo-release",
      objective: "Prepare and validate a release without publishing it.",
      lanes: DEMO_LANES.filter((lane) => lane.batchId === "demo-release")
    }
  ];
  await Promise.all(
    batches.map(({ batchId, objective, lanes }) =>
      writeJson(join(batchesDirectory, `${batchId}.json`), {
        schema_version: 1,
        batch_id: batchId,
        repo: DEMO_REPO,
        objective,
        targets: lanes.map((lane) => ({ type: "issue", target: lane.target, title: `${lane.batchLane} demo lane` })),
        lanes: lanes.map((lane) => ({
          name: lane.batchLane,
          owner: lane.agentId,
          targets: [lane.target],
          depends_on: lane.dependsOn,
          status: lane.status,
          thread_handle: `demo-${lane.batchLane}`,
          host: "codex",
          operator: "demo-operator",
          branch: `demo/${lane.batchLane}`
        })),
        created_at: isoAt(now, -300_000),
        created_by_machine: "demo-m1",
        updated_at: now.toISOString()
      })
    )
  );
}

export async function tickDemoState(root: string, sequence: number, now = new Date()): Promise<void> {
  const activeLanes = DEMO_LANES.filter((lane) => !["stale", "dead", "done"].includes(lane.status));
  const phases = ["implementing", "validating", "reviewing"];
  const phase = phases[sequence % phases.length];

  await Promise.all(
    activeLanes.map((lane) =>
      writeJsonAtomic(
        join(root, "heartbeats", `${lane.agentId}.json`),
        {
          schema_version: 1,
          agent_id: lane.agentId,
          machine_id: lane.machineId,
          thread_handle: `demo-${lane.batchLane}`,
          host: "codex",
          operator: "demo-operator",
          repo: DEMO_REPO,
          target: lane.target,
          batch_id: lane.batchId,
          branch: `demo/${lane.batchLane}`,
          status: lane.status,
          updated_at: now.toISOString(),
          expires_at: isoAt(now, 10_000)
        },
        `${sequence}-${lane.agentId}`
      )
    )
  );

  const events = activeLanes.map((lane) => ({
    schema_version: 1,
    event_id: `demo-${sequence}-${lane.agentId}`,
    type: "phase",
    batch_id: lane.batchId,
    lane: lane.batchLane,
    agent_id: lane.agentId,
    machine_id: lane.machineId,
    thread_handle: `demo-${lane.batchLane}`,
    host: "codex",
    operator: "demo-operator",
    repo: DEMO_REPO,
    target: lane.target,
    branch: `demo/${lane.batchLane}`,
    phase,
    at: now.toISOString(),
    message: `Demo tick ${sequence}: ${lane.batchLane} is ${phase}.`
  }));
  await appendFile(join(root, "events", "demo-ticks.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

async function installOfflineGitHubStub(root: string): Promise<string> {
  const binDirectory = join(root, "bin");
  const ghPath = join(binDirectory, "gh");
  await mkdir(binDirectory, { recursive: true });
  await writeFile(ghPath, `#!/bin/sh
if [ "$1" != "api" ]; then
  printf '[]\\n'
  exit 0
fi
case "$2" in
  */branches/demo%2Fpublish) printf 'HTTP 404: Branch not found\\n' >&2; exit 1 ;;
  */branches/*) printf '{}\\n'; exit 0 ;;
esac
target="\${2##*/}"
case "$target" in
  202) printf '{"number":202,"title":"Merged QA demo lane","html_url":"https://github.com/${DEMO_REPO}/pull/202","state":"closed","closed_at":"2026-07-12T10:00:00Z","pull_request":{"merged_at":"2026-07-12T09:59:00Z"},"labels":[]}\\n' ;;
  203) printf '{"number":203,"title":"Closed publish demo lane","html_url":"https://github.com/${DEMO_REPO}/issues/203","state":"closed","closed_at":"2026-07-12T09:30:00Z","labels":[]}\\n' ;;
  *) printf '{"number":%s,"title":"Open demo lane","html_url":"https://github.com/${DEMO_REPO}/issues/%s","state":"open","labels":[]}\\n' "$target" "$target" ;;
esac
`, "utf8");
  await chmod(ghPath, 0o755);
  return binDirectory;
}

export async function runDemo(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-coordination-dashboard-demo-"));
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const degraded = process.argv.includes("--degraded");
  let degradedApiServer: Server | undefined;
  let degradedApiUrl = "";
  let offlineBin: string;
  try {
    offlineBin = await installOfflineGitHubStub(root);
    await initializeDemoState(root);
    if (degraded) {
      degradedApiServer = createServer((_req, res) => {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "unauthorized" }));
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        degradedApiServer?.once("error", rejectListen);
        degradedApiServer?.listen(0, "127.0.0.1", () => resolveListen());
      });
      const address = degradedApiServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP address for the degraded demo API.");
      }
      degradedApiUrl = `http://127.0.0.1:${address.port}`;
    }
  } catch (error) {
    degradedApiServer?.close();
    await rm(root, { force: true, recursive: true });
    throw error;
  }

  const serverEnv = { ...process.env };
  delete serverEnv.AGENT_COORD_API_URL;
  delete serverEnv.AGENT_COORD_API_TOKEN;
  delete serverEnv.AGENT_COORD_TOKEN;
  Object.assign(serverEnv, {
    AGENT_COORD_STATE_ROOT: root,
    ALLOWED_HOSTS: "localhost,127.0.0.1,::1",
    DASHBOARD_REFRESH_MS: "2000",
    DASHBOARD_SETTINGS_PATH: join(root, "settings.json"),
    HOST: "127.0.0.1",
    NODE_ENV: process.env.AGENT_COORD_DASHBOARD_DEMO_NODE_ENV || "development",
    PATH: `${offlineBin}${delimiter}${process.env.PATH || ""}`,
    PORT: process.env.PORT || String(DEFAULT_PORT),
    TARGET_REPOS: DEMO_REPO
  });
  if (degraded) {
    Object.assign(serverEnv, {
      AGENT_COORD_API_URL: degradedApiUrl,
      AGENT_COORD_API_TOKEN: "demo-expired-token"
    });
  }

  console.log(`Demo coordination state: ${root}`);
  console.log(`Demo dashboard: http://127.0.0.1:${serverEnv.PORT}`);
  if (degraded) {
    console.log("Degraded demo mode: coordination API returns 401 for every resource.");
  }
  console.log("Synthetic state ticks every 3 seconds; the dashboard refreshes every 2 seconds. Press Ctrl-C to stop.");

  const server = spawn(
    process.execPath,
    [fileURLToPath(import.meta.resolve("tsx/cli")), join(projectRoot, "src", "server", "index.ts")],
    {
      cwd: projectRoot,
      env: serverEnv,
      stdio: "inherit"
    }
  );
  const serverClosed = new Promise<void>((resolveClosed) => server.once("close", () => resolveClosed()));
  let sequence = 0;
  let tickQueue = Promise.resolve();
  const interval = setInterval(() => {
    sequence += 1;
    tickQueue = tickQueue.then(() => tickDemoState(root, sequence)).catch((error: unknown) => {
      console.error(`Demo tick failed: ${error instanceof Error ? error.message : "unknown error"}`);
    });
  }, 3000);

  let shutdownPromise: Promise<void> | undefined;
  function shutdown(signal?: NodeJS.Signals): Promise<void> {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      clearInterval(interval);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
      }
      await serverClosed;
      await tickQueue;
      if (degradedApiServer?.listening) {
        await new Promise<void>((resolveClose, rejectClose) =>
          degradedApiServer?.close((error) => (error ? rejectClose(error) : resolveClose()))
        );
      }
      await rm(root, { force: true, recursive: true });
      console.log("Demo coordination state removed.");
    })();
    return shutdownPromise;
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          console.error(`Demo shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`);
          process.exitCode = 1;
        }
      );
    });
  }

  server.once("error", (error) => {
    console.error(`Demo server failed: ${error.message}`);
  });
  server.once("close", (code, signal) => {
    if (!shutdownPromise) {
      void shutdown().then(
        () => {
          process.exitCode = code ?? (signal ? 1 : 0);
        },
        () => {
          process.exitCode = 1;
        }
      );
    }
  });
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  void runDemo().catch((error: unknown) => {
    console.error(`Demo failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
