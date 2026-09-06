import type { ServerConfig } from "./config";

/**
 * Read client for the coordination Worker's `attention` state prefixes.
 *
 * The module is deliberately narrow: it performs one bounded `GET /v1/state`
 * per prefix, never calls GitHub, never touches the filesystem, and never
 * throws. Every failure becomes a warning plus a typed source status so the
 * read-only attention view can render `UNKNOWN` instead of an error page.
 */

declare const attentionPrefixBrand: unique symbol;

/**
 * `attention/<workspace>/<owner>/<name>` and nothing else.
 *
 * The template literal rejects wrong-shaped literals outright; the brand keeps
 * a four-segment string from being forged by hand, so the only way to obtain
 * one is `toAttentionPrefix` or the `isAttentionPrefix` guard. Segment counts
 * are not expressible in a template literal (`${string}` spans `/`), which is
 * why the runtime guard is part of the type's contract.
 */
export type AttentionPrefix = `attention/${string}/${string}/${string}` & {
  readonly [attentionPrefixBrand]: true;
};

export type StateSourceState = "ok" | "empty" | "auth_error" | "unreachable";

/** One prefix's read outcome, reported per prefix rather than per request. */
export interface StateSourceStatus {
  prefix: AttentionPrefix;
  mode: "api";
  status: StateSourceState;
  /** Omitted whenever the response arrived but could not be trusted. */
  httpStatus?: number;
  checkedAt: string;
}

/** A raw state record as the Worker returns it; parsing belongs to the caller. */
export interface StateEntry {
  path: string;
  data: Record<string, unknown>;
}

export interface StatePrefixReadResult {
  entries: StateEntry[];
  warnings: string[];
  sourceStatus: StateSourceStatus;
}

export interface CoordinationApiOptions
  extends Pick<ServerConfig, "coordApiUrl" | "coordApiToken" | "coordApiTokenEnvVar"> {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the current time. */
  now?: () => Date;
}

const API_FETCH_TIMEOUT_MS = 5000;
const LOOPBACK_API_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_TOKEN_ENV_VAR = "AGENT_COORD_API_TOKEN";
const PREFIX_SEGMENT_PATTERN = /^[^/\s]+$/;

function isPrefixSegment(value: string): boolean {
  return PREFIX_SEGMENT_PATTERN.test(value) && value !== "." && value !== "..";
}

/** Runtime half of {@link AttentionPrefix}: exactly four non-empty segments. */
export function isAttentionPrefix(value: string): value is AttentionPrefix {
  const segments = value.split("/");
  return segments.length === 4 && segments[0] === "attention" && segments.slice(1).every(isPrefixSegment);
}

/**
 * Build a prefix from its parts, or `null` when a part is unusable. Repository
 * settings are user-supplied, so a bad value must surface as a warning in the
 * caller rather than as a thrown error inside the render path.
 */
