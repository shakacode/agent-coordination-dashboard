import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import {
  constants as fsConstants,
  fstatSync as fsFstatSync,
  ftruncateSync as fsFtruncateSync,
  writeSync as fsWriteSync
} from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection, createServer, isIP } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const LIFECYCLE_SCHEMA_VERSION = 1;
const START_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 2_000;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_IDENTITY_RECHECK_MS = 250;
const PROCESS_IDENTITY_ATTEMPTS = 3;
const PROCESS_IDENTITY_RETRY_MS = 25;
const MAX_HEALTH_BODY_BYTES = 64 * 1024;
const MAX_LIFECYCLE_LOG_BYTES = 8 * 1024 * 1024;
const LIFECYCLE_LOG_ROLLOVER_MARKER = "[lifecycle log reset after exceeding 8 MiB]\n";
const LIFECYCLE_LOG_FAILURE_MARKER = "[lifecycle log enforcement failed; stopping dashboard]\n";
const API_ENV_KEYS = ["AGENT_COORD_API_URL", "AGENT_COORD_API_TOKEN", "AGENT_COORD_TOKEN"];
const SUPPORTED_LIFECYCLE_PLATFORMS = new Set(["darwin", "linux"]);

class LifecycleUsageError extends Error {}

export function assertSupportedLifecyclePlatform(platform = process.platform) {
  if (!SUPPORTED_LIFECYCLE_PLATFORMS.has(platform)) {
    throw new Error("Dashboard lifecycle commands support macOS and Linux hosts.");
  }
}

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

  let entries;
  try {
    entries = await readdir(paths.lockDir);
  } catch (error) {
    if (isFileNotFound(error)) return true;
    throw error;
  }
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
  if (entries.length !== 1 || !/^(?:owner(?:-[a-f0-9]{32})?|reap-[a-f0-9]{32})\.json$/.test(entries[0])) {
    throw new Error("Lifecycle lock directory contains unexpected files.");
  }
  if (entries[0].startsWith("reap-")) {
    let currentStats;
    try {
      currentStats = await lstat(paths.lockDir);
    } catch (error) {
      if (isFileNotFound(error)) return true;
      throw error;
    }
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
      if (!processExists(owner.pid)) {
        return await removeClaimedLock(paths, entries[0], instanceId);
      }
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
  await ensureLifecycleStateDir(paths);
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
      const ownerPath = join(paths.lockDir, `owner-${instanceId}.json`);
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

function lifecycleStateDirError(error) {
  if (
    error &&
    typeof error === "object" &&
    new Set(["EEXIST", "ELOOP", "ENOTDIR"]).has(error.code)
  ) {
    return new Error("Lifecycle state path is not a protected directory.");
  }
  return error;
}

async function ensureLifecycleStateDir(paths) {
  try {
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw lifecycleStateDirError(error);
  }

  let handle;
  try {
    handle = await open(
      paths.stateDir,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK
    );
  } catch (error) {
    throw lifecycleStateDirError(error);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      throw new Error("Lifecycle state path is not a protected directory.");
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error("Lifecycle state directory is not owned by the current user.");
    }
    await handle.chmod(0o700);
    const finalStats = await handle.stat();
    if (!finalStats.isDirectory() || (finalStats.mode & 0o777) !== 0o700) {
      throw new Error("Lifecycle state directory must use mode 0700.");
    }
  } finally {
    await handle.close();
  }
}

async function validateLifecycleStateDirForRead(paths) {
  let handle;
  try {
    handle = await open(
      paths.stateDir,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK
    );
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw lifecycleStateDirError(error);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      throw new Error("Lifecycle state path is not a protected directory.");
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error("Lifecycle state directory is not owned by the current user.");
    }
    if ((stats.mode & 0o777) !== 0o700) {
      throw new Error("Lifecycle state directory must use mode 0700.");
    }
    return true;
  } finally {
    await handle.close();
  }
}

