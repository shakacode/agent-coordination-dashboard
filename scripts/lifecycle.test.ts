import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { constants as fsConstants, fstatSync, writeSync as fsWriteSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer as createNetServer, isIP } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertSupportedLifecyclePlatform,
  bindHostCoversProbeHost,
  installLifecycleLogWriter,
  probeHostsForBindHost
} from "../bin/lifecycle.js";

async function runLifecycle(
  args: string[],
  root: string,
  extraEnv: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
  timeoutMs = 0,
  executablePath = resolve("bin/agent-coordination-dashboard.js")
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [executablePath, ...args], {
    cwd,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      ...extraEnv
    },
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
  const timeout = timeoutMs > 0 ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : null;
  const [status] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (timeout) clearTimeout(timeout);
  return { status, stdout, stderr };
}

async function writeRelocatedLifecycleExecutable(root: string): Promise<string> {
  const packageRoot = join(root, "relocated-package");
  const executablePath = join(packageRoot, "bin", "agent-coordination-dashboard.js");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(
    executablePath,
    `import { runLifecycleCommand } from ${JSON.stringify(pathToFileURL(resolve("bin/lifecycle.js")).href)};
await runLifecycleCommand(process.argv[2], process.argv.slice(3), {
  executablePath: ${JSON.stringify(executablePath)},
  packageRoot: ${JSON.stringify(packageRoot)},
  tsxCli: ${JSON.stringify(resolve("node_modules/tsx/dist/cli.mjs"))}
});
`,
    "utf8"
  );
  return executablePath;
}

async function executableOnPath(command: string): Promise<string> {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const candidate = resolve(directory || ".", command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  throw new Error(`Could not resolve ${command} on PATH.`);
}

async function unusedPort(host = "127.0.0.1"): Promise<number> {
  const server = createNetServer();
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address for the lifecycle test server.");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function portIsListening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise((resolveListening) => {
    const socket = createConnection({ host, port });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolveListening(listening);
    };
    socket.setTimeout(100, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function linuxProcessIdentity(pid: number): Promise<{ birthMarker: string; state: string }> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) {
    throw new Error(`Could not parse Linux process identity for ${pid}.`);
  }
  return { birthMarker: `linux:${fields[19]}`, state: fields[0] };
}

function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

