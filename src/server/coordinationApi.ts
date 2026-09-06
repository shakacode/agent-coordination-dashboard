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
// `URL.hostname` keeps the brackets on IPv6 literals per the WHATWG URL spec, so `[::1]` is deliberate, not a typo.
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
  // The test is on the serialized URL, not on `url.search`/`url.hash`: both
  // read as "" for a bare `?` or `#`, which `toString()` still preserves and
  // the concatenation still swallows. A path may only hold `?`/`#`
  // percent-encoded, so this cannot reject an otherwise valid base.
  if (/[?#]/.test(url.toString())) {
    throw new Error("expected an http(s) URL with no query string or fragment");
  }
  // Same reasoning one step further: userinfo in the base would ride along in
  // every state request URL beside the bearer token, so an operator who pasted
  // credentials into AGENT_COORD_API_URL is told rather than quietly obeyed.
  if (url.username || url.password) {
    throw new Error("expected an http(s) URL with no embedded username or password");
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

/**
 * Prefer the backend's own error text; fall back to the HTTP status line.
 *
 * The whole read is guarded, not just the JSON parse. Reading an error body is
 * a second network wait that can stall past the body timeout and reject with
 * `AbortError`; the HTTP status has already classified the failure by then, so
 * a body that never arrives may cost the operator the backend's wording but
 * must never throw away an `auth_error`. This function therefore never throws.
 */
async function responseErrorMessage(response: Response): Promise<string> {
  const statusLine = response.statusText || `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as unknown;
    return isRecord(body) && typeof body.error === "string" ? body.error : statusLine;
  } catch {
    return statusLine;
  }
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
      // Redirects are surfaced, never followed. `fetch` strips the bearer
      // header only when a redirect crosses origins, so a same-origin
      // `Location` from a misbehaving backend would otherwise receive the
      // token at a path nobody configured.
      redirect: "manual",
      signal: controller.signal
    });
    // Headers arrived within the request budget. Reading the body is a second
    // network wait, so it gets its own timer: a stalled or endless stream must
    // not inherit whatever is left of the request's five seconds.
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);

    // The state endpoint has no redirects to offer, so a 3xx is a
    // misconfiguration or a hostile backend either way. It is classified
    // without reading the body and without a second request, which keeps the
    // never-throws contract and leaves the token on exactly one origin.
    if (response.status >= 300 && response.status < 400) {
      warnings.push(`Could not read coordination API ${prefix}: unexpected redirect (HTTP ${response.status})`);
      return {
        entries: [],
        warnings,
        sourceStatus: sourceStatus(prefix, "unreachable", checkedAt, response.status)
      };
    }

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
      // `GET /v1/state?prefix=` is a string match on the backend, so a listing
      // for `attention/default/shakacode/app` can also carry
      // `attention/default/shakacode/app2/...`. Requiring the `/` boundary keeps
      // one repository's records from reaching a caller that asked for another,
      // which the read-only scope rule in AGENTS.md forbids. An out-of-scope
      // path is dropped exactly like a malformed wrapper: the in-scope entries
      // still come back, but the listing can no longer be called healthy.
      //
      // The warning names the requested prefix and the entry's index but never
      // the rejected path: repeating it would hand the other repository's name
      // and target to every caller that displays warnings, which is the leak
      // this check exists to prevent.
      if (!entry.path.startsWith(`${prefix}/`)) {
        rejectedEntry = true;
        warnings.push(`Out-of-scope coordination API ${prefix} entry at index ${index}`);
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