async function readRuntime(paths) {
  if (!(await validateLifecycleStateDirForRead(paths))) return null;
  let handle;
  try {
    handle = await open(
      paths.runtimeFile,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw new Error("Dashboard lifecycle metadata is unreadable or invalid.");
  }
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      (typeof process.getuid === "function" && stats.uid !== process.getuid())
    ) {
      throw new Error("invalid");
    }
    const parsed = JSON.parse(await handle.readFile("utf8"));
    if (
      parsed?.schema_version !== LIFECYCLE_SCHEMA_VERSION ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 1 ||
      typeof parsed.instance_id !== "string" ||
      !/^[a-f0-9]{32}$/.test(parsed.instance_id) ||
      typeof parsed.url !== "string" ||
      ((parsed.wrapper_entrypoint !== undefined || parsed.server_entrypoint !== undefined) &&
        (typeof parsed.wrapper_entrypoint !== "string" ||
          !isAbsolute(parsed.wrapper_entrypoint) ||
          typeof parsed.server_entrypoint !== "string" ||
          !isAbsolute(parsed.server_entrypoint))) ||
      ((parsed.bind_host !== undefined || parsed.bind_port !== undefined) &&
        (typeof parsed.bind_host !== "string" ||
          (parsed.bind_host !== "localhost" && isIP(parsed.bind_host) === 0) ||
          (isIP(parsed.bind_host) === 6 && parsed.bind_host.includes("%")) ||
          !Number.isInteger(parsed.bind_port) ||
          parsed.bind_port < 1 ||
          parsed.bind_port > 65535)) ||
      (parsed.bind_address !== undefined &&
        (typeof parsed.bind_address !== "string" || isIP(parsed.bind_address) === 0)) ||
      (parsed.bind_ipv4_coverage !== undefined &&
        (typeof parsed.bind_ipv4_coverage !== "boolean" ||
          (parsed.bind_ipv4_coverage && parsed.bind_host !== "::"))) ||
      !runtimeEndpointMetadataIsCoherent(parsed) ||
      ((parsed.pgid !== undefined || parsed.process_birth_marker !== undefined) &&
        (!Number.isInteger(parsed.pgid) ||
          parsed.pgid <= 1 ||
          parsed.pgid !== parsed.pid ||
          typeof parsed.process_birth_marker !== "string" ||
          !parsed.process_birth_marker))
    ) {
      throw new Error("invalid");
    }
    return parsed;
  } catch {
    throw new Error("Dashboard lifecycle metadata is unreadable or invalid.");
  } finally {
    await handle.close();
  }
}

async function writeRuntime(paths, runtime) {
  await ensureLifecycleStateDir(paths);
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
      const escapes = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
      let decoded = "";
      // Decode only the documented escape pairs once; unsupported pairs stay literal.
      for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        const escaped = value[index + 1];
        if (character === "\\" && Object.hasOwn(escapes, escaped)) {
          decoded += escapes[escaped];
          index += 1;
        } else {
          decoded += character;
        }
      }
      value = decoded;
    }
  } else {
    const commentIndex = value.search(/\s+#/);
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trimEnd();
  }
  if (value.includes("\0")) {
    throw new Error(`Environment file values must not contain NUL bytes (line ${lineNumber}).`);
  }
  return [match[1], value];
}

async function readProtectedEnv(envFile, required) {
  let handle;
  try {
    handle = await open(envFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isFileNotFound(error) && !required) return {};
    if (isFileNotFound(error)) throw new Error("Configured environment file does not exist.");
    if (error && typeof error === "object" && error.code === "ELOOP") {
      throw new Error("Configured environment file must be a regular file, not a symlink.");
    }
    throw new Error("Configured environment file cannot be inspected.");
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error("Configured environment file must be a regular file, not a symlink.");
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error("Configured environment file must be owned by the current user.");
    }
    if ((stats.mode & 0o777) !== 0o600) {
      throw new Error("Configured environment file must use mode 0600; run chmod 600 on it.");
    }
    const entries = {};
    const contents = await handle.readFile("utf8");
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      const parsed = parseEnvLine(line, index + 1);
      if (parsed) entries[parsed[0]] = parsed[1];
    }
    return entries;
  } finally {
    await handle.close();
  }
}

function lifecycleLogOpenError(error) {
  if (error && typeof error === "object" && error.code === "ELOOP") {
    return new Error("Lifecycle log file must be a regular file, not a symlink.");
  }
  if (
    error &&
    typeof error === "object" &&
    new Set(["EISDIR", "ENODEV", "ENXIO"]).has(error.code)
  ) {
    return new Error("Lifecycle log file must be a regular file.");
  }
  return error;
}

