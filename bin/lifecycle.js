import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const LIFECYCLE_SCHEMA_VERSION = 1;
const START_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 2_000;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_IDENTITY_RECHECK_MS = 250;
const API_ENV_KEYS = ["AGENT_COORD_API_URL", "AGENT_COORD_API_TOKEN", "AGENT_COORD_TOKEN"];

class LifecycleUsageError extends Error {}

function lifecyclePaths(env = process.env) {
  const stateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  const stateDir = join(stateHome, "agent-coordination-dashboard");
  return {
    envFile: join(configHome, "agent-coordination-dashboard", "env"),
    lockDir: join(stateDir, "lifecycle.lock"),
    logFile: join(stateDir, "dashboard.log"),
    runtimeFile: join(stateDir, "runtime.json"),
    stateDir
  };
}

async function delay(milliseconds) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function removeClaimedLock(paths, entry, instanceId) {
  const claimedEntry = `reap-${instanceId}.json`;
  try {
    await rename(join(paths.lockDir, entry), join(paths.lockDir, claimedEntry));
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
  await unlink(join(paths.lockDir, claimedEntry));
  await rmdir(paths.lockDir);
  return true;
}

async function reapStaleLock(paths, instanceId, verifiedOwners) {
  let stats;
  try {
    stats = await lstat(paths.lockDir);
  } catch (error) {
    if (isFileNotFound(error)) return true;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Lifecycle lock path is not a protected directory.");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("Lifecycle lock directory is not owned by the current user.");
  }
  if ((stats.mode & 0o777) !== 0o700) {
    throw new Error("Lifecycle lock directory must use mode 0700.");
  }

  const entries = await readdir(paths.lockDir);
  if (entries.length === 0) {
    if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) return false;
    try {
      await rmdir(paths.lockDir);
      return true;
    } catch (error) {
      if (isFileNotFound(error) || (error && typeof error === "object" && error.code === "ENOTEMPTY")) {
        return false;
      }
      throw error;
    }
  }
  if (entries.length !== 1 || !/^(?:owner|reap-[a-f0-9]{32})\.json$/.test(entries[0])) {
    throw new Error("Lifecycle lock directory contains unexpected files.");
  }
  if (entries[0].startsWith("reap-")) {
    const currentStats = await lstat(paths.lockDir);
    if (Date.now() - currentStats.mtimeMs < LOCK_STALE_MS) return false;
  }

  let owner;
  try {
    owner = JSON.parse(await readFile(join(paths.lockDir, entries[0]), "utf8"));
  } catch (error) {
    if (isFileNotFound(error)) return false;
    if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) return false;
    return await removeClaimedLock(paths, entries[0], instanceId);
  }
  if (Number.isInteger(owner?.pid) && owner.pid > 1 && processExists(owner.pid)) {
    if (typeof owner.process_birth_marker !== "string" || !owner.process_birth_marker) {
      throw new Error("Lifecycle lock owner identity is incomplete; lock preserved for manual inspection.");
    }
    const ownerKey = `${owner.pid}:${owner.instance_id}:${owner.process_birth_marker}`;
    if ((verifiedOwners.get(ownerKey) || 0) > Date.now()) return false;
    const currentBirthMarker = await processBirthMarker(owner.pid);
    if (!currentBirthMarker) {
      throw new Error("Lifecycle lock owner identity could not be verified; lock preserved for manual inspection.");
    }
    if (currentBirthMarker === owner.process_birth_marker) {
      verifiedOwners.set(ownerKey, Date.now() + LOCK_IDENTITY_RECHECK_MS);
      return false;
    }
  }
  return await removeClaimedLock(paths, entries[0], instanceId);
}

