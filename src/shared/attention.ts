/**
 * Shared attention contract for the read-only Human Attention view.
 *
 * Both the server (Node, tsx) and the browser client (Vite) import this module,
 * so it stays plain TypeScript: no runtime dependencies, no node builtins, no
 * React, and no reach into the server or client trees.
 *
 * Field names, enums, and bounds follow the upstream attention record schema
 * `schema/state/v1/attention/attention-record.schema.json` in
 * shakacode/agent-coordination at commit
 * 52d391ff8f5686d66ca9bd865543907d8faee195, plus the additive optional v1.1
 * fields proposed in shakacode/agent-coordination#301.
 */

/** Lifecycle of a decision record. */
export type AttentionStatus = "open" | "resolved";

/** Canonical priority vocabulary; the record schema is the source of truth. */
export type AttentionPriorityClass =
  | "urgent-risk"
  | "unblocks-work"
  | "current-head-merge"
  | "product-architecture";

/** Capability truth only: untested behavior stays `unknown`. */
export type AttentionCapabilityState = "available" | "unavailable" | "unknown";

/** Walkthrough offer state from the desk contract (absent means none). */
export type AttentionWalkthroughMode = "automatic" | "requested";

export interface AttentionSourceCapabilities {
  native_open: AttentionCapabilityState;
  prompt_forwarding: AttentionCapabilityState;
}

export interface AttentionSource {
  provider: string;
  host_id: string;
  task_id: string;
  /** Opaque provider-native launch target for navigation only; never fetched. */
  open_uri?: string;
  last_seen_at: string;
  capabilities: AttentionSourceCapabilities;
}

export interface AttentionRecord {
  schema_version: 1;
  workspace: string;
  id: string;
  /** `owner/name`. */
  repository: string;
  target: string;
  status: AttentionStatus;
  kind: string;
  question: string;
  choices: string[];
  priority_class: AttentionPriorityClass;
  priority_reason: string;
  safe_resume: string;
  source: AttentionSource;
  source_generation: number;
  created_at: string;
  refreshed_at: string;
  /** Present only when `status` is `resolved`. */
  resolved_at?: string;

  // Optional additive v1.1 card fields (shakacode/agent-coordination#301).
  what_changes?: string;
  risk_downside?: string;
  recommendation?: string;
  one_action?: string;
  unlocks?: string;
  unlocks_count?: number;
  walkthrough_mode?: AttentionWalkthroughMode | null;
  walkthrough_url?: string;
  hil_task_title?: string;
  refresh_interval_seconds?: number;
}

/** Upstream text bound; every rendered text value is capped at this length. */
export const ATTENTION_TEXT_LIMIT = 4000;

/** Visible marker appended when a rendered text value is capped. */
export const ATTENTION_TRUNCATION_MARKER = "…[truncated]";

/** Upstream `target` bound, reused for every validated URL. */
const ATTENTION_URL_LIMIT = 2000;

/** Upstream `source.task_id` bound. */
const TASK_ID_LIMIT = 255;

