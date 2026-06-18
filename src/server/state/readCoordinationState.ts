import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { deriveHeartbeatLiveness } from "../../shared/liveness";
import type { BatchRecord, ClaimRecord, CoordinationWarning, HeartbeatRecord } from "../../shared/types";

interface RawState {
  claims: ClaimRecord[];
  heartbeats: HeartbeatRecord[];
  batches: BatchRecord[];
  warnings: CoordinationWarning[];
}

async function listJsonFiles(directory: string, root: string, warnings: CoordinationWarning[]): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          return listJsonFiles(path, root, warnings);
        }
        return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
      })
    );
    return nested.flat().sort();
  } catch (error) {
    const path = relative(root, directory);
    warnings.push({
      severity: "warning",
      ...warningContextFromPath(path),
      message: `Could not read coordination directory ${path || "."}: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    });
    return [];
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function repoFromClaimPath(path: string): string {
  const parts = path.split("/");
  return parts.length >= 4 ? `${parts[1]}/${parts[2]}` : "";
}

function targetFromPath(path: string): string {
  return basename(path, ".json");
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

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

export async function readCoordinationState(root: string, now = new Date()): Promise<RawState> {
  const warnings: CoordinationWarning[] = [];
  const claimFiles = await listJsonFiles(join(root, "claims"), root, warnings);
  const heartbeatFiles = await listJsonFiles(join(root, "heartbeats"), root, warnings);
  const batchFiles = await listJsonFiles(join(root, "batches"), root, warnings);

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

  return {
    claims: await readMany(claimFiles, normalizeClaim),
    heartbeats: await readMany(heartbeatFiles, (raw, path) => normalizeHeartbeat(raw, path, now)),
    batches: await readMany(batchFiles, normalizeBatch),
    warnings
  };
}
