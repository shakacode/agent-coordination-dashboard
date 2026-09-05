import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "../src/server/config";

const DEMO_REPO = "demo/coordination-showcase";
const DEMO_STATE_DIRECTORIES = ["claims", "heartbeats", "batches", "events"];

/**
 * Boot the real dashboard server over a disposable, empty coordination root so
 * the demo shows the placeholder and honest `empty` diagnostics. Attention
 * fixtures arrive with the attention reader.
 */
export async function runDemo(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-coordination-dashboard-demo-"));
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    await Promise.all(DEMO_STATE_DIRECTORIES.map((directory) => mkdir(join(root, directory), { recursive: true })));
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }

  const serverEnv = { ...process.env };
  delete serverEnv.AGENT_COORD_API_URL;
  delete serverEnv.AGENT_COORD_API_TOKEN;
  delete serverEnv.AGENT_COORD_TOKEN;
  Object.assign(serverEnv, {
    AGENT_COORD_STATE_ROOT: root,
    DASHBOARD_SETTINGS_PATH: join(root, "settings.json"),
    HOST: "127.0.0.1",
    NODE_ENV: process.env.AGENT_COORD_DASHBOARD_DEMO_NODE_ENV || "development",
    PORT: process.env.PORT || String(DEFAULT_PORT),
    TARGET_REPOS: DEMO_REPO
  });

  console.log(`Demo coordination state: ${root}`);
  console.log(`Demo dashboard: http://127.0.0.1:${serverEnv.PORT}`);
  console.log("The coordination root is empty, so the dashboard serves the placeholder page and /api/doctor reports every resource as empty. Press Ctrl-C to stop.");

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

  let shutdownPromise: Promise<void> | undefined;
  function shutdown(signal?: NodeJS.Signals): Promise<void> {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
      }
      await serverClosed;
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