/** Upstream `repository` pattern and bound. */
const REPOSITORY_PATTERN = /^(?!.*[.][.])(?![.]\/)(?![^/]+\/[.]$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPOSITORY_LIMIT = 160;

/** `https://github.com/<owner>/<repo>/pull/<n>` and nothing else. */
const PULL_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/[1-9][0-9]*$/;

/** The same URL, optionally followed by `/files` or `#pullrequestreview-<digits>`. */
const WALKTHROUGH_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/[1-9][0-9]*(?:\/files|#pullrequestreview-[1-9][0-9]*)?$/;

const CODEX_PROVIDER = "codex";

/** Safe path segment grammar shared with agent-coord storage keys. */
const SAFE_TASK_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function splitRepository(repository: unknown): { owner: string; name: string } | null {
  if (typeof repository !== "string" || repository.length > REPOSITORY_LIMIT) {
    return null;
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    return null;
  }
  const slash = repository.indexOf("/");
  return { owner: repository.slice(0, slash), name: repository.slice(slash + 1) };
}

/**
 * GitHub owner and repository names are ASCII and case-insensitive, so a record
 * that spells its repository differently from its target URL still points at the
 * same repository.
 */
function sameRepositorySegment(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function matchPullUrl(value: unknown, repository: unknown, pattern: RegExp): string | null {
  if (typeof value !== "string" || value.length > ATTENTION_URL_LIMIT) {
    return null;
  }
  const parsed = splitRepository(repository);
  if (!parsed) {
    return null;
  }
  const match = pattern.exec(value);
  if (!match) {
    return null;
  }
  const [, owner, name] = match;
  if (!sameRepositorySegment(owner, parsed.owner) || !sameRepositorySegment(name, parsed.name)) {
    return null;
  }
  return value;
}

/**
 * Returns `target` when it is the record repository's pull request URL, else
 * `null`. Other hosts, other repositories, issue URLs, query strings, fragments,
 * extra path segments, and non-numeric pull numbers are rejected.
 */
export function validateAttentionTarget(target: unknown, repository: unknown): string | null {
  return matchPullUrl(target, repository, PULL_URL_PATTERN);
}

/**
 * Returns `url` when it is the record repository's pull request URL, optionally
 * followed by exactly `/files` or `#pullrequestreview-<digits>`, else `null`.
 */
export function validateWalkthroughUrl(url: unknown, repository: unknown): string | null {
  return matchPullUrl(url, repository, WALKTHROUGH_URL_PATTERN);
}

/**
 * Returns the source's launch URI when it is exactly
 * `codex://threads/<source.task_id>` for a `codex` provider, else `null`. The
 * URI is never fabricated, never fetched, and never thrown over.
 */
export function validateOpenUri(source: AttentionSource | null | undefined): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const provider: unknown = source.provider;
  const taskId: unknown = source.task_id;
  const openUri: unknown = source.open_uri;
  if (provider !== CODEX_PROVIDER) {
    return null;
  }
  if (typeof taskId !== "string" || taskId.length > TASK_ID_LIMIT || !SAFE_TASK_ID_PATTERN.test(taskId)) {
    return null;
  }
  if (typeof openUri !== "string") {
    return null;
  }
  return openUri === `codex://threads/${taskId}` ? openUri : null;
}

/** The only record fields an attention card may read. */
export const renderAllowlist = [
  "id",
  "repository",
  "target",
  "status",
  "kind",
  "question",
  "choices",
  "priority_class",
  "priority_reason",
  "safe_resume",
  "what_changes",
  "risk_downside",
  "recommendation",
  "one_action",
  "unlocks",
  "unlocks_count",
  "walkthrough_mode",
  "walkthrough_url",
  "hil_task_title",
  "refresh_interval_seconds",
  "created_at",
  "refreshed_at",
  "resolved_at",
  "source"
] as const;

export type AttentionRenderField = (typeof renderAllowlist)[number];

/** The only `source` fields an attention card may read. */
export const renderSourceAllowlist = [
  "provider",
  "host_id",
  "task_id",
  "open_uri",
  "last_seen_at",
  "capabilities"
] as const;

export type AttentionRenderSourceField = (typeof renderSourceAllowlist)[number];

export interface AttentionRenderSourceView {
  provider?: string;
  host_id?: string;
  task_id?: string;
  open_uri?: string;
  last_seen_at?: string;
  capabilities?: Partial<AttentionSourceCapabilities>;
}

export type AttentionRenderView = Partial<Pick<AttentionRecord, Exclude<AttentionRenderField, "source">>> & {
  source?: AttentionRenderSourceView;
};

/** Caps a text value at {@link ATTENTION_TEXT_LIMIT} with a visible marker. */
export function truncateForRender(value: string): string {
  if (value.length <= ATTENTION_TEXT_LIMIT) {
    return value;
  }
  let head = value.slice(0, ATTENTION_TEXT_LIMIT - ATTENTION_TRUNCATION_MARKER.length);
  const lastUnit = head.charCodeAt(head.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return `${head}${ATTENTION_TRUNCATION_MARKER}`;
}

function projectValue(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === "string") {
    return truncateForRender(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map(truncateForRender);
  }
  return undefined;
}

function isCapabilityState(value: unknown): value is AttentionCapabilityState {
  return value === "available" || value === "unavailable" || value === "unknown";
}

function projectCapabilities(value: unknown): Partial<AttentionSourceCapabilities> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const view: Partial<AttentionSourceCapabilities> = {};
  if (isCapabilityState(raw.native_open)) {
    view.native_open = raw.native_open;
  }
  if (isCapabilityState(raw.prompt_forwarding)) {
    view.prompt_forwarding = raw.prompt_forwarding;
  }
  return view;
}

function projectSource(value: unknown): AttentionRenderSourceView | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const view: Record<string, unknown> = {};
  for (const field of renderSourceAllowlist) {
    if (!Object.hasOwn(raw, field)) {
      continue;
    }
    if (field === "capabilities") {
      const capabilities = projectCapabilities(raw[field]);
      if (capabilities) {
        view[field] = capabilities;
      }
      continue;
    }
    const projected = projectValue(raw[field]);
    if (projected !== undefined) {
      view[field] = projected;
    }
  }
  return view as AttentionRenderSourceView;
}

/**
 * Projects a record through {@link renderAllowlist}: unknown fields are dropped,
 * text values are capped, and nothing outside the allowlist can reach a card.
 */
export function projectAttentionRecord(record: AttentionRecord): AttentionRenderView {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return {};
  }
  const raw = record as unknown as Record<string, unknown>;
  const view: Record<string, unknown> = {};
  for (const field of renderAllowlist) {
    if (!Object.hasOwn(raw, field)) {
      continue;
    }
    if (field === "source") {
      const source = projectSource(raw[field]);
      if (source) {
        view[field] = source;
      }
      continue;
    }
    const projected = projectValue(raw[field]);
    if (projected !== undefined) {
      view[field] = projected;
    }
  }
  return view as AttentionRenderView;
}