function validateLifecycleLogStats(stats) {
  if (!stats.isFile()) {
    throw new Error("Lifecycle log file must be a regular file.");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("Lifecycle log file must be owned by the current user.");
  }
  return stats;
}

async function validateLifecycleLogHandle(handle) {
  return validateLifecycleLogStats(await handle.stat());
}

function writeAllToLifecycleLog(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fsWriteSync(fd, buffer, offset, buffer.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error("Lifecycle log descriptor could not accept output.");
    }
    offset += written;
  }
}

function resetLifecycleLogWithTail(fd, chunk, maxBytes) {
  const marker = Buffer.from(LIFECYCLE_LOG_ROLLOVER_MARKER);
  const boundedMarker = marker.subarray(0, Math.min(marker.length, maxBytes));
  const tailCapacity = maxBytes - boundedMarker.length;
  const tail = chunk.subarray(Math.max(0, chunk.length - tailCapacity));
  // Lifecycle startup opens this shared inherited descriptor with O_APPEND.
  // Reset before writing the newest tail so the stale shared offset cannot
  // create a sparse hole and the file never exceeds the cap at write return.
  fsFtruncateSync(fd, 0);
  writeAllToLifecycleLog(fd, boundedMarker);
  writeAllToLifecycleLog(fd, tail);
}

function writeBoundedLifecycleLogChunk(fd, chunk, maxBytes) {
  const stats = validateLifecycleLogStats(fsFstatSync(fd));
  if (stats.size + chunk.length <= maxBytes) {
    writeAllToLifecycleLog(fd, chunk);
    return;
  }
  // Rollover discards the previous log and any oldest bytes from an oversized
  // chunk. Only the fixed marker and newest chunk suffix are retained.
  resetLifecycleLogWithTail(fd, chunk, maxBytes);
}

function lifecycleLogBuffer(chunk, encoding) {
  if (typeof chunk === "string") return Buffer.from(chunk, encoding);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (ArrayBuffer.isView(chunk) && chunk.BYTES_PER_ELEMENT === 1) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError("Lifecycle log writes require a string or Uint8Array chunk.");
}

function lifecycleLogWriteArguments(encodingOrCallback, callback) {
  if (
    encodingOrCallback !== undefined &&
    typeof encodingOrCallback !== "string" &&
    typeof encodingOrCallback !== "function"
  ) {
    throw new TypeError("Lifecycle log write encoding must be a string.");
  }
  const completion = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
  if (completion !== undefined && typeof completion !== "function") {
    throw new TypeError("Lifecycle log write callback must be a function.");
  }
  return {
    completion,
    encoding: typeof encodingOrCallback === "string" ? encodingOrCallback : undefined
  };
}

function stopAfterLifecycleLogFailure(fd, maxBytes) {
  try {
    const marker = Buffer.from(LIFECYCLE_LOG_FAILURE_MARKER);
    fsFtruncateSync(fd, 0);
    writeAllToLifecycleLog(fd, marker.subarray(0, maxBytes));
  } catch {
    // The verified descriptor itself failed, so there is no safe fallback path.
  }
  process.kill(process.pid, "SIGTERM");
}

export function installLifecycleLogWriter(
  stdout = process.stdout,
  stderr = process.stderr,
  maxBytes = MAX_LIFECYCLE_LOG_BYTES
) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Lifecycle log cap must be a positive integer.");
  }
  const stdoutStats = validateLifecycleLogStats(fsFstatSync(stdout.fd));
  const stderrStats = validateLifecycleLogStats(fsFstatSync(stderr.fd));
  if (stdoutStats.dev !== stderrStats.dev || stdoutStats.ino !== stderrStats.ino) {
    throw new Error("Lifecycle stdout and stderr must reference the same regular log file.");
  }
  if (stdoutStats.size > maxBytes) resetLifecycleLogWithTail(stdout.fd, Buffer.alloc(0), maxBytes);

  const originalStdoutWrite = stdout.write;
  const originalStderrWrite = stderr.write;
  const boundedWrite = (stream) => function write(chunk, encodingOrCallback, callback) {
    const { completion, encoding } = lifecycleLogWriteArguments(encodingOrCallback, callback);
    const buffer = lifecycleLogBuffer(chunk, encoding);
    try {
      writeBoundedLifecycleLogChunk(stream.fd, buffer, maxBytes);
    } catch (error) {
      if (completion) process.nextTick(() => completion(error));
      stopAfterLifecycleLogFailure(stream.fd, maxBytes);
      return false;
    }
    if (completion) process.nextTick(() => completion());
    return true;
  };
  const stdoutWrite = boundedWrite(stdout);
  const stderrWrite = boundedWrite(stderr);
  stdout.write = stdoutWrite;
  stderr.write = stderrWrite;

  return () => {
    if (stdout.write === stdoutWrite) stdout.write = originalStdoutWrite;
    if (stderr.write === stderrWrite) stderr.write = originalStderrWrite;
  };
}

