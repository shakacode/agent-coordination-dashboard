/**
 * Client contract for `GET /api/attention`, the only endpoint the Human
 * Attention view reads.
 *
 * The route does not exist yet: shakacode/agent-coordination-dashboard#128
 * serves it and #127 re-exports these payload types from
 * `src/shared/attention.ts`. Until then this file *is* the contract, and the
 * view is built and tested against `src/client/attention/fixtures.ts`.
 *
 * The dashboard stays read-only: this module issues one GET, never mutates
 * coordination state, and never reaches GitHub from the render path.
 */

import type { AttentionCapabilityState, AttentionRenderView } from "../shared/attention";

/** Same-origin path; the dev server proxies `/api` to the dashboard server. */
export const ATTENTION_ENDPOINT = "/api/attention";

/** Loopback-only bypass header honoured by #128 for a foreground refresh. */
export const DASHBOARD_REFRESH_HEADER = "X-Dashboard-Refresh";
export const DASHBOARD_REFRESH_FOREGROUND = "foreground";

/**
 * The literal sets are declared as values so the payload guard checks the same
 * vocabulary the types promise, the way `src/shared/attention.ts` does.
 */
const SOURCE_MODES = ["fs", "api"] as const;
export type AttentionSourceMode = (typeof SOURCE_MODES)[number];

const SOURCE_STATUSES = ["ok", "empty", "auth_error", "unreachable"] as const;
export type AttentionSourceStatus = (typeof SOURCE_STATUSES)[number];

const NATIVE_OPEN_STATES: readonly AttentionCapabilityState[] = ["available", "unavailable", "unknown"];

export interface AttentionCardPayload {
  /**
   * Server-assigned position, `1..N` and contiguous in payload order. The view
   * labels cards by list position instead, so a gap can never break numbering.
   */
  number: number;
  id: string;
  /** `owner/name` the record belongs to. */
  repository: string;
  /**
   * `projectAttentionRecord` output: `target`, `walkthrough_url`, and
   * `source.open_uri` arrive validated or `null`, never as raw record text.
   */
  record: AttentionRenderView;
  /** Normalized host that owns the agent session: `M5` or `M1`. */
  host: string;
  /** True when {@link AttentionPayload.dashboard_host} equals {@link host}. */
  host_matches: boolean;
  native_open: AttentionCapabilityState;
  /** Another card in this payload points at the same pull request. */
  same_pr: boolean;
  open_days: number;
  /** The record has been open long enough that the age deserves a check. */
  verify_open_age: boolean;
}

export interface AttentionSourcePayload {
  repository: string;
  mode: AttentionSourceMode;
  status: AttentionSourceStatus;
  checked_at: string;
  partial: boolean;
  truncated: boolean;
  message?: string;
}

export interface AttentionDiagnosticPayload {
  /** `null` when the diagnostic is not about one repository. */
  repository: string | null;
  kind: string;
  message: string;
}

export interface AttentionPayload {
  generated_at: string;
  /** Host the dashboard itself runs on: normalized `M5`, `M1`, or `UNKNOWN`. */
  dashboard_host: string;
  cards: AttentionCardPayload[];
  sources: AttentionSourcePayload[];
  diagnostics: AttentionDiagnosticPayload[];
}

export type AttentionFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchAttentionOptions {
  /** Sends the loopback bypass header and asks the server to skip its cache. */
  foreground?: boolean;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: AttentionFetch;
}

/** Prefix of every rejection so a caller can log one recognizable failure. */
const FAILURE_PREFIX = "attention request failed";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isOneOf(values: readonly string[], value: unknown): boolean {
  return isString(value) && values.includes(value);
}

function isCard(value: unknown): value is AttentionCardPayload {
  if (!isObject(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.number) &&
    isString(value.id) &&
    isString(value.repository) &&
    isObject(value.record) &&
    isString(value.host) &&
    isBoolean(value.host_matches) &&
    isOneOf(NATIVE_OPEN_STATES, value.native_open) &&
    isBoolean(value.same_pr) &&
    isFiniteNumber(value.open_days) &&
    isBoolean(value.verify_open_age)
  );
}

function isSource(value: unknown): value is AttentionSourcePayload {
  if (!isObject(value)) {
    return false;
  }
  return (
    isString(value.repository) &&
    isOneOf(SOURCE_MODES, value.mode) &&
    isOneOf(SOURCE_STATUSES, value.status) &&
    isString(value.checked_at) &&
    isBoolean(value.partial) &&
    isBoolean(value.truncated) &&
    isOptionalString(value.message)
  );
}

function isDiagnostic(value: unknown): value is AttentionDiagnosticPayload {
  if (!isObject(value)) {
    return false;
  }
  return (value.repository === null || isString(value.repository)) && isString(value.kind) && isString(value.message);
}

/**
 * Structural check of the whole payload before a single value reaches a card.
 * A missing boolean would otherwise silently pick the wrong render branch, so
 * an off-contract body is rejected as `malformed` rather than half-rendered.
 */
export function isAttentionPayload(value: unknown): value is AttentionPayload {
  if (!isObject(value)) {
    return false;
  }
  return (
    isString(value.generated_at) &&
    isString(value.dashboard_host) &&
    Array.isArray(value.cards) &&
    value.cards.every(isCard) &&
    Array.isArray(value.sources) &&
    value.sources.every(isSource) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isDiagnostic)
  );
}

/**
 * Reads the attention payload. Rejects with an `Error` whose message names the
 * failure class: `http <status>` for a non-2xx response, `network` when the
 * request never completed, and `malformed` when the body is not a payload.
 */
export async function fetchAttention(options: FetchAttentionOptions = {}): Promise<AttentionPayload> {
  const { foreground = false } = options;
  // Read the global lazily so a test can stub `fetch` after this module loads,
  // and call it through a wrapper so it keeps its own receiver.
  const request: AttentionFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const headers: Record<string, string> = { accept: "application/json" };
  if (foreground) {
    headers[DASHBOARD_REFRESH_HEADER] = DASHBOARD_REFRESH_FOREGROUND;
  }

  let response: Response;
  try {
    response = await request(ATTENTION_ENDPOINT, { method: "GET", headers });
  } catch {
    throw new Error(`${FAILURE_PREFIX}: network`);
  }

  if (!response.ok) {
    throw new Error(`${FAILURE_PREFIX}: http ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${FAILURE_PREFIX}: malformed`);
  }

  if (!isAttentionPayload(body)) {
    throw new Error(`${FAILURE_PREFIX}: malformed`);
  }
  return body;
}
