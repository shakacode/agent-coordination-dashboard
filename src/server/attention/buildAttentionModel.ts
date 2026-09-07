import {
  ATTENTION_TRUNCATION_MARKER,
  projectAttentionRecord,
  rank,
  validateAttentionTarget,
  type AttentionCapabilityState,
  type AttentionCardPayload,
  type AttentionDashboardHost,
  type AttentionDiagnosticPayload,
  type AttentionPayload,
  type AttentionRecord,
  type AttentionSourcePayload
} from "../../shared/attention";
import type { AttentionReadResult, AttentionRepositoryRead } from "./readAttentionRecords";

/**
 * Turn one attention read into the payload the read-only view renders.
 *
 * The module is pure: no I/O, no GitHub, no timers, no logging, no clock of its
 * own. Every input arrives in the read result or the options, so the same
 * inputs always produce the same payload, and a test can move the clock without
 * waiting.
 *
 * It never throws. The reader already drops anything that fails the record
 * schema, but a record with malformed fields is still dropped here rather than
 * rendered: every field is read through a total accessor, and a record that
 * cannot be modelled is suppressed with a diagnostic instead of raising.
 *
 * Suppression is the shape of every rule below. A record that must not render
 * never silently disappears: it leaves a diagnostic naming the record and the
 * reason, so the view can show a warning instead of a shorter list.
 */

/** Fallback refresh interval when a record does not carry one; PR 1b makes it a setting. */
export const ATTENTION_DEFAULT_REFRESH_INTERVAL_SECONDS = 900;

/** A record is stale once it is older than this many refresh intervals. */
export const ATTENTION_STALE_INTERVAL_MULTIPLE = 2;

/** A `refreshed_at` further ahead of the clock than this is rejected, not trusted. */
export const ATTENTION_CLOCK_SKEW_TOLERANCE_SECONDS = 300;

/** An open record older than this many days carries the verify flag. */
export const ATTENTION_OPEN_AGE_FLAG_DAYS = 7;

/** Rendered cards per repository; the rest are dropped by rank and reported. */
export const ATTENTION_CARD_CAP_PER_REPOSITORY = 100;

/** Resolved records per repository listed in the return-to trail. */
export const ATTENTION_RESOLVED_TRAIL_LENGTH = 20;

/** Resolved records per repository above which the payload warns. */
export const ATTENTION_RESOLVED_TOTAL_WARNING_THRESHOLD = 500;

/**
 * Diagnostic bounds. The payload is rendered in one page and cached whole, so a
 * repository whose records all fail one rule must not be able to grow it
 * without limit. Both caps end with a `diagnostics_truncated` entry naming what
 * was dropped, so a truncated list never looks like a complete one.
 */
export const ATTENTION_DIAGNOSTIC_CAP_PER_REPOSITORY = 100;

/** Diagnostics in the whole payload, repository-scoped and dashboard-wide alike. */
export const ATTENTION_DIAGNOSTIC_CAP_TOTAL = 200;

/** Characters per diagnostic message, marker included. */
export const ATTENTION_DIAGNOSTIC_MESSAGE_LIMIT = 500;

/** Characters per record value quoted inside a message, marker included. */
export const ATTENTION_MESSAGE_VALUE_LIMIT = 64;

/**
 * Every diagnostic kind this module raises. Reader diagnostics pass through
 * under their own kinds, so the payload's `kind` stays a plain string.
 */
export const ATTENTION_MODEL_DIAGNOSTIC_KINDS = [
  "resolved_recent",
  "resolved_total_warning",
  "producer_duplicate",
  "unknown_host",
  "dashboard_host_unknown",
  "cross_host_count",
  "stale_source",
  "stale_companion",
  "clock_skew",
  "open_age_flagged",
  "truncated",
  "diagnostics_truncated"
] as const;

export type AttentionModelDiagnosticKind = (typeof ATTENTION_MODEL_DIAGNOSTIC_KINDS)[number];

/** The two hosts a card may name; `UNKNOWN` belongs to the dashboard, never to a card. */
type AttentionCardHost = AttentionCardPayload["host"];