async function openLifecycleLogForAppend(paths) {
  await ensureLifecycleStateDir(paths);
  let handle;
  try {
    handle = await open(
      paths.logFile,
      fsConstants.O_CREAT |
        fsConstants.O_APPEND |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK,
      0o600
    );
  } catch (error) {
    throw lifecycleLogOpenError(error);
  }
  try {
    const stats = await validateLifecycleLogHandle(handle);
    await handle.chmod(0o600);
    if (stats.size > MAX_LIFECYCLE_LOG_BYTES) {
      await handle.truncate(0);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openLifecycleLogForRead(paths) {
  if (!(await validateLifecycleStateDirForRead(paths))) return null;
  let handle;
  try {
    handle = await open(
      paths.logFile,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw lifecycleLogOpenError(error);
  }
  try {
    await validateLifecycleLogHandle(handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
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

async function processBirthMarkerOnce(pid) {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      if (fields.length >= 20 && /^\d+$/.test(fields[19])) return `linux:${fields[19]}`;
    } catch {
      // Fall through to the portable ps birth timestamp below.
    }
  }

  try {
    const child = spawn("ps", ["-ww", "-p", String(pid), "-o", "lstart="], {
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
  } catch {
    return null;
  }
}

async function processBirthMarker(pid) {
  for (let attempt = 1; attempt <= PROCESS_IDENTITY_ATTEMPTS; attempt += 1) {
    const marker = await processBirthMarkerOnce(pid);
    if (marker) return marker;
    if (attempt < PROCESS_IDENTITY_ATTEMPTS) await delay(PROCESS_IDENTITY_RETRY_MS);
  }
  return null;
}

async function processIsZombie(pid) {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      if (fields[0]) return fields[0] === "Z";
    } catch {
      // Fall through to the portable ps state below.
    }
  }

  try {
    const child = spawn("ps", ["-ww", "-p", String(pid), "-o", "stat="], {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      if (output.length < 1024) output += String(chunk);
    });
    const [status] = await once(child, "exit");
    return status === 0 && /^Z/.test(output.trim());
  } catch {
    return false;
  }
}

async function processCommand(pid) {
  const child = spawn("ps", ["-ww", "-p", String(pid), "-o", "command="], {
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    if (output.length < 64 * 1024) output += String(chunk);
  });
  const [status] = await once(child, "exit");
  return status === 0 ? output.trim() : "";
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && error.code === "EPERM");
  }
}

async function processGroupCommands(pgid) {
  try {
    const child = spawn("ps", ["-ww", "-axo", "pgid=,command="], {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"]
    });
    const commands = [];
    let pending = "";
    const collectLine = (line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (match && Number(match[1]) === pgid) commands.push(match[2]);
    };
    child.stdout.on("data", (chunk) => {
      pending += String(chunk);
      let newlineIndex;
      while ((newlineIndex = pending.indexOf("\n")) >= 0) {
        collectLine(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
      }
    });
    const [status] = await once(child, "close");
    if (status !== 0) return null;
    if (pending) collectLine(pending);
    return commands;
  } catch {
    return null;
  }
}

async function runtimeOwnership(runtime, context) {
  if (processExists(runtime.pid)) {
    if (runtime.process_birth_marker) {
      const currentBirthMarker = await processBirthMarker(runtime.pid);
      if (!currentBirthMarker || currentBirthMarker !== runtime.process_birth_marker) return "unowned";
    }
    if (!(await processIsZombie(runtime.pid))) {
      const command = await processCommand(runtime.pid);
      const marker = `__lifecycle-serve --instance ${runtime.instance_id}`;
      const wrapperEntrypoint = runtime.wrapper_entrypoint || context.executablePath;
      return command.includes(wrapperEntrypoint) && command.includes(marker) ? "owned" : "unowned";
    }
  }

  const pgid = runtime.pgid;
  if (!Number.isInteger(pgid) || !runtime.process_birth_marker) return "stopped";
  if (!processGroupExists(pgid)) return "stopped";
  const commands = await processGroupCommands(pgid);
  if (!commands) return "unowned";
  const serverEntrypoint = runtime.server_entrypoint ||
    join(context.packageRoot, "src", "server", "index.ts");
  const instanceMarker = `--lifecycle-instance ${runtime.instance_id}`;
  return commands.some((command) => command.includes(serverEntrypoint) && command.includes(instanceMarker))
    ? "orphaned_owned"
    : "unowned";
}

function probeHostForBindHost(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

export function probeHostsForBindHost(
  host,
  bindAddress = probeHostForBindHost(host),
  ipv6WildcardCoversIpv4 = false,
  interfaces = networkInterfaces()
) {
  const probeHosts = new Set([host === "localhost" ? bindAddress : probeHostForBindHost(host)]);
  if (host !== "0.0.0.0" && host !== "::") return [...probeHosts];

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      const isIpv4 = address.family === "IPv4" || address.family === 4;
      const isIpv6 = address.family === "IPv6" || address.family === 6;
      if (host === "0.0.0.0" ? isIpv4 : isIpv6 || (ipv6WildcardCoversIpv4 && isIpv4)) {
        probeHosts.add(address.address);
      }
    }
  }
  return [...probeHosts];
}

function normalizeAddress(host) {
  const value = host.toLowerCase();
  if (isIP(value) !== 6) return value;
  return new URL(`http://[${value}]`).hostname.slice(1, -1);
}

function isIpv6LinkLocal(address) {
  if (isIP(address) !== 6) return false;
  const firstHextet = Number.parseInt(normalizeAddress(address).split(":")[0], 16);
  return (firstHextet & 0xffc0) === 0xfe80;
}

function isLocalBindAddress(address) {
  if (address === "0.0.0.0" || address === "::") return true;
  if (isIP(address) === 4 && address.startsWith("127.")) return true;
  if (isIP(address) === 6 && normalizeAddress(address) === "::1") return true;
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses || [])
    .some((candidate) => {
      try {
        return normalizeAddress(candidate.address) === normalizeAddress(address);
      } catch {
        return false;
      }
    });
}

export function bindHostCoversProbeHost(bindHost, probeHost, ipv6WildcardCoversIpv4 = false) {
  const probeFamily = isIP(probeHost);
  if (bindHost === "0.0.0.0") return probeFamily === 4;
  if (bindHost === "::") return probeFamily === 6 || (probeFamily === 4 && ipv6WildcardCoversIpv4);
  return normalizeAddress(bindHost) === normalizeAddress(probeHost);
}

async function ipv6WildcardCoversIpv4() {
  const server = createServer();
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
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    }
  }
}

