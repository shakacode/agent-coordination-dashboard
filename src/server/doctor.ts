import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ATTENTION_WORKSPACE, readAttentionRecords as readAttentionRecordsImpl } from "./attention/readAttentionRecords";
import { API_FETCH_TIMEOUT_MS, apiStateListUrl, parseApiBaseUrl } from "./security/coordinationApiUrl";

export type DoctorResource = "claims" | "heartbeats" | "batches" | "events";
export type DoctorResourceMode = "fs" | "api";
export type DoctorResourceState = "ok" | "empty" | "auth_error" | "unreachable";

export interface DoctorResourceStatus {
  resource: DoctorResource;
  mode: DoctorResourceMode;
  status: DoctorResourceState;
  httpStatus?: number;
  checkedAt: string;
}

/** One configured repository's attention read outcome; a status, never a record. */
export interface DoctorAttentionRepositoryStatus {
  /** The configured `owner/name`, exactly as it appears in the settings. */
  repository: string;
  status: DoctorResourceState;
  /** Present only when the coordination API answered with a status code. */
  httpStatus?: number;
  checkedAt: string;
  /** True when the read budget stopped before the whole listing was examined. */
  partial: boolean;
}

/**
 * Which settings state produced the reported attention scope.
 *
 * `first_run_default` is the only state in which the configured `TARGET_REPOS`
 * stand in for saved settings (AGENTS.md: they are a first-run fallback for
 * when settings have never been saved). `unreadable` means a settings file
 * exists but could not be read, so no repository is in scope and none is
 * probed: naming the configured repositories there would hide the
 * configuration failure and report repositories the operator never saved.
 */
export type DoctorSettingsStatus = "saved" | "first_run_default" | "unreadable";

/**
 * Where `/api/attention` reads from, and whether each configured repository
 * answers.
 *
 * Statuses only: records, questions, targets, and diagnostic text never appear
 * here. The doctor stays a diagnostics endpoint, and `/api/attention` remains
 * the one route that serves record content.
 */
export interface DoctorAttentionScope {
  mode: DoctorResourceMode;
  workspace: string;
  /** Where the repositories below came from, including "nowhere readable". */
  settings: DoctorSettingsStatus;
  repositories: DoctorAttentionRepositoryStatus[];
}

export interface DoctorReport {
  apiUrl: string | null;
  tokenEnvVar: string | null;
  stateRoot: string;
  perResource: DoctorResourceStatus[];
  attention: DoctorAttentionScope;
}

export interface DoctorOptions {
  stateRoot: string;
  apiUrl?: string;
  token?: string;
  tokenEnvVar?: string;
  /**
   * The configured `owner/name` targets whose attention read scope is reported.
   * No targets is a real configuration, so it reports an empty scope rather
   * than an error.
   */
  targetRepos?: readonly string[];
  attentionWorkspace?: string;
  /**
   * How the caller resolved {@link DoctorOptions.targetRepos}. Defaults to
   * `saved`, the state a caller that hands over a scope is in; `unreadable`
   * reports an empty scope and reads nothing.
   */
  settings?: DoctorSettingsStatus;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the current time. */
  now?: () => Date;
  /** Injectable for tests; defaults to the real attention reader. */
  readAttentionRecords?: typeof readAttentionRecordsImpl;
}

const DOCTOR_RESOURCES: readonly DoctorResource[] = ["claims", "heartbeats", "batches", "events"];

/** The token environment variables the attention reader names in its warnings. */
const COORD_TOKEN_ENV_VARS = ["AGENT_COORD_API_TOKEN", "AGENT_COORD_TOKEN"] as const;

/** Narrow the doctor's free-text env var name to the two the reader knows. */
function coordTokenEnvVar(value: string | undefined): (typeof COORD_TOKEN_ENV_VARS)[number] | undefined {
  return COORD_TOKEN_ENV_VARS.find((name) => name === value);
}

/**
 * Report the configured backend without its secrets: credentials embedded in
 * the URL, the query string, and the fragment can all carry tokens. An
 * unparseable URL is reported as UNKNOWN rather than echoed back.
 */
function reportableApiUrl(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "UNKNOWN";
  }
}

function resourceStatus(
  resource: DoctorResource,
  mode: DoctorResourceMode,
  status: DoctorResourceState,
  checkedAt: string,
  httpStatus?: number
): DoctorResourceStatus {
  return { resource, mode, status, ...(httpStatus === undefined ? {} : { httpStatus }), checkedAt };
}

/**
 * Reachability only: count directory entries without reading or parsing files.
 * An absent directory is `empty` — an uninitialized coordination root is a
 * normal first-run state, not a backend failure. Any other read error (denied
 * permissions, unreadable path) is `unreachable`.
 */
async function probeFilesystemResource(
  stateRoot: string,
  resource: DoctorResource,
  checkedAt: string
): Promise<DoctorResourceStatus> {
  try {
    const entries = await readdir(join(stateRoot, resource));
    return resourceStatus(resource, "fs", entries.length > 0 ? "ok" : "empty", checkedAt);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return resourceStatus(resource, "fs", code === "ENOENT" ? "empty" : "unreachable", checkedAt);
  }
}