export interface BuildAttentionModelOptions {
  /** The dashboard's clock; freshness, open age, and `generated_at` all read it. */
  now: Date;
  /** `AGENT_COORD_MACHINE_ID`, or undefined when the dashboard does not know its host. */
  machineId?: string;
  /** Injectable for tests; defaults to {@link ATTENTION_DEFAULT_REFRESH_INTERVAL_SECONDS}. */
  defaultRefreshIntervalSeconds?: number;
  /** Injectable for tests; defaults to {@link ATTENTION_OPEN_AGE_FLAG_DAYS}. */
  openAgeFlagDays?: number;
  /** Injectable for tests; defaults to {@link ATTENTION_CARD_CAP_PER_REPOSITORY}. */
  cardCapPerRepository?: number;
  /** Injectable for tests; defaults to {@link ATTENTION_RESOLVED_TOTAL_WARNING_THRESHOLD}. */
  resolvedTotalWarningThreshold?: number;
  /** Injectable for tests; defaults to {@link ATTENTION_RESOLVED_TRAIL_LENGTH}. */
  resolvedTrailLength?: number;
  /** Injectable for tests; defaults to {@link ATTENTION_DIAGNOSTIC_CAP_PER_REPOSITORY}. */
  diagnosticCapPerRepository?: number;
}

interface ModelSettings {
  nowMs: number;
  defaultRefreshIntervalSeconds: number;
  openAgeFlagDays: number;
  cardCapPerRepository: number;
  resolvedTotalWarningThreshold: number;
  resolvedTrailLength: number;
  diagnosticCapPerRepository: number;
}

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86400000;

/**
 * Separator for the composite keys that group records. A NUL rather than a
 * printable character, so no pair of record values can be spelled to collide
 * with a different pair across the boundary.
 */
const KEY_SEPARATOR = "\u0000";

function resolveSettings(options: BuildAttentionModelOptions): ModelSettings {
  return {
    nowMs: options.now instanceof Date ? options.now.getTime() : Number.NaN,
    defaultRefreshIntervalSeconds:
      positiveFinite(options.defaultRefreshIntervalSeconds) ?? ATTENTION_DEFAULT_REFRESH_INTERVAL_SECONDS,
    openAgeFlagDays: options.openAgeFlagDays ?? ATTENTION_OPEN_AGE_FLAG_DAYS,
    cardCapPerRepository: options.cardCapPerRepository ?? ATTENTION_CARD_CAP_PER_REPOSITORY,
    resolvedTotalWarningThreshold:
      options.resolvedTotalWarningThreshold ?? ATTENTION_RESOLVED_TOTAL_WARNING_THRESHOLD,
    resolvedTrailLength: options.resolvedTrailLength ?? ATTENTION_RESOLVED_TRAIL_LENGTH,
    diagnosticCapPerRepository: options.diagnosticCapPerRepository ?? ATTENTION_DIAGNOSTIC_CAP_PER_REPOSITORY
  };
}

/**
 * A record's own fields, or an empty object when the value is not one.
 *
 * Every field read in this module goes through here, so a garbage record reads
 * as a record with no fields: each rule then fails it on its own terms and
 * reports it, rather than throwing on a property access.
 */
function fields(record: AttentionRecord): Record<string, unknown> {
  return typeof record === "object" && record !== null && !Array.isArray(record)
    ? (record as unknown as Record<string, unknown>)
    : {};
}

function sourceFields(record: AttentionRecord): Record<string, unknown> {
  const source: unknown = fields(record).source;
  return typeof source === "object" && source !== null && !Array.isArray(source)
    ? (source as Record<string, unknown>)
    : {};
}

function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function textOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Caps a value at `limit` characters, marker included, without splitting a surrogate pair. */
function capText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  let head = value.slice(0, limit - ATTENTION_TRUNCATION_MARKER.length);
  const lastUnit = head.charCodeAt(head.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return `${head}${ATTENTION_TRUNCATION_MARKER}`;
}

/**
 * A record value as message text: quoted and capped when it is a string, and
 * named by its type when it is not, so a malformed field is legible without the
 * message carrying an unbounded value.
 */
function quoted(value: unknown): string {
  if (typeof value === "string") {
    return `"${capText(value, ATTENTION_MESSAGE_VALUE_LIMIT)}"`;
  }
  if (value === undefined) {
    return "(missing)";
  }
  return value === null ? "(null)" : `(${typeof value})`;
}