function runtimeEndpointMetadataIsCoherent(runtime) {
  if (runtime.bind_host === undefined && runtime.bind_port === undefined && runtime.bind_address === undefined) {
    return true;
  }
  if (runtime.bind_host === undefined || runtime.bind_port === undefined) return false;

  let runtimeUrl;
  try {
    runtimeUrl = new URL(runtime.url);
  } catch {
    return false;
  }
  if (
    runtimeUrl.protocol !== "http:" ||
    runtimeUrl.username ||
    runtimeUrl.password ||
    runtimeUrl.search ||
    runtimeUrl.hash ||
    runtimeUrl.pathname !== "/" ||
    runtimeUrl.origin !== runtime.url ||
    Number(runtimeUrl.port || 80) !== runtime.bind_port
  ) {
    return false;
  }

  const advertisedHost = runtimeUrl.hostname.startsWith("[")
    ? runtimeUrl.hostname.slice(1, -1)
    : runtimeUrl.hostname;
  if (normalizeAddress(advertisedHost) !== normalizeAddress(probeHostForBindHost(runtime.bind_host))) {
    return false;
  }
  if (runtime.bind_address === undefined) return true;
  if (runtime.bind_host === "localhost") {
    return (isIP(runtime.bind_address) === 4 && runtime.bind_address.startsWith("127.")) ||
      (isIP(runtime.bind_address) === 6 && normalizeAddress(runtime.bind_address) === "::1");
  }
  return normalizeAddress(runtime.bind_address) === normalizeAddress(runtime.bind_host);
}