async function acquireLifecycleLock(paths) {
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await chmod(paths.stateDir, 0o700);
  const instanceId = randomBytes(16).toString("hex");
  const ownerBirthMarker = await processBirthMarker(process.pid);
  if (!ownerBirthMarker) {
    throw new Error("Lifecycle process identity could not be determined; no lock was created.");
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const verifiedOwners = new Map();

  while (Date.now() < deadline) {
    let created = false;
    try {
      await mkdir(paths.lockDir, { mode: 0o700 });
      created = true;
      await chmod(paths.lockDir, 0o700);
      const ownerPath = join(paths.lockDir, "owner.json");
      const handle = await open(ownerPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          pid: process.pid,
          instance_id: instanceId,
          process_birth_marker: ownerBirthMarker
        })}\n`, "utf8");
      } finally {
        await handle.close();
      }
      await chmod(ownerPath, 0o600);
      return async () => {
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        if (owner?.pid !== process.pid || owner?.instance_id !== instanceId) {
          throw new Error("Lifecycle lock ownership changed unexpectedly.");
        }
        await unlink(ownerPath);
        await rmdir(paths.lockDir);
      };
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "EEXIST")) {
        if (created) await rmdir(paths.lockDir).catch(() => {});
        throw error;
      }
      if (await reapStaleLock(paths, instanceId, verifiedOwners)) continue;
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new Error("Another lifecycle command is still running; try again after it finishes.");
}

async function withLifecycleLock(paths, operation) {
  const release = await acquireLifecycleLock(paths);
  try {
    return await operation();
  } finally {
    await release();
  }
}

function isFileNotFound(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

async function readRuntime(runtimeFile) {
  try {
    const parsed = JSON.parse(await readFile(runtimeFile, "utf8"));
    if (
      parsed?.schema_version !== LIFECYCLE_SCHEMA_VERSION ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 1 ||
      typeof parsed.instance_id !== "string" ||
      !/^[a-f0-9]{32}$/.test(parsed.instance_id) ||
      typeof parsed.url !== "string"
    ) {
      throw new Error("invalid");
    }
    return parsed;
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw new Error("Dashboard lifecycle metadata is unreadable or invalid.");
  }
}

async function writeRuntime(paths, runtime) {
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await chmod(paths.stateDir, 0o700);
  const temporary = `${paths.runtimeFile}.${process.pid}.tmp`;
  let complete = false;
  let ownsTemporary = false;
  let renamed = false;
  try {
    const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    ownsTemporary = true;
    try {
      await handle.writeFile(`${JSON.stringify(runtime, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporary, paths.runtimeFile);
    renamed = true;
    await chmod(paths.runtimeFile, 0o600);
    complete = true;
  } finally {
    if (!complete && renamed) {
      await unlink(paths.runtimeFile).catch(() => {});
    } else if (!complete && ownsTemporary) {
      await unlink(temporary).catch(() => {});
    }
  }
}

function parseEnvLine(line, lineNumber) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) {
    throw new Error(`Environment file contains invalid syntax on line ${lineNumber}.`);
  }
  let value = match[2].trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    if (value.length < 2 || value.at(-1) !== quote) {
      throw new Error(`Environment file contains an unterminated quoted value on line ${lineNumber}.`);
    }
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  } else {
    const commentIndex = value.search(/\s+#/);
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trimEnd();
  }
  return [match[1], value];
}

async function readProtectedEnv(envFile, required) {
  let stats;
  try {
    stats = await lstat(envFile);
  } catch (error) {
    if (isFileNotFound(error) && !required) return {};
    if (isFileNotFound(error)) throw new Error("Configured environment file does not exist.");
    throw new Error("Configured environment file cannot be inspected.");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Configured environment file must be a regular file, not a symlink.");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("Configured environment file must be owned by the current user.");
  }
  if ((stats.mode & 0o777) !== 0o600) {
    throw new Error("Configured environment file must use mode 0600; run chmod 600 on it.");
  }
  const entries = {};
  const contents = await readFile(envFile, "utf8");
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const parsed = parseEnvLine(line, index + 1);
    if (parsed) entries[parsed[0]] = parsed[1];
  }
  return entries;
}

