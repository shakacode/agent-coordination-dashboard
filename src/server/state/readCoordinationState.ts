import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { normalizeBatchReservations, normalizeBatchTargets } from "../../shared/batchManifest";
import { deriveHeartbeatLiveness } from "../../shared/liveness";
import { displayAttribution } from "../../shared/attribution";
import type {
  BatchEvent,
  BatchRecord,
  ClaimRecord,
  CoordinationSourceStatus,
  CoordinationWarning,
  HeartbeatRecord
} from "../../shared/types";

interface RawState {
  claims: ClaimRecord[];
  heartbeats: HeartbeatRecord[];
  batches: BatchRecord[];
  events: BatchEvent[];
  warnings: CoordinationWarning[];
  sourceStatus: CoordinationSourceStatus[];
}

interface CoordinationApiOptions {
  apiUrl?: string;
  token?: string;
}

type ApiPrefix = "claims" | "heartbeats" | "batches" | "events";

interface ApiStateEntry {
  path: string;
  data: Record<string, unknown>;
}

interface ApiReadResult {
  entries: ApiStateEntry[];
  sourceStatus: CoordinationSourceStatus;
}

interface StateFileList {
  files: string[];
  unavailable: boolean;
}

interface StateReadResult<T> {
  records: T[];
  unavailable: boolean;
}

function filesystemSourceState(source: StateFileList, read: StateReadResult<unknown>): CoordinationSourceStatus["status"] {
  if (source.unavailable || read.unavailable) {
    return "unreachable";
  }
  return source.files.length === 0 ? "empty" : "ok";
}

const REQUIRED_STATE_DIRECTORIES = ["claims", "heartbeats", "batches"];
const API_STATE_PREFIXES: ApiPrefix[] = ["claims", "heartbeats", "batches", "events"];
const API_FETCH_TIMEOUT_MS = 5000;
const LOOPBACK_API_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const COORDINATION_ROOT_REMEDIATION = [
  "Set AGENT_COORD_STATE_ROOT to an existing coordination workspace,",
  "or initialize this workspace with claims/, heartbeats/, and batches/ directories."
].join(" ");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyState(warnings: CoordinationWarning[], sourceStatus: CoordinationSourceStatus[]): RawState {
  return {
    claims: [],
    heartbeats: [],
    batches: [],
    events: [],
    warnings,
    sourceStatus
  };
}

function parseApiBaseUrl(apiUrl: string): URL {
  const url = new URL(apiUrl);
  if (!["http:", "https:"].includes(url.protocol) || !url.host) {
    throw new Error("expected http(s) URL with host");
  }
  if (url.protocol === "http:" && !LOOPBACK_API_HOSTS.has(url.hostname)) {
    throw new Error("HTTP coordination API URLs must use https unless they point at localhost");
  }
  return url;
}

function apiStateListUrl(baseUrl: URL, prefix: ApiPrefix): URL {
  const url = new URL(`${baseUrl.toString().replace(/\/+$/, "")}/v1/state`);
  url.searchParams.set("prefix", prefix);
  return url;
}

function apiWarning(message: string): CoordinationWarning {
  return {
    severity: "warning",
    message
  };
}

async function responseErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (isRecord(body) && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Use the status text below.
  }
  return response.statusText || `HTTP ${response.status}`;
}

function apiSourceStatus(
  resource: ApiPrefix,
  status: CoordinationSourceStatus["status"],
  checkedAt: string,
  httpStatus?: number
): CoordinationSourceStatus {
  return { resource, mode: "api", status, ...(httpStatus === undefined ? {} : { httpStatus }), checkedAt };
}