function runtimeBindEndpoint(runtime) {
  if (runtime.bind_host !== undefined && runtime.bind_port !== undefined) {
    return {
      address: runtime.bind_address || runtime.bind_host,
      ipv6WildcardCoversIpv4: runtime.bind_ipv4_coverage === true,
      host: runtime.bind_host,
      port: runtime.bind_port
    };
  }
  const runtimeUrl = new URL(runtime.url);
  const hostname = runtimeUrl.hostname;
  return {
    address: hostname.startsWith("[") ? hostname.slice(1, -1) : hostname,
    ipv6WildcardCoversIpv4: false,
    host: hostname.startsWith("[") ? hostname.slice(1, -1) : hostname,
    port: Number(runtimeUrl.port || 80)
  };
}

function validateLifecycleHost(value) {
  const host = String(value || "127.0.0.1").trim();
  const addressFamily = isIP(host);
  if (addressFamily === 6 && host.includes("%")) {
    throw new Error("IPv6 zone identifiers are not supported in HOST.");
  }
  if (addressFamily === 6 && isIpv6LinkLocal(host)) {
    throw new Error("IPv6 link-local HOST addresses require scope identifiers and are not supported.");
  }
  if (host !== "localhost" && addressFamily === 0) {
    throw new Error("HOST must be localhost or an IPv4 or IPv6 address (including wildcard addresses).");
  }
  return addressFamily > 0 ? normalizeAddress(host) : host;
}

function isSpecificAllowedHost(value) {
  const host = value.trim().toLowerCase();
  const addressFamily = isIP(host);
  if (addressFamily > 0) {
    return !new Set(["0.0.0.0", "::"]).has(normalizeAddress(host)) && !host.includes("%");
  }
  if (!host || host === "*" || host.length > 253 || /^[0-9.]+$/.test(host)) return false;
  const hostname = host.endsWith(".") ? host.slice(0, -1) : host;
  return hostname.split(".").every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  );
}

function canonicalizeAllowedHost(value) {
  const host = value.trim();
  return isIP(host) > 0 && !host.includes("%") ? normalizeAddress(host) : host;
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
  const targetUrl = new URL("/api/health", url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(targetUrl.hostname)) {
    const localAddress = targetUrl.hostname.includes(":") ? "::1" : "127.0.0.1";
    const loopbackHost = localAddress.includes(":") ? `[${localAddress}]` : localAddress;
    return await new Promise((resolveHealthy) => {
      let settled = false;
      let timeout;
      const finish = (healthy) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolveHealthy(healthy);
      };
      const request = httpRequest(targetUrl, {
        headers: {
          accept: "application/json",
          host: `${loopbackHost}:${targetUrl.port || "80"}`
        },
        localAddress,
        method: "GET"
      }, (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          finish(false);
          return;
        }
        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > MAX_HEALTH_BODY_BYTES) {
          response.destroy();
          finish(false);
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_HEALTH_BODY_BYTES) {
            response.destroy();
            finish(false);
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (settled) return;
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString("utf8"))?.ok === true);
          } catch {
            finish(false);
          }
        });
        response.once("error", () => finish(false));
      });
      timeout = setTimeout(() => {
        request.destroy();
        finish(false);
      }, 500);
      request.once("error", () => finish(false));
      request.end();
    });
  }

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

async function waitForHealthy(url, pgid) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processGroupExists(pgid)) return false;
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
  const doctorEnv = { ...process.env };
  delete doctorEnv.NODE_OPTIONS;
  const child = spawn(
    process.execPath,
    doctorArgs,
    { env: doctorEnv, stdio: ["ignore", "pipe", "pipe"] }
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

async function stopDetachedGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ESRCH")) throw error;
  }
}

async function waitForProcessGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pgid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return !processGroupExists(pgid);
}

async function terminateDetachedGroup(pgid) {
  await stopDetachedGroup(pgid, "SIGTERM");
  if (!(await waitForProcessGroupExit(pgid, 5_000))) {
    await stopDetachedGroup(pgid, "SIGKILL");
    if (!(await waitForProcessGroupExit(pgid, 1_000))) {
      throw new Error(`Dashboard process group ${pgid} did not exit; lifecycle metadata was preserved.`);
    }
  }
}