const CLASS_ORDER: Record<AttentionPriorityClass, number> = {
  "urgent-risk": 0,
  "unblocks-work": 1,
  "current-head-merge": 2,
  "product-architecture": 3
};

/** Classes outside the schema enum sort after `product-architecture`. */
const UNKNOWN_CLASS_ORDER = 4;

function classOrder(record: AttentionRecord): number {
  const value: unknown = record.priority_class;
  if (typeof value === "string" && Object.hasOwn(CLASS_ORDER, value)) {
    return CLASS_ORDER[value as AttentionPriorityClass];
  }
  return UNKNOWN_CLASS_ORDER;
}

function urgentOrder(record: AttentionRecord): number {
  return record.priority_class === "urgent-risk" ? 0 : 1;
}

function carriesUnlocksCount(record: AttentionRecord): boolean {
  return typeof record.unlocks_count === "number" && Number.isFinite(record.unlocks_count);
}

function unlocksCountOrZero(record: AttentionRecord): number {
  return carriesUnlocksCount(record) ? (record.unlocks_count as number) : 0;
}

/** Instants, not spellings: the same moment written with different offsets ties. */
function createdAtInstant(record: AttentionRecord): number {
  const parsed = Date.parse(typeof record.created_at === "string" ? record.created_at : "");
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function compareText(left: unknown, right: unknown): number {
  const a = typeof left === "string" ? left : "";
  const b = typeof right === "string" ? right : "";
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Orders attention records for the desk: `urgent-risk` first, then either the
 * desk contract's `unlocks_count` order (when any record carries a count) or the
 * `attention-list` class order, and finally `created_at` then `id`. No other
 * field affects the order. Pure: the input array is never mutated and equal keys
 * keep their input order.
 */
export function rank(records: readonly AttentionRecord[]): AttentionRecord[] {
  const byUnlocksCount = records.some(carriesUnlocksCount);
  return [...records].sort((left, right) => {
    const urgent = urgentOrder(left) - urgentOrder(right);
    if (urgent !== 0) {
      return urgent;
    }
    if (byUnlocksCount) {
      const unlocks = unlocksCountOrZero(right) - unlocksCountOrZero(left);
      if (unlocks !== 0) {
        return unlocks < 0 ? -1 : 1;
      }
    } else {
      const classes = classOrder(left) - classOrder(right);
      if (classes !== 0) {
        return classes < 0 ? -1 : 1;
      }
    }
    const leftCreated = createdAtInstant(left);
    const rightCreated = createdAtInstant(right);
    if (leftCreated !== rightCreated) {
      return leftCreated < rightCreated ? -1 : 1;
    }
    if (!Number.isFinite(leftCreated)) {
      const unparsed = compareText(left.created_at, right.created_at);
      if (unparsed !== 0) {
        return unparsed;
      }
    }
    return compareText(left.id, right.id);
  });
}
