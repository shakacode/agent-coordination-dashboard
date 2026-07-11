import type {
  BatchEvent,
  BatchLane,
  BatchOperation,
  BatchRecord,
  ClaimRecord,
  DashboardModel,
  HeartbeatRecord,
  Liveness,
  WorkItem,
  WorkItemType
} from "../shared/types";
import { isQaEventType } from "../shared/qaEvents";

export const UNKNOWN = "UNKNOWN";
export const WEDGED_THRESHOLD_MS = 15 * 60 * 1000;

export type OperatorState = "running" | "wedged" | "paused" | "blocked" | "stale" | "dead" | "ready" | "done" | "unknown";
export type OperatorRowSource = "target" | "lane" | "batch";
export type OverviewOperatorFilter = "ready_for_batch" | "needs_recovery" | "processing_now" | "qa_attention" | "batch_repair";

export const OVERVIEW_OPERATOR_FILTER_LABELS: Record<OverviewOperatorFilter, string> = {
  ready_for_batch: "Ready for batch",
  needs_recovery: "Claimed, not processing",
  processing_now: "Processing now",
  qa_attention: "QA needs attention",
  batch_repair: "Batch repair"
};

export interface OperatorDeepLink {
  batchId?: string;
  laneName?: string;
  repo?: string;
  target?: string;
  query?: string;
  overviewFilter?: OverviewOperatorFilter;
}

export interface OperatorRow {
  id: string;
  source: OperatorRowSource;
  repo: string;
  target?: string;
  type: WorkItemType;
  title: string;
  url?: string;
  operatorState: OperatorState;
  liveness: Liveness | "none";
  livenessAge: string;
  activityStatus: string;
  activityMessage?: string;
  lastActivityAt?: string;
  lastActivityAge: string;
  lastEventAt?: string;
  heartbeatUpdatedAt?: string;
  batchId?: string;
  batchPath?: string;
  laneName?: string;
  dependencies: string[];
  blockedOn: string[];
  agentId?: string;
  machineId?: string;
  threadHandle?: string;
  host?: string;
  operator?: string;
  branch?: string;
  prUrl?: string;
  warnings: string[];
  searchText: string;
}

interface BuildOperatorRowsOptions {
  now?: Date | string;
}

interface MetadataSource {
  agentId?: string;
  machineId?: string;
  threadHandle?: string;
  host?: string;
  operator?: string;
  branch?: string;
  prUrl?: string;
}

const DONE_PATTERN = /\b(complete|completed|done|merged|closed|passed|released)\b/i;
const PAUSED_PATTERN =
  /\b(paused?|token[_\-\s]?limit(?:[_\-\s]?pause)?|context[_\-\s]?limit(?:[_\-\s]?pause)?|context[_\-\s]?window)\b/i;
const BLOCKED_PATTERN = /\b(blocked|blocking|waiting|needs[_\-\s]?changes|changes[_\-\s]?requested)\b/i;
const READY_PATTERN = /\b(ready|queued|pending)\b/i;
const ACTIVE_LANE_PATTERN = /\b(in_progress|running|coding|working|started|validating)\b/i;

function firstValue(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value?.trim()));
}

function timestampMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function maxTimestamp(...values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => timestampMs(right) - timestampMs(left))[0];
}

function latestEvent(events: BatchEvent[]): BatchEvent | undefined {
  return [...events].sort((left, right) => timestampMs(right.timestamp) - timestampMs(left.timestamp))[0];
}