async function stopDashboard(context, paths, { quiet = false } = {}) {
  const runtime = await readRuntime(paths);
  if (!runtime) {
    if (!quiet) process.stdout.write("Dashboard is already stopped.\n");
    return true;
  }
  const ownership = await runtimeOwnership(runtime, context);
  if (ownership === "unowned") {
    process.stderr.write("Lifecycle metadata points to a process this package does not own; nothing was stopped.\n");
    process.exitCode = 2;
    return false;
  }
  if (ownership === "owned" || ownership === "orphaned_owned") {
    await terminateDetachedGroup(runtime.pgid || runtime.pid);
  }
  await unlink(paths.runtimeFile).catch((error) => {
    if (!isFileNotFound(error)) throw error;
  });
  if (!quiet) {
    process.stdout.write(
      ownership === "owned" || ownership === "orphaned_owned"
        ? "Dashboard stopped.\n"
        : "Dashboard is already stopped.\n"
    );
  }
  return true;
}

async function prepareStart(options) {
  const fileEnv = await readProtectedEnv(options.envFile, options.envFileRequired);
  if (Object.hasOwn(fileEnv, "NODE_OPTIONS")) {
    throw new Error("NODE_OPTIONS is not supported in the protected environment file.");
  }
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  for (const key of API_ENV_KEYS) childEnv[key] = "";
  Object.assign(childEnv, fileEnv);
  childEnv.NODE_ENV = "production";
  const port = Number(childEnv.PORT || 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT in the environment file must be an integer from 1 through 65535.");
  }
  const refreshValue = childEnv.DASHBOARD_REFRESH_MS?.trim();
  if (refreshValue) {
    const refreshIntervalMs = Number(refreshValue);
    if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs < 0) {
      throw new Error("DASHBOARD_REFRESH_MS must be a non-negative number.");
    }
  }
  const bindHost = validateLifecycleHost(childEnv.HOST);
  const allowedHosts = String(childEnv.ALLOWED_HOSTS || "").split(",");
  if (
    new Set(["0.0.0.0", "::"]).has(bindHost) &&
    !allowedHosts.every(isSpecificAllowedHost)
  ) {
    throw new Error(
      "ALLOWED_HOSTS must contain only specific hostnames or IP addresses when HOST binds all interfaces."
    );
  }
  const bindAddress = bindHost === "localhost" ? (await lookup(bindHost)).address : bindHost;
  if (!isLocalBindAddress(bindAddress)) {
    throw new Error("HOST must be a loopback address or an IP address assigned to this machine.");
  }
  childEnv.HOST = bindAddress;
  const probeHost = probeHostForBindHost(bindHost);
  const bindIpv4Coverage = bindHost === "::" && await ipv6WildcardCoversIpv4();
  if (childEnv.ALLOWED_HOSTS !== undefined) {
    childEnv.ALLOWED_HOSTS = [...new Set([
      ...allowedHosts.map(canonicalizeAllowedHost).filter(Boolean),
      canonicalizeAllowedHost(probeHost)
    ])].join(",");
  }
  return {
    bindAddress,
    bindIpv4Coverage,
    bindHost,
    childEnv,
    port,
    probeHost,
    url: new URL(`http://${formatUrlHost(probeHost)}:${port}`).origin
  };
}

async function preflightRestartEndpoint(preparedStart, context, paths) {
  const current = await readRuntime(paths);
  let currentEndpoint = null;
  if (current) {
    const ownership = await runtimeOwnership(current, context);
    if (ownership === "owned" || ownership === "orphaned_owned") {
      currentEndpoint = runtimeBindEndpoint(current);
    }
  }
  if (
    currentEndpoint?.port === preparedStart.port &&
    normalizeAddress(currentEndpoint.host) === normalizeAddress(preparedStart.bindHost) &&
    normalizeAddress(currentEndpoint.address) === normalizeAddress(preparedStart.bindAddress)
  ) {
    return;
  }
  for (const host of probeHostsForBindHost(
    preparedStart.bindHost,
    preparedStart.bindAddress,
    preparedStart.bindIpv4Coverage
  )) {
    if (await portIsListening(preparedStart.port, host)) {
      if (
        currentEndpoint?.port === preparedStart.port &&
        bindHostCoversProbeHost(
          currentEndpoint.address,
          host,
          currentEndpoint.ipv6WildcardCoversIpv4
        )
      ) {
        continue;
      }
      throw new Error(
        `Port ${preparedStart.port} is already in use by a process this lifecycle does not own; nothing was stopped.`
      );
    }
  }
}