function parseCommandOptions(command, args, paths) {
  if (!new Set(["start", "restart"]).has(command)) {
    if (args.length > 0) throw new LifecycleUsageError(`${command} does not accept options.`);
    return { envFile: paths.envFile, envFileRequired: false };
  }
  let envFile = paths.envFile;
  let envFileRequired = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--config-env-file" && !envFileRequired) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new LifecycleUsageError("--config-env-file requires a path.");
      }
      envFile = isAbsolute(value) ? value : resolve(process.cwd(), value);
      envFileRequired = true;
      index += 1;
    } else {
      throw new LifecycleUsageError(`Unknown or repeated ${command} option.`);
    }
  }
  return { envFile, envFileRequired };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && error.code === "EPERM");
  }
}

async function processBirthMarker(pid) {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      if (fields.length >= 20 && /^\d+$/.test(fields[19])) return `linux:${fields[19]}`;
    } catch {
      // Fall through to the portable ps birth timestamp below.
    }
  }

  const child = spawn("ps", ["-p", String(pid), "-o", "lstart="], {
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    if (output.length < 1024) output += String(chunk);
  });
  const [status] = await once(child, "exit");
  const startedAt = output.trim();
  return status === 0 && startedAt ? `ps:${startedAt}` : null;
}

async function processCommand(pid) {
  const child = spawn("ps", ["-p", String(pid), "-o", "command="], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    if (output.length < 64 * 1024) output += String(chunk);
  });
  const [status] = await once(child, "exit");
  return status === 0 ? output.trim() : "";
}

async function runtimeOwnership(runtime, executablePath) {
  if (!processExists(runtime.pid)) return "stopped";
  const command = await processCommand(runtime.pid);
  const marker = `__lifecycle-serve --instance ${runtime.instance_id}`;
  return command.includes(executablePath) && command.includes(marker) ? "owned" : "unowned";
}