/**
 * Reachability only: one bounded list request per resource. The response body is
 * never parsed, so a reachable backend reports `ok` regardless of its contents.
 */
async function probeApiResource(
  baseUrl: URL,
  token: string,
  resource: DoctorResource,
  checkedAt: string,
  fetchImpl: typeof fetch
): Promise<DoctorResourceStatus> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(apiStateListUrl(baseUrl, resource), {
      headers: {
        authorization: `Bearer ${token}`
      },
      signal: controller.signal
    });
    // Only the status is used, so release the body immediately: an unread
    // large or streaming list response would otherwise hold the connection.
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 200) {
      return resourceStatus(resource, "api", "ok", checkedAt, response.status);
    }
    if (response.status === 401 || response.status === 403) {
      return resourceStatus(resource, "api", "auth_error", checkedAt, response.status);
    }
    return resourceStatus(resource, "api", "unreachable", checkedAt, response.status);
  } catch {
    return resourceStatus(resource, "api", "unreachable", checkedAt);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read the configured repositories through the attention reader and keep only
 * each one's source status.
 *
 * The reader is the only thing that knows a repository's reachability, and it
 * learns it by reading, so the records are fetched and then dropped. The reader
 * never throws, so this never throws either: a repository that cannot be read
 * arrives as an `unreachable` or `auth_error` status like any other.
 */
async function readAttentionScope(options: DoctorOptions): Promise<DoctorAttentionScope> {
  const settings = options.settings || "saved";
  if (settings === "unreadable") {
    // No repository is in scope, so nothing is probed: the report states that
    // the saved scope could not be read instead of substituting a scope the
    // operator never saved. The same rule the reader and `config.ts` use
    // decides the mode, which is configuration rather than a read.
    const mode: DoctorResourceMode = (options.apiUrl || "").trim() === "" ? "fs" : "api";
    return { mode, workspace: "UNKNOWN", settings, repositories: [] };
  }

  const read = await (options.readAttentionRecords || readAttentionRecordsImpl)({
    stateRoot: options.stateRoot,
    coordApiUrl: options.apiUrl,
    coordApiToken: options.token,
    coordApiTokenEnvVar: coordTokenEnvVar(options.tokenEnvVar),
    targetRepos: options.targetRepos || [],
    workspace: options.attentionWorkspace ?? ATTENTION_WORKSPACE,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {})
  });

  return {
    mode: read.mode,
    workspace: read.workspace,
    settings,
    repositories: read.repositories.map((repository) => ({
      repository: repository.repository,
      status: repository.sourceStatus.status,
      ...(repository.sourceStatus.httpStatus === undefined
        ? {}
        : { httpStatus: repository.sourceStatus.httpStatus }),
      checkedAt: repository.sourceStatus.checkedAt,
      partial: repository.partial
    }))
  };
}

/**
 * Report whether the configured coordination backend answers, one row per
 * resource, plus the attention read scope. The token is used only as a request
 * header and never returned.
 */
export async function readDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const checkedAt = (options.now?.() || new Date()).toISOString();
  const apiUrl = options.apiUrl?.trim() || "";
  const tokenEnvVar = options.tokenEnvVar || null;
  // The attention scope is an independent read, so it is started here and
  // awaited at the end: it runs beside the resource probes rather than after
  // them. Every return path awaits it, so it is never left floating.
  const attentionScope = readAttentionScope(options);

  if (!apiUrl) {
    const [perResource, attention] = await Promise.all([
      Promise.all(DOCTOR_RESOURCES.map((resource) => probeFilesystemResource(options.stateRoot, resource, checkedAt))),
      attentionScope
    ]);
    return {
      apiUrl: null,
      tokenEnvVar,
      stateRoot: options.stateRoot,
      perResource,
      attention
    };
  }

  const apiReport = async (perResource: DoctorResourceStatus[]): Promise<DoctorReport> => ({
    apiUrl: reportableApiUrl(apiUrl),
    tokenEnvVar,
    stateRoot: options.stateRoot,
    perResource,
    attention: await attentionScope
  });

  let baseUrl: URL;
  try {
    baseUrl = parseApiBaseUrl(apiUrl);
  } catch {
    return apiReport(DOCTOR_RESOURCES.map((resource) => resourceStatus(resource, "api", "unreachable", checkedAt)));
  }

  const token = (options.token || "").trim();
  if (!token) {
    return apiReport(DOCTOR_RESOURCES.map((resource) => resourceStatus(resource, "api", "auth_error", checkedAt)));
  }

  const fetchImpl = options.fetchImpl || fetch;
  // Both reads are awaited together so neither is left without a handler while
  // the other is still running.
  const [perResource] = await Promise.all([
    Promise.all(DOCTOR_RESOURCES.map((resource) => probeApiResource(baseUrl, token, resource, checkedAt, fetchImpl))),
    attentionScope
  ]);
  return apiReport(perResource);
}