/** The record's id for a message; a record with no usable id is still named. */
function idText(record: AttentionRecord): string {
  const id = textOrEmpty(fields(record).id);
  return id === "" ? "(unknown id)" : capText(id, ATTENTION_MESSAGE_VALUE_LIMIT);
}

/** Milliseconds since the epoch, or `NaN` for anything that is not a timestamp. */
function instant(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/**
 * `m5` and `M5` are the same host; anything else is not a host this dashboard
 * knows. Case folding is ASCII-only so no locale can map another letter onto
 * `M`.
 */
function normalizeHost(value: unknown): AttentionCardHost | null {
  if (typeof value !== "string") {
    return null;
  }
  const folded = value.trim().replace(/[a-z]/g, (letter) => letter.toUpperCase());
  return folded === "M5" || folded === "M1" ? folded : null;
}

function diagnostic(repository: string | null, kind: string, message: string): AttentionDiagnosticPayload {
  return { repository, kind, message: capText(message, ATTENTION_DIAGNOSTIC_MESSAGE_LIMIT) };
}

/** A record that survived every suppression, with what its card needs. */
interface Candidate {
  model: RepositoryModel;
  record: AttentionRecord;
  host: AttentionCardHost;
  /**
   * The record's target as {@link validateAttentionTarget} accepts it, or
   * `null` when the record does not point at its own pull request. This is the
   * value the same-pull-request rules relate cards by, never the raw field.
   */
  target: string | null;
  openDays: number;
  verifyOpenAge: boolean;
}

/** One repository's contribution to the payload, before ranking joins them. */
interface RepositoryModel {
  repository: string;
  source: AttentionSourcePayload;
  candidates: Candidate[];
  /** Reader diagnostics, then the resolved-total warning, then suppressions. */
  warnings: AttentionDiagnosticPayload[];
  /** Producer duplicates whose records all belong to this repository. */
  duplicates: AttentionDiagnosticPayload[];
  /** The card cap notice, filled in once ranking has decided what fits. */
  capNotice: AttentionDiagnosticPayload[];
  /** The return-to trail, last in the block so it never crowds out a warning. */
  trail: AttentionDiagnosticPayload[];
}

interface Suppression {
  kind: AttentionModelDiagnosticKind;
  message: string;
}

/**
 * Freshness against the dashboard clock.
 *
 * An unparseable timestamp is stale rather than fresh: a record whose age
 * cannot be established has not been shown to be current, and a producer that
 * stopped writing must not keep a card alive by writing a timestamp nobody can
 * read.
 */
function freshnessSuppressions(record: AttentionRecord, settings: ModelSettings): Suppression[] {
  const own = fields(record);
  const source = sourceFields(record);
  const intervalSeconds = positiveFinite(own.refresh_interval_seconds) ?? settings.defaultRefreshIntervalSeconds;
  const staleAfterMs = intervalSeconds * ATTENTION_STALE_INTERVAL_MULTIPLE * MS_PER_SECOND;
  const skewToleranceMs = ATTENTION_CLOCK_SKEW_TOLERANCE_SECONDS * MS_PER_SECOND;
  const id = idText(record);
  const suppressions: Suppression[] = [];

  const refreshedAt = instant(own.refreshed_at);
  if (!Number.isFinite(refreshedAt)) {
    suppressions.push({
      kind: "stale_source",
      message: `Record ${id} has an unreadable refreshed_at ${quoted(own.refreshed_at)}; the card is suppressed.`
    });
  } else if (refreshedAt - settings.nowMs > skewToleranceMs) {
    suppressions.push({
      kind: "clock_skew",
      message:
        `Record ${id} refreshed_at ${quoted(own.refreshed_at)} is more than ` +
        `${ATTENTION_CLOCK_SKEW_TOLERANCE_SECONDS} seconds ahead of the dashboard clock; the card is suppressed.`
    });
  } else if (settings.nowMs - refreshedAt > staleAfterMs) {
    suppressions.push({
      kind: "stale_source",
      message:
        `Record ${id} refreshed_at ${quoted(own.refreshed_at)} is older than twice its ` +
        `${intervalSeconds}-second refresh interval; the card is suppressed.`
    });
  }

  const lastSeenAt = instant(source.last_seen_at);
  if (!Number.isFinite(lastSeenAt)) {
    suppressions.push({
      kind: "stale_companion",
      message:
        `Record ${id} has an unreadable source.last_seen_at ${quoted(source.last_seen_at)}; ` +
        "the card is suppressed."
    });
  } else if (settings.nowMs - lastSeenAt > staleAfterMs) {
    suppressions.push({
      kind: "stale_companion",
      message:
        `Record ${id} source.last_seen_at ${quoted(source.last_seen_at)} is older than twice its ` +
        `${intervalSeconds}-second refresh interval; the card is suppressed.`
    });
  }

  return suppressions;
}

/** Whole days open, floored, and never negative for a record created in the future. */
function openDaysFor(record: AttentionRecord, settings: ModelSettings): number {
  const createdAt = instant(fields(record).created_at);
  if (!Number.isFinite(createdAt) || !Number.isFinite(settings.nowMs)) {
    return 0;
  }
  const days = Math.floor((settings.nowMs - createdAt) / MS_PER_DAY);
  return days > 0 ? days : 0;
}

/** Newest first by `resolved_at`, then by id, with unreadable instants last. */
function compareResolved(left: AttentionRecord, right: AttentionRecord): number {
  const leftAt = instant(fields(left).resolved_at);
  const rightAt = instant(fields(right).resolved_at);
  const leftKey = Number.isFinite(leftAt) ? leftAt : Number.NEGATIVE_INFINITY;
  const rightKey = Number.isFinite(rightAt) ? rightAt : Number.NEGATIVE_INFINITY;
  if (leftKey !== rightKey) {
    return leftKey > rightKey ? -1 : 1;
  }
  const leftId = textOrEmpty(fields(left).id);
  const rightId = textOrEmpty(fields(right).id);
  if (leftId === rightId) {
    return 0;
  }
  return leftId < rightId ? -1 : 1;
}

function resolvedTrailMessage(record: AttentionRecord): string {
  const own = fields(record);
  // The same validator the projection applies, so a trail entry can never name
  // a URL a card would have refused to link.
  const target = validateAttentionTarget(own.target, own.repository);
  // The URL is not capped separately: it is already a validated pull request
  // URL, and the message cap bounds the whole line.
  return `Resolved ${idText(record)} at ${quoted(own.resolved_at)}: ${target ?? "no valid target"}.`;
}

/**
 * One repository's open filter, host and freshness suppressions, resolved
 * trail, and source status. Ranking, the card cap, and the duplicate scan need
 * every repository at once, so they run afterwards.
 */
function buildRepositoryModel(read: AttentionRepositoryRead, settings: ModelSettings): RepositoryModel {
  const repository = textOrEmpty(read.repository);
  const readerDiagnostics = Array.isArray(read.diagnostics) ? read.diagnostics : [];
  const status = read.sourceStatus?.status ?? "unreachable";
  const firstReason = textOrEmpty(readerDiagnostics[0]?.reason);
  // A status the operator can act on carries the first reader reason; `ok` and
  // `empty` are not failures, so they carry no message.
  const message =
    (status === "auth_error" || status === "unreachable") && firstReason !== ""
      ? { message: capText(firstReason, ATTENTION_DIAGNOSTIC_MESSAGE_LIMIT) }
      : {};

  const model: RepositoryModel = {
    repository,
    source: {
      repository,
      mode: read.mode === "api" ? "api" : "fs",
      status,
      checked_at: textOrEmpty(read.sourceStatus?.checkedAt),
      partial: read.partial === true,
      truncated: false,
      resolved_total: 0,
      ...message
    },
    candidates: [],
    warnings: [],
    duplicates: [],
    capNotice: [],
    trail: []
  };

  for (const readerDiagnostic of readerDiagnostics) {
    // Every reader diagnostic already belongs to this repository, so it keeps
    // its own kind and joins this repository's block under its storage path.
    model.warnings.push(
      diagnostic(repository, readerDiagnostic.kind, `${readerDiagnostic.path}: ${readerDiagnostic.reason}`)
    );
  }

  const open: AttentionRecord[] = [];
  const resolved: AttentionRecord[] = [];
  for (const record of Array.isArray(read.records) ? read.records : []) {
    const lifecycle: unknown = fields(record).status;
    if (lifecycle === "open") {
      open.push(record);
    } else if (lifecycle === "resolved") {
      resolved.push(record);
    }
    // A value that claims neither status is not a record this view models; it
    // cannot become a card, and there is no lifecycle to report it under.
  }

  model.source.resolved_total = resolved.length;
  if (resolved.length > settings.resolvedTotalWarningThreshold) {
    model.warnings.push(
      diagnostic(
        repository,
        "resolved_total_warning",
        `Repository ${repository} has ${resolved.length} resolved attention records, over the ` +
          `${settings.resolvedTotalWarningThreshold}-record warning threshold.`
      )
    );
  }

  for (const record of open) {
    const host = normalizeHost(sourceFields(record).host_id);
    if (host === null) {
      // The host decides where the record can be answered, so a record that
      // does not name one this dashboard knows is reported instead of rendered.
      // It is also the first check, so a record with nothing usable in it is
      // reported once rather than once per rule it fails.
      model.warnings.push(
        diagnostic(
          repository,
          "unknown_host",
          `Record ${idText(record)} names host ${quoted(sourceFields(record).host_id)}, which is neither M5 nor M1; ` +
            "the card is suppressed."
        )
      );
      continue;
    }
    const suppressions = freshnessSuppressions(record, settings);
    if (suppressions.length > 0) {
      for (const suppression of suppressions) {
        model.warnings.push(diagnostic(repository, suppression.kind, suppression.message));
      }
      continue;
    }
    const openDays = openDaysFor(record, settings);
    const own = fields(record);
    model.candidates.push({
      model,
      record,
      host,
      // The same validator the projection applies, so the card and the rules
      // that relate cards agree on what this record points at.
      target: validateAttentionTarget(own.target, own.repository),
      openDays,
      verifyOpenAge: openDays > settings.openAgeFlagDays
    });
  }

  // The reader's array is never sorted in place: it belongs to the caller.
  for (const record of [...resolved].sort(compareResolved).slice(0, settings.resolvedTrailLength)) {
    model.trail.push(diagnostic(repository, "resolved_recent", resolvedTrailMessage(record)));
  }

  return model;
}

/**
 * Rank every repository's candidates in one call, so the order that decides the
 * per-repository cap is the order the cards are rendered in. `rank` returns
 * records, so candidates are matched back through a per-record queue: two
 * candidates may hold the same record object, and equal keys keep their input
 * order, so the queue hands them back in that order.
 */
function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  const queues = new Map<AttentionRecord, Candidate[]>();
  for (const candidate of candidates) {
    const queue = queues.get(candidate.record);
    if (queue === undefined) {
      queues.set(candidate.record, [candidate]);
    } else {
      queue.push(candidate);
    }
  }
  const ordered: Candidate[] = [];
  for (const record of rank(candidates.map((candidate) => candidate.record))) {
    const next = queues.get(record)?.shift();
    if (next !== undefined) {
      ordered.push(next);
    }
  }
  return ordered;
}

