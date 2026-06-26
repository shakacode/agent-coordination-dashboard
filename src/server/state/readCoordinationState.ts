import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { normalizeBatchReservations, normalizeBatchTargets } from "../../shared/batchManifest";
import { deriveHeartbeatLiveness } from "../../shared/liveness";
import type { BatchEvent, BatchRecord, ClaimRecord, CoordinationWarning, HeartbeatRecord } from "../../shared/types";

interface RawState {
  claims: ClaimRecord[];
  heartbeats: HeartbeatRecord[];
  batches: BatchRecord[];
  events: BatchEvent[];
  warnings: CoordinationWarning[];
}

const REQUIRED_STATE_DIRECTORIES = ["claims", "heartbeats", "batches"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function hasInitializedCoordinationRoot(root: string, warnings: CoordinationWarning[]): Promise<boolean> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const directoryNames = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const hasRequiredDirectory = REQUIRED_STATE_DIRECTORIES.some((directory) => directoryNames.has(directory));
    if (!hasRequiredDirectory) {
      warnings.push({
        severity: "info",
        message: `No coordination state found at ${root}. Set AGENT_COORD_STATE_ROOT to an existing state root, or initialize this root with claims/, heartbeats/, and batches/ directories.`
      });
    }
    return hasRequiredDirectory;
  } catch (error) {
    warnings.push({
      severity: "info",
      message: `No coordination state found at ${root}: ${errorMessage(
        error
      )}. Set AGENT_COORD_STATE_ROOT to an existing state root, or initialize this root with claims/, heartbeats/, and batches/ directories.`
    });
    return false;
  }
}

async function listStateFiles(
  directory: string,
  root: string,
  warnings: CoordinationWarning[],
  extensions = [".json"],
  warnMissing = true
): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          return listStateFiles(path, root, warnings, extensions, warnMissing);
        }
        return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
      })
    );
    return nested.flat().sort();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" && !warnMissing) {
      return [];
    }
    const path = relative(root, directory);
    warnings.push({
      severity: "warning",
      ...warningContextFromPath(path),
      message: `Could not read coordination directory ${path || "."}: ${errorMessage(error)}`
    });
    return [];
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function machineIdFrom(raw: Record<string, unknown>): string | undefined {
  return (
    stringValue(raw.machine_id) ||
    stringValue(raw.machine) ||
    stringValue(raw.host) ||
    stringValue(raw.hostname) ||
    undefined
  );
}

function repoFromClaimPath(path: string): string {
  const parts = path.split("/");
  return parts.length >= 4 ? `${parts[1]}/${parts[2]}` : "";
}

function targetFromPath(path: string): string {
  return basename(path, ".json");
}

function idFromPath(path: string): string {
  return basename(path).replace(/\.(json|jsonl)$/i, "");
}

function warningContextFromPath(path: string): Pick<CoordinationWarning, "repo" | "target"> {
  const parts = path.split("/");
  if (parts[0] === "claims" && parts.length >= 3) {
    return {
      repo: `${parts[1]}/${parts[2]}`,
      target: parts[3] ? basename(parts[3], ".json") : undefined
    };
  }
  return {};
}

function normalizeClaim(raw: Record<string, unknown>, path: string): ClaimRecord {
  return {
    schemaVersion: Number(raw.schema_version || 1),
    repo: stringValue(raw.repo) || repoFromClaimPath(path),
    target: raw.target ? String(raw.target) : targetFromPath(path),
    agentId: stringValue(raw.agent_id, "UNKNOWN"),
    machineId: machineIdFrom(raw),
    batchId: stringValue(raw.batch_id) || undefined,
    branch: stringValue(raw.branch) || undefined,
    status: raw.status === "released" ? "released" : raw.status === "active" ? "active" : "unknown",
    claimedAt: stringValue(raw.claimed_at) || undefined,
    updatedAt: stringValue(raw.updated_at) || undefined,
    expiresAt: stringValue(raw.expires_at) || undefined,
    path
  };
}

function normalizeHeartbeat(raw: Record<string, unknown>, path: string, now: Date): HeartbeatRecord {
  const updatedAt = stringValue(raw.updated_at);
  const expiresAt = stringValue(raw.expires_at);

  return {
    schemaVersion: Number(raw.schema_version || 1),
    agentId: stringValue(raw.agent_id, targetFromPath(path)),
    machineId: machineIdFrom(raw),
    repo: stringValue(raw.repo) || undefined,
    target: raw.target ? String(raw.target) : undefined,
    batchId: stringValue(raw.batch_id) || undefined,
    branch: stringValue(raw.branch) || undefined,
    status: stringValue(raw.status, "unknown"),
    updatedAt,
    expiresAt,
    path,
    liveness: deriveHeartbeatLiveness({ updatedAt, expiresAt }, now)
  };
}