async function startDashboard(options, context, paths, preparedStart = null, preparedLogHandle = null) {
  const current = await readRuntime(paths);
  if (current) {
    const ownership = await runtimeOwnership(current, context);
    if (ownership === "owned" || ownership === "orphaned_owned") {
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

  const { bindAddress, bindHost, bindIpv4Coverage, childEnv, port, url } = preparedStart || await prepareStart(options);
  for (const host of probeHostsForBindHost(bindHost, bindAddress, bindIpv4Coverage)) {
    if (await portIsListening(port, host)) {
      throw new Error(`Port ${port} is already in use by a process this lifecycle does not own; nothing was stopped.`);
    }
  }

  const logHandle = preparedLogHandle || await openLifecycleLogForAppend(paths);
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
    if (!preparedLogHandle) await logHandle.close();
  }
  if (!child.pid) throw new Error("Dashboard process did not receive a process id.");
  const childBirthMarker = await processBirthMarker(child.pid);
  if (!childBirthMarker) {
    child.unref();
    await terminateDetachedGroup(child.pid);
    throw new Error("Dashboard process identity could not be determined; nothing was started.");
  }
  child.unref();
  try {
    await writeRuntime(paths, {
      schema_version: LIFECYCLE_SCHEMA_VERSION,
      bind_address: bindAddress,
      bind_host: bindHost,
      bind_ipv4_coverage: bindIpv4Coverage,
      bind_port: port,
      pid: child.pid,
      pgid: child.pid,
      instance_id: instanceId,
      process_birth_marker: childBirthMarker,
      server_entrypoint: join(context.packageRoot, "src", "server", "index.ts"),
      started_at: new Date().toISOString(),
      url,
      log_file: paths.logFile,
      wrapper_entrypoint: context.executablePath
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
  const runtime = await readRuntime(paths);
  if (!runtime) {
    process.stdout.write("Dashboard is stopped.\n");
    process.exitCode = 3;
    return;
  }
  const ownership = await runtimeOwnership(runtime, context);
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
  const handle = await openLifecycleLogForRead(paths);
  if (!handle) {
    process.stdout.write("No lifecycle logs are available yet.\n");
    return;
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
  const runtime = await readRuntime(paths);
  const ownership = runtime ? await runtimeOwnership(runtime, context) : "stopped";
  if (!new Set(["owned", "orphaned_owned"]).has(ownership)) {
    throw new Error("Dashboard is not running as an owned lifecycle process.");
  }
  if (!(await serviceIsHealthy(runtime.url))) {
    throw new Error("Dashboard health check failed; nothing was opened.");
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [runtime.url], { detached: true, stdio: "ignore" });
  const [status] = await once(child, "exit");
  if (status !== 0) {
    throw new Error("Dashboard URL opener could not open the dashboard URL.");
  }
  process.stdout.write(`Opened ${runtime.url}.\n`);
}

export async function runLifecycleCommand(command, args, context) {
  try {
    assertSupportedLifecyclePlatform();
    const paths = lifecyclePaths();
    const options = parseCommandOptions(command, args, paths);
    if (command === "start") {
      await withLifecycleLock(paths, () => startDashboard(options, context, paths));
    } else if (command === "stop") {
      await withLifecycleLock(paths, () => stopDashboard(context, paths));
    } else if (command === "restart") {
      await withLifecycleLock(paths, async () => {
        const preparedStart = await prepareStart(options);
        await preflightRestartEndpoint(preparedStart, context, paths);
        const logHandle = await openLifecycleLogForAppend(paths);
        try {
          if (await stopDashboard(context, paths, { quiet: true })) {
            await startDashboard(options, context, paths, preparedStart, logHandle);
          }
        } finally {
          await logHandle.close();
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
  const child = spawn(
    process.execPath,
    [context.tsxCli, target, "--lifecycle-instance", args[1]],
    {
    cwd: context.packageRoot,
    detached: false,
    env: process.env,
    stdio: "inherit"
    }
  );
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