function probeHostForBindHost(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

function formatUrlHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

async function portIsListening(port, host) {
  return await new Promise((resolveListening) => {
    const socket = createConnection({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolveListening(value);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function serviceIsHealthy(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`${url}/api/health`, { redirect: "manual", signal: controller.signal });
    if (response.status !== 200) return false;
    const payload = await response.json();
    return payload?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealthy(url, pid) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return false;
    if (await serviceIsHealthy(url)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
}

async function runDeepDoctor(executablePath, url) {
  const hostname = new URL(url).hostname;
  const doctorArgs = [executablePath, "doctor", "--stack-json", "--deep", "--url", url];
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    doctorArgs.push("--local-interface-url");
  }
  const child = spawn(
    process.execPath,
    doctorArgs,
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    if (stdout.length < 512 * 1024) stdout += String(chunk);
  });
  const [status] = await once(child, "exit");
  try {
    const contract = JSON.parse(stdout);
    return { healthy: status === 0 && contract?.status === "healthy", status: contract?.status || "unknown" };
  } catch {
    return { healthy: false, status: "unknown" };
  }
}

async function reportCoordinationDiagnostics(executablePath, url, { reportHealthy = false } = {}) {
  const doctor = await runDeepDoctor(executablePath, url);
  if (doctor.healthy) {
    if (reportHealthy) process.stdout.write("Coordination diagnostics are healthy.\n");
    return true;
  }
  process.stderr.write(`Coordination diagnostics are ${doctor.status}; run doctor --stack-json --deep for details.\n`);
  process.exitCode = 1;
  return false;
}

async function stopDetachedGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isFileNotFound(error) && !(error && typeof error === "object" && error.code === "ESRCH")) throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return !processExists(pid);
}

async function terminateDetachedGroup(pid) {
  await stopDetachedGroup(pid, "SIGTERM");
  if (!(await waitForProcessExit(pid, 5_000))) {
    await stopDetachedGroup(pid, "SIGKILL");
    await waitForProcessExit(pid, 1_000);
  }
}

async function stopDashboard(context, paths, { quiet = false } = {}) {
  const runtime = await readRuntime(paths.runtimeFile);
  if (!runtime) {
    if (!quiet) process.stdout.write("Dashboard is already stopped.\n");
    return true;
  }
  const ownership = await runtimeOwnership(runtime, context.executablePath);
  if (ownership === "unowned") {
    process.stderr.write("Lifecycle metadata points to a process this package does not own; nothing was stopped.\n");
    process.exitCode = 2;
    return false;
  }
  if (ownership === "owned") {
    await terminateDetachedGroup(runtime.pid);
  }
  await unlink(paths.runtimeFile).catch((error) => {
    if (!isFileNotFound(error)) throw error;
  });
  if (!quiet) {
    process.stdout.write(ownership === "owned" ? "Dashboard stopped.\n" : "Dashboard is already stopped.\n");
  }
  return true;
}

async function startDashboard(options, context, paths) {
  const current = await readRuntime(paths.runtimeFile);
  if (current) {
    const ownership = await runtimeOwnership(current, context.executablePath);
    if (ownership === "owned") {
      process.stdout.write(`Dashboard is already running at ${current.url}.\n`);
      if (await serviceIsHealthy(current.url)) {
        await reportCoordinationDiagnostics(context.executablePath, current.url);
      } else {
        process.stderr.write(`Dashboard process is running, but its health check failed at ${current.url}.\n`);
        process.exitCode = 1;
      }
      return;
    }
    if (ownership === "unowned") {
      throw new Error("Lifecycle metadata points to a process this package does not own; nothing was started or stopped.");
    }
    await unlink(paths.runtimeFile);
  }

  const fileEnv = await readProtectedEnv(options.envFile, options.envFileRequired);
  const childEnv = { ...process.env };
  for (const key of API_ENV_KEYS) childEnv[key] = "";
  Object.assign(childEnv, fileEnv);
  childEnv.NODE_ENV = "production";
  const port = Number(childEnv.PORT || 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT in the environment file must be an integer from 1 through 65535.");
  }
  const probeHost = probeHostForBindHost(childEnv.HOST || "127.0.0.1");
  const url = `http://${formatUrlHost(probeHost)}:${port}`;
  if (await portIsListening(port, probeHost)) {
    throw new Error(`Port ${port} is already in use by a process this lifecycle does not own; nothing was stopped.`);
  }

  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await chmod(paths.stateDir, 0o700);
  const logHandle = await open(paths.logFile, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600);
  await chmod(paths.logFile, 0o600);
  const instanceId = randomBytes(16).toString("hex");
  const child = spawn(
    process.execPath,
    [context.executablePath, "__lifecycle-serve", "--instance", instanceId],
    {
      cwd: context.packageRoot,
      detached: true,
      env: childEnv,
      stdio: ["ignore", logHandle.fd, logHandle.fd]
    }
  );
  try {
    await once(child, "spawn");
  } finally {
    await logHandle.close();
  }
  if (!child.pid) throw new Error("Dashboard process did not receive a process id.");
  child.unref();
  try {
    await writeRuntime(paths, {
      schema_version: LIFECYCLE_SCHEMA_VERSION,
      pid: child.pid,
      instance_id: instanceId,
      started_at: new Date().toISOString(),
      url,
      log_file: paths.logFile
    });
  } catch (error) {
    await terminateDetachedGroup(child.pid);
    throw error;
  }

  if (!(await waitForHealthy(url, child.pid))) {
    await terminateDetachedGroup(child.pid);
    await unlink(paths.runtimeFile).catch(() => {});
    throw new Error("Dashboard failed its startup health check; inspect lifecycle logs.");
  }
  process.stdout.write(`Dashboard started at ${url}.\n`);
  await reportCoordinationDiagnostics(context.executablePath, url, { reportHealthy: true });
}

async function reportStatus(context, paths) {
  const runtime = await readRuntime(paths.runtimeFile);
  if (!runtime) {
    process.stdout.write("Dashboard is stopped.\n");
    process.exitCode = 3;
    return;
  }
  const ownership = await runtimeOwnership(runtime, context.executablePath);
  if (ownership === "stopped") {
    process.stdout.write("Dashboard is stopped (stale lifecycle metadata remains).\n");
    process.exitCode = 3;
    return;
  }
  if (ownership === "unowned") {
    process.stderr.write("Dashboard lifecycle metadata does not identify an owned process; nothing was stopped.\n");
    process.exitCode = 2;
    return;
  }
  if (await serviceIsHealthy(runtime.url)) {
    process.stdout.write(`Dashboard is running at ${runtime.url}.\n`);
    await reportCoordinationDiagnostics(context.executablePath, runtime.url);
    return;
  }
  process.stderr.write(`Dashboard process is running, but its health check failed at ${runtime.url}.\n`);
  process.exitCode = 1;
}

async function printLogs(paths) {
  let handle;
  try {
    handle = await open(paths.logFile, fsConstants.O_RDONLY);
  } catch (error) {
    if (isFileNotFound(error)) {
      process.stdout.write("No lifecycle logs are available yet.\n");
      return;
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    const maxBytes = 1024 * 1024;
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, stats.size - length);
    if (stats.size > maxBytes) process.stdout.write("[showing the last 1 MiB of lifecycle logs]\n");
    process.stdout.write(buffer.toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function openDashboard(context, paths) {
  if (!new Set(["darwin", "linux"]).has(process.platform)) {
    throw new Error("The open lifecycle command supports macOS and Linux hosts.");
  }
  const runtime = await readRuntime(paths.runtimeFile);
  if (!runtime || (await runtimeOwnership(runtime, context.executablePath)) !== "owned") {
    throw new Error("Dashboard is not running as an owned lifecycle process.");
  }
  if (!(await serviceIsHealthy(runtime.url))) {
    throw new Error("Dashboard health check failed; nothing was opened.");
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [runtime.url], { detached: true, stdio: "ignore" });
  await once(child, "spawn");
  child.unref();
  process.stdout.write(`Opened ${runtime.url}.\n`);
}

export async function runLifecycleCommand(command, args, context) {
  const paths = lifecyclePaths();
  try {
    const options = parseCommandOptions(command, args, paths);
    if (command === "start") {
      await withLifecycleLock(paths, () => startDashboard(options, context, paths));
    } else if (command === "stop") {
      await withLifecycleLock(paths, () => stopDashboard(context, paths));
    } else if (command === "restart") {
      await withLifecycleLock(paths, async () => {
        if (await stopDashboard(context, paths, { quiet: true })) {
          await startDashboard(options, context, paths);
        }
      });
    } else if (command === "logs") {
      await printLogs(paths);
    } else if (command === "open") {
      await openDashboard(context, paths);
    } else if (command === "status") {
      await reportStatus(context, paths);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : `Failed to run ${command}.`}\n`);
    process.exitCode = error instanceof LifecycleUsageError ? 64 : 1;
  }
}

export async function runLifecycleChild(args, context) {
  if (args.length !== 2 || args[0] !== "--instance" || !/^[a-f0-9]{32}$/.test(args[1])) {
    process.exitCode = 64;
    return;
  }
  const target = join(context.packageRoot, "src", "server", "index.ts");
  const child = spawn(process.execPath, [context.tsxCli, target], {
    cwd: context.packageRoot,
    detached: false,
    env: process.env,
    stdio: "inherit"
  });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stopping = true;
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    });
  }
  child.once("error", (error) => {
    process.stderr.write(`Failed to start agent-coordination-dashboard: ${error.message}\n`);
    process.exitCode = 1;
  });
  const [code, signal] = await once(child, "exit");
  process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0));
}