function normalizeBatch(raw: Record<string, unknown>, path: string): BatchRecord {
  const batchId = stringValue(raw.batch_id) || targetFromPath(path);
  const lanes = Array.isArray(raw.lanes) ? raw.lanes : [];

  return {
    schemaVersion: Number(raw.schema_version || 1),
    batchId,
    repo: stringValue(raw.repo) || undefined,
    objective: stringValue(raw.objective) || undefined,
    targets: normalizeBatchTargets(raw.targets),
    reservations: normalizeBatchReservations(raw.reservations),
    createdAt: stringValue(raw.created_at) || undefined,
    createdByMachine: stringValue(raw.created_by_machine) || undefined,
    launchPrompt: stringValue(raw.launch_prompt) || undefined,
    updatedAt: stringValue(raw.updated_at) || undefined,
    path,
    lanes: lanes.map((laneRaw) => {
      const lane = laneRaw as Record<string, unknown>;
      const targets = Array.isArray(lane.targets) ? lane.targets.map(String) : lane.target ? [String(lane.target)] : [];
      const dependsOn = Array.isArray(lane.depends_on)
        ? lane.depends_on.map(String)
        : lane.depends_on
          ? [String(lane.depends_on)]
          : [];

      return {
        name: stringValue(lane.name) || stringValue(lane.id, "UNKNOWN"),
        owner: stringValue(lane.owner) || stringValue(lane.agent_id, "UNKNOWN"),
        targets,
        dependsOn,
        status: stringValue(lane.status, "unknown"),
        liveness: "no-heartbeat",
        blockedOn: []
      };
    })
  };
}

function normalizeBatchEvent(raw: Record<string, unknown>, path: string): BatchEvent {
  const timestamp = stringValue(raw.timestamp) || stringValue(raw.created_at) || stringValue(raw.updated_at) || undefined;
  const batchId = stringValue(raw.batch_id) || undefined;
  const laneName = stringValue(raw.lane_name) || stringValue(raw.lane_id) || stringValue(raw.lane) || undefined;

  return {
    eventId: stringValue(raw.event_id) || stringValue(raw.id) || `${path}:${timestamp || idFromPath(path)}`,
    type: stringValue(raw.type) || stringValue(raw.event_type) || stringValue(raw.name, "unknown"),
    batchId,
    laneName,
    machineId: machineIdFrom(raw),
    agentId: stringValue(raw.agent_id) || undefined,
    repo: stringValue(raw.repo) || undefined,
    target: raw.target ? String(raw.target) : undefined,
    status: stringValue(raw.status) || undefined,
    message: stringValue(raw.message) || undefined,
    timestamp,
    path
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

export async function readCoordinationState(root: string, now = new Date()): Promise<RawState> {
  const warnings: CoordinationWarning[] = [];
  const hasInitializedRoot = await hasInitializedCoordinationRoot(root, warnings);
  const claimFiles = await listStateFiles(join(root, "claims"), root, warnings, [".json"], hasInitializedRoot);
  const heartbeatFiles = await listStateFiles(join(root, "heartbeats"), root, warnings, [".json"], hasInitializedRoot);
  const batchFiles = await listStateFiles(join(root, "batches"), root, warnings, [".json"], hasInitializedRoot);
  const eventFiles = [
    ...(await listStateFiles(join(root, "events"), root, warnings, [".json", ".jsonl"], false)),
    ...(await listStateFiles(join(root, "history"), root, warnings, [".json", ".jsonl"], false))
  ];

  async function readMany<T>(
    files: string[],
    normalize: (raw: Record<string, unknown>, path: string) => T
  ): Promise<T[]> {
    const records: T[] = [];
    for (const file of files) {
      const path = relative(root, file);
      try {
        records.push(normalize(await readJson(file), path));
      } catch (error) {
        warnings.push({
          severity: "warning",
          ...warningContextFromPath(path),
          message: `Malformed JSON in ${path}: ${error instanceof Error ? error.message : "unknown error"}`
        });
      }
    }
    return records;
  }

  async function readEvents(files: string[]): Promise<BatchEvent[]> {
    const records: BatchEvent[] = [];
    for (const file of files) {
      const path = relative(root, file);
      try {
        const text = await readFile(file, "utf8");
        if (file.endsWith(".jsonl")) {
          const lines = text
            .split("\n")
            .map((line, index) => ({ index, line: line.trim() }))
            .filter(({ line }) => Boolean(line));

          for (const { index, line } of lines) {
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              if (event && typeof event === "object" && !Array.isArray(event)) {
                records.push(normalizeBatchEvent(event, `${path}:${index + 1}`));
              }
            } catch (error) {
              warnings.push({
                severity: "warning",
                ...warningContextFromPath(path),
                message: `Malformed JSON in ${path}:${index + 1}: ${error instanceof Error ? error.message : "unknown error"}`
              });
            }
          }
          continue;
        }

        const rawEvents = JSON.parse(text);
        const events = Array.isArray(rawEvents) ? rawEvents : [rawEvents];

        for (const [index, event] of events.entries()) {
          if (event && typeof event === "object" && !Array.isArray(event)) {
            records.push(normalizeBatchEvent(event as Record<string, unknown>, events.length > 1 ? `${path}#${index + 1}` : path));
          }
        }
      } catch (error) {
        warnings.push({
          severity: "warning",
          ...warningContextFromPath(path),
          message: `Malformed JSON in ${path}: ${error instanceof Error ? error.message : "unknown error"}`
        });
      }
    }
    return records;
  }

  return {
    claims: await readMany(claimFiles, normalizeClaim),
    heartbeats: await readMany(heartbeatFiles, (raw, path) => normalizeHeartbeat(raw, path, now)),
    batches: await readMany(batchFiles, normalizeBatch),
    events: await readEvents(eventFiles),
    warnings
  };
}
