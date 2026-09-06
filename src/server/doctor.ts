import { readdir } from "node:fs/promises";
import { join } from "node:path";

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

export interface DoctorReport {
  apiUrl: string | null;
  tokenEnvVar: string | null;
  stateRoot: string;
  perResource: DoctorResourceStatus[];
}

export interface DoctorOptions {
  stateRoot: string;
  apiUrl?: string;
  token?: string;
  tokenEnvVar?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the current time. */
  now?: () => Date;
}

const DOCTOR_RESOURCES: readonly DoctorResource[] = ["claims", "heartbeats", "batches", "events"];
const API_FETCH_TIMEOUT_MS = 5000;
const LOOPBACK_API_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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

function apiStateListUrl(baseUrl: URL, prefix: DoctorResource): URL {
  const url = new URL(`${baseUrl.toString().replace(/\/+$/, "")}/v1/state`);
  url.searchParams.set("prefix", prefix);
  return url;
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
 * Report whether the configured coordination backend answers, one row per
 * resource. The token is used only as a request header and never returned.
 */
export async function readDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const checkedAt = (options.now?.() || new Date()).toISOString();
  const apiUrl = options.apiUrl?.trim() || "";
  const tokenEnvVar = options.tokenEnvVar || null;

  if (!apiUrl) {
    return {
      apiUrl: null,
      tokenEnvVar,
      stateRoot: options.stateRoot,
      perResource: await Promise.all(
        DOCTOR_RESOURCES.map((resource) => probeFilesystemResource(options.stateRoot, resource, checkedAt))
      )
    };
  }

  const apiReport = (perResource: DoctorResourceStatus[]): DoctorReport => ({
    apiUrl: reportableApiUrl(apiUrl),
    tokenEnvVar,
    stateRoot: options.stateRoot,
    perResource
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
  return apiReport(
    await Promise.all(DOCTOR_RESOURCES.map((resource) => probeApiResource(baseUrl, token, resource, checkedAt, fetchImpl)))
  );
}