/**
 * The grouping key for the same-pull-request rules: exact equality of the
 * validated target.
 *
 * Two cards are related only by a link the projection accepted. Keying on the
 * raw field instead would let a rejected `javascript:` target, or one naming
 * another repository's pull request, relate two cards that the view cannot
 * even link to the same place, and would let a record claim kinship with
 * another repository's records by spelling their target.
 */
function targetKey(candidate: Candidate): string | null {
  return candidate.target;
}

interface AdjacencyResult {
  order: Candidate[];
  samePr: Set<Candidate>;
}

/**
 * Keep same-target records together without changing which record leads.
 *
 * Each group is emitted at the position of its highest-ranked member and keeps
 * its internal rank order, so a reader who answers one question about a pull
 * request sees the rest of them next rather than scattered down the list.
 */
function applySameTargetAdjacency(ranked: readonly Candidate[]): AdjacencyResult {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of ranked) {
    const key = targetKey(candidate);
    if (key === null) {
      continue;
    }
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [candidate]);
    } else {
      group.push(candidate);
    }
  }

  const placed = new Set<Candidate>();
  const order: Candidate[] = [];
  for (const candidate of ranked) {
    if (placed.has(candidate)) {
      continue;
    }
    const key = targetKey(candidate);
    const group = key === null ? [candidate] : (groups.get(key) ?? [candidate]);
    for (const member of group) {
      if (placed.has(member)) {
        continue;
      }
      placed.add(member);
      order.push(member);
    }
  }

  const samePr = new Set<Candidate>();
  for (const group of groups.values()) {
    if (group.length > 1) {
      for (const member of group) {
        samePr.add(member);
      }
    }
  }
  return { order, samePr };
}