async function lifecycleProcessIds(): Promise<Set<number>> {
  const child = spawn("ps", ["-axo", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  await once(child, "exit");
  const executable = resolve("bin/agent-coordination-dashboard.js");
  return new Set(
    output
      .split("\n")
      .filter((line) => line.includes(executable) && line.includes("__lifecycle-serve --instance"))
      .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
      .filter(Number.isInteger)
  );
}

async function cleanupNewLifecycleProcesses(baseline: Set<number>): Promise<void> {
  for (const pid of await lifecycleProcessIds()) {
    if (baseline.has(pid)) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The exact lifecycle process group may have exited between inspection and cleanup.
    }
  }
}

async function cleanupLifecycle(root: string): Promise<void> {
  const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
  const runtime: { pid?: number } = await readFile(runtimePath, "utf8")
    .then((text) => JSON.parse(text) as { pid?: number })
    .catch(() => ({}));
  await runLifecycle(["stop"], root);
  if (!runtime.pid) return;
  const deadline = Date.now() + 2_000;
  while (processExists(runtime.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processExists(runtime.pid)) {
    try {
      process.kill(-runtime.pid, "SIGKILL");
    } catch {
      // The process group may have exited between the check and signal.
    }
    const killDeadline = Date.now() + 1_000;
    while (processExists(runtime.pid) && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const lanIpv4 = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses || [])
  .find((address) => address.family === "IPv4" && !address.internal)?.address;
const resolvedLocalhost = (await lookup("localhost")).address;
const alternateLoopback = isIP(resolvedLocalhost) === 6 ? "127.0.0.1" : "::1";
const supportsAlternateLoopback = await unusedPort(alternateLoopback).then(
  () => true,
  () => false
);
const supportsSecondaryIpv4Loopback = await unusedPort("127.0.0.2").then(
  () => true,
  () => false
);
const supportsIpv6WildcardIpv4 = await (async () => {
  const server = createNetServer();
  try {
    server.listen(0, "::");
    await once(server, "listening");
    const address = server.address();
    return Boolean(
      address &&
      typeof address !== "string" &&
      await portIsListening(address.port, "127.0.0.1")
    );
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
})();

describe("portable dashboard lifecycle", () => {
  it("only treats IPv6 wildcard binds as covering IPv4 when dual-stack support was recorded", () => {
    expect(bindHostCoversProbeHost("::", "::1")).toBe(true);
    expect(bindHostCoversProbeHost("::", "127.0.0.1")).toBe(false);
    expect(bindHostCoversProbeHost("::", "127.0.0.1", true)).toBe(true);
    expect(bindHostCoversProbeHost("0.0.0.0", "127.0.0.1")).toBe(true);
  });

  it("includes IPv4 probes for an IPv6 wildcard only when dual-stack support was recorded", () => {
    const interfaces = {
      loopback: [
        { address: "127.0.0.1", family: "IPv4" },
        { address: "::1", family: "IPv6" }
      ],
      lan: [
        { address: "192.0.2.10", family: "IPv4" },
        { address: "2001:db8::10", family: "IPv6" }
      ]
    } as unknown as ReturnType<typeof networkInterfaces>;

    expect(new Set(probeHostsForBindHost("::", "::", false, interfaces))).toEqual(
      new Set(["::1", "2001:db8::10"])
    );
    expect(new Set(probeHostsForBindHost("::", "::", true, interfaces))).toEqual(
      new Set(["::1", "127.0.0.1", "192.0.2.10", "2001:db8::10"])
    );
    expect(new Set(probeHostsForBindHost("0.0.0.0", "0.0.0.0", false, interfaces))).toEqual(
      new Set(["127.0.0.1", "192.0.2.10"])
    );
  });

  it("rejects unsupported lifecycle platforms through the shared public-command guard", () => {
    expect(() => assertSupportedLifecyclePlatform("win32")).toThrow("macOS and Linux");
    expect(() => assertSupportedLifecyclePlatform("darwin")).not.toThrow();
    expect(() => assertSupportedLifecyclePlatform("linux")).not.toThrow();
  });

  it("rejects a non-regular inherited lifecycle log descriptor before installing writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const handle = await open(
      root,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NONBLOCK
    );
    const stream = {
      fd: handle.fd,
      write: () => true
    } as Parameters<typeof installLifecycleLogWriter>[0];
    try {
      expect(() => installLifecycleLogWriter(stream, stream)).toThrow(
        "Lifecycle log file must be a regular file"
      );
    } finally {
      await handle.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("hard-bounds single and burst writes shared by lifecycle stdout and stderr", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const logFile = join(root, "dashboard.log");
    const handle = await open(
      logFile,
      fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600
    );
    const directWrite = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | (() => void),
      callback?: () => void
    ) => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      const completion = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
      fsWriteSync(handle.fd, buffer);
      completion?.();
      return true;
    };
    const stdout = {
      fd: handle.fd,
      write: directWrite
    } as unknown as NonNullable<Parameters<typeof installLifecycleLogWriter>[0]>;
    const stderr = {
      fd: handle.fd,
      write: directWrite
    } as unknown as NonNullable<Parameters<typeof installLifecycleLogWriter>[1]>;
    const cap = 8 * 1024 * 1024;
    const rolloverMarker = "[lifecycle log reset after exceeding 8 MiB]";
    const discardedSecret = "sentinel-secret-in-discarded-prefix";
    const safeTail = "safe-newest-log-tail";
    let callbackCount = 0;
    const restore = installLifecycleLogWriter(stdout, stderr);

    try {
      stdout.write(
        Buffer.concat([
          Buffer.from(`${discardedSecret}\n`),
          Buffer.alloc(cap, "x"),
          Buffer.from(`\n${safeTail}\n`)
        ]),
        () => {
          callbackCount += 1;
        }
      );
      let maximumObservedSize = fstatSync(handle.fd).size;
      expect(maximumObservedSize).toBeLessThanOrEqual(cap);
      const singleWriteContents = await readFile(logFile, "utf8");
      expect(singleWriteContents).toContain(rolloverMarker);
      expect(singleWriteContents).toContain(safeTail);
      expect(singleWriteContents).not.toContain(discardedSecret);
      expect(singleWriteContents).not.toContain("\0");

      for (let index = 0; index < 96; index += 1) {
        const stream = index % 2 === 0 ? stdout : stderr;
        expect(stream.write(Buffer.alloc(128 * 1024, index % 26 + 97), () => {
          callbackCount += 1;
        })).toBe(true);
        maximumObservedSize = Math.max(maximumObservedSize, fstatSync(handle.fd).size);
      }
      expect(stderr.write("encoded stderr tail\n", "utf8", () => {
        callbackCount += 1;
      })).toBe(true);
      maximumObservedSize = Math.max(maximumObservedSize, fstatSync(handle.fd).size);

      const contents = await readFile(logFile, "utf8");
      expect(maximumObservedSize).toBeLessThanOrEqual(cap);
      expect(contents).toContain(rolloverMarker);
      expect(contents).not.toContain(discardedSecret);
      expect(contents).not.toContain("\0");
      await new Promise<void>((resolveCallbacks) => setImmediate(resolveCallbacks));
      expect(callbackCount).toBe(98);
    } finally {
      restore();
      await handle.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves fresh status and logs behavior without creating lifecycle state", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    try {
      const result = await runLifecycle(["status"], root);
      const logs = await runLifecycle(["logs"], root);

      expect(result.status).toBe(3);
      expect(result.stdout).toContain("Dashboard is stopped.");
      expect(result.stderr).toBe("");
      expect(logs.status).toBe(0);
      expect(logs.stdout).toContain("No lifecycle logs are available yet.");
      expect(logs.stderr).toBe("");
      await expect(access(join(root, "state", "agent-coordination-dashboard")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    { host: "::1", urlHost: "[::1]" },
    { host: "0:0:0:0:0:0:0:1", urlHost: "[::1]" },
    { host: "localhost", urlHost: "localhost" }
  ])("uses the configured $host loopback host for lifecycle probes", async ({ host, urlHost }) => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort(host);
    const configDir = join(root, "config", "agent-coordination-dashboard");
    await mkdir(configDir, { recursive: true });
    const envFile = join(configDir, "env");
    await writeFile(
      envFile,
      `HOST=${host}\nPORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      expect(started.stdout).toContain(`Dashboard started at http://${urlHost}:${port}.`);
      expect(started.stdout).toContain("Coordination diagnostics are healthy.");
      expect(started.stderr).toBe("");

      const status = await runLifecycle(["status"], root);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(`Dashboard is running at http://${urlHost}:${port}.`);
      expect(status.stderr).toBe("");
      const runtime = JSON.parse(await readFile(
        join(root, "state", "agent-coordination-dashboard", "runtime.json"),
        "utf8"
      )) as { url: string };
      expect(runtime.url).toBe(`http://${urlHost}:${port}`);
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it.runIf(supportsSecondaryIpv4Loopback)(
    "keeps start and status diagnostics healthy on a secondary IPv4 loopback address",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const host = "127.0.0.2";
      const port = await unusedPort(host);
      const configDir = join(root, "config", "agent-coordination-dashboard");
      await mkdir(configDir, { recursive: true });
      const envFile = join(configDir, "env");
      await writeFile(
        envFile,
        `HOST=${host}\nPORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\n`,
        "utf8"
      );
      await chmod(envFile, 0o600);

      try {
        const started = await runLifecycle(["start"], root);
        expect(started.status).toBe(0);
        expect(started.stdout).toContain(`Dashboard started at http://${host}:${port}.`);
        expect(started.stdout).toContain("Coordination diagnostics are healthy.");
        expect(started.stderr).toBe("");

        const status = await runLifecycle(["status"], root);
        expect(status.status).toBe(0);
        expect(status.stdout).toContain(`Dashboard is running at http://${host}:${port}.`);
        expect(status.stderr).toBe("");
      } finally {
        await cleanupLifecycle(root);
        await rm(root, { force: true, recursive: true });
      }
    },
    20_000
  );

  it("restarts the exact owned IPv6 wildcard endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort("::1");
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
    const envFile = join(configDir, "env");
    await mkdir(configDir, { recursive: true });
    await writeFile(envFile, `HOST=::\nPORT=${port}\nALLOWED_HOSTS=dashboard.example.test\n`, "utf8");
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      const originalPid = (JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number }).pid;

      const restarted = await runLifecycle(["restart"], root);
      const replacementPid = (JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number }).pid;

      expect(restarted.status).toBe(0);
      expect(replacementPid).not.toBe(originalPid);
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("rejects a hostname bind before spawning a lifecycle process", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const baseline = await lifecycleProcessIds();
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(envFile, `HOST=localhost.\nPORT=${port}\n`, "utf8");
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(1);
      expect(started.stdout).toBe("");
      expect(started.stderr).toContain("HOST must be localhost or an IPv4 or IPv6 address");
      await expect(readFile(runtimePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await portIsListening(port)).toBe(false);
      expect(await lifecycleProcessIds()).toEqual(baseline);
    } finally {
      await cleanupLifecycle(root);
      await cleanupNewLifecycleProcesses(baseline);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("rejects a scoped IPv6 bind before spawning or writing runtime artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const baseline = await lifecycleProcessIds();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    await mkdir(configDir, { recursive: true });
    await writeFile(envFile, "HOST=fe80::1%lo0\nPORT=4317\n", "utf8");
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(1);
      expect(started.stdout).toBe("");
      expect(started.stderr).toContain("IPv6 zone identifiers are not supported");
      await expect(readFile(join(lifecycleDir, "runtime.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(lifecycleDir, "dashboard.log"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await lifecycleProcessIds()).toEqual(baseline);
    } finally {
      await cleanupLifecycle(root);
      await cleanupNewLifecycleProcesses(baseline);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("rejects an unscoped IPv6 link-local bind before spawning or writing runtime artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const baseline = await lifecycleProcessIds();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    await mkdir(configDir, { recursive: true });
    await writeFile(envFile, "HOST=fe80::1\nPORT=4317\n", "utf8");
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(1);
      expect(started.stdout).toBe("");
      expect(started.stderr).toContain("IPv6 link-local HOST addresses require scope identifiers");
      await expect(readFile(join(lifecycleDir, "runtime.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(lifecycleDir, "dashboard.log"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await lifecycleProcessIds()).toEqual(baseline);
    } finally {
      await cleanupLifecycle(root);
      await cleanupNewLifecycleProcesses(baseline);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it.each([
    { label: "missing", allowedHosts: null },
    { label: "blank", allowedHosts: "   " },
    { label: "invalid", allowedHosts: "bad host" },
    { label: "catch-all", allowedHosts: "*" },
    { label: "expanded IPv6 wildcard", allowedHosts: "0:0:0:0:0:0:0:0" }
  ])("rejects $label wildcard ALLOWED_HOSTS before spawning", async ({ allowedHosts }) => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const baseline = await lifecycleProcessIds();
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    await mkdir(configDir, { recursive: true });
    const allowedHostsLine = allowedHosts === null ? "" : `ALLOWED_HOSTS=${allowedHosts}\n`;
    await writeFile(envFile, `HOST=0.0.0.0\nPORT=${port}\n${allowedHostsLine}`, "utf8");
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(1);
      expect(started.stderr).toContain("specific hostnames or IP addresses");
      await expect(readFile(join(lifecycleDir, "runtime.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(lifecycleDir, "dashboard.log"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await lifecycleProcessIds()).toEqual(baseline);
    } finally {
      await cleanupLifecycle(root);
      await cleanupNewLifecycleProcesses(baseline);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("adds the advertised lifecycle URL host to an explicit wildcard ALLOWED_HOSTS list", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      envFile,
      `HOST=0.0.0.0\nPORT=${port}\nALLOWED_HOSTS=dashboard.example.test,192.0.2.1,::1\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      expect(started.stdout).toContain(`Dashboard started at http://127.0.0.1:${port}.`);

      const browserResponse = await fetch(`http://127.0.0.1:${port}/api/settings`);
      expect(browserResponse.status).toBe(200);

      const configuredHostResponse = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        headers: { host: `dashboard.example.test:${port}` }
      });
      expect(configuredHostResponse.status).toBe(200);
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it.runIf(Boolean(lanIpv4))(
    "preflights a wildcard start against a non-loopback local listener before spawning",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const baseline = await lifecycleProcessIds();
      const unrelated = createNetServer((socket) => {
        socket.on("error", () => {});
        socket.end("still-running");
      });
      unrelated.listen(0, lanIpv4 as string);
      await once(unrelated, "listening");
      const address = unrelated.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an unrelated TCP address.");
      }
      const configDir = join(root, "config", "agent-coordination-dashboard");
      const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
      const envFile = join(configDir, "env");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        envFile,
        `HOST=0.0.0.0\nPORT=${address.port}\nALLOWED_HOSTS=${lanIpv4}\n`,
        "utf8"
      );
      await chmod(envFile, 0o600);

      try {
        const started = await runLifecycle(["start"], root);

        expect(started.status).toBe(1);
        expect(started.stderr).toContain(`Port ${address.port} is already in use`);
        expect(started.stderr).toContain("nothing was stopped");
        expect(started.stderr).not.toContain("startup health check");
        await expect(readFile(join(lifecycleDir, "runtime.json"), "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(lifecycleDir, "dashboard.log"), "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
        expect(await lifecycleProcessIds()).toEqual(baseline);
        expect(unrelated.listening).toBe(true);
        await expect(new Promise<string>((resolveResponse, rejectResponse) => {
          const socket = createConnection({ host: lanIpv4 as string, port: address.port });
          let response = "";
          socket.on("data", (chunk) => {
            response += String(chunk);
          });
          socket.on("end", () => resolveResponse(response));
          socket.on("error", rejectResponse);
        })).resolves.toBe("still-running");
      } finally {
        await cleanupLifecycle(root);
        await cleanupNewLifecycleProcesses(baseline);
        await new Promise<void>((resolveClose) => unrelated.close(() => resolveClose()));
        await rm(root, { force: true, recursive: true });
      }
    },
    20_000
  );

  it("canonicalizes expanded IPv6 ALLOWED_HOSTS entries for the child host guard", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort("::1");
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      envFile,
      [
        "HOST=::",
        `PORT=${port}`,
        "ALLOWED_HOSTS=0:0:0:0:0:0:0:1",
        `AGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}`,
        `DASHBOARD_SETTINGS_PATH=${join(root, "settings.json")}`,
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);

      const settingsResponse = await fetch(`http://[::1]:${port}/api/settings`);
      expect(settingsResponse.status).toBe(200);
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it.each([
    { label: "missing", allowedHosts: null },
    { label: "non-specific", allowedHosts: "0:0:0:0:0:0:0:0" }
  ])(
    "rejects an expanded IPv6 wildcard HOST with a $label allow-list before spawning",
    async ({ allowedHosts }) => {
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const baseline = await lifecycleProcessIds();
      const port = await unusedPort("::1");
      const configDir = join(root, "config", "agent-coordination-dashboard");
      const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
      const envFile = join(configDir, "env");
      await mkdir(configDir, { recursive: true });
      const allowedHostsLine = allowedHosts === null ? "" : `ALLOWED_HOSTS=${allowedHosts}\n`;
      await writeFile(
        envFile,
        `HOST=0:0:0:0:0:0:0:0\nPORT=${port}\n${allowedHostsLine}`,
        "utf8"
      );
      await chmod(envFile, 0o600);

      try {
        const started = await runLifecycle(["start"], root);
        expect(started.status).toBe(1);
        expect(started.stderr).toContain("specific hostnames or IP addresses");
        await expect(readFile(join(lifecycleDir, "runtime.json"), "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(lifecycleDir, "dashboard.log"), "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
        expect(await lifecycleProcessIds()).toEqual(baseline);
      } finally {
        await cleanupLifecycle(root);
        await cleanupNewLifecycleProcesses(baseline);
        await rm(root, { force: true, recursive: true });
      }
    },
    20_000
  );

  it.runIf(Boolean(lanIpv4))("keeps deep diagnostics healthy for a specific local interface bind", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const host = lanIpv4 as string;
    const port = await unusedPort(host);
    const configDir = join(root, "config", "agent-coordination-dashboard");
    await mkdir(configDir, { recursive: true });
    const envFile = join(configDir, "env");
    await writeFile(
      envFile,
      `HOST=${host}\nPORT=${port}\nALLOWED_HOSTS=dashboard.example.test\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      expect(started.stderr).toBe("");
      expect(started.stdout).toContain("Coordination diagnostics are healthy.");

      const status = await runLifecycle(["status"], root);
      expect(status.status).toBe(0);
      expect(status.stderr).toBe("");
      expect(status.stdout).toContain(`Dashboard is running at http://${host}:${port}.`);
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("requires the protected environment file to use mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    await mkdir(configDir, { recursive: true });
    const envFile = join(configDir, "env");
    await writeFile(envFile, `PORT=${port}\n`, "utf8");
    await chmod(envFile, 0o400);

    try {
      const result = await runLifecycle(["start"], root);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("must use mode 0600");
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("decodes double-quoted protected environment escapes in one pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    const stateRootPrefix = join(root, "coordination-state");
    const encodedStateRoot = String.raw`${stateRootPrefix}-literal\\n-newline\n-carriage\r-tab\t-quote\"-slash\\-unknown\q`;
    const expectedStateRoot = `${stateRootPrefix}-literal\\n-newline\n-carriage\r-tab\t-quote"-slash\\-unknown\\q`;
    await mkdir(configDir, { recursive: true });
    await writeFile(
      envFile,
      `PORT=${port}\nAGENT_COORD_STATE_ROOT="${encodedStateRoot}"\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);

      const doctorResponse = await fetch(`http://127.0.0.1:${port}/api/doctor`);
      const doctor = await doctorResponse.json() as { stateRoot: string };
      expect(doctor.stateRoot).toBe(expectedStateRoot);
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it.each([
    { label: "missing", fixture: "missing", message: "does not exist" },
    { label: "invalid", fixture: "invalid", message: "invalid syntax on line 1" },
    { label: "symlinked", fixture: "symlink", message: "regular file, not a symlink" }
  ])("rejects a $label protected environment file", async ({ fixture, message }) => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const envFile = join(root, "dashboard.env");
    if (fixture === "invalid") {
      await writeFile(envFile, "this is not an assignment\n", "utf8");
      await chmod(envFile, 0o600);
    } else if (fixture === "symlink") {
      const target = join(root, "dashboard-target.env");
      await writeFile(target, "PORT=4319\n", "utf8");
      await chmod(target, 0o600);
      await symlink(target, envFile);
    }

    try {
      const result = await runLifecycle(["start", "--config-env-file", envFile], root);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    { label: "missing override", fixture: "missing", message: "does not exist" },
    { label: "invalid syntax", fixture: "invalid", message: "invalid syntax on line 1" },
    { label: "unsafe mode", fixture: "mode", message: "must use mode 0600" },
    { label: "invalid port", fixture: "port", message: "must be an integer" },
    {
      label: "invalid refresh interval",
      fixture: "refresh",
      message: "DASHBOARD_REFRESH_MS must be a non-negative number"
    },
    {
      label: "unassigned IP host",
      fixture: "unassigned_host",
      message: "HOST must be a loopback address or an IP address assigned to this machine"
    },
    {
      label: "file-provided NODE_OPTIONS",
      fixture: "node_options",
      message: "NODE_OPTIONS is not supported in the protected environment file"
    },
    {
      label: "literal NUL byte",
      fixture: "nul_byte",
      message: "must not contain NUL bytes"
    },
    {
      label: "wildcard host without allowed hosts",
      fixture: "wildcard_missing",
      message: "specific hostnames or IP addresses"
    },
    {
      label: "wildcard host with blank allowed hosts",
      fixture: "wildcard_blank",
      message: "specific hostnames or IP addresses"
    },
    {
      label: "wildcard host with invalid allowed hosts",
      fixture: "wildcard_invalid",
      message: "specific hostnames or IP addresses"
    },
    {
      label: "wildcard host with catch-all allowed hosts",
      fixture: "wildcard_catchall",
      message: "specific hostnames or IP addresses"
    },
    {
      label: "wildcard host with expanded IPv6 wildcard allowed hosts",
      fixture: "wildcard_expanded_ipv6",
      message: "specific hostnames or IP addresses"
    }
  ])("keeps the running dashboard intact when restart configuration has $label", async ({ fixture, message }) => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    const runtimePath = join(lifecycleDir, "runtime.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      envFile,
      `PORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      const originalRuntime = await readFile(runtimePath, "utf8");
      const originalPid = (JSON.parse(originalRuntime) as { pid: number }).pid;

      let restartArgs = ["restart"];
      if (fixture === "missing") {
        restartArgs = ["restart", "--config-env-file", join(root, "missing.env")];
      } else if (fixture === "invalid") {
        await writeFile(envFile, "not an assignment\n", "utf8");
      } else if (fixture === "mode") {
        await chmod(envFile, 0o400);
      } else if (fixture === "refresh") {
        await writeFile(envFile, `PORT=${port}\nDASHBOARD_REFRESH_MS=Infinity\n`, "utf8");
      } else if (fixture === "unassigned_host") {
        await writeFile(envFile, `HOST=192.0.2.10\nPORT=${port}\n`, "utf8");
      } else if (fixture === "node_options") {
        await writeFile(envFile, `PORT=${port}\nNODE_OPTIONS=--require=/missing.cjs\n`, "utf8");
      } else if (fixture === "nul_byte") {
        await writeFile(envFile, `PORT=${port}\nDASHBOARD_SETTINGS_PATH=${root}\0settings.json\n`, "utf8");
      } else if (fixture.startsWith("wildcard_")) {
        const allowedHosts = fixture === "wildcard_missing"
          ? ""
          : `ALLOWED_HOSTS=${fixture === "wildcard_blank"
            ? "   "
            : fixture === "wildcard_invalid"
              ? "bad host"
              : fixture === "wildcard_expanded_ipv6"
                ? "0:0:0:0:0:0:0:0"
                : "*"}\n`;
        await writeFile(envFile, `HOST=0.0.0.0\nPORT=${port}\n${allowedHosts}`, "utf8");
      } else {
        await writeFile(envFile, "PORT=not-a-port\n", "utf8");
      }

      const restarted = await runLifecycle(restartArgs, root);
      expect(restarted.status).toBe(1);
      expect(restarted.stderr).toContain(message);
      expect(await readFile(runtimePath, "utf8")).toBe(originalRuntime);
      expect(processExists(originalPid)).toBe(true);
      await expect(fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json()))
        .resolves.toMatchObject({ ok: true });
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);

  it("restarts safely without forwarding inherited caller-relative NODE_OPTIONS to the child", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const baseline = await lifecycleProcessIds();
    const port = await unusedPort();
    const callerDir = join(root, "caller");
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
    const markerPath = join(root, "node-options-marker.txt");
    await mkdir(callerDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(callerDir, "hook.cjs"),
      "require('node:fs').appendFileSync(process.env.NODE_OPTIONS_MARKER, `${process.pid}\\n`);\n",
      "utf8"
    );
    const envFile = join(configDir, "env");
    await writeFile(
      envFile,
      `PORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      const originalPid = (JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number }).pid;

      const restarted = await runLifecycle(
        ["restart"],
        root,
        {
          NODE_OPTIONS: "--require=./hook.cjs",
          NODE_OPTIONS_MARKER: markerPath
        },
        callerDir
      );
      expect(restarted.status).toBe(0);
      expect(restarted.stderr).toBe("");

      const replacementPid = (JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number }).pid;
      expect(replacementPid).not.toBe(originalPid);
      expect(processExists(replacementPid)).toBe(true);
      expect((await readFile(markerPath, "utf8")).trim().split("\n")).toHaveLength(1);
      await expect(fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json()))
        .resolves.toMatchObject({ ok: true });
    } finally {
      await cleanupLifecycle(root);
      await cleanupNewLifecycleProcesses(baseline);
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);

  it.each([
    { label: "missing", allowedHosts: null },
    { label: "non-specific", allowedHosts: "0:0:0:0:0:0:0:0" }
  ])(
    "keeps the running dashboard intact when expanded IPv6 wildcard HOST has a $label allow-list",
    async ({ allowedHosts }) => {
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const port = await unusedPort();
      const configDir = join(root, "config", "agent-coordination-dashboard");
      const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
      const envFile = join(configDir, "env");
      await mkdir(configDir, { recursive: true });
      await writeFile(envFile, `PORT=${port}\n`, "utf8");
      await chmod(envFile, 0o600);

      try {
        const started = await runLifecycle(["start"], root);
        expect(started.status).toBe(0);
        const originalRuntime = await readFile(runtimePath, "utf8");
        const originalPid = (JSON.parse(originalRuntime) as { pid: number }).pid;
        const allowedHostsLine = allowedHosts === null ? "" : `ALLOWED_HOSTS=${allowedHosts}\n`;
        await writeFile(
          envFile,
          `HOST=0:0:0:0:0:0:0:0\nPORT=${port}\n${allowedHostsLine}`,
          "utf8"
        );

        const restarted = await runLifecycle(["restart"], root);

        expect(restarted.status).toBe(1);
        expect(restarted.stderr).toContain("specific hostnames or IP addresses");
        expect(await readFile(runtimePath, "utf8")).toBe(originalRuntime);
        expect(processExists(originalPid)).toBe(true);
        await expect(fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json()))
          .resolves.toMatchObject({ ok: true });
      } finally {
        await cleanupLifecycle(root);
        await rm(root, { force: true, recursive: true });
      }
    },
    30_000
  );

  it("preflights an occupied replacement endpoint before restarting the owned dashboard", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const originalPort = await unusedPort();
    const unrelated = createNetServer();
    unrelated.listen(0, "127.0.0.1");
    await once(unrelated, "listening");
    const unrelatedAddress = unrelated.address();
    if (!unrelatedAddress || typeof unrelatedAddress === "string") {
      throw new Error("Expected an unrelated TCP address.");
    }
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
    const envFile = join(configDir, "env");
    await mkdir(configDir, { recursive: true });
    await writeFile(envFile, `PORT=${originalPort}\n`, "utf8");
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      const originalRuntime = await readFile(runtimePath, "utf8");
      const originalPid = (JSON.parse(originalRuntime) as { pid: number }).pid;
      await writeFile(envFile, `PORT=${unrelatedAddress.port}\n`, "utf8");

      const restarted = await runLifecycle(["restart"], root);
      const runtimeAfterRestart = await readFile(runtimePath, "utf8").catch(() => "");
      const originalStillAlive = processExists(originalPid);
      const originalStillHealthy = await fetch(`http://127.0.0.1:${originalPort}/api/health`)
        .then(async (response) => {
          const payload = await response.json() as { ok?: boolean };
          return payload.ok === true;
        }, () => false);
      const unrelatedStillListening = unrelated.listening;

      await writeFile(envFile, `PORT=${originalPort}\n`, "utf8");
      if (!runtimeAfterRestart) {
        const recovered = await runLifecycle(["start"], root);
        expect(recovered.status).toBe(0);
      }
      const beforeSameEndpointRestart = JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number };
      const sameEndpointRestart = await runLifecycle(["restart"], root);
      const afterSameEndpointRestart = JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number };

      expect(restarted.status).toBe(1);
      expect(restarted.stderr).toContain(`Port ${unrelatedAddress.port} is already in use`);
      expect(restarted.stderr).toContain("nothing was stopped");
      expect(runtimeAfterRestart).toBe(originalRuntime);
      expect(originalStillAlive).toBe(true);
      expect(originalStillHealthy).toBe(true);
      expect(unrelatedStillListening).toBe(true);
      expect(sameEndpointRestart.status).toBe(0);
      expect(afterSameEndpointRestart.pid).not.toBe(beforeSameEndpointRestart.pid);
    } finally {
      await cleanupLifecycle(root);
      await new Promise<void>((resolve) => unrelated.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it.runIf(supportsAlternateLoopback)(
    "preserves a same-port localhost dashboard when DNS resolves to an occupied different loopback",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const port = await unusedPort(alternateLoopback);
      const configDir = join(root, "config", "agent-coordination-dashboard");
      const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
      const envFile = join(configDir, "env");
      const unrelated = createNetServer();
      const alternateUrl = `http://${isIP(alternateLoopback) === 6 ? `[${alternateLoopback}]` : alternateLoopback}:${port}`;
      await mkdir(configDir, { recursive: true });
      await writeFile(envFile, `HOST=${alternateLoopback}\nPORT=${port}\n`, "utf8");
      await chmod(envFile, 0o600);

      try {
        const started = await runLifecycle(["start"], root);
        expect(started.status).toBe(0);
        const runtime = JSON.parse(await readFile(runtimePath, "utf8")) as {
          bind_address: string;
          bind_host: string;
          pid: number;
          url: string;
        };
        const originalPid = runtime.pid;
        runtime.bind_address = alternateLoopback;
        runtime.bind_host = "localhost";
        runtime.url = `http://localhost:${port}`;
        const recordedRuntime = `${JSON.stringify(runtime, null, 2)}\n`;
        await writeFile(runtimePath, recordedRuntime, "utf8");
        await writeFile(envFile, `HOST=localhost\nPORT=${port}\n`, "utf8");
        unrelated.listen(port, resolvedLocalhost);
        await once(unrelated, "listening");

        const restarted = await runLifecycle(["restart"], root);

        expect(restarted.status).toBe(1);
        expect(restarted.stderr).toContain(`Port ${port} is already in use`);
        expect(restarted.stderr).toContain("nothing was stopped");
        expect(await readFile(runtimePath, "utf8")).toBe(recordedRuntime);
        expect(processExists(originalPid)).toBe(true);
        await expect(fetch(`${alternateUrl}/api/health`).then((response) => response.json()))
          .resolves.toMatchObject({ ok: true });
        expect(unrelated.listening).toBe(true);
      } finally {
        if (unrelated.listening) {
          await new Promise<void>((resolveClose) => unrelated.close(() => resolveClose()));
        }
        await cleanupLifecycle(root);
        await rm(root, { force: true, recursive: true });
      }
    },
    30_000
  );

  it("rejects inconsistent runtime endpoint metadata before restarting an owned dashboard", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const originalPort = await unusedPort();
    const unrelated = createNetServer();
    unrelated.listen(0, "127.0.0.1");
    await once(unrelated, "listening");
    const unrelatedAddress = unrelated.address();
    if (!unrelatedAddress || typeof unrelatedAddress === "string") {
      throw new Error("Expected an unrelated TCP address.");
    }
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
    const envFile = join(configDir, "env");
    await mkdir(configDir, { recursive: true });
    await writeFile(envFile, `PORT=${originalPort}\n`, "utf8");
    await chmod(envFile, 0o600);
    let originalRuntime = "";

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      originalRuntime = await readFile(runtimePath, "utf8");
      const corruptedRuntime = JSON.parse(originalRuntime) as { bind_port: number; pid: number };
      const originalPid = corruptedRuntime.pid;
      corruptedRuntime.bind_port = unrelatedAddress.port;
      await writeFile(runtimePath, `${JSON.stringify(corruptedRuntime, null, 2)}\n`, "utf8");
      await writeFile(envFile, `PORT=${unrelatedAddress.port}\n`, "utf8");

      const restarted = await runLifecycle(["restart"], root);

      expect(restarted.status).toBe(1);
      expect(restarted.stderr).toContain("metadata is unreadable or invalid");
      expect(processExists(originalPid)).toBe(true);
      await expect(fetch(`http://127.0.0.1:${originalPort}/api/health`).then((response) => response.json()))
        .resolves.toMatchObject({ ok: true });
      expect(unrelated.listening).toBe(true);
    } finally {
      if (originalRuntime) await writeFile(runtimePath, originalRuntime, "utf8").catch(() => {});
      await cleanupLifecycle(root);
      await new Promise<void>((resolve) => unrelated.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it.runIf(process.platform === "darwin" && Boolean(lanIpv4))(
    "preflights a same-port LAN-specific listener before restarting to a wildcard endpoint",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const unrelated = createNetServer();
      unrelated.listen(0, lanIpv4 as string);
      await once(unrelated, "listening");
      const unrelatedAddress = unrelated.address();
      if (!unrelatedAddress || typeof unrelatedAddress === "string") {
        throw new Error("Expected an unrelated TCP address.");
      }
      const originalPort = unrelatedAddress.port;
      const configDir = join(root, "config", "agent-coordination-dashboard");
      const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
      const envFile = join(configDir, "env");
      await mkdir(configDir, { recursive: true });
      await writeFile(envFile, `PORT=${originalPort}\n`, "utf8");
      await chmod(envFile, 0o600);

      try {
        const started = await runLifecycle(["start"], root);
        expect(started.status).toBe(0);
        const originalRuntime = await readFile(runtimePath, "utf8");
        const originalPid = (JSON.parse(originalRuntime) as { pid: number }).pid;
        await writeFile(
          envFile,
          `HOST=0.0.0.0\nPORT=${unrelatedAddress.port}\nALLOWED_HOSTS=dashboard.example.test\n`,
          "utf8"
        );

        const restarted = await runLifecycle(["restart"], root);

        expect(restarted.status).toBe(1);
        expect(restarted.stderr).toContain(`Port ${unrelatedAddress.port} is already in use`);
        expect(restarted.stderr).toContain("nothing was stopped");
        expect(await readFile(runtimePath, "utf8")).toBe(originalRuntime);
        expect(processExists(originalPid)).toBe(true);
        await expect(fetch(`http://127.0.0.1:${originalPort}/api/health`).then((response) => response.json()))
          .resolves.toMatchObject({ ok: true });
        expect(unrelated.listening).toBe(true);
      } finally {
        await cleanupLifecycle(root);
        await new Promise<void>((resolve) => unrelated.close(() => resolve()));
        await rm(root, { force: true, recursive: true });
      }
    },
    30_000
  );

  it.runIf(Boolean(lanIpv4))(
    "allows owned same-port wildcard, LAN, and localhost bind-host transitions",
    async () => {
      const host = lanIpv4 as string;
      const cases = [
        {
          current: `HOST=0.0.0.0\nALLOWED_HOSTS=${host}\n`,
          replacement: `HOST=${host}\n`
        },
        {
          current: `HOST=${host}\n`,
          replacement: `HOST=0.0.0.0\nALLOWED_HOSTS=${host}\n`
        },
        {
          current: "HOST=localhost\n",
          replacement: `HOST=0.0.0.0\nALLOWED_HOSTS=${host}\n`
        },
        {
          current: `HOST=0.0.0.0\nALLOWED_HOSTS=${host}\n`,
          replacement: "HOST=localhost\n"
        }
      ];

      for (const fixture of cases) {
        const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
        const port = await unusedPort(fixture.current.includes("HOST=localhost") ? "localhost" : "127.0.0.1");
        const configDir = join(root, "config", "agent-coordination-dashboard");
        const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
        const envFile = join(configDir, "env");
        await mkdir(configDir, { recursive: true });
        await writeFile(envFile, `${fixture.current}PORT=${port}\n`, "utf8");
        await chmod(envFile, 0o600);

        try {
          const started = await runLifecycle(["start"], root);
          expect(started.status).toBe(0);
          const originalPid = (JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number }).pid;
          await writeFile(envFile, `${fixture.replacement}PORT=${port}\n`, "utf8");

          const restarted = await runLifecycle(["restart"], root);
          const replacementPid = (JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number }).pid;
          const status = await runLifecycle(["status"], root);

          expect(restarted.status).toBe(0);
          expect(replacementPid).not.toBe(originalPid);
          expect(status.status).toBe(0);
        } finally {
          await cleanupLifecycle(root);
          await rm(root, { force: true, recursive: true });
        }
      }
    },
    40_000
  );

  it.runIf(Boolean(lanIpv4) && supportsIpv6WildcardIpv4)(
    "allows an owned dual-stack IPv6 wildcard to transition to its covered IPv4 interface",
    async () => {
      const host = lanIpv4 as string;
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const port = await unusedPort("::");
      const configDir = join(root, "config", "agent-coordination-dashboard");
      const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
      const envFile = join(configDir, "env");
      await mkdir(configDir, { recursive: true });
      await writeFile(envFile, `HOST=::\nPORT=${port}\nALLOWED_HOSTS=${host}\n`, "utf8");
      await chmod(envFile, 0o600);

      try {
        const started = await runLifecycle(["start"], root);
        expect(started.status).toBe(0);
        const originalRuntime = JSON.parse(await readFile(runtimePath, "utf8")) as {
          bind_ipv4_coverage: boolean;
          pid: number;
        };
        const originalPid = originalRuntime.pid;
        expect(originalRuntime.bind_ipv4_coverage).toBe(true);
        await writeFile(envFile, `HOST=${host}\nPORT=${port}\n`, "utf8");

        const restarted = await runLifecycle(["restart"], root);
        const replacementPid = (JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number }).pid;

        expect(restarted.status).toBe(0);
        expect(restarted.stderr).toBe("");
        expect(replacementPid).not.toBe(originalPid);
        await expect(fetch(`http://${host}:${port}/api/health`).then((response) => response.json()))
          .resolves.toMatchObject({ ok: true });
      } finally {
        await cleanupLifecycle(root);
        await rm(root, { force: true, recursive: true });
      }
    },
    30_000
  );

  it("reports stale metadata and removes it on an idempotent stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const runtimePath = join(lifecycleDir, "runtime.json");
    await mkdir(lifecycleDir, { recursive: true });
    await chmod(lifecycleDir, 0o700);
    await writeFile(runtimePath, JSON.stringify({
      schema_version: 1,
      pid: 999_999_999,
      instance_id: "0".repeat(32),
      started_at: new Date().toISOString(),
      url: "http://127.0.0.1:4319",
      log_file: join(lifecycleDir, "dashboard.log")
    }), "utf8");

    try {
      const status = await runLifecycle(["status"], root);
      expect(status.status).toBe(3);
      expect(status.stdout).toContain("stale lifecycle metadata remains");

      const stopped = await runLifecycle(["stop"], root);
      expect(stopped.status).toBe(0);
      expect(stopped.stdout).toContain("already stopped");
      await expect(readFile(runtimePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects environment-file options on lifecycle commands that do not start a process", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    try {
      const result = await runLifecycle(["status", "--config-env-file", "unused.env"], root);

      expect(result.status).toBe(64);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("status does not accept options");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("starts with an explicit protected configuration environment file", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const customEnvFile = join(root, "dashboard.env");
    await writeFile(
      customEnvFile,
      `PORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\n`,
      "utf8"
    );
    await chmod(customEnvFile, 0o600);

    try {
      const result = await runLifecycle(["start", "--config-env-file", customEnvFile], root);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Dashboard started at http://127.0.0.1:${port}.`);
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it.each([
    {
      label: "missing override path",
      args: ["start", "--config-env-file"],
      message: "--config-env-file requires a path"
    },
    {
      label: "option in place of override path",
      args: ["start", "--config-env-file", "--bogus"],
      message: "--config-env-file requires a path"
    },
    {
      label: "repeated override",
      args: ["start", "--config-env-file", "one.env", "--config-env-file", "two.env"],
      message: "Unknown or repeated start option"
    },
    {
      label: "unknown restart option",
      args: ["restart", "--bogus"],
      message: "Unknown or repeated restart option"
    }
  ])("rejects $label as lifecycle usage", async ({ args, message }) => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    try {
      const result = await runLifecycle(args, root);

      expect(result.status).toBe(64);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("documents lifecycle commands, their override flag, and the protected default path", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    try {
      const result = await runLifecycle(["--help"], root);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("start [--config-env-file <path>]");
      expect(result.stdout).toContain("restart [--config-env-file <path>]");
      expect(result.stdout).toContain("~/.config/agent-coordination-dashboard/env");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("starts without tmux and clears inherited API mode when the protected env omits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const stateRoot = join(root, "coordination-state");
    const settingsPath = join(root, "settings.json");
    let pid: number | undefined;
    await mkdir(configDir, { recursive: true });
    const envFile = join(configDir, "env");
    await writeFile(
      envFile,
      `PORT=${port}\nAGENT_COORD_STATE_ROOT=${stateRoot}\nDASHBOARD_SETTINGS_PATH=${settingsPath}\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root, {
        AGENT_COORD_API_URL: "https://stale.example.test",
        AGENT_COORD_API_TOKEN: "sentinel-stale-api-token",
        AGENT_COORD_TOKEN: "sentinel-stale-legacy-token",
        PATH: "/usr/bin:/bin"
      });

      expect(started.status).toBe(0);
      expect(started.stdout).toContain(`Dashboard started at http://127.0.0.1:${port}.`);
      expect(started.stdout).toContain("Coordination diagnostics are healthy.");
      expect(started.stderr).toBe("");

      const status = await runLifecycle(["status"], root);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(`Dashboard is running at http://127.0.0.1:${port}.`);

      const runtimeText = await readFile(
        join(root, "state", "agent-coordination-dashboard", "runtime.json"),
        "utf8"
      );
      const runtime = JSON.parse(runtimeText) as { pid: number };
      pid = runtime.pid;
      expect(runtimeText).not.toContain("sentinel-");

      const doctorResponse = await fetch(`http://127.0.0.1:${port}/api/doctor`);
      const doctor = await doctorResponse.json() as { apiUrl: string | null; tokenEnvVar: string | null };
      expect(doctor).toMatchObject({ apiUrl: null, tokenEnvVar: null });

      const command = await new Promise<string>((resolve) => {
        const ps = spawn("ps", ["-p", String(pid), "-o", "command="], { stdio: ["ignore", "pipe", "ignore"] });
        let output = "";
        ps.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        ps.on("exit", () => resolve(output));
      });
      expect(command).toContain("__lifecycle-serve");
      expect(command).not.toContain("sentinel-");
      const logs = await readFile(
        join(root, "state", "agent-coordination-dashboard", "dashboard.log"),
        "utf8"
      );
      expect(logs).not.toContain("sentinel-");
    } finally {
      await cleanupLifecycle(root);
      if (pid) expect(processExists(pid)).toBe(false);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("makes repeated start and stop operations idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    await mkdir(configDir, { recursive: true });
    const envFile = join(configDir, "env");
    await writeFile(
      envFile,
      `PORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\nDASHBOARD_SETTINGS_PATH=${join(root, "settings.json")}\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const firstStart = await runLifecycle(["start"], root);
      expect(firstStart.status).toBe(0);

      const secondStart = await runLifecycle(["start"], root);
      expect(secondStart.status).toBe(0);
      expect(secondStart.stdout).toContain(`Dashboard is already running at http://127.0.0.1:${port}.`);

      const logs = await runLifecycle(["logs"], root);
      expect(logs.status).toBe(0);
      expect(logs.stdout).toContain(`agent-coordination-dashboard listening on http://127.0.0.1:${port}`);
      expect(logs.stderr).toBe("");

      const openerDir = join(root, "opener-bin");
      const openedUrlFile = join(root, "opened-url.txt");
      await mkdir(openerDir, { recursive: true });
      for (const opener of ["open", "xdg-open"]) {
        const openerPath = join(openerDir, opener);
        await writeFile(openerPath, '#!/bin/sh\nprintf "%s" "$1" > "$OPEN_CAPTURE"\n', "utf8");
        await chmod(openerPath, 0o700);
      }
      const opened = await runLifecycle(["open"], root, {
        OPEN_CAPTURE: openedUrlFile,
        PATH: `${openerDir}:/usr/bin:/bin`
      });
      expect(opened.status).toBe(0);
      expect(opened.stdout).toContain(`Opened http://127.0.0.1:${port}.`);
      const openDeadline = Date.now() + 2_000;
      let openedUrl = "";
      while (!openedUrl && Date.now() < openDeadline) {
        openedUrl = await readFile(openedUrlFile, "utf8").catch(() => "");
        if (!openedUrl) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(openedUrl).toBe(`http://127.0.0.1:${port}`);

      for (const opener of ["open", "xdg-open"]) {
        await writeFile(join(openerDir, opener), "#!/bin/sh\nexit 7\n", "utf8");
      }
      const rejectedOpen = await runLifecycle(["open"], root, {
        PATH: `${openerDir}:/usr/bin:/bin`
      });
      expect(rejectedOpen.status).toBe(1);
      expect(rejectedOpen.stdout).not.toContain("Opened ");
      expect(rejectedOpen.stderr).toContain("could not open the dashboard URL");

      const firstStop = await runLifecycle(["stop"], root);
      expect(firstStop.status).toBe(0);
      expect(firstStop.stdout).toContain("Dashboard stopped.");

      const secondStop = await runLifecycle(["stop"], root);
      expect(secondStop.status).toBe(0);
      expect(secondStop.stdout).toContain("Dashboard is already stopped.");

      const status = await runLifecycle(["status"], root);
      expect(status.status).toBe(3);
      expect(status.stdout).toContain("Dashboard is stopped.");
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("uses wide process inventory to recover and stop the owned server group", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const fakeBinDir = join(root, "fake-bin");
    const psArgumentsLog = join(root, "ps-arguments.log");
    const psLocaleLog = join(root, "ps-locale.log");
    const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
    const envFile = join(configDir, "env");
    const realPs = await executableOnPath("ps");
    let pgid: number | undefined;
    await Promise.all([mkdir(configDir, { recursive: true }), mkdir(fakeBinDir, { recursive: true })]);
    await writeFile(
      envFile,
      `PORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);
    const fakePs = join(fakeBinDir, "ps");
    await writeFile(
      fakePs,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PS_ARGUMENTS_LOG\"\nprintf '%s\\n' \"$LC_ALL\" >> \"$PS_LOCALE_LOG\"\nif [ \"$*\" = \"-ww -axo pgid=,command=\" ]; then\n  dd if=/dev/zero bs=1048576 count=2 2>/dev/null | tr '\\000' x\n  printf '\\n'\nfi\nexec \"$REAL_PS\" \"$@\"\n",
      "utf8"
    );
    await chmod(fakePs, 0o700);
    const fakePsEnv = {
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      PS_ARGUMENTS_LOG: psArgumentsLog,
      PS_LOCALE_LOG: psLocaleLog,
      REAL_PS: realPs
    };

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      const runtime = JSON.parse(await readFile(runtimePath, "utf8")) as {
        instance_id: string;
        pgid?: number;
        pid: number;
      };
      pgid = runtime.pgid || runtime.pid;
      const ownedStatus = await runLifecycle(["status"], root, fakePsEnv);
      expect(ownedStatus.status).toBe(0);
      process.kill(runtime.pid, "SIGKILL");
      const wrapperDeadline = Date.now() + 2_000;
      while (processExists(runtime.pid) && Date.now() < wrapperDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(processExists(runtime.pid)).toBe(false);
      expect(processGroupExists(pgid)).toBe(true);
      expect(await portIsListening(port)).toBe(true);

      const status = await runLifecycle(["status"], root, fakePsEnv);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(`Dashboard is running at http://127.0.0.1:${port}.`);
      const psArguments = (await readFile(psArgumentsLog, "utf8")).trim().split("\n");
      expect(psArguments.some((line) => /^-ww -p \d+ -o command=$/.test(line))).toBe(true);
      expect(psArguments).toContain("-ww -axo pgid=,command=");
      expect((await readFile(psLocaleLog, "utf8")).trim().split("\n").every((locale) => locale === "C")).toBe(true);

      const repeatedStart = await runLifecycle(["start"], root);
      expect(repeatedStart.status).toBe(0);
      expect(repeatedStart.stdout).toContain("Dashboard is already running");

      const stopped = await runLifecycle(["stop"], root);
      expect(stopped.status).toBe(0);
      expect(stopped.stdout).toContain("Dashboard stopped.");
      expect(processGroupExists(pgid)).toBe(false);
      expect(await portIsListening(port)).toBe(false);
      await expect(readFile(runtimePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (pgid && processGroupExists(pgid)) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // The exact lifecycle process group may have exited between inspection and cleanup.
        }
      }
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it.each([
    { label: "live wrapper", orphanWrapper: false },
    { label: "orphaned server group", orphanWrapper: true }
  ])(
    "preserves $label ownership after the package installation path changes",
    async ({ orphanWrapper }) => {
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const port = await unusedPort();
      const configDir = join(root, "config", "agent-coordination-dashboard");
      const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
      const envFile = join(configDir, "env");
      const relocatedExecutable = await writeRelocatedLifecycleExecutable(root);
      await mkdir(configDir, { recursive: true });
      await writeFile(envFile, `PORT=${port}\n`, "utf8");
      await chmod(envFile, 0o600);
      let pgid: number | undefined;

      try {
        const started = await runLifecycle(["start"], root);
        expect(started.status).toBe(0);
        const runtime = JSON.parse(await readFile(runtimePath, "utf8")) as {
          pgid: number;
          pid: number;
          server_entrypoint: string;
          wrapper_entrypoint: string;
        };
        pgid = runtime.pgid;
        expect(runtime.wrapper_entrypoint).toBe(resolve("bin/agent-coordination-dashboard.js"));
        expect(runtime.server_entrypoint).toBe(resolve("src/server/index.ts"));
        if (orphanWrapper) {
          process.kill(runtime.pid, "SIGKILL");
          const wrapperDeadline = Date.now() + 2_000;
          while (processExists(runtime.pid) && Date.now() < wrapperDeadline) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
          }
          expect(processExists(runtime.pid)).toBe(false);
          expect(processGroupExists(runtime.pgid)).toBe(true);
          expect(await portIsListening(port)).toBe(true);
        }

        const stopped = await runLifecycle(
          ["stop"],
          root,
          {},
          process.cwd(),
          0,
          relocatedExecutable
        );

        expect(stopped.status).toBe(0);
        expect(stopped.stderr).toBe("");
        expect(stopped.stdout).toContain("Dashboard stopped.");
        expect(processGroupExists(runtime.pgid)).toBe(false);
        expect(await portIsListening(port)).toBe(false);
        await expect(readFile(runtimePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await cleanupLifecycle(root);
        if (pgid && processGroupExists(pgid)) {
          try {
            process.kill(-pgid, "SIGKILL");
          } catch {
            // The exact lifecycle process group may have exited between inspection and cleanup.
          }
        }
        await rm(root, { force: true, recursive: true });
      }
    },
    30_000
  );

  it.runIf(process.platform === "linux")(
    "falls through a test-owned zombie wrapper to its marked live server group",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
      const runtimePath = join(lifecycleDir, "runtime.json");
      const wrapperScript = join(root, "zombie-wrapper.mjs");
      const holderScript = join(root, "zombie-holder.mjs");
      const wrapperPidFile = join(root, "wrapper.pid");
      const releaseFile = join(root, "release-holder");
      const serverEntrypoint = resolve("src/server/index.ts");
      const instanceId = "a".repeat(32);
      const port = await unusedPort();
      let wrapperPid: number | undefined;
      await mkdir(lifecycleDir, { recursive: true });
      await chmod(lifecycleDir, 0o700);
      await writeFile(
        wrapperScript,
        `import { spawn } from "node:child_process";
const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.argv[2], "--lifecycle-instance", process.argv[3]], {
  stdio: "ignore"
});
server.unref();
`,
        "utf8"
      );
      await writeFile(
        holderScript,
        `import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const child = spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[4]], {
  detached: true,
  stdio: "ignore"
});
writeFileSync(process.argv[5], String(child.pid));
const waitArray = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(process.argv[6])) Atomics.wait(waitArray, 0, 0, 25);
try { process.kill(-child.pid, "SIGKILL"); } catch {}
child.once("exit", () => { process.exitCode = 0; });
setTimeout(() => { process.exitCode = 1; }, 2000).unref();
`,
        "utf8"
      );
      const holder = spawn(
        process.execPath,
        [holderScript, wrapperScript, serverEntrypoint, instanceId, wrapperPidFile, releaseFile],
        { stdio: "ignore" }
      );

      try {
        const zombieDeadline = Date.now() + 5_000;
        let identity: { birthMarker: string; state: string } | undefined;
        while (Date.now() < zombieDeadline) {
          const pidText = await readFile(wrapperPidFile, "utf8").catch(() => "");
          if (pidText) {
            wrapperPid = Number(pidText);
            identity = await linuxProcessIdentity(wrapperPid).catch(() => undefined);
            if (identity?.state === "Z") break;
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        }
        expect(wrapperPid).toBeTypeOf("number");
        expect(identity?.state).toBe("Z");
        await writeFile(runtimePath, `${JSON.stringify({
          schema_version: 1,
          pid: wrapperPid,
          pgid: wrapperPid,
          instance_id: instanceId,
          process_birth_marker: identity?.birthMarker,
          server_entrypoint: serverEntrypoint,
          started_at: new Date().toISOString(),
          url: `http://127.0.0.1:${port}`,
          log_file: join(lifecycleDir, "dashboard.log"),
          wrapper_entrypoint: wrapperScript
        }, null, 2)}\n`, "utf8");
        await chmod(runtimePath, 0o600);

        const status = await runLifecycle(["status"], root);

        expect(status.status).toBe(1);
        expect(status.stderr).toContain("process is running, but its health check failed");
        expect(status.stderr).not.toContain("does not identify an owned process");
      } finally {
        const holderExit = once(holder, "exit").catch(() => []);
        await writeFile(releaseFile, "release\n", "utf8").catch(() => {});
        await Promise.race([
          holderExit,
          new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000))
        ]);
        if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
        if (wrapperPid && processGroupExists(wrapperPid)) {
          try {
            process.kill(-wrapperPid, "SIGKILL");
          } catch {
            // The test-owned group may have disappeared during holder cleanup.
          }
        }
        await rm(root, { force: true, recursive: true });
      }
    },
    20_000
  );

  it("fails closed when an orphaned server group's process inventory is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const fakeBinDir = join(root, "fake-bin");
    const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
    const envFile = join(configDir, "env");
    let pgid: number | undefined;
    await Promise.all([mkdir(configDir, { recursive: true }), mkdir(fakeBinDir, { recursive: true })]);
    await writeFile(envFile, `PORT=${port}\n`, "utf8");
    await chmod(envFile, 0o600);
    const fakePs = join(fakeBinDir, "ps");
    await writeFile(fakePs, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(fakePs, 0o700);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      const originalRuntime = await readFile(runtimePath, "utf8");
      const runtime = JSON.parse(originalRuntime) as { pgid: number; pid: number };
      pgid = runtime.pgid;
      process.kill(runtime.pid, "SIGKILL");
      const wrapperDeadline = Date.now() + 2_000;
      while (processExists(runtime.pid) && Date.now() < wrapperDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const status = await runLifecycle(["status"], root, { PATH: `${fakeBinDir}:/usr/bin:/bin` });
      expect(status.status).toBe(2);
      expect(status.stderr).toContain("does not identify an owned process");
      expect(await readFile(runtimePath, "utf8")).toBe(originalRuntime);
      expect(processGroupExists(runtime.pgid)).toBe(true);
      expect(await portIsListening(port)).toBe(true);

      const stopped = await runLifecycle(["stop"], root);
      expect(stopped.status).toBe(0);
      expect(processGroupExists(runtime.pgid)).toBe(false);
    } finally {
      if (pgid && processGroupExists(pgid)) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // The exact lifecycle process group may have exited between inspection and cleanup.
        }
      }
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("serializes simultaneous starts across a transient process identity lookup failure", async () => {
    const baseline = await lifecycleProcessIds();
    const realPs = await executableOnPath("ps");
    const usesLinuxProcIdentity = process.platform === "linux" && await access(`/proc/${process.pid}/stat`)
      .then(() => true, () => false);
    for (let iteration = 1; iteration <= 10; iteration += 1) {
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const port = await unusedPort();
      const configDir = join(root, "config", "agent-coordination-dashboard");
      const fakeBinDir = join(root, "fake-bin");
      const psCounterDir = join(root, "ps-counters");
      const psFailureLog = join(root, "ps-failures.log");
      await Promise.all([
        mkdir(configDir, { recursive: true }),
        mkdir(fakeBinDir, { recursive: true }),
        mkdir(psCounterDir, { recursive: true })
      ]);
      const fakePs = join(fakeBinDir, "ps");
      await writeFile(
        fakePs,
        `#!/bin/sh
if [ "$5" = "lstart=" ]; then
  counter="$PS_COUNTER_DIR/$3"
  while ! mkdir "$counter.lock" 2>/dev/null; do sleep 0.01; done
  count=0
  if [ -f "$counter.count" ]; then read -r count < "$counter.count"; fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$counter.count"
  rmdir "$counter.lock"
  if [ "$count" -eq 2 ]; then
    printf '%s\\n' "$3" >> "$PS_FAILURE_LOG"
    exit 1
  fi
fi
exec "$REAL_PS" "$@"
`,
        "utf8"
      );
      await chmod(fakePs, 0o700);
      const envFile = join(configDir, "env");
      await writeFile(
        envFile,
        `PORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\n`,
        "utf8"
      );
      await chmod(envFile, 0o600);

      try {
        const starts = await Promise.all(
          Array.from({ length: 4 }, () =>
            runLifecycle(["start"], root, {
              PATH: `${fakeBinDir}:${process.env.PATH}`,
              PS_COUNTER_DIR: psCounterDir,
              PS_FAILURE_LOG: psFailureLog,
              REAL_PS: realPs
            })
          )
        );
        expect({ iteration, failures: starts.filter((result) => result.status !== 0) }).toEqual({
          iteration,
          failures: []
        });
        expect(starts.filter((result) => result.stdout.includes("Dashboard started at")).length).toBe(1);
        expect(starts.filter((result) => result.stdout.includes("Dashboard is already running")).length).toBe(3);
        if (!usesLinuxProcIdentity) expect(await readFile(psFailureLog, "utf8")).toMatch(/\d/);

        const status = await runLifecycle(["status"], root);
        expect(status.status).toBe(0);
        expect(status.stdout).toContain(`Dashboard is running at http://127.0.0.1:${port}.`);

        const stopped = await runLifecycle(["stop"], root);
        expect(stopped.status).toBe(0);
        expect(stopped.stdout).toContain("Dashboard stopped.");
      } finally {
        await cleanupLifecycle(root);
        await cleanupNewLifecycleProcesses(baseline);
        expect(await lifecycleProcessIds()).toEqual(baseline);
        await rm(root, { force: true, recursive: true });
      }
    }
  }, 60_000);

  it("rejects a symlinked lifecycle state directory without modifying its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const stateHome = join(root, "state");
    const lifecycleDir = join(stateHome, "agent-coordination-dashboard");
    const harmlessTarget = join(root, "harmless-state-target");
    const envFile = join(configDir, "env");
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(stateHome, { recursive: true }),
      mkdir(harmlessTarget, { mode: 0o755 })
    ]);
    await writeFile(envFile, `PORT=${port}\n`, "utf8");
    await chmod(envFile, 0o600);
    await symlink(harmlessTarget, lifecycleDir);

    try {
      const started = await runLifecycle(["start"], root);

      expect(started.status).toBe(1);
      expect(started.stderr).toContain("Lifecycle state path is not a protected directory");
      expect((await stat(harmlessTarget)).mode & 0o777).toBe(0o755);
      await expect(access(join(harmlessTarget, "runtime.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(harmlessTarget, "dashboard.log"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await portIsListening(port)).toBe(false);
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each(["logs", "status"])(
    "does not let %s read through a symlinked lifecycle state directory",
    async (command) => {
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const stateHome = join(root, "state");
      const lifecycleDir = join(stateHome, "agent-coordination-dashboard");
      const harmlessTarget = join(root, "harmless-read-target");
      const sentinel = "sentinel contents must not be disclosed\n";
      await Promise.all([
        mkdir(stateHome, { recursive: true }),
        mkdir(harmlessTarget, { mode: 0o700 })
      ]);
      if (command === "logs") {
        await writeFile(join(harmlessTarget, "dashboard.log"), sentinel, "utf8");
      } else {
        await writeFile(join(harmlessTarget, "runtime.json"), JSON.stringify({
          schema_version: 1,
          pid: 999_999_999,
          instance_id: "0".repeat(32),
          url: "http://127.0.0.1:4319"
        }), "utf8");
      }
      await symlink(harmlessTarget, lifecycleDir);

      try {
        const result = await runLifecycle([command], root);

        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain("sentinel");
        expect(result.stdout).not.toContain("stale lifecycle metadata");
        expect(result.stderr).toContain("Lifecycle state path is not a protected directory");
        if (command === "logs") {
          expect(await readFile(join(harmlessTarget, "dashboard.log"), "utf8")).toBe(sentinel);
        }
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  );

  it("does not invoke an opener through a symlinked lifecycle state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const relocatedStateDir = join(root, "relocated-lifecycle-state");
    const openerDir = join(root, "opener-bin");
    const openedUrlFile = join(root, "opened-url.txt");
    const envFile = join(configDir, "env");
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(openerDir, { recursive: true })
    ]);
    await writeFile(envFile, `PORT=${port}\n`, "utf8");
    await chmod(envFile, 0o600);
    for (const opener of ["open", "xdg-open"]) {
      const openerPath = join(openerDir, opener);
      await writeFile(openerPath, '#!/bin/sh\nprintf "%s" "$1" > "$OPEN_CAPTURE"\n', "utf8");
      await chmod(openerPath, 0o700);
    }

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      await rename(lifecycleDir, relocatedStateDir);
      await symlink(relocatedStateDir, lifecycleDir);

      const opened = await runLifecycle(["open"], root, {
        OPEN_CAPTURE: openedUrlFile,
        PATH: `${openerDir}:/usr/bin:/bin`
      });

      expect(opened.status).toBe(1);
      expect(opened.stdout).not.toContain("Opened ");
      expect(opened.stderr).toContain("Lifecycle state path is not a protected directory");
      await expect(access(openedUrlFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await unlink(lifecycleDir).catch(() => {});
      await rename(relocatedStateDir, lifecycleDir).catch(() => {});
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("does not follow or chmod a symlinked lifecycle log when starting", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const baseline = await lifecycleProcessIds();
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    const logFile = join(lifecycleDir, "dashboard.log");
    const harmlessTarget = join(root, "harmless-target.txt");
    const targetContents = "harmless target contents\n";
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(lifecycleDir, { recursive: true })
    ]);
    await writeFile(envFile, `PORT=${port}\n`, "utf8");
    await chmod(envFile, 0o600);
    await writeFile(harmlessTarget, targetContents, "utf8");
    await chmod(harmlessTarget, 0o644);
    await symlink(harmlessTarget, logFile);

    try {
      const started = await runLifecycle(["start"], root);

      expect(started.status).toBe(1);
      expect(started.stdout).toBe("");
      expect(started.stderr).toContain("Lifecycle log file must be a regular file, not a symlink");
      expect(await readFile(harmlessTarget, "utf8")).toBe(targetContents);
      expect((await stat(harmlessTarget)).mode & 0o777).toBe(0o644);
      await expect(readFile(join(lifecycleDir, "runtime.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await lifecycleProcessIds()).toEqual(baseline);
    } finally {
      await cleanupLifecycle(root);
      await cleanupNewLifecycleProcesses(baseline);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("caps an oversized lifecycle log through the validated descriptor before restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const runtimePath = join(lifecycleDir, "runtime.json");
    const logFile = join(lifecycleDir, "dashboard.log");
    const envFile = join(configDir, "env");
    await mkdir(configDir, { recursive: true });
    await writeFile(envFile, `PORT=${port}\n`, "utf8");
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      const originalPid = (JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number }).pid;
      await truncate(logFile, 8 * 1024 * 1024 + 1);

      const restarted = await runLifecycle(["restart"], root);
      const replacementPid = (JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number }).pid;

      expect(restarted.status).toBe(0);
      expect(restarted.stderr).toBe("");
      expect(replacementPid).not.toBe(originalPid);
      expect((await stat(logFile)).size).toBeLessThan(8 * 1024 * 1024);
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("hard-caps marked server log writes while preserving live lifecycle commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const runtimePath = join(lifecycleDir, "runtime.json");
    const logFile = join(lifecycleDir, "dashboard.log");
    const envFile = join(configDir, "env");
    const cap = 8 * 1024 * 1024;
    const rolloverMarker = "[lifecycle log reset after exceeding 8 MiB]";
    const secretSentinel = "sentinel-secret-from-oversized-log";
    let pid: number | undefined;
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(lifecycleDir, { recursive: true })
    ]);
    await chmod(lifecycleDir, 0o700);
    await writeFile(envFile, `PORT=${port}\n`, "utf8");
    await chmod(envFile, 0o600);
    const secretPrefix = Buffer.from(`${secretSentinel}\n`);
    await writeFile(
      logFile,
      Buffer.concat([secretPrefix, Buffer.alloc(cap - secretPrefix.length, "x")])
    );
    await chmod(logFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      pid = (JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number }).pid;

      const cappedSize = (await stat(logFile)).size;
      const cappedContents = await readFile(logFile, "utf8");

      expect(cappedSize).toBeLessThanOrEqual(cap);
      expect(cappedContents).toContain(rolloverMarker);
      expect(cappedContents).toContain(
        `agent-coordination-dashboard listening on http://127.0.0.1:${port}`
      );
      expect(cappedContents).not.toContain(secretSentinel);
      expect(cappedContents).not.toContain("\0");

      const logs = await runLifecycle(["logs"], root);
      expect(logs.status).toBe(0);
      expect(logs.stdout).toContain(rolloverMarker);
      expect(logs.stdout).not.toContain(secretSentinel);
      expect(logs.stderr).toBe("");

      const status = await runLifecycle(["status"], root);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(`Dashboard is running at http://127.0.0.1:${port}.`);
      expect(processExists(pid)).toBe(true);

      const stopped = await runLifecycle(["stop"], root);
      expect(stopped.status).toBe(0);
      expect(stopped.stdout).toContain("Dashboard stopped.");
      await expect(readFile(runtimePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(processExists(pid)).toBe(false);
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("keeps the running dashboard intact when restart finds a symlinked lifecycle log", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    const logFile = join(lifecycleDir, "dashboard.log");
    const runtimeFile = join(lifecycleDir, "runtime.json");
    const harmlessTarget = join(root, "harmless-target.txt");
    const targetContents = "harmless target contents\n";
    await mkdir(configDir, { recursive: true });
    await writeFile(envFile, `PORT=${port}\n`, "utf8");
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      const originalRuntime = await readFile(runtimeFile, "utf8");
      const originalPid = (JSON.parse(originalRuntime) as { pid: number }).pid;
      await writeFile(harmlessTarget, targetContents, "utf8");
      await chmod(harmlessTarget, 0o644);
      await unlink(logFile);
      await symlink(harmlessTarget, logFile);

      const restarted = await runLifecycle(["restart"], root);

      expect(restarted.status).toBe(1);
      expect(restarted.stderr).toContain("Lifecycle log file must be a regular file, not a symlink");
      expect(await readFile(runtimeFile, "utf8")).toBe(originalRuntime);
      expect(processExists(originalPid)).toBe(true);
      await expect(fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json()))
        .resolves.toMatchObject({ ok: true });
      expect(await readFile(harmlessTarget, "utf8")).toBe(targetContents);
      expect((await stat(harmlessTarget)).mode & 0o777).toBe(0o644);
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("does not read a symlinked lifecycle log", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const logFile = join(lifecycleDir, "dashboard.log");
    const harmlessTarget = join(root, "harmless-target.txt");
    const targetContents = "sentinel harmless target contents\n";
    await mkdir(lifecycleDir, { recursive: true });
    await chmod(lifecycleDir, 0o700);
    await writeFile(harmlessTarget, targetContents, "utf8");
    await chmod(harmlessTarget, 0o644);
    await symlink(harmlessTarget, logFile);

    try {
      const logs = await runLifecycle(["logs"], root);

      expect(logs.status).toBe(1);
      expect(logs.stdout).toBe("");
      expect(logs.stderr).toContain("Lifecycle log file must be a regular file, not a symlink");
      expect(logs.stderr).not.toContain("sentinel harmless target contents");
      expect(await readFile(harmlessTarget, "utf8")).toBe(targetContents);
      expect((await stat(harmlessTarget)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each(["symlink", "fifo"])(
    "rejects a %s runtime metadata file without following or blocking",
    async (fixture) => {
      const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
      const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
      const runtimeFile = join(lifecycleDir, "runtime.json");
      await mkdir(lifecycleDir, { recursive: true });
      await chmod(lifecycleDir, 0o700);
      if (fixture === "symlink") {
        const harmlessTarget = join(root, "harmless-runtime-target.json");
        await writeFile(harmlessTarget, JSON.stringify({
          schema_version: 1,
          pid: 999_999_999,
          instance_id: "0".repeat(32),
          url: "http://127.0.0.1:4319"
        }), "utf8");
        await chmod(harmlessTarget, 0o600);
        await symlink(harmlessTarget, runtimeFile);
      } else {
        const mkfifo = spawn("mkfifo", [runtimeFile], { stdio: "ignore" });
        const [mkfifoStatus] = (await once(mkfifo, "exit")) as [number | null, NodeJS.Signals | null];
        expect(mkfifoStatus).toBe(0);
      }

      try {
        const status = await runLifecycle(["status"], root, {}, process.cwd(), 2_000);

        expect(status.status).toBe(1);
        expect(status.stdout).toBe("");
        expect(status.stderr).toContain("Dashboard lifecycle metadata is unreadable or invalid");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    10_000
  );

  it("rejects a non-regular lifecycle log with a clear error", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const baseline = await lifecycleProcessIds();
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    const logFile = join(lifecycleDir, "dashboard.log");
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(logFile, { recursive: true })
    ]);
    await writeFile(envFile, `PORT=${port}\n`, "utf8");
    await chmod(envFile, 0o600);

    try {
      const started = await runLifecycle(["start"], root);
      const logs = await runLifecycle(["logs"], root);

      expect(started.status).toBe(1);
      expect(started.stderr).toContain("Lifecycle log file must be a regular file");
      expect(logs.status).toBe(1);
      expect(logs.stdout).toBe("");
      expect(logs.stderr).toContain("Lifecycle log file must be a regular file");
      expect(await lifecycleProcessIds()).toEqual(baseline);
    } finally {
      await cleanupLifecycle(root);
      await cleanupNewLifecycleProcesses(baseline);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("rejects a FIFO lifecycle log without blocking", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const baseline = await lifecycleProcessIds();
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    const logFile = join(lifecycleDir, "dashboard.log");
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(lifecycleDir, { recursive: true })
    ]);
    await writeFile(envFile, `PORT=${port}\n`, "utf8");
    await chmod(envFile, 0o600);
    const mkfifo = spawn("mkfifo", [logFile], { stdio: "ignore" });
    const [mkfifoStatus] = (await once(mkfifo, "exit")) as [number | null, NodeJS.Signals | null];
    expect(mkfifoStatus).toBe(0);

    try {
      const started = await runLifecycle(["start"], root, {}, process.cwd(), 2_000);
      const logs = await runLifecycle(["logs"], root, {}, process.cwd(), 2_000);

      expect(started.status).toBe(1);
      expect(started.stderr).toContain("Lifecycle log file must be a regular file");
      expect(logs.status).toBe(1);
      expect(logs.stdout).toBe("");
      expect(logs.stderr).toContain("Lifecycle log file must be a regular file");
      expect(await lifecycleProcessIds()).toEqual(baseline);
    } finally {
      await cleanupLifecycle(root);
      await cleanupNewLifecycleProcesses(baseline);
      await rm(root, { force: true, recursive: true });
    }
  }, 10_000);

  it("terminates the detached process when runtime metadata cannot be persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const baseline = await lifecycleProcessIds();
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(lifecycleDir, { recursive: true })
    ]);
    const envFile = join(configDir, "env");
    await writeFile(
      envFile,
      `PORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const child = spawn(process.execPath, ["bin/agent-coordination-dashboard.js", "start"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_STATE_HOME: join(root, "state")
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (!child.pid) throw new Error("Expected a process id for the lifecycle start command.");
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      await mkdir(join(lifecycleDir, `runtime.json.${child.pid}.tmp`));
      const [status] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      expect(status).toBe(1);
      expect(stderr).toContain("EEXIST");
      const deadline = Date.now() + 3_000;
      let listenerAppeared = false;
      while (!listenerAppeared && Date.now() < deadline) {
        listenerAppeared = await portIsListening(port);
        if (!listenerAppeared) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(listenerAppeared).toBe(false);
      expect(await lifecycleProcessIds()).toEqual(baseline);
    } finally {
      await cleanupNewLifecycleProcesses(baseline);
      await rm(root, { force: true, recursive: true });
    }
  }, 15_000);

  it("recovers a protected lock left by a dead lifecycle command", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lockDir = join(root, "state", "agent-coordination-dashboard", "lifecycle.lock");
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(lockDir, { recursive: true })
    ]);
    const envFile = join(configDir, "env");
    const ownerPath = join(lockDir, "owner.json");
    await writeFile(
      envFile,
      `PORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\n`,
      "utf8"
    );
    await writeFile(
      ownerPath,
      `${JSON.stringify({ pid: 999_999_999, instance_id: "0".repeat(32) })}\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);
    await chmod(ownerPath, 0o600);
    await chmod(lockDir, 0o700);

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      expect(started.stdout).toContain(`Dashboard started at http://127.0.0.1:${port}.`);
      await expect(readFile(ownerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("recovers a stale lock when its PID was reused by another process", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const lockDir = join(root, "state", "agent-coordination-dashboard", "lifecycle.lock");
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(lockDir, { recursive: true })
    ]);
    const envFile = join(configDir, "env");
    const ownerPath = join(lockDir, "owner.json");
    await writeFile(
      envFile,
      `PORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\n`,
      "utf8"
    );
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        pid: process.pid,
        instance_id: "0".repeat(32),
        process_birth_marker: "stale-process-birth"
      })}\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);
    await chmod(ownerPath, 0o600);
    await chmod(lockDir, 0o700);

    let timedOut = false;
    try {
      const child = spawn(process.execPath, ["bin/agent-coordination-dashboard.js", "start"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_STATE_HOME: join(root, "state")
        },
        stdio: "ignore"
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 3_000);
      const [status] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      clearTimeout(timeout);

      expect(timedOut).toBe(false);
      expect(status).toBe(0);
    } finally {
      await rm(lockDir, { force: true, recursive: true });
      await cleanupLifecycle(root);
      await rm(root, { force: true, recursive: true });
    }
  }, 15_000);

  it("reloads a rotated token and returns to filesystem mode when API settings are removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const authorizations: string[] = [];
    const apiServer = createHttpServer((_req, res) => {
      authorizations.push(String(_req.headers.authorization || ""));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ entries: [] }));
    });
    apiServer.listen(0, "127.0.0.1");
    await once(apiServer, "listening");
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("Expected a TCP address for the coordination API fixture.");
    }
    const apiUrl = `http://127.0.0.1:${apiAddress.port}`;
    const configDir = join(root, "config", "agent-coordination-dashboard");
    await mkdir(configDir, { recursive: true });
    const envFile = join(configDir, "env");
    const commonEnv = `PORT=${port}\nAGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}\nDASHBOARD_SETTINGS_PATH=${join(root, "settings.json")}\n`;
    const firstToken = String.raw`sentinel-token-one\n`;
    const encodedFirstToken = String.raw`sentinel-token-one\\n`;
    await writeFile(
      envFile,
      `${commonEnv}AGENT_COORD_API_URL=${apiUrl}\nAGENT_COORD_API_TOKEN="${encodedFirstToken}"\n`,
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const firstStart = await runLifecycle(["start"], root);
      expect(firstStart.status).toBe(0);
      expect(authorizations).toContain(`Bearer ${firstToken}`);

      authorizations.length = 0;
      await writeFile(
        envFile,
        `${commonEnv}AGENT_COORD_API_URL=${apiUrl}\nAGENT_COORD_API_TOKEN=sentinel-token-two\n`,
        "utf8"
      );
      const rotated = await runLifecycle(["restart"], root);
      expect(rotated.status).toBe(0);
      expect(authorizations).toContain("Bearer sentinel-token-two");
      expect(authorizations).not.toContain(`Bearer ${firstToken}`);

      authorizations.length = 0;
      await writeFile(envFile, commonEnv, "utf8");
      const filesystemRestart = await runLifecycle(["restart"], root);
      expect(filesystemRestart.status).toBe(0);
      const doctorResponse = await fetch(`http://127.0.0.1:${port}/api/doctor`);
      const doctor = await doctorResponse.json() as { apiUrl: string | null; tokenEnvVar: string | null };
      expect(doctor).toMatchObject({ apiUrl: null, tokenEnvVar: null });
      expect(authorizations).toEqual([]);

      const runtimeAndLogs = await Promise.all([
        readFile(join(root, "state", "agent-coordination-dashboard", "runtime.json"), "utf8"),
        readFile(join(root, "state", "agent-coordination-dashboard", "dashboard.log"), "utf8")
      ]);
      expect(runtimeAndLogs.join("\n")).not.toContain("sentinel-token-");
    } finally {
      await cleanupLifecycle(root);
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("never stops an unrelated listener or a process named by unowned metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const listener = createNetServer((socket) => {
      socket.on("error", () => {});
      socket.end("still-running");
    });
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP address for the unrelated listener.");
    }
    const configDir = join(root, "config", "agent-coordination-dashboard");
    await mkdir(configDir, { recursive: true });
    const envFile = join(configDir, "env");
    await writeFile(envFile, `PORT=${address.port}\n`, "utf8");
    await chmod(envFile, 0o600);

    try {
      const start = await runLifecycle(["start"], root);
      expect(start.status).toBe(1);
      expect(start.stderr).toContain(`Port ${address.port} is already in use`);
      expect(start.stderr).toContain("nothing was stopped");

      const response = await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: address.port });
        let received = "";
        socket.on("data", (chunk) => {
          received += String(chunk);
        });
        socket.on("end", () => resolve(received));
        socket.on("error", reject);
      });
      expect(response).toBe("still-running");

      const lifecycleDir = join(root, "state", "agent-coordination-dashboard");
      await mkdir(lifecycleDir, { recursive: true });
      const runtimePath = join(lifecycleDir, "runtime.json");
      await writeFile(runtimePath, JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        instance_id: "0".repeat(32),
        started_at: new Date().toISOString(),
        url: `http://127.0.0.1:${address.port}`,
        log_file: join(lifecycleDir, "dashboard.log")
      }), "utf8");
      const stop = await runLifecycle(["stop"], root);
      expect(stop.status).toBe(2);
      expect(stop.stderr).toContain("does not own");
      expect(await readFile(runtimePath, "utf8")).toContain(`"pid":${process.pid}`);
      expect(listener.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects owned runtime metadata that redirects signals to another process group", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const configDir = join(root, "config", "agent-coordination-dashboard");
    const envFile = join(configDir, "env");
    const runtimePath = join(root, "state", "agent-coordination-dashboard", "runtime.json");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore"
    });
    await once(unrelated, "spawn");
    if (!unrelated.pid) throw new Error("Expected an unrelated process-group id.");
    unrelated.unref();
    await mkdir(configDir, { recursive: true });
    await writeFile(envFile, `PORT=${port}\n`, "utf8");
    await chmod(envFile, 0o600);
    let originalRuntime = "";

    try {
      const started = await runLifecycle(["start"], root);
      expect(started.status).toBe(0);
      originalRuntime = await readFile(runtimePath, "utf8");
      const redirectedRuntime = JSON.parse(originalRuntime) as { pgid: number };
      redirectedRuntime.pgid = unrelated.pid;
      await writeFile(runtimePath, `${JSON.stringify(redirectedRuntime, null, 2)}\n`, "utf8");

      const status = await runLifecycle(["status"], root);
      const stopped = await runLifecycle(["stop"], root);
      const unrelatedSurvived = processGroupExists(unrelated.pid);
      const serviceSurvived = await portIsListening(port);

      await writeFile(runtimePath, originalRuntime, "utf8");
      const cleanup = await runLifecycle(["stop"], root);
      expect(cleanup.status).toBe(0);

      expect(status.status).toBe(1);
      expect(status.stderr).toContain("metadata is unreadable or invalid");
      expect(stopped.status).toBe(1);
      expect(stopped.stderr).toContain("metadata is unreadable or invalid");
      expect(unrelatedSurvived).toBe(true);
      expect(serviceSurvived).toBe(true);
    } finally {
      if (originalRuntime) {
        await mkdir(join(root, "state", "agent-coordination-dashboard"), { recursive: true });
        await writeFile(runtimePath, originalRuntime, "utf8");
      }
      await cleanupLifecycle(root);
      if (processGroupExists(unrelated.pid)) {
        try {
          process.kill(-unrelated.pid, "SIGKILL");
        } catch {
          // The unrelated test process may have exited between inspection and cleanup.
        }
      }
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  it("keeps surfacing coordination-backend failure on repeated start and status", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-lifecycle-test-"));
    const port = await unusedPort();
    const apiServer = createHttpServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    apiServer.listen(0, "127.0.0.1");
    await once(apiServer, "listening");
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("Expected a TCP address for the degraded coordination API fixture.");
    }
    const configDir = join(root, "config", "agent-coordination-dashboard");
    await mkdir(configDir, { recursive: true });
    const envFile = join(configDir, "env");
    await writeFile(
      envFile,
      [
        `PORT=${port}`,
        `AGENT_COORD_STATE_ROOT=${join(root, "coordination-state")}`,
        `DASHBOARD_SETTINGS_PATH=${join(root, "settings.json")}`,
        `AGENT_COORD_API_URL=http://127.0.0.1:${apiAddress.port}`,
        "AGENT_COORD_API_TOKEN=sentinel-degraded-token",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(envFile, 0o600);

    try {
      const firstStart = await runLifecycle(["start"], root);
      expect(firstStart.status).toBe(1);
      expect(firstStart.stdout).toContain(`Dashboard started at http://127.0.0.1:${port}.`);
      expect(firstStart.stderr).toContain("Coordination diagnostics are degraded");
      expect(firstStart.stderr).not.toContain("sentinel-degraded-token");

      const repeatedStart = await runLifecycle(["start"], root);
      expect(repeatedStart.status).toBe(1);
      expect(repeatedStart.stdout).toContain("Dashboard is already running");
      expect(repeatedStart.stderr).toContain("Coordination diagnostics are degraded");

      const status = await runLifecycle(["status"], root);
      expect(status.status).toBe(1);
      expect(status.stdout).toContain("Dashboard is running");
      expect(status.stderr).toContain("Coordination diagnostics are degraded");
    } finally {
      await cleanupLifecycle(root);
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);
});