async function fetchApiEntries(
  baseUrl: URL,
  token: string,
  prefix: ApiPrefix,
  warnings: CoordinationWarning[],
  checkedAt: string
): Promise<ApiReadResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(apiStateListUrl(baseUrl, prefix), {
      headers: {
        authorization: `Bearer ${token}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      warnings.push(apiWarning(`Could not read coordination API ${prefix}: ${response.status} ${await responseErrorMessage(response)}`));
      return {
        entries: [],
        sourceStatus: apiSourceStatus(prefix, response.status === 401 || response.status === 403 ? "auth_error" : "unreachable", checkedAt, response.status)
      };
    }

    const body = (await response.json()) as unknown;
    if (!isRecord(body) || !Array.isArray(body.entries)) {
      warnings.push(apiWarning(`Could not read coordination API ${prefix}: malformed response`));
      return { entries: [], sourceStatus: apiSourceStatus(prefix, "unreachable", checkedAt) };
    }

    const entries: ApiStateEntry[] = [];
    let rejectedEntry = false;
    body.entries.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.path !== "string" || !isRecord(entry.data)) {
        rejectedEntry = true;
        warnings.push(apiWarning(`Malformed coordination API ${prefix} entry at index ${index}`));
        return;
      }
      entries.push({
        path: entry.path,
        data: entry.data
      });
    });
    return {
      entries,
      sourceStatus: rejectedEntry
        ? apiSourceStatus(prefix, "unreachable", checkedAt)
        : apiSourceStatus(prefix, entries.length === 0 ? "empty" : "ok", checkedAt, response.status)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readApiEntries(
  baseUrl: URL,
  token: string,
  prefix: ApiPrefix,
  warnings: CoordinationWarning[],
  checkedAt: string
): Promise<ApiReadResult> {
  try {
    return await fetchApiEntries(baseUrl, token, prefix, warnings, checkedAt);
  } catch (error) {
    const reason = isAbortError(error) ? `timed out after ${API_FETCH_TIMEOUT_MS}ms` : errorMessage(error);
    warnings.push(apiWarning(`Could not read coordination API ${prefix}: ${reason}`));
    return { entries: [], sourceStatus: apiSourceStatus(prefix, "unreachable", checkedAt) };
  }
}

function apiEntryWarningContext(entry: ApiStateEntry): Pick<CoordinationWarning, "repo" | "target"> {
  const pathContext = warningContextFromPath(entry.path);
  const repo = pathContext.repo || (typeof entry.data.repo === "string" ? entry.data.repo : "");
  const rawTarget = entry.data.target;
  const target =
    pathContext.target ||
    (typeof rawTarget === "string" || typeof rawTarget === "number" ? String(rawTarget) : "");
  return {
    ...(repo ? { repo } : {}),
    ...(target ? { target } : {})
  };
}

function normalizeApiEntries<T>(
  prefix: ApiPrefix,
  entries: ApiStateEntry[],
  warnings: CoordinationWarning[],
  normalize: (raw: Record<string, unknown>, path: string) => T
): StateReadResult<T> {
  const records: T[] = [];
  let unavailable = false;
  for (const entry of entries) {
    try {
      records.push(normalize(entry.data, entry.path));
    } catch (error) {
      unavailable = true;
      warnings.push({
        severity: "warning",
        ...apiEntryWarningContext(entry),
        message: `Malformed coordination API ${prefix} record ${entry.path}: ${errorMessage(error)}`
      });
    }
  }
  return { records, unavailable };
}

async function readApiCoordinationState(options: Required<CoordinationApiOptions>, now: Date): Promise<RawState> {
  const warnings: CoordinationWarning[] = [];
  const checkedAt = now.toISOString();
  let baseUrl: URL;
  try {
    baseUrl = parseApiBaseUrl(options.apiUrl);
  } catch (error) {
    warnings.push(apiWarning(`Invalid AGENT_COORD_API_URL: ${errorMessage(error)}`));
    return emptyState(warnings, API_STATE_PREFIXES.map((prefix) => apiSourceStatus(prefix, "unreachable", checkedAt)));
  }

  const token = options.token.trim();
  if (!token) {
    warnings.push(apiWarning("AGENT_COORD_API_TOKEN is required when AGENT_COORD_API_URL is set."));
    return emptyState(warnings, API_STATE_PREFIXES.map((prefix) => apiSourceStatus(prefix, "auth_error", checkedAt)));
  }

  const results = Object.fromEntries(
    await Promise.all(API_STATE_PREFIXES.map(async (prefix) => [prefix, await readApiEntries(baseUrl, token, prefix, warnings, checkedAt)]))
  ) as Record<ApiPrefix, ApiReadResult>;
  const claims = normalizeApiEntries("claims", results.claims.entries, warnings, normalizeClaim);
  const heartbeats = normalizeApiEntries("heartbeats", results.heartbeats.entries, warnings, (raw, path) =>
    normalizeHeartbeat(raw, path, now)
  );
  const batches = normalizeApiEntries("batches", results.batches.entries, warnings, normalizeBatch);
  const events = normalizeApiEntries("events", results.events.entries, warnings, normalizeBatchEvent);
  const normalizedByPrefix = { claims, heartbeats, batches, events };

  return {
    claims: claims.records,
    heartbeats: heartbeats.records,
    batches: batches.records,
    events: events.records,
    warnings,
    sourceStatus: API_STATE_PREFIXES.map((prefix) => {
      if (!normalizedByPrefix[prefix].unavailable) {
        return results[prefix].sourceStatus;
      }
      const { httpStatus: _successfulHttpStatus, ...sourceStatus } = results[prefix].sourceStatus;
      return { ...sourceStatus, status: "unreachable" };
    })
  };
}

async function hasInitializedCoordinationRoot(root: string, warnings: CoordinationWarning[]): Promise<boolean> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const directoryNames = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const hasRequiredDirectory = REQUIRED_STATE_DIRECTORIES.some((directory) => directoryNames.has(directory));
    if (!hasRequiredDirectory) {
      warnings.push({
        severity: "info",
        message: `No coordination state found at ${root}. ${COORDINATION_ROOT_REMEDIATION}`
      });
    }
    return hasRequiredDirectory;
  } catch (error) {
    warnings.push({
      severity: "info",
      message: `No coordination state found at ${root}: ${errorMessage(
        error
      )}. ${COORDINATION_ROOT_REMEDIATION}`
    });
    return false;
  }
}

async function listStateFiles(
  directory: string,
  root: string,
  warnings: CoordinationWarning[],
  extensions = [".json"]
): Promise<StateFileList> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          return listStateFiles(path, root, warnings, extensions);
        }
        return {
          files: entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [],
          unavailable: false
        };
      })
    );
    return {
      files: nested.flatMap((result) => result.files).sort(),
      unavailable: nested.some((result) => result.unavailable)
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return { files: [], unavailable: false };
    }
    const path = relative(root, directory);
    warnings.push({
      severity: "warning",
      ...warningContextFromPath(path),
      message: `Could not read coordination directory ${path || "."}: ${errorMessage(error)}`
    });
    return { files: [], unavailable: true };
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function finiteNonNegativeDecimalInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) return undefined;
  const result = Number(trimmed);
  return Number.isFinite(result) && Number.isInteger(result) && result >= 0 ? result : undefined;
}

function machineIdFrom(raw: Record<string, unknown>): string | undefined {
  return (
    stringValue(raw.machine_id) ||
    stringValue(raw.machine) ||
    stringValue(raw.hostname) ||
    undefined
  );
}

function threadHandleFrom(raw: Record<string, unknown>): string | undefined {
  return (
    stringValue(raw.thread_handle) ||
    stringValue(raw.thread_name) ||
    stringValue(raw.thread) ||
    undefined
  );
}

function hostFrom(raw: Record<string, unknown>): string | undefined {
  return stringValue(raw.host) || stringValue(raw.host_app) || undefined;
}

function operatorFrom(raw: Record<string, unknown>): string | undefined {
  return stringValue(raw.operator) || stringValue(raw.operator_id) || undefined;
}

function prUrlFrom(raw: Record<string, unknown>): string | undefined {
  return stringValue(raw.pr_url) || stringValue(raw.prUrl) || stringValue(raw.pull_request_url) || undefined;
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
    agentId: displayAttribution(stringValue(raw.agent_id)),
    machineId: machineIdFrom(raw),
    threadHandle: threadHandleFrom(raw),
    host: hostFrom(raw),
    operator: operatorFrom(raw),
    batchId: stringValue(raw.batch_id) || undefined,
    branch: stringValue(raw.branch) || undefined,
    prUrl: prUrlFrom(raw),
    generation: finiteNonNegativeDecimalInteger(raw.generation ?? raw.claim_generation),
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
    agentId: displayAttribution(stringValue(raw.agent_id) || targetFromPath(path)),
    machineId: machineIdFrom(raw),
    threadHandle: threadHandleFrom(raw),
    host: hostFrom(raw),
    operator: operatorFrom(raw),
    repo: stringValue(raw.repo) || undefined,
    target: raw.target ? String(raw.target) : undefined,
    batchId: stringValue(raw.batch_id) || undefined,
    branch: stringValue(raw.branch) || undefined,
    prUrl: prUrlFrom(raw),
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
        name: displayAttribution(stringValue(lane.name) || stringValue(lane.id)),
        owner: displayAttribution(stringValue(lane.owner) || stringValue(lane.agent_id)),
        targets,
        dependsOn,
        status: stringValue(lane.status, "unknown"),
        liveness: "no-heartbeat",
        blockedOn: [],
        threadHandle: threadHandleFrom(lane),
        host: hostFrom(lane),
        operator: operatorFrom(lane),
        branch: stringValue(lane.branch) || undefined,
        prUrl: prUrlFrom(lane)
      };
    })
  };
}

function normalizeBatchEvent(raw: Record<string, unknown>, path: string): BatchEvent {
  const timestamp =
    stringValue(raw.timestamp) || stringValue(raw.at) || stringValue(raw.created_at) || stringValue(raw.updated_at) || undefined;
  const batchId = stringValue(raw.batch_id) || undefined;
  const laneName = stringValue(raw.lane_name) || stringValue(raw.lane_id) || stringValue(raw.lane) || undefined;

  return {
    eventId: stringValue(raw.event_id) || stringValue(raw.id) || `${path}:${timestamp || idFromPath(path)}`,
    type: stringValue(raw.type) || stringValue(raw.event_type) || stringValue(raw.name, "unknown"),
    generation: finiteNonNegativeDecimalInteger(raw.generation ?? raw.claim_generation),
    batchId,
    laneName,
    machineId: machineIdFrom(raw),
    agentId: stringValue(raw.agent_id) || undefined,
    threadHandle: threadHandleFrom(raw),
    host: hostFrom(raw),
    operator: operatorFrom(raw),
    repo: stringValue(raw.repo) || undefined,
    target: raw.target ? String(raw.target) : undefined,
    branch: stringValue(raw.branch) || undefined,
    prUrl: prUrlFrom(raw),
    status: stringValue(raw.status) || stringValue(raw.phase) || undefined,
    message: stringValue(raw.message) || undefined,
    timestamp,
    path
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

export async function readCoordinationState(root: string, now = new Date(), apiOptions: CoordinationApiOptions = {}): Promise<RawState> {
  if (apiOptions.apiUrl?.trim()) {
    return readApiCoordinationState(
      {
        apiUrl: apiOptions.apiUrl,
        token: apiOptions.token || ""
      },
      now
    );
  }

  const warnings: CoordinationWarning[] = [];
  await hasInitializedCoordinationRoot(root, warnings);
  const claimsSource = await listStateFiles(join(root, "claims"), root, warnings);
  const heartbeatsSource = await listStateFiles(join(root, "heartbeats"), root, warnings);
  const batchesSource = await listStateFiles(join(root, "batches"), root, warnings);
  const eventsSource = await listStateFiles(join(root, "events"), root, warnings, [".json", ".jsonl"]);
  const historySource = await listStateFiles(join(root, "history"), root, warnings, [".json", ".jsonl"]);
  const eventFilesSource = {
    files: [...eventsSource.files, ...historySource.files],
    unavailable: eventsSource.unavailable || historySource.unavailable
  };
  const claimFiles = claimsSource.files;
  const heartbeatFiles = heartbeatsSource.files;
  const batchFiles = batchesSource.files;
  const eventFiles = eventFilesSource.files;

  async function readMany<T>(
    files: string[],
    normalize: (raw: Record<string, unknown>, path: string) => T
  ): Promise<StateReadResult<T>> {
    const records: T[] = [];
    let unavailable = false;
    for (const file of files) {
      const path = relative(root, file);
      try {
        records.push(normalize(await readJson(file), path));
      } catch (error) {
        unavailable = true;
        warnings.push({
          severity: "warning",
          ...warningContextFromPath(path),
          message: `Malformed JSON in ${path}: ${error instanceof Error ? error.message : "unknown error"}`
        });
      }
    }
    return { records, unavailable };
  }

  async function readEvents(files: string[]): Promise<StateReadResult<BatchEvent>> {
    const records: BatchEvent[] = [];
    let unavailable = false;
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
              unavailable = true;
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
        unavailable = true;
        warnings.push({
          severity: "warning",
          ...warningContextFromPath(path),
          message: `Malformed JSON in ${path}: ${error instanceof Error ? error.message : "unknown error"}`
        });
      }
    }
    return { records, unavailable };
  }

  const claimsRead = await readMany(claimFiles, normalizeClaim);
  const heartbeatsRead = await readMany(heartbeatFiles, (raw, path) => normalizeHeartbeat(raw, path, now));
  const batchesRead = await readMany(batchFiles, normalizeBatch);
  const eventsRead = await readEvents(eventFiles);

  return {
    claims: claimsRead.records,
    heartbeats: heartbeatsRead.records,
    batches: batchesRead.records,
    events: eventsRead.records,
    warnings,
    sourceStatus: [
      {
        resource: "claims",
        mode: "fs",
        status: filesystemSourceState(claimsSource, claimsRead),
        checkedAt: now.toISOString()
      },
      {
        resource: "heartbeats",
        mode: "fs",
        status: filesystemSourceState(heartbeatsSource, heartbeatsRead),
        checkedAt: now.toISOString()
      },
      {
        resource: "batches",
        mode: "fs",
        status: filesystemSourceState(batchesSource, batchesRead),
        checkedAt: now.toISOString()
      },
      {
        resource: "events",
        mode: "fs",
        status: filesystemSourceState(eventFilesSource, eventsRead),
        checkedAt: now.toISOString()
      }
    ]
  };
}