/** Which producer wrote a record: the pair the duplicate rule compares. */
function producerKey(record: AttentionRecord): string {
  const source = sourceFields(record);
  return `${textOrEmpty(source.host_id)}${KEY_SEPARATOR}${textOrEmpty(source.task_id)}`;
}

/**
 * Rendered cards that ask the same question about the same pull request from
 * different producers.
 *
 * Both still render: the model cannot tell which producer is authoritative, and
 * dropping one would hide a live question. The diagnostic is what tells the
 * operator that two control towers are writing the same decision.
 *
 * The pull request is the validated target, so a record whose link the
 * projection rejected is never anyone's duplicate: it points at nothing this
 * view can open, and a producer could otherwise be accused of duplicating a
 * question it never answered by another producer spelling its target.
 */
function producerDuplicateGroups(order: readonly Candidate[]): Candidate[][] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of order) {
    const target = targetKey(candidate);
    const question: unknown = fields(candidate.record).question;
    if (target === null || typeof question !== "string") {
      continue;
    }
    const key = `${target}${KEY_SEPARATOR}${question}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [candidate]);
    } else {
      group.push(candidate);
    }
  }
  return [...groups.values()].filter(
    (group) => group.length > 1 && new Set(group.map((member) => producerKey(member.record))).size > 1
  );
}

function duplicateDiagnostic(group: readonly Candidate[]): AttentionDiagnosticPayload {
  const ids = group.map((member) => idText(member.record)).join(", ");
  const repositories = new Set(group.map((member) => member.model.repository));
  const target = quoted(group[0].target);
  return diagnostic(
    // One repository owns the duplicate only when every record in it does;
    // otherwise it is a dashboard-wide observation, not one repository's.
    repositories.size === 1 ? group[0].model.repository : null,
    "producer_duplicate",
    `Records ${ids} ask the same question about target ${target} from different sources; each one still renders.`
  );
}

/** Caps one block and marks what it dropped, so a short list is never silent. */
function capDiagnostics(
  block: readonly AttentionDiagnosticPayload[],
  cap: number,
  repository: string | null
): AttentionDiagnosticPayload[] {
  if (block.length <= cap) {
    return [...block];
  }
  const dropped = block.length - cap;
  const scope = repository === null ? "The payload" : `Repository ${repository}`;
  return [
    ...block.slice(0, cap),
    diagnostic(
      repository,
      "diagnostics_truncated",
      `${scope} raised ${dropped} more diagnostics than the ${cap} shown.`
    )
  ];
}

/**
 * Build the attention payload. Pure and total: the same read and options always
 * produce the same payload, and no input throws.
 */
export function buildAttentionModel(
  input: AttentionReadResult,
  options: BuildAttentionModelOptions
): AttentionPayload {
  const settings = resolveSettings(options);
  const reads: readonly AttentionRepositoryRead[] = Array.isArray(input?.repositories) ? input.repositories : [];
  const models = reads.map((read) => buildRepositoryModel(read, settings));

  const dashboardHost: AttentionDashboardHost = normalizeHost(options.machineId) ?? "UNKNOWN";
  const dashboardDiagnostics: AttentionDiagnosticPayload[] = [];
  if (dashboardHost === "UNKNOWN") {
    // The view still renders every card; it just cannot claim any of them are
    // answerable here, so the unknown host is stated rather than assumed.
    dashboardDiagnostics.push(
      diagnostic(
        null,
        "dashboard_host_unknown",
        options.machineId === undefined
          ? "The dashboard machine id is not set, so the dashboard host is UNKNOWN."
          : `The dashboard machine id ${quoted(options.machineId)} is neither M5 nor M1, ` +
            "so the dashboard host is UNKNOWN."
      )
    );
  }

  const ranked = rankCandidates(models.flatMap((model) => model.candidates));

  // The cap keeps each repository's highest-ranked records: it walks the one
  // ranked order the cards are rendered in, so a dropped record never outranks
  // a kept one.
  const kept: Candidate[] = [];
  const keptPerRepository = new Map<RepositoryModel, number>();
  const droppedPerRepository = new Map<RepositoryModel, number>();
  for (const candidate of ranked) {
    const count = keptPerRepository.get(candidate.model) ?? 0;
    if (count >= settings.cardCapPerRepository) {
      droppedPerRepository.set(candidate.model, (droppedPerRepository.get(candidate.model) ?? 0) + 1);
      continue;
    }
    keptPerRepository.set(candidate.model, count + 1);
    kept.push(candidate);
  }
  for (const [model, dropped] of droppedPerRepository) {
    model.source.truncated = true;
    model.capNotice.push(
      diagnostic(
        model.repository,
        "truncated",
        `Repository ${model.repository} kept the ${settings.cardCapPerRepository} highest-ranked open records ` +
          `and dropped ${dropped}.`
      )
    );
  }

  const { order, samePr } = applySameTargetAdjacency(kept);

  const cards: AttentionCardPayload[] = order.map((candidate, index) => {
    // The projection is the only path record text or a link takes to a card.
    const view = projectAttentionRecord(candidate.record);
    const nativeOpen: AttentionCapabilityState = view.source?.capabilities?.native_open ?? "unknown";
    return {
      number: index + 1,
      // The id comes off the projection too, so the card carries one capped
      // copy of it rather than a capped one inside `record` and a raw one
      // beside it. A record whose id is not text still renders with an empty
      // id, exactly as it did when the raw record was read.
      id: textOrEmpty(view.id),
      repository: candidate.model.repository,
      record: view,
      host: candidate.host,
      host_matches: candidate.host === dashboardHost,
      native_open: nativeOpen,
      same_pr: samePr.has(candidate),
      open_days: candidate.openDays,
      verify_open_age: candidate.verifyOpenAge
    };
  });

  const crossRepositoryDuplicates: AttentionDiagnosticPayload[] = [];
  for (const group of producerDuplicateGroups(order)) {
    const entry = duplicateDiagnostic(group);
    if (entry.repository === null) {
      crossRepositoryDuplicates.push(entry);
    } else {
      group[0].model.duplicates.push(entry);
    }
  }

  const crossHostCount = cards.filter((card) => !card.host_matches).length;
  const flaggedCount = cards.filter((card) => card.verify_open_age).length;
  const totals: AttentionDiagnosticPayload[] = [];
  if (crossHostCount > 0) {
    totals.push(
      diagnostic(
        null,
        "cross_host_count",
        `${crossHostCount} of ${cards.length} rendered cards belong to another host.`
      )
    );
  }
  if (flaggedCount > 0) {
    totals.push(
      diagnostic(
        null,
        "open_age_flagged",
        `${flaggedCount} rendered cards have been open longer than ${settings.openAgeFlagDays} days.`
      )
    );
  }

  const diagnostics = capDiagnostics(
    [
      // The payload-wide block leads, for the reason the resolved trail comes
      // last inside a repository block: the payload cap must drop the entries
      // that carry the least. This block is bounded by the number of
      // repositories rather than by the number of records, and a
      // cross-repository `producer_duplicate` is the only place the payload
      // records that two producers are asking the same question, while one
      // more read failure among hundreds names a path the rest already
      // characterize.
      ...dashboardDiagnostics,
      ...crossRepositoryDuplicates,
      ...totals,
      // Then one contiguous block per repository, each capped on its own: read
      // failures first, then this repository's suppressions and notices, and
      // the resolved trail last so it can never crowd out a warning.
      ...models.flatMap((model) =>
        capDiagnostics(
          [...model.warnings, ...model.duplicates, ...model.capNotice, ...model.trail],
          settings.diagnosticCapPerRepository,
          model.repository
        )
      )
    ],
    ATTENTION_DIAGNOSTIC_CAP_TOTAL,
    null
  );

  return {
    // A clock that is not a usable date leaves the field empty rather than
    // throwing; the view renders UNKNOWN for it, as it does for any value it
    // cannot read.
    generated_at: Number.isFinite(settings.nowMs) ? new Date(settings.nowMs).toISOString() : "",
    dashboard_host: dashboardHost,
    cards,
    sources: models.map((model) => model.source),
    diagnostics
  };
}