function ageLabel(value: string | undefined, nowMs: number): string {
  const valueMs = timestampMs(value);
  if (!valueMs) {
    return UNKNOWN;
  }
  const diffSeconds = Math.max(0, Math.floor((nowMs - valueMs) / 1000));
  if (diffSeconds < 60) {
    return `${diffSeconds}s`;
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  return `${Math.floor(diffHours / 24)}d`;
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function searchTarget(query: string): string | undefined {
  const match = normalizeSearch(query).match(/^(?:pr|pull request|issue)?\s*#?\s*(\d+)$/);
  return match?.[1];
}

function repoTargetKey(repo: string | undefined, target: string | undefined): string | undefined {
  return repo && target ? `${repo}#${target}` : undefined;
}

function uniqueManifestRepoForTarget(batch: BatchRecord, target: string): string | undefined {
  const repos = new Set(
    (batch.targets || [])
      .filter((batchTarget) => batchTarget.target === target)
      .map((batchTarget) => batchTarget.repo)
      .filter((repo): repo is string => Boolean(repo))
  );
  return repos.size === 1 ? Array.from(repos)[0] : undefined;
}

function targetTypeFromBatch(batch: BatchRecord, target: string): WorkItemType {
  return batch.targets?.find((batchTarget) => batchTarget.target === target)?.type || "unknown";
}

function targetTitleFromBatch(batch: BatchRecord, target: string): string | undefined {
  return batch.targets?.find((batchTarget) => batchTarget.target === target)?.title;
}

function targetUrlFromBatch(batch: BatchRecord, target: string): string | undefined {
  return batch.targets?.find((batchTarget) => batchTarget.target === target)?.url;
}

function metadataFrom(...sources: Array<MetadataSource | undefined>): MetadataSource {
  return {
    agentId: firstValue(...sources.map((source) => source?.agentId)),
    machineId: firstValue(...sources.map((source) => source?.machineId)),
    threadHandle: firstValue(...sources.map((source) => source?.threadHandle)),
    host: firstValue(...sources.map((source) => source?.host)),
    operator: firstValue(...sources.map((source) => source?.operator)),
    branch: firstValue(...sources.map((source) => source?.branch)),
    prUrl: firstValue(...sources.map((source) => source?.prUrl))
  };
}

function laneMetadata(lane: BatchLane | undefined): MetadataSource | undefined {
  if (!lane) {
    return undefined;
  }
  return {
    agentId: lane.owner,
    threadHandle: lane.threadHandle,
    host: lane.host,
    operator: lane.operator,
    branch: lane.branch,
    prUrl: lane.prUrl
  };
}

function eventMetadata(event: BatchEvent | undefined): MetadataSource | undefined {
  if (!event) {
    return undefined;
  }
  return {
    agentId: event.agentId,
    machineId: event.machineId,
    threadHandle: event.threadHandle,
    host: event.host,
    operator: event.operator,
    branch: event.branch,
    prUrl: event.prUrl
  };
}

function stateText(values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function deriveOperatorState(input: {
  workItem?: WorkItem;
  heartbeat?: HeartbeatRecord;
  claim?: ClaimRecord;
  lane?: BatchLane;
  event?: BatchEvent;
  transitionEvent?: BatchEvent;
  signalStatus?: string;
  liveness?: Liveness | "none";
  blockedOn: string[];
  nowMs: number;
}): OperatorState {
  const eventDrivesOperatorState = !input.event || !isQaEventType(input.event.type);
  const text = stateText([
    input.workItem?.schedulingState,
    input.heartbeat?.status,
    input.claim?.status,
    input.lane?.status,
    eventDrivesOperatorState ? input.event?.type : undefined,
    eventDrivesOperatorState ? input.event?.status : undefined,
    input.signalStatus
  ]);

  const hasReadySignal = input.workItem?.schedulingState === "ready_for_batch" || READY_PATTERN.test(text);
  const hasActiveClaim = Boolean(input.claim && input.claim.status !== "released");
  const liveness = input.heartbeat?.liveness || input.liveness;

  if (DONE_PATTERN.test(text)) {
    return "done";
  }
  if (PAUSED_PATTERN.test(text)) {
    return "paused";
  }
  if (input.blockedOn.length > 0 || BLOCKED_PATTERN.test(text)) {
    return "blocked";
  }
  if (liveness === "dead") {
    return "dead";
  }
  if (liveness === "stale") {
    return "stale";
  }
  if (liveness === "live") {
    const transitionAt = input.transitionEvent?.timestamp || input.heartbeat?.updatedAt;
    if (timestampMs(transitionAt) > 0 && input.nowMs - timestampMs(transitionAt) >= WEDGED_THRESHOLD_MS) {
      return "wedged";
    }
    return "running";
  }
  if (!input.claim && !input.heartbeat && hasReadySignal) {
    return "ready";
  }
  if (input.workItem?.schedulingState === "started_not_processing" || hasActiveClaim) {
    return "dead";
  }
  if (input.lane && liveness === "no-heartbeat" && ACTIVE_LANE_PATTERN.test(text)) {
    return "dead";
  }
  if (input.heartbeat) {
    return "unknown";
  }
  if (hasReadySignal) {
    return "ready";
  }
  return "unknown";
}

function isActiveOperatorState(state: OperatorState): boolean {
  return ["running", "wedged", "paused", "blocked", "stale", "dead"].includes(state);
}

function metadataWarnings(row: Pick<OperatorRow, "operatorState" | "type" | "threadHandle" | "operator" | "host" | "prUrl">): string[] {
  if (!isActiveOperatorState(row.operatorState)) {
    return [];
  }
  return [
    row.threadHandle ? "" : "Thread UNKNOWN",
    row.operator ? "" : "Operator UNKNOWN",
    row.host ? "" : "Host UNKNOWN",
    row.type === "pull_request" && !row.prUrl ? "PR URL UNKNOWN" : ""
  ].filter(Boolean);
}

function rowSearchText(row: Omit<OperatorRow, "searchText">): string {
  return normalizeSearch(
    [
      row.repo,
      row.target,
      row.target ? `#${row.target}` : "",
      row.type === "pull_request" && row.target ? `pr #${row.target}` : "",
      row.type === "issue" && row.target ? `issue #${row.target}` : "",
      row.title,
      row.url,
      row.operatorState,
      row.liveness,
      row.activityStatus,
      row.activityMessage,
      row.batchId,
      row.batchPath,
      row.laneName,
      row.dependencies.join(" "),
      row.blockedOn.join(" "),
      row.agentId,
      row.machineId,
      row.threadHandle,
      row.host,
      row.operator,
      row.branch,
      row.prUrl,
      row.warnings.join(" ")
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function rowSortRank(row: OperatorRow): number {
  const ranks: Record<OperatorState, number> = {
    blocked: 0,
    wedged: 1,
    dead: 2,
    stale: 3,
    paused: 4,
    running: 5,
    ready: 6,
    unknown: 7,
    done: 8
  };
  return ranks[row.operatorState];
}

function targetSortValue(target: string | undefined): number {
  if (!target) {
    return Number.MAX_SAFE_INTEGER;
  }
  const numeric = Number(target);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
}

function sortRows(rows: OperatorRow[], targetRepos: string[]): OperatorRow[] {
  const repoRanks = new Map(targetRepos.map((repo, index) => [repo, index]));
  return [...rows].sort((left, right) => {
    const rankDelta = rowSortRank(left) - rowSortRank(right);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    const repoDelta = (repoRanks.get(left.repo) ?? 9999) - (repoRanks.get(right.repo) ?? 9999);
    if (repoDelta !== 0) {
      return repoDelta;
    }
    const repoNameDelta = left.repo.localeCompare(right.repo);
    if (repoNameDelta !== 0) {
      return repoNameDelta;
    }
    const targetDelta = targetSortValue(left.target) - targetSortValue(right.target);
    if (targetDelta !== 0) {
      return targetDelta;
    }
    return left.id.localeCompare(right.id);
  });
}

function activeBatchIdsForWork(item: WorkItem): Set<string> {
  const claimBatchId = item.claim && item.claim.status !== "released" ? item.claim.batchId : undefined;
  if (claimBatchId) {
    return new Set([claimBatchId]);
  }
  const heartbeatBatchId = item.heartbeat && ["live", "stale"].includes(item.heartbeat.liveness) ? item.heartbeat.batchId : undefined;
  return new Set([heartbeatBatchId].filter((batchId): batchId is string => Boolean(batchId)));
}

function hasActiveWorkSignal(item: WorkItem): boolean {
  return Boolean(item.heartbeat || (item.claim && item.claim.status !== "released"));
}

function currentBatchIdsForWork(item: WorkItem): Set<string> {
  const activeBatchIds = activeBatchIdsForWork(item);
  if (activeBatchIds.size > 0) {
    return activeBatchIds;
  }
  if (hasActiveWorkSignal(item)) {
    return activeBatchIds;
  }
  return new Set(
    (item.batchSignals || []).map((signal) => signal.batchId).filter((batchId): batchId is string => Boolean(batchId))
  );
}

function eventMatchesCurrentWorkBatch(item: WorkItem, event: BatchEvent): boolean {
  if (!event.batchId) {
    return true;
  }
  const batchIds = currentBatchIdsForWork(item);
  return batchIds.has(event.batchId);
}

function matchingEventsForWork(item: WorkItem, events: BatchEvent[]): BatchEvent[] {
  const signals = item.batchSignals || [];
  return events.filter((event) => {
    const targetMatch =
      event.target === item.target &&
      (!event.repo || event.repo === item.repo) &&
      eventMatchesCurrentWorkBatch(item, event);
    const laneMatch =
      !event.target &&
      (!event.repo || event.repo === item.repo) &&
      eventMatchesCurrentWorkBatch(item, event) &&
      signals.some((signal) => event.batchId === signal.batchId && event.laneName === signal.laneName);
    return targetMatch || laneMatch;
  });
}

function latestTransitionEvent(events: BatchEvent[]): BatchEvent | undefined {
  return latestEvent(events.filter((event) => !isQaEventType(event.type)));
}

function preferredSignalForWork(item: WorkItem) {
  const signals = item.batchSignals || [];
  const activeBatchIds = activeBatchIdsForWork(item);
  if (activeBatchIds.size > 0) {
    const activeSignal = signals.find((signal) => activeBatchIds.has(signal.batchId));
    if (activeSignal) {
      return activeSignal;
    }
  }
  if (hasActiveWorkSignal(item)) {
    return undefined;
  }
  return (
    signals.find((signal) => READY_PATTERN.test(signal.status)) ||
    signals.find((signal) => !DONE_PATTERN.test(signal.status) && !BLOCKED_PATTERN.test(signal.status)) ||
    signals[0]
  );
}

function eventMatchesBatchRecord(batch: BatchRecord, event: BatchEvent): boolean {
  if (event.batchId !== batch.batchId) {
    return false;
  }
  if (event.batchPath && event.batchPath !== batch.path) {
    return false;
  }
  if (event.repo && batch.repo && event.repo !== batch.repo) {
    return false;
  }
  return true;
}

function matchingEventsForLane(batch: BatchRecord, lane: BatchLane, events: BatchEvent[]): BatchEvent[] {
  return events.filter((event) => {
    if (!eventMatchesBatchRecord(batch, event)) {
      return false;
    }
    if (event.laneName === lane.name) {
      return true;
    }
    if (!event.target || !lane.targets.includes(event.target)) {
      return false;
    }
    const targetRepo = uniqueManifestRepoForTarget(batch, event.target) || batch.repo;
    return !event.repo || !targetRepo || event.repo === targetRepo;
  });
}

function batchContainsWork(batch: BatchRecord, item: WorkItem, lane: BatchLane): boolean {
  if (!lane.targets.includes(item.target)) {
    return batch.repo === item.repo;
  }
  const targetRepo = uniqueManifestRepoForTarget(batch, item.target) || batch.repo;
  return !targetRepo || targetRepo === item.repo;
}

function findSignalLane(item: WorkItem, batches: BatchRecord[]): { batch?: BatchRecord; lane?: BatchLane } {
  const signal = preferredSignalForWork(item);
  if (!signal) {
    return {};
  }
  const batch = batches.find((candidate) => {
    if (candidate.batchId !== signal.batchId) {
      return false;
    }
    const lane = candidate.lanes.find((candidateLane) => candidateLane.name === signal.laneName);
    return Boolean(lane && batchContainsWork(candidate, item, lane));
  });
  return {
    batch,
    lane: batch?.lanes.find((lane) => lane.name === signal.laneName)
  };
}

function workTitle(item: WorkItem): string {
  return item.github?.title || `${item.type === "pull_request" ? "Pull request" : item.type === "issue" ? "Issue" : "Target"} #${item.target}`;
}

function batchTargetForWork(batch: BatchRecord | undefined, item: WorkItem): NonNullable<BatchRecord["targets"]>[number] | undefined {
  return batch?.targets?.find((target) => {
    if (target.target !== item.target) {
      return false;
    }
    const targetRepo = target.repo || batch.repo;
    return !targetRepo || targetRepo === item.repo;
  });
}

function buildTargetRow(item: WorkItem, dashboard: DashboardModel, nowMs: number): OperatorRow {
  const matchingEvents = matchingEventsForWork(item, dashboard.events);
  const latest = latestEvent(matchingEvents);
  const transitionEvent = latestTransitionEvent(matchingEvents);
  const { batch, lane } = findSignalLane(item, dashboard.batches);
  const signal = preferredSignalForWork(item);
  const batchTarget = batchTargetForWork(batch, item);
  const blockedOn = [...(signal?.blockedOn || []), ...(lane?.blockedOn || [])].filter(Boolean);
  const metadata = metadataFrom(item.claim, item.heartbeat, laneMetadata(lane), eventMetadata(latest));
  const state = deriveOperatorState({
    workItem: item,
    heartbeat: item.heartbeat,
    claim: item.claim,
    lane,
    event: latest,
    transitionEvent,
    signalStatus: signal?.status,
    blockedOn,
    nowMs
  });
  const lastActivityAt = maxTimestamp(latest?.timestamp, item.heartbeat?.updatedAt, item.claim?.updatedAt);
  const baseRow: Omit<OperatorRow, "searchText"> = {
    id: `target:${item.repo}#${item.target}`,
    source: "target",
    repo: item.repo,
    target: item.target,
    type: item.type === "unknown" ? batchTarget?.type || "unknown" : item.type,
    title: item.github?.title || batchTarget?.title || workTitle(item),
    url: item.github?.url || batchTarget?.url,
    operatorState: state,
    liveness: item.heartbeat?.liveness || "none",
    livenessAge: ageLabel(item.heartbeat?.updatedAt, nowMs),
    activityStatus: firstValue(latest?.status, latest?.type, item.heartbeat?.status, signal?.status, lane?.status, item.schedulingState) || UNKNOWN,
    activityMessage: latest?.message,
    lastActivityAt,
    lastActivityAge: ageLabel(lastActivityAt, nowMs),
    lastEventAt: latest?.timestamp,
    heartbeatUpdatedAt: item.heartbeat?.updatedAt,
    batchId: signal?.batchId || item.claim?.batchId || item.heartbeat?.batchId || batch?.batchId,
    batchPath: batch?.path,
    laneName: signal?.laneName || lane?.name,
    dependencies: lane?.dependsOn || [],
    blockedOn,
    agentId: metadata.agentId,
    machineId: metadata.machineId,
    threadHandle: metadata.threadHandle,
    host: metadata.host,
    operator: metadata.operator,
    branch: metadata.branch,
    prUrl: metadata.prUrl,
    warnings: item.warnings.map((warning) => warning.message)
  };
  const warnings = [...baseRow.warnings, ...metadataWarnings(baseRow)];
  const row = { ...baseRow, warnings };
  return { ...row, searchText: rowSearchText(row) };
}

function buildLaneRow(batch: BatchRecord, lane: BatchLane, events: BatchEvent[], nowMs: number): OperatorRow {
  const matchingEvents = matchingEventsForLane(batch, lane, events);
  const latest = latestEvent(matchingEvents);
  const transitionEvent = latestTransitionEvent(matchingEvents);
  const firstTarget = lane.targets[0];
  const repo = (firstTarget && uniqueManifestRepoForTarget(batch, firstTarget)) || batch.repo || UNKNOWN;
  const target = firstTarget || undefined;
  const type = firstTarget ? targetTypeFromBatch(batch, firstTarget) : "unknown";
  const metadata = metadataFrom(laneMetadata(lane), eventMetadata(latest));
  const state = deriveOperatorState({
    lane,
    event: latest,
    transitionEvent,
    liveness: lane.liveness || "no-heartbeat",
    blockedOn: lane.blockedOn,
    nowMs
  });
  const lastActivityAt = maxTimestamp(latest?.timestamp, batch.updatedAt, batch.createdAt);
  const title = firstValue(target ? targetTitleFromBatch(batch, target) : undefined, batch.objective, `Batch lane ${lane.name}`) || UNKNOWN;
  const baseRow: Omit<OperatorRow, "searchText"> = {
    id: `lane:${batch.repo || batch.path}:${batch.batchId}:${lane.name}`,
    source: "lane",
    repo,
    target,
    type,
    title,
    url: target ? targetUrlFromBatch(batch, target) : undefined,
    operatorState: state,
    liveness: lane.liveness || "no-heartbeat",
    livenessAge: UNKNOWN,
    activityStatus: firstValue(latest?.status, latest?.type, lane.status) || UNKNOWN,
    activityMessage: latest?.message,
    lastActivityAt,
    lastActivityAge: ageLabel(lastActivityAt, nowMs),
    lastEventAt: latest?.timestamp,
    batchId: batch.batchId,
    batchPath: batch.path,
    laneName: lane.name,
    dependencies: lane.dependsOn,
    blockedOn: lane.blockedOn,
    agentId: metadata.agentId,
    machineId: metadata.machineId,
    threadHandle: metadata.threadHandle,
    host: metadata.host,
    operator: metadata.operator,
    branch: metadata.branch,
    prUrl: metadata.prUrl,
    warnings: []
  };
  const warnings = metadataWarnings(baseRow);
  const row = { ...baseRow, warnings };
  return { ...row, searchText: rowSearchText(row) };
}

export function buildOperatorRows(dashboard: DashboardModel, options: BuildOperatorRowsOptions = {}): OperatorRow[] {
  const now = options.now ? new Date(options.now) : new Date(dashboard.generatedAt);
  const nowMs = Number.isNaN(now.getTime()) ? Date.now() : now.getTime();
  const rows = dashboard.workItems.map((item) => buildTargetRow(item, dashboard, nowMs));
  const rowTargetKeys = new Set(rows.map((row) => repoTargetKey(row.repo, row.target)).filter((value): value is string => Boolean(value)));

  for (const batch of dashboard.batches) {
    for (const lane of batch.lanes) {
      const hasTargetRow = lane.targets.some((target) => {
        const repo = uniqueManifestRepoForTarget(batch, target) || batch.repo;
        return rowTargetKeys.has(`${repo}#${target}`);
      });
      if (!hasTargetRow) {
        rows.push(buildLaneRow(batch, lane, dashboard.events, nowMs));
      }
    }
  }

  return sortRows(rows, dashboard.targetRepos);
}

export function filterOperatorRows(rows: OperatorRow[], query: string, targetRepos = Array.from(new Set(rows.map((row) => row.repo)))): OperatorRow[] {
  const normalized = normalizeSearch(query);
  if (!normalized) {
    return rows;
  }
  const exactTarget = searchTarget(query);
  const filtered = exactTarget
    ? rows.filter((row) => row.target === exactTarget || Boolean(row.prUrl?.endsWith(`/pull/${exactTarget}`)))
    : rows.filter((row) => row.searchText.includes(normalized));
  return sortRows(filtered, targetRepos);
}

export function operatorDeepLinkFromSearchParams(params: URLSearchParams): OperatorDeepLink {
  const overviewFilter = params.get("operatorFilter");
  return {
    batchId: params.get("batch") || undefined,
    laneName: params.get("lane") || undefined,
    repo: params.get("repo") || undefined,
    target: params.get("target") || undefined,
    query: params.get("q") || undefined,
    overviewFilter:
      overviewFilter && Object.prototype.hasOwnProperty.call(OVERVIEW_OPERATOR_FILTER_LABELS, overviewFilter)
        ? (overviewFilter as OverviewOperatorFilter)
        : undefined
  };
}

export function hasStructuredOperatorDeepLink(deepLink?: OperatorDeepLink): boolean {
  return Boolean(deepLink?.batchId || deepLink?.laneName || deepLink?.repo || deepLink?.target || deepLink?.overviewFilter);
}

export function hasExactOperatorDeepLink(deepLink?: OperatorDeepLink): boolean {
  return Boolean(deepLink?.batchId || deepLink?.laneName || deepLink?.repo || deepLink?.target);
}

function rowMatchesRepoTarget(row: OperatorRow, repo: string, target: string): boolean {
  return row.repo === repo && row.target === target;
}

function batchMatchesOperation(batch: BatchRecord, operation: BatchOperation): boolean {
  if (batch.batchId !== operation.batchId) {
    return false;
  }
  if (batch.path && operation.batchPath) {
    return batch.path === operation.batchPath;
  }
  return Boolean(batch.repo && operation.repo && batch.repo === operation.repo);
}

function rowMatchesBatchScope(row: OperatorRow, batch: BatchRecord): boolean {
  if (!row.batchId || row.batchId !== batch.batchId) {
    return false;
  }
  if (row.batchPath && batch.path) {
    return row.batchPath === batch.path;
  }
  return Boolean(row.repo && batch.repo && row.repo === batch.repo);
}

function rowMatchesOperationScope(row: OperatorRow, operation: BatchOperation): boolean {
  if (!row.batchId || row.batchId !== operation.batchId) {
    return false;
  }
  if (row.batchPath && operation.batchPath) {
    return row.batchPath === operation.batchPath;
  }
  return Boolean(row.repo && operation.repo && row.repo === operation.repo);
}

function rowMatchesBatchTarget(row: OperatorRow, batch: BatchRecord): boolean {
  if (!row.target || !batch.lanes.some((lane) => lane.targets.includes(row.target as string))) {
    return false;
  }
  const targetRepo = uniqueManifestRepoForTarget(batch, row.target) || batch.repo;
  return Boolean(targetRepo && row.repo === targetRepo);
}

function batchTargetPresentationRow(row: OperatorRow, batch: BatchRecord): OperatorRow {
  const lane = batch.lanes.find((candidate) => Boolean(row.target && candidate.targets.includes(row.target)));
  const presentation = {
    ...row,
    id: `batch-repair-target:${batch.path}:${row.id}`,
    batchId: batch.batchId,
    batchPath: batch.path,
    laneName: lane?.name || row.laneName
  };
  return { ...presentation, searchText: rowSearchText(presentation) };
}

function buildRepairBatchRow(batch: BatchRecord | undefined, operation: BatchOperation | undefined, nowMs: number): OperatorRow {
  const batchId = batch?.batchId || operation?.batchId || UNKNOWN;
  const repo = batch?.repo || operation?.repo || UNKNOWN;
  const batchPath = batch?.path || operation?.batchPath;
  const lastActivityAt = maxTimestamp(operation?.latestEventAt, batch?.updatedAt, batch?.createdAt);
  const activityStatus =
    operation?.controlStatus !== undefined && operation.controlStatus !== "running"
      ? operation.controlStatus
      : batch?.source === "inferred"
        ? "batch plan missing"
        : "prompt missing";
  const baseRow: Omit<OperatorRow, "searchText"> = {
    id: `batch-repair:${batchPath || repo}:${batchId}`,
    source: "batch",
    repo,
    type: "unknown",
    title: batch?.objective || `Batch ${batchId}`,
    operatorState: "unknown",
    liveness: "none",
    livenessAge: UNKNOWN,
    activityStatus,
    lastActivityAt,
    lastActivityAge: ageLabel(lastActivityAt, nowMs),
    batchId,
    batchPath,
    dependencies: [],
    blockedOn: [],
    warnings: []
  };
  return { ...baseRow, searchText: rowSearchText(baseRow) };
}

export function filterOperatorRowsForOverview(
  rows: OperatorRow[],
  dashboard: DashboardModel,
  filter: OverviewOperatorFilter | undefined
): OperatorRow[] {
  if (!filter) {
    return rows;
  }
  if (["ready_for_batch", "needs_recovery", "processing_now"].includes(filter)) {
    const schedulingState =
      filter === "ready_for_batch" ? "ready_for_batch" : filter === "needs_recovery" ? "started_not_processing" : "in_process";
    const items = dashboard.workItems.filter((item) => item.schedulingState === schedulingState);
    return rows.filter((row) => items.some((item) => rowMatchesRepoTarget(row, item.repo, item.target)));
  }
  if (filter === "qa_attention") {
    const qaItems = dashboard.qaValidations.filter((item) => ["missing", "failed", "requested", "in_progress"].includes(item.status));
    return rows.filter((row) => qaItems.some((item) => rowMatchesRepoTarget(row, item.repo, item.target)));
  }
  const stoppedOperations = dashboard.batchOperations.filter((operation) => operation.controlStatus !== "running");
  const repairBatches = dashboard.batches.filter(
    (batch) =>
      batch.source === "inferred" ||
      !batch.launchPrompt ||
      stoppedOperations.some((operation) => batchMatchesOperation(batch, operation))
  );
  const results = new Map<string, OperatorRow>();
  const nowMs = timestampMs(dashboard.generatedAt) || Date.now();

  for (const batch of repairBatches) {
    const matchingRows = rows.filter((row) => rowMatchesBatchScope(row, batch) || rowMatchesBatchTarget(row, batch));
    if (matchingRows.length > 0) {
      for (const row of matchingRows) {
        const presentationRow = rowMatchesBatchScope(row, batch) ? row : batchTargetPresentationRow(row, batch);
        results.set(presentationRow.id, presentationRow);
      }
      continue;
    }
    const operation = stoppedOperations.find((candidate) => batchMatchesOperation(batch, candidate));
    const repairRow = buildRepairBatchRow(batch, operation, nowMs);
    results.set(repairRow.id, repairRow);
  }

  for (const operation of stoppedOperations) {
    if (dashboard.batches.some((batch) => batchMatchesOperation(batch, operation))) {
      continue;
    }
    const matchingRows = rows.filter((row) => rowMatchesOperationScope(row, operation));
    if (matchingRows.length > 0) {
      for (const row of matchingRows) {
        results.set(row.id, row);
      }
      continue;
    }
    const repairRow = buildRepairBatchRow(undefined, operation, nowMs);
    results.set(repairRow.id, repairRow);
  }

  return sortRows(Array.from(results.values()), dashboard.targetRepos);
}

export function operatorRowMatchesDeepLink(row: OperatorRow, deepLink?: OperatorDeepLink): boolean {
  if (!hasExactOperatorDeepLink(deepLink)) {
    return false;
  }
  if (deepLink?.batchId && row.batchId !== deepLink.batchId) {
    return false;
  }
  if (deepLink?.laneName && row.laneName !== deepLink.laneName) {
    return false;
  }
  if (deepLink?.repo && row.repo !== deepLink.repo) {
    return false;
  }
  if (deepLink?.target && row.target !== deepLink.target) {
    return false;
  }
  return true;
}