export function toAttentionPrefix(workspace: string, owner: string, name: string): AttentionPrefix | null {
  const candidate = `attention/${workspace}/${owner}/${name}`;
  return isAttentionPrefix(candidate) ? candidate : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseApiBaseUrl(apiUrl: string): URL {
  const url = new URL(apiUrl);
  if (!["http:", "https:"].includes(url.protocol) || !url.host) {
    throw new Error("expected http(s) URL with host");
  }
  if (url.protocol === "http:" && !LOOPBACK_API_HOSTS.has(url.hostname)) {
    throw new Error("HTTP coordination API URLs must use https unless they point at localhost");
  }
  // `apiStateListUrl` appends `/v1/state` to the base as text. A base that
  // already carries a query string or fragment would swallow that suffix into
  // the query (or hash) and send an authenticated request to the origin root
  // instead, so the misconfiguration is refused here rather than misrouted.
  if (url.search || url.hash) {
    throw new Error("expected an http(s) URL with no query string or fragment");
  }
  return url;
}

function apiStateListUrl(baseUrl: URL, prefix: AttentionPrefix): URL {
  const url = new URL(`${baseUrl.toString().replace(/\/+$/, "")}/v1/state`);
  url.searchParams.set("prefix", prefix);
  return url;
}

function sourceStatus(
  prefix: AttentionPrefix,
  status: StateSourceState,
  checkedAt: string,
  httpStatus?: number
): StateSourceStatus {
  return { prefix, mode: "api", status, ...(httpStatus === undefined ? {} : { httpStatus }), checkedAt };
}

function unreadable(
  prefix: AttentionPrefix,
  status: StateSourceState,
  checkedAt: string,
  warnings: string[]
): StatePrefixReadResult {
  return { entries: [], warnings, sourceStatus: sourceStatus(prefix, status, checkedAt) };
}

/** Prefer the backend's own error text; fall back to the HTTP status line. */
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

async function fetchStatePrefix(
  baseUrl: URL,
  token: string,
  prefix: AttentionPrefix,
  checkedAt: string,
  warnings: string[],
  fetchImpl: typeof fetch
): Promise<StatePrefixReadResult> {
  const controller = new AbortController();
  let timeoutId = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(apiStateListUrl(baseUrl, prefix), {
      headers: {
        authorization: `Bearer ${token}`
      },
      signal: controller.signal
    });
    // Headers arrived within the request budget. Reading the body is a second
    // network wait, so it gets its own timer: a stalled or endless stream must
    // not inherit whatever is left of the request's five seconds.
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);

    if (!response.ok) {
      const authFailure = response.status === 401 || response.status === 403;
      const detail = `${response.status} ${await responseErrorMessage(response)}`;
      warnings.push(
        authFailure
          ? `Could not read coordination API ${prefix}: ${detail}. The coordination token needs read access to the ${prefix} prefix.`
          : `Could not read coordination API ${prefix}: ${detail}`
      );
      return {
        entries: [],
        warnings,
        sourceStatus: sourceStatus(prefix, authFailure ? "auth_error" : "unreachable", checkedAt, response.status)
      };
    }

    const body = (await response.json()) as unknown;
    if (!isRecord(body) || !Array.isArray(body.entries)) {
      warnings.push(`Could not read coordination API ${prefix}: malformed response`);
      return unreadable(prefix, "unreachable", checkedAt, warnings);
    }

    const rawEntries: unknown[] = body.entries;
    const entries: StateEntry[] = [];
    let rejectedEntry = false;
    rawEntries.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.path !== "string" || !isRecord(entry.data)) {
        rejectedEntry = true;
        warnings.push(`Malformed coordination API ${prefix} entry at index ${index}`);
        return;
      }
      entries.push({ path: entry.path, data: entry.data });
    });

    // A rejected wrapper means the listing is incomplete, so the successful HTTP
    // status is dropped along with it: a partial read is not a healthy read.
    return {
      entries,
      warnings,
      sourceStatus: rejectedEntry
        ? sourceStatus(prefix, "unreachable", checkedAt)
        : sourceStatus(prefix, entries.length === 0 ? "empty" : "ok", checkedAt, response.status)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readOnePrefix(
  options: CoordinationApiOptions,
  prefix: AttentionPrefix,
  checkedAt: string
): Promise<StatePrefixReadResult> {
  const warnings: string[] = [];
  const apiUrl = options.coordApiUrl?.trim() || "";
  if (!apiUrl) {
    warnings.push(`Could not read coordination API ${prefix}: AGENT_COORD_API_URL is not configured.`);
    return unreadable(prefix, "unreachable", checkedAt, warnings);
  }

  let baseUrl: URL;
  try {
    baseUrl = parseApiBaseUrl(apiUrl);
  } catch (error) {
    warnings.push(`Invalid AGENT_COORD_API_URL: ${errorMessage(error)}`);
    return unreadable(prefix, "unreachable", checkedAt, warnings);
  }

  const token = options.coordApiToken?.trim() || "";
  if (!token) {
    const tokenEnvVar = options.coordApiTokenEnvVar || DEFAULT_TOKEN_ENV_VAR;
    warnings.push(
      `Could not read coordination API ${prefix}: ${tokenEnvVar} is required when AGENT_COORD_API_URL is set, and it must grant read access to the ${prefix} prefix.`
    );
    return unreadable(prefix, "auth_error", checkedAt, warnings);
  }

  const fetchImpl = options.fetchImpl || fetch;
  try {
    return await fetchStatePrefix(baseUrl, token, prefix, checkedAt, warnings, fetchImpl);
  } catch (error) {
    const reason = isAbortError(error) ? `timed out after ${API_FETCH_TIMEOUT_MS}ms` : errorMessage(error);
    warnings.push(`Could not read coordination API ${prefix}: ${reason}`);
    return unreadable(prefix, "unreachable", checkedAt, warnings);
  }
}

/** Read one attention prefix. Never throws; never reads GitHub or the disk. */
export async function readStatePrefix(
  options: CoordinationApiOptions,
  prefix: AttentionPrefix
): Promise<StatePrefixReadResult> {
  return readOnePrefix(options, prefix, (options.now?.() || new Date()).toISOString());
}

/**
 * Read several prefixes concurrently against one `checkedAt`. Each prefix
 * carries its own status and warnings, so one unreachable repository never
 * hides the repositories that answered.
 */
export async function readStatePrefixes(
  options: CoordinationApiOptions,
  prefixes: readonly AttentionPrefix[]
): Promise<StatePrefixReadResult[]> {
  const checkedAt = (options.now?.() || new Date()).toISOString();
  return Promise.all(prefixes.map((prefix) => readOnePrefix(options, prefix, checkedAt)));
}
