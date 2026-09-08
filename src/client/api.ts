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

import {
  validateAttentionTarget,
  validateOpenUri,
  validateWalkthroughUrl,
  type AttentionCapabilityState,
  type AttentionPriorityClass,
  type AttentionRenderView,
  type AttentionSource,
  type AttentionStatus,
  type AttentionWalkthroughMode
} from "../shared/attention";

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

/**
 * The projected record's own vocabulary. Each array is typed against the shared
 * union, so dropping or renaming a member upstream fails this build rather than
 * letting the guard drift away from `projectAttentionRecord`.
 */
const RECORD_STATUSES: readonly AttentionStatus[] = ["open", "resolved"];

const RECORD_PRIORITY_CLASSES: readonly AttentionPriorityClass[] = [
  "urgent-risk",
  "unblocks-work",
  "current-head-merge",
  "product-architecture"
];

const RECORD_WALKTHROUGH_MODES: readonly AttentionWalkthroughMode[] = ["automatic", "requested"];

/** Allowlisted render fields whose value is plain text when present. */
const RECORD_TEXT_FIELDS = [
  "id",
  "repository",
  "kind",
  "question",
  "priority_reason",
  "safe_resume",
  "what_changes",
  "risk_downside",
  "recommendation",
  "one_action",
  "unlocks",
  "hil_task_title",
  "created_at",
  "refreshed_at",
  "resolved_at"
] as const;

/** Allowlisted render fields whose value is a number when present. */
const RECORD_NUMBER_FIELDS = ["unlocks_count", "refresh_interval_seconds"] as const;

/** Allowlisted source fields whose value is plain text when present. */
const SOURCE_TEXT_FIELDS = ["provider", "host_id", "task_id", "last_seen_at"] as const;

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
  /**
   * Resolved records the read returned, whether or not they are in the trail.
   *
   * Advisory, and optional here even though `src/shared/attention.ts` declares
   * it required and the model sets it on every source: {@link isSource} does
   * not check it, so nothing verifies this type, and a reader must test it for
   * a finite number before showing it.
   * @see isSource
   */
  resolved_total?: number;
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
  /** Aborts the request; an abort surfaces as the `network` failure class. */
  signal?: AbortSignal;
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

/**
 * The projected `source` view: text fields are text, capability states are in
 * the shared set, and `open_uri` is `null` or exactly the codex thread URI that
 * {@link validateOpenUri} accepts for this source's own task id.
 */
function isRenderSource(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isObject(value)) {
    return false;
  }
  for (const field of SOURCE_TEXT_FIELDS) {
    if (value[field] !== undefined && !isString(value[field])) {
      return false;
    }
  }
  const capabilities = value.capabilities;
  if (capabilities !== undefined) {
    if (!isObject(capabilities)) {
      return false;
    }
    if (capabilities.native_open !== undefined && !isOneOf(NATIVE_OPEN_STATES, capabilities.native_open)) {
      return false;
    }
    if (capabilities.prompt_forwarding !== undefined && !isOneOf(NATIVE_OPEN_STATES, capabilities.prompt_forwarding)) {
      return false;
    }
  }
  const openUri = value.open_uri;
  if (openUri === undefined || openUri === null) {
    return true;
  }
  // The shared validator is the only open-URI rule; this asks it whether the
  // value in hand is what it would have produced.
  return validateOpenUri(value as unknown as AttentionSource) === openUri;
}

/**
 * The card's record must be what `projectAttentionRecord` produced, not merely
 * an object. Until #128 serves the route nothing upstream proves that, and a
 * card renders links straight out of these fields, so a record whose `target`,
 * `walkthrough_url`, or `source.open_uri` would not survive the shared
 * validators is rejected here rather than trusted at render time.
 *
 * The link rules are not reimplemented: each field is handed to the shared
 * validator and must come back unchanged.
 */
function isRenderView(value: unknown): value is AttentionRenderView {
  if (!isObject(value)) {
    return false;
  }
  for (const field of RECORD_TEXT_FIELDS) {
    if (value[field] !== undefined && !isString(value[field])) {
      return false;
    }
  }
  for (const field of RECORD_NUMBER_FIELDS) {
    if (value[field] !== undefined && !isFiniteNumber(value[field])) {
      return false;
    }
  }
  if (value.status !== undefined && !isOneOf(RECORD_STATUSES, value.status)) {
    return false;
  }
  if (value.priority_class !== undefined && !isOneOf(RECORD_PRIORITY_CLASSES, value.priority_class)) {
    return false;
  }
  if (
    value.walkthrough_mode !== undefined &&
    value.walkthrough_mode !== null &&
    !isOneOf(RECORD_WALKTHROUGH_MODES, value.walkthrough_mode)
  ) {
    return false;
  }
  const choices = value.choices;
  if (choices !== undefined && (!Array.isArray(choices) || !choices.every(isString))) {
    return false;
  }
  const repository = value.repository;
  const target = value.target;
  if (target !== undefined && target !== null && validateAttentionTarget(target, repository) !== target) {
    return false;
  }
  const walkthroughUrl = value.walkthrough_url;
  if (
    walkthroughUrl !== undefined &&
    walkthroughUrl !== null &&
    validateWalkthroughUrl(walkthroughUrl, repository) !== walkthroughUrl
  ) {
    return false;
  }
  return isRenderSource(value.source);
}

function isCard(value: unknown): value is AttentionCardPayload {
  if (!isObject(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.number) &&
    isString(value.id) &&
    isString(value.repository) &&
    isRenderView(value.record) &&
    isString(value.host) &&
    isBoolean(value.host_matches) &&
    isOneOf(NATIVE_OPEN_STATES, value.native_open) &&
    isBoolean(value.same_pr) &&
    isFiniteNumber(value.open_days) &&
    isBoolean(value.verify_open_age)
  );
}

/**
 * The fields a source must have to be one.
 *
 * `resolved_total` is deliberately absent from this list. Rejection here is
 * all-or-nothing — one bad field fails {@link isAttentionPayload} and the view
 * renders no page at all — so the check has to be reserved for values the page
 * cannot be right without. The resolved count is not one of them: it is a
 * number beside a source line, and losing it costs a reader that number, while
 * rejecting the payload over it costs them every card, every diagnostic, and
 * the backend health this page exists to show. Issues
 * shakacode/agent-coordination-dashboard#146 and #166 track making the guard
 * degrade per field instead of per payload; until then, an advisory field is
 * checked where it is rendered, not here.
 */
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
    // An abort lands here too, and reads as `network`: in both cases no answer
    // arrived, and the caller that aborted already knows it did.
    response = await request(ATTENTION_ENDPOINT, { method: "GET", headers, signal: options.signal });
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
