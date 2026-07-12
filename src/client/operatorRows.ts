import type {
  BatchEvent,
  BatchLane,
  BatchOperation,
  BatchRecord,
  ClaimRecord,
  DashboardModel,
  HeartbeatRecord,
  Liveness,
  MetadataProvenance,
  MetadataSource,
  OperatorRowProvenance,
  WorkItem,
  WorkItemType
} from "../shared/types";
import { isQaEventType } from "../shared/qaEvents";

export const UNKNOWN = "UNKNOWN";
export const WEDGED_THRESHOLD_MS = 15 * 60 * 1000;
export const OPERATOR_ACTIVITY_STATUS_LABELS: Record<string, string> = {
  stopped: "Stopped",
  stop_requested: "Stop requested",
  batch_plan_missing: "Batch plan missing",
  prompt_missing: "Prompt missing"
};

export function operatorActivityLabel(status: string): string {
  return OPERATOR_ACTIVITY_STATUS_LABELS[status] || status;
}

export function safeGithubUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      return undefined;
    }
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length !== 4 || !["pull", "issues"].includes(pathParts[2]) || !/^\d+$/.test(pathParts[3])) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

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
  provenance: OperatorRowProvenance;
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
  retentionStatus: string;
  githubState?: string;
  schedulingState?: WorkItem["schedulingState"];
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
  metadata: {
    owner: MetadataProvenance;
    thread: MetadataProvenance;
    host: MetadataProvenance;
    machine: MetadataProvenance;
    branch: MetadataProvenance;
    prUrl: MetadataProvenance;
    batch: MetadataProvenance;
    activity: MetadataProvenance;
  };
  warnings: string[];
  searchText: string;
}

interface BuildOperatorRowsOptions {
  now?: Date | string;
}

interface MetadataFields {
  agentId?: string;
  machineId?: string;
  threadHandle?: string;
  host?: string;
  operator?: string;
  branch?: string;
  prUrl?: string;
}

const DONE_PATTERN = /\b(complete|completed|done|merged|closed|cancelled|passed|released)\b/i;
const PAUSED_PATTERN =
  /\b(paused?|token[_\-\s]?limit(?:[_\-\s]?pause)?|context[_\-\s]?limit(?:[_\-\s]?pause)?|context[_\-\s]?window)\b/i;
const BLOCKED_PATTERN = /\b(blocked|blocking|waiting|needs[_\-\s]?changes|changes[_\-\s]?requested)\b/i;
const READY_PATTERN = /\b(ready|queued|pending)\b/i;
const ACTIVE_LANE_PATTERN = /\b(in_progress|running|coding|working|started|validating)\b/i;
const ACCEPTED_TERMINAL_STATUSES = new Set(["done", "merged", "closed", "cancelled"]);

function isAcceptedTerminalStatus(value: string | undefined): boolean {
  return ACCEPTED_TERMINAL_STATUSES.has(value?.trim().toLowerCase() || "");
}

function firstValue(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function observed(value: string | undefined, source: MetadataSource): MetadataProvenance {
  const normalized = value?.trim();
  return normalized ? { value: normalized, state: "observed", source } : { state: "missing", source };
}

function notApplicable(): MetadataProvenance {
  return { state: "not_applicable" };
}

function firstObserved(
  fallback: MetadataProvenance,
  ...candidates: Array<[MetadataSource, string | undefined]>
): MetadataProvenance {
  const selected = candidates.find(([, value]) => Boolean(value?.trim()));
  return selected ? observed(selected[1], selected[0]) : fallback;
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
    .filter((value): value is string => timestampMs(value) > 0)
    .sort((left, right) => timestampMs(right) - timestampMs(left))[0];
}

function latestLifecycleStatus(
  candidates: Array<{ status?: string; timestamp?: string }>
): string {
  return [...candidates]
    .filter((candidate) => Boolean(candidate.status?.trim()) && timestampMs(candidate.timestamp) > 0)
    .sort((left, right) => timestampMs(right.timestamp) - timestampMs(left.timestamp))[0]
    ?.status?.trim().toLowerCase() || "unknown";
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

function uniqueSources(sources: Array<MetadataSource | undefined>): MetadataSource[] {
  return Array.from(new Set(sources.filter((source): source is MetadataSource => Boolean(source))));
}

function targetProvenance(item: WorkItem, matchingEvents: BatchEvent[], batch: BatchRecord | undefined): OperatorRowProvenance {
  if (item.provenance) {
    return {
      classification: matchingEvents.length > 0 ? "observed" : item.provenance.classification,
      evidence: uniqueSources([
        ...item.provenance.evidence,
        matchingEvents.length > 0 ? "event" : undefined
      ])
    };
  }
  const evidence = uniqueSources([
    item.claim ? "claim" : undefined,
    item.heartbeat ? "heartbeat" : undefined,
    matchingEvents.length > 0 ? "event" : undefined,
    item.github ? "github" : undefined,
    batch ? (batch.source === "inferred" ? "inferred_batch" : "manifest") : undefined
  ]);
  const observed = Boolean(item.claim || item.heartbeat || matchingEvents.length > 0 || item.github?.loadState === "loaded");
  const inferred = Boolean(batch);
  return { classification: observed ? "observed" : inferred ? "inferred" : "unknown", evidence };
}

function uniqueManifestRepoForTarget(batch: BatchRecord, target: string): string | undefined {
  const repos = new Set(manifestReposForTarget(batch, target));
  return repos.size === 1 ? Array.from(repos)[0] : undefined;
}

function manifestReposForTarget(batch: BatchRecord, target: string): string[] {
  return Array.from(
    new Set(
      (batch.targets || [])
        .filter((batchTarget) => batchTarget.target === target)
        .map((batchTarget) => batchTarget.repo || batch.repo)
        .filter((repo): repo is string => Boolean(repo))
    )
  );
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

function metadataFrom(...sources: Array<MetadataFields | undefined>): MetadataFields {
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

function laneMetadata(lane: BatchLane | undefined): MetadataFields | undefined {
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

function eventMetadata(event: BatchEvent | undefined): MetadataFields | undefined {
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

function eventMetadataFromHistory(events: BatchEvent[]): MetadataFields | undefined {
  const newestFirst = [...events].sort(
    (left, right) => timestampMs(right.timestamp) - timestampMs(left.timestamp)
  );
  return newestFirst.length ? metadataFrom(...newestFirst.map(eventMetadata)) : undefined;
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
  currentLifecycleAt?: string;
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
  const currentText = stateText([
    input.workItem?.schedulingState,
    input.heartbeat?.status,
    input.claim?.status,
    input.lane?.status,
    input.signalStatus
  ]);

  const hasReadySignal = input.workItem?.schedulingState === "ready_for_batch" || READY_PATTERN.test(text);
  const hasActiveClaim = Boolean(input.claim && input.claim.status !== "released");
  const liveness = input.heartbeat?.liveness || input.liveness;
  const currentStatuses = [input.heartbeat?.status, input.claim?.status, input.lane?.status, input.signalStatus].filter(
    (status): status is string => Boolean(status?.trim())
  );
  const transitionStatus = input.transitionEvent?.status || input.transitionEvent?.type;
  const transitionAt = timestampMs(input.transitionEvent?.timestamp);
  const currentLifecycleAt = timestampMs(input.currentLifecycleAt);
  const terminalTransitionIsCurrent =
    isAcceptedTerminalStatus(transitionStatus) &&
    transitionAt > 0 &&
    (currentLifecycleAt > 0 ? transitionAt > currentLifecycleAt : currentStatuses.length === 0);

  if (PAUSED_PATTERN.test(currentText)) {
    return "paused";
  }
  if (input.blockedOn.length > 0 || BLOCKED_PATTERN.test(currentText)) {
    return "blocked";
  }
  if (currentStatuses.some(isAcceptedTerminalStatus) || terminalTransitionIsCurrent) {
    return "done";
  }
  if (liveness === "dead") {
    return "dead";
  }
  if (liveness === "stale") {
    return "stale";
  }
  if (liveness === "live") {
    const activityAt = input.transitionEvent?.timestamp || input.heartbeat?.updatedAt;
    if (timestampMs(activityAt) > 0 && input.nowMs - timestampMs(activityAt) >= WEDGED_THRESHOLD_MS) {
      return "wedged";
    }
    return "running";
  }
  if (
    (input.workItem?.schedulingState === "ready_for_batch" && !input.claim && !input.heartbeat) ||
    (!input.claim && !input.heartbeat && READY_PATTERN.test(currentText))
  ) {
    return "ready";
  }
  if (input.lane && liveness === "no-heartbeat" && ACTIVE_LANE_PATTERN.test(currentText)) {
    return "dead";
  }
  if (DONE_PATTERN.test(text)) {
    return "done";
  }
  if (PAUSED_PATTERN.test(text)) {
    return "paused";
  }
  if (input.blockedOn.length > 0 || BLOCKED_PATTERN.test(text)) {
    return "blocked";
  }
  if (!input.claim && !input.heartbeat && hasReadySignal) {
    return "ready";
  }
  if (input.workItem?.schedulingState === "started_not_processing" || hasActiveClaim) {
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

function metadataWarnings(
  row: Pick<OperatorRow, "operatorState" | "metadata">,
  requiresActiveOperatorFields?: boolean
): string[] {
  const fieldsAreRequired = requiresActiveOperatorFields ?? isActiveOperatorState(row.operatorState);
  if (!fieldsAreRequired) {
    return [];
  }
  return [
    !row.metadata.owner.value ? "Operator UNKNOWN" : "",
    !row.metadata.thread.value ? "Thread UNKNOWN" : "",
    !row.metadata.host.value ? "Host UNKNOWN" : "",
    row.metadata.machine.state === "missing" ? "Machine UNKNOWN" : "",
    row.metadata.prUrl.state === "missing" ? "PR URL UNKNOWN" : "",
    row.metadata.activity.state === "missing" ? "Activity UNKNOWN" : ""
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
  return (
    batchIds.has(event.batchId) ||
    (batchIds.size === 0 && item.schedulingState === "started_not_processing" && !hasActiveWorkSignal(item))
  );
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

function matchingEventsForLane(
  batch: BatchRecord,
  lane: BatchLane,
  events: BatchEvent[],
  target?: string,
  repo?: string
): BatchEvent[] {
  return events.filter((event) => {
    if (!eventMatchesBatchRecord(batch, event)) {
      return false;
    }
    if (repo === UNKNOWN && event.repo) {
      return false;
    }
    if (event.laneName === lane.name) {
      if (!event.target || !target) {
        return true;
      }
      return event.target === target && (!event.repo || !repo || event.repo === repo);
    }
    if (!event.target || !lane.targets.includes(event.target)) {
      return false;
    }
    if (target && event.target !== target) {
      return false;
    }
    if (repo && repo !== UNKNOWN && event.repo && event.repo !== repo) {
      return false;
    }
    const targetRepos = manifestReposForTarget(batch, event.target);
    if (targetRepos.length > 1) {
      return event.batchPath === batch.path && (!event.repo || targetRepos.includes(event.repo));
    }
    const targetRepo = targetRepos[0] || batch.repo;
    return !event.repo || !targetRepo || event.repo === targetRepo;
  });
}

function batchContainsWork(batch: BatchRecord, item: WorkItem, lane: BatchLane): boolean {
  if (!lane.targets.includes(item.target)) {
    return false;
  }
  const manifestRepos = manifestReposForTarget(batch, item.target);
  if (manifestRepos.length > 0) {
    return manifestRepos.includes(item.repo);
  }
  return !batch.repo || batch.repo === item.repo;
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
  const eventHistoryMetadata = eventMetadataFromHistory(matchingEvents);
  const transitionEvent = latestTransitionEvent(matchingEvents);
  const { batch, lane } = findSignalLane(item, dashboard.batches);
  const signal = preferredSignalForWork(item);
  const batchTarget = batchTargetForWork(batch, item);
  const blockedOn = Array.from(new Set([...(signal?.blockedOn || []), ...(lane?.blockedOn || [])].filter(Boolean)));
  const metadata = metadataFrom(item.claim, item.heartbeat, laneMetadata(lane), eventHistoryMetadata);
  const lifecycleSignalCandidates = (item.batchSignals || []).map((candidate) => {
    const matchingBatch = dashboard.batches.find((candidateBatch) => {
      if (candidateBatch.batchId !== candidate.batchId) {
        return false;
      }
      const matchingLane = candidateBatch.lanes.find((candidateLane) => candidateLane.name === candidate.laneName);
      return Boolean(matchingLane && batchContainsWork(candidateBatch, item, matchingLane));
    });
    return {
      status: candidate.status,
      timestamp: maxTimestamp(candidate.updatedAt, matchingBatch?.updatedAt, matchingBatch?.createdAt)
    };
  });
  const claimLifecycleAt = maxTimestamp(item.claim?.updatedAt, item.claim?.claimedAt);
  const currentLifecycleAt = maxTimestamp(
    item.heartbeat?.updatedAt,
    claimLifecycleAt,
    ...lifecycleSignalCandidates.map((candidate) => candidate.timestamp)
  );
  const state = deriveOperatorState({
    workItem: item,
    heartbeat: item.heartbeat,
    claim: item.claim,
    lane,
    event: latest,
    transitionEvent,
    signalStatus: signal?.status,
    currentLifecycleAt,
    blockedOn,
    nowMs
  });
  const lastActivityAt = maxTimestamp(latest?.timestamp, item.heartbeat?.updatedAt, item.claim?.updatedAt);
  const lifecycleEvents = matchingEvents.filter((event) => !isQaEventType(event.type));
  const lifecycleCandidates = [
    ...lifecycleEvents.map((event) => ({ status: event.status || event.type, timestamp: event.timestamp })),
    { status: item.heartbeat?.status, timestamp: item.heartbeat?.updatedAt },
    { status: item.claim?.status, timestamp: claimLifecycleAt },
    ...lifecycleSignalCandidates
  ];
  const latestLifecycleAt = maxTimestamp(
    ...lifecycleCandidates.map((candidate) => candidate.timestamp),
    item.heartbeat?.updatedAt,
    claimLifecycleAt
  );
  const retentionStatus = latestLifecycleStatus(lifecycleCandidates);
  const ownerMetadata = firstObserved(
    notApplicable(),
    ["claim", item.claim?.operator],
    ["heartbeat", item.heartbeat?.operator],
    ["manifest", lane?.operator],
    ["event", eventHistoryMetadata?.operator]
  );
  const threadMetadata = firstObserved(
    notApplicable(),
    ["claim", item.claim?.threadHandle],
    ["heartbeat", item.heartbeat?.threadHandle],
    ["manifest", lane?.threadHandle],
    ["event", eventHistoryMetadata?.threadHandle]
  );
  const hostMetadata = firstObserved(
    notApplicable(),
    ["claim", item.claim?.host],
    ["heartbeat", item.heartbeat?.host],
    ["manifest", lane?.host],
    ["event", eventHistoryMetadata?.host]
  );
  const machineMetadata = firstObserved(
    item.heartbeat ? { state: "missing", source: "heartbeat" } : notApplicable(),
    ["heartbeat", item.heartbeat?.machineId],
    ["claim", item.claim?.machineId],
    ["event", eventHistoryMetadata?.machineId]
  );
  const branchMetadata = firstObserved(
    notApplicable(),
    ["claim", item.claim?.branch],
    ["heartbeat", item.heartbeat?.branch],
    ["manifest", lane?.branch],
    ["event", eventHistoryMetadata?.branch]
  );
  const prUrlMetadata = firstObserved(
    item.type === "pull_request" ? { state: "missing", source: "github" } : notApplicable(),
    ["claim", item.claim?.prUrl],
    ["heartbeat", item.heartbeat?.prUrl],
    ["manifest", lane?.prUrl],
    ["event", eventHistoryMetadata?.prUrl],
    ["github", item.type === "pull_request" ? item.github?.url : undefined]
  );
  const batchId =
    signal?.batchId || item.claim?.batchId || item.heartbeat?.batchId || batch?.batchId || latest?.batchId;
  const batchMetadata = batchId
    ? batch?.source === "inferred"
      ? { value: batchId, state: "inferred" as const, source: "inferred_batch" as const }
      : firstObserved(
          notApplicable(),
          ["manifest", signal?.batchId],
          ["claim", item.claim?.batchId],
          ["heartbeat", item.heartbeat?.batchId],
          ["event", latest?.batchId],
          ["manifest", batch?.batchId]
        )
    : notApplicable();
  const activityMetadata = firstObserved(
    { value: item.schedulingState, state: "inferred", source: "dashboard" },
    ["event", latest?.status || latest?.type],
    ["heartbeat", item.heartbeat?.status],
    ["claim", item.claim?.status],
    ["manifest", signal?.status || lane?.status]
  );
  const baseRow: Omit<OperatorRow, "searchText"> = {
    id: `target:${item.repo}#${item.target}`,
    source: "target",
    provenance: targetProvenance(item, matchingEvents, batch),
    repo: item.repo,
    target: item.target,
    type: item.type === "unknown" ? batchTarget?.type || "unknown" : item.type,
    title: item.github?.title || batchTarget?.title || workTitle(item),
    url: item.github?.url || batchTarget?.url,
    operatorState: state,
    liveness: item.heartbeat?.liveness || "none",
    livenessAge: ageLabel(item.heartbeat?.updatedAt, nowMs),
    activityStatus: activityMetadata.value || UNKNOWN,
    activityMessage: latest?.message,
    lastActivityAt: latestLifecycleAt || lastActivityAt,
    lastActivityAge: ageLabel(latestLifecycleAt || lastActivityAt, nowMs),
    retentionStatus,
    githubState: item.github?.loadState === "loaded" ? item.github.state : UNKNOWN,
    schedulingState: item.schedulingState,
    lastEventAt: latest?.timestamp,
    heartbeatUpdatedAt: item.heartbeat?.updatedAt,
    batchId,
    batchPath: batch?.path,
    laneName: signal?.laneName || lane?.name,
    dependencies: lane?.dependsOn || [],
    blockedOn,
    agentId: metadata.agentId,
    machineId: machineMetadata.value,
    threadHandle: threadMetadata.value,
    host: hostMetadata.value,
    operator: ownerMetadata.value,
    branch: branchMetadata.value,
    prUrl: prUrlMetadata.value,
    metadata: {
      owner: ownerMetadata,
      thread: threadMetadata,
      host: hostMetadata,
      machine: machineMetadata,
      branch: branchMetadata,
      prUrl: prUrlMetadata,
      batch: batchMetadata,
      activity: activityMetadata
    },
    warnings: item.warnings.map((warning) => warning.message)
  };
  const warnings = [
    ...baseRow.warnings,
    ...metadataWarnings(baseRow, item.schedulingState === "in_process")
  ];
  const row = { ...baseRow, warnings };
  return { ...row, searchText: rowSearchText(row) };
}

function buildLaneRow(
  batch: BatchRecord,
  lane: BatchLane,
  events: BatchEvent[],
  nowMs: number,
  options: {
    target?: string;
    repo?: string;
    provenance?: OperatorRowProvenance;
    warnings?: string[];
  } = {}
): OperatorRow {
  const firstTarget = options.target ?? lane.targets[0];
  const manifestRepos = firstTarget ? manifestReposForTarget(batch, firstTarget) : [];
  const repo =
    options.repo ||
    (manifestRepos.length === 1 ? manifestRepos[0] : manifestRepos.length > 1 ? UNKNOWN : batch.repo || UNKNOWN);
  const matchingEvents = matchingEventsForLane(batch, lane, events, firstTarget, repo);
  const latest = latestEvent(matchingEvents);
  const eventHistoryMetadata = eventMetadataFromHistory(matchingEvents);
  const transitionEvent = latestTransitionEvent(matchingEvents);
  const target = firstTarget || undefined;
  const targetRepoUnknown = Boolean(firstTarget && repo === UNKNOWN);
  const type = firstTarget && !targetRepoUnknown ? targetTypeFromBatch(batch, firstTarget) : "unknown";
  const metadata = metadataFrom(laneMetadata(lane), eventHistoryMetadata);
  const ownerMetadata = firstObserved(
    notApplicable(),
    ["manifest", lane.operator],
    ["event", eventHistoryMetadata?.operator]
  );
  const threadMetadata = firstObserved(
    notApplicable(),
    ["manifest", lane.threadHandle],
    ["event", eventHistoryMetadata?.threadHandle]
  );
  const hostMetadata = firstObserved(notApplicable(), ["manifest", lane.host], ["event", eventHistoryMetadata?.host]);
  const machineMetadata = eventHistoryMetadata?.machineId
    ? observed(eventHistoryMetadata.machineId, "event")
    : notApplicable();
  const branchMetadata = firstObserved(
    notApplicable(),
    ["manifest", lane.branch],
    ["event", eventHistoryMetadata?.branch]
  );
  const prUrlMetadata =
    type === "pull_request"
      ? firstObserved(
          { state: "missing", source: "manifest" },
          ["manifest", lane.prUrl],
          ["event", eventHistoryMetadata?.prUrl]
        )
      : notApplicable();
  const batchMetadata =
    batch.source === "inferred"
      ? { value: batch.batchId, state: "inferred" as const, source: "inferred_batch" as const }
      : observed(batch.batchId, "manifest");
  const activityMetadata = firstObserved(
    { state: "missing", source: "manifest" },
    ["event", latest?.status || latest?.type],
    ["manifest", lane.status]
  );
  const state = deriveOperatorState({
    lane,
    event: latest,
    transitionEvent,
    currentLifecycleAt: maxTimestamp(batch.updatedAt, batch.createdAt),
    liveness: lane.liveness || "no-heartbeat",
    blockedOn: lane.blockedOn,
    nowMs
  });
  const lastActivityAt = maxTimestamp(latest?.timestamp, batch.updatedAt, batch.createdAt);
  const retentionStatus = latestLifecycleStatus([
    { status: transitionEvent?.status || transitionEvent?.type, timestamp: transitionEvent?.timestamp },
    { status: lane.status, timestamp: maxTimestamp(batch.updatedAt, batch.createdAt) }
  ]);
  const title = targetRepoUnknown
    ? `Target #${target} (repository UNKNOWN)`
    : firstValue(target ? targetTitleFromBatch(batch, target) : undefined, batch.objective, `Batch lane ${lane.name}`) || UNKNOWN;
  const baseRow: Omit<OperatorRow, "searchText"> = {
    id: `lane:${batch.repo || batch.path}:${batch.batchId}:${lane.name}${lane.targets.length > 1 && firstTarget ? `:${firstTarget}` : ""}`,
    source: "lane",
    provenance:
      options.provenance || {
        classification:
          matchingEvents.length > 0 ? "observed" : batch.source === "inferred" ? "inferred" : "synthetic",
        evidence: uniqueSources([
          batch.source === "inferred" ? "inferred_batch" : "manifest",
          matchingEvents.length > 0 ? "event" : undefined
        ])
      },
    repo,
    target,
    type,
    title,
    url: target && !targetRepoUnknown ? targetUrlFromBatch(batch, target) : undefined,
    operatorState: state,
    liveness: lane.liveness || "no-heartbeat",
    livenessAge: UNKNOWN,
    activityStatus: activityMetadata.value || UNKNOWN,
    activityMessage: latest?.message,
    lastActivityAt,
    lastActivityAge: ageLabel(lastActivityAt, nowMs),
    retentionStatus,
    githubState: target ? UNKNOWN : undefined,
    lastEventAt: latest?.timestamp,
    batchId: batch.batchId,
    batchPath: batch.path,
    laneName: lane.name,
    dependencies: lane.dependsOn,
    blockedOn: lane.blockedOn,
    agentId: metadata.agentId,
    machineId: machineMetadata.value,
    threadHandle: threadMetadata.value,
    host: hostMetadata.value,
    operator: ownerMetadata.value,
    branch: branchMetadata.value,
    prUrl: prUrlMetadata.value,
    metadata: {
      owner: ownerMetadata,
      thread: threadMetadata,
      host: hostMetadata,
      machine: machineMetadata,
      branch: branchMetadata,
      prUrl: prUrlMetadata,
      batch: batchMetadata,
      activity: activityMetadata
    },
    warnings: options.warnings || []
  };
  const warnings = [...baseRow.warnings, ...metadataWarnings(baseRow)];
  const row = { ...baseRow, warnings };
  return { ...row, searchText: rowSearchText(row) };
}

export function buildOperatorRows(dashboard: DashboardModel, options: BuildOperatorRowsOptions = {}): OperatorRow[] {
  const now = options.now ? new Date(options.now) : new Date(dashboard.generatedAt);
  const nowMs = Number.isNaN(now.getTime()) ? Date.now() : now.getTime();
  const rows = dashboard.workItems.map((item) => buildTargetRow(item, dashboard, nowMs));
  const rowTargetKeys = new Set(rows.map((row) => repoTargetKey(row.repo, row.target)).filter((value): value is string => Boolean(value)));
  const ambiguousLaneKeys = new Set<string>();

  for (const batch of dashboard.batches) {
    for (const lane of batch.lanes) {
      if (lane.targets.length === 0) {
        rows.push(buildLaneRow(batch, lane, dashboard.events, nowMs));
      } else {
        for (const target of lane.targets) {
          const manifestRepos = manifestReposForTarget(batch, target);
          if (manifestRepos.length > 1) {
            if (manifestRepos.every((repo) => rowTargetKeys.has(`${repo}#${target}`))) {
              continue;
            }
            const unknownKey = `${batch.path}:${batch.batchId}:${lane.name}:${target}`;
            if (!ambiguousLaneKeys.has(unknownKey)) {
              rows.push(
                buildLaneRow(batch, lane, dashboard.events, nowMs, {
                  target,
                  repo: UNKNOWN,
                  provenance: { classification: "unknown", evidence: ["manifest"] },
                  warnings: [`Target repository UNKNOWN: manifest target #${target} matches multiple saved repositories.`]
                })
              );
              ambiguousLaneKeys.add(unknownKey);
            }
            continue;
          }
          if (manifestRepos.length === 0 && !batch.repo) {
            const unknownKey = `${batch.path}:${batch.batchId}:${lane.name}:${target}`;
            if (!ambiguousLaneKeys.has(unknownKey)) {
              rows.push(
                buildLaneRow(batch, lane, dashboard.events, nowMs, {
                  target,
                  repo: UNKNOWN,
                  provenance: {
                    classification: "unknown",
                    evidence: [batch.source === "inferred" ? "inferred_batch" : "manifest"]
                  },
                  warnings: [`Target repository UNKNOWN: lane target #${target} has no explicit repository evidence.`]
                })
              );
              ambiguousLaneKeys.add(unknownKey);
            }
            continue;
          }
          const repo = manifestRepos[0] || batch.repo || UNKNOWN;
          const key = `${repo}#${target}`;
          if (!rowTargetKeys.has(key)) {
            rows.push(buildLaneRow(batch, lane, dashboard.events, nowMs, { target, repo }));
            rowTargetKeys.add(key);
          }
        }
      }
    }
  }

  return sortRows(rows, dashboard.targetRepos);
}

export function filterOperatorRowsByProvenance(rows: OperatorRow[], includeDerived: boolean): OperatorRow[] {
  return includeDerived
    ? rows
    : rows.filter((row) => !["inferred", "synthetic"].includes(row.provenance.classification));
}

export const TERMINAL_ROW_AGE_OUT_MS = 24 * 60 * 60 * 1000;
export const SHOW_OLDER_TERMINAL_WORK_STORAGE_KEY = "agent-coordination-dashboard:show-older-terminal-work";

export function savedOlderTerminalWorkPreference(): boolean {
  try {
    return window.localStorage.getItem(SHOW_OLDER_TERMINAL_WORK_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function filterOperatorRowsByAge(
  rows: OperatorRow[],
  now: Date | string | number,
  revealOlderTerminalRows = false
): { visibleRows: OperatorRow[]; hiddenRows: OperatorRow[] } {
  if (revealOlderTerminalRows) {
    return { visibleRows: rows, hiddenRows: [] };
  }
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : timestampMs(now);
  const visibleRows: OperatorRow[] = [];
  const hiddenRows: OperatorRow[] = [];
  for (const row of rows) {
    const activityMs = timestampMs(row.lastActivityAt);
    const shouldHide =
      isTerminalRowEligibleForAgeOut(row) &&
      activityMs > 0 &&
      nowMs > 0 &&
      nowMs - activityMs > TERMINAL_ROW_AGE_OUT_MS;
    (shouldHide ? hiddenRows : visibleRows).push(row);
  }
  return { visibleRows, hiddenRows };
}

export function isTerminalRowEligibleForAgeOut(row: OperatorRow): boolean {
  const githubState = row.githubState?.trim().toUpperCase();
  const hasCurrentPresentationState = ["running", "wedged", "paused", "blocked", "stale", "dead", "ready", "unknown"].includes(
    row.operatorState
  );
  return (
    ACCEPTED_TERMINAL_STATUSES.has(row.retentionStatus.trim().toLowerCase()) &&
    githubState !== "OPEN" &&
    githubState !== UNKNOWN &&
    row.liveness !== "live" &&
    row.liveness !== "stale" &&
    row.liveness !== "dead" &&
    !hasCurrentPresentationState &&
    row.schedulingState !== "started_not_processing" &&
    row.schedulingState !== "ready_for_batch" &&
    row.schedulingState !== "in_process"
  );
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
  if (row.batchId && row.batchId !== batch.batchId) {
    return false;
  }
  if (row.batchPath && batch.path && row.batchPath !== batch.path) {
    return false;
  }
  if (!row.target || !batch.lanes.some((lane) => lane.targets.includes(row.target as string))) {
    return false;
  }
  const explicitTargets = (batch.targets || []).filter((target) => target.target === row.target);
  if (explicitTargets.length > 0) {
    return explicitTargets.some((target) => {
      const targetRepo = target.repo || batch.repo;
      return Boolean(targetRepo && targetRepo === row.repo);
    });
  }
  const targetRepo = uniqueManifestRepoForTarget(batch, row.target) || batch.repo;
  return Boolean(targetRepo && row.repo === targetRepo);
}

function repairActivityStatus(batch: BatchRecord | undefined, operation: BatchOperation | undefined): string {
  if (operation?.controlStatus !== undefined && operation.controlStatus !== "running") {
    return operation.controlStatus;
  }
  return batch?.source === "inferred" ? "batch_plan_missing" : "prompt_missing";
}

function repairActivityMetadata(
  batch: BatchRecord | undefined,
  operation: BatchOperation | undefined,
  activityStatus: string
): MetadataProvenance {
  if (operation && operation.controlStatus !== "running") {
    return { value: activityStatus, state: "inferred", source: "event" };
  }
  if (batch?.source === "inferred") {
    return { value: activityStatus, state: "inferred", source: "inferred_batch" };
  }
  return { value: activityStatus, state: "inferred", source: "dashboard" };
}

function repairStatusPresentationRow(
  row: OperatorRow,
  activityStatus: string,
  activityMetadata: MetadataProvenance
): OperatorRow {
  const presentation = { ...row, activityStatus, metadata: { ...row.metadata, activity: activityMetadata } };
  return { ...presentation, searchText: rowSearchText(presentation) };
}

function batchTargetPresentationRow(
  row: OperatorRow,
  batch: BatchRecord,
  activityStatus: string,
  activityMetadata: MetadataProvenance
): OperatorRow {
  const lane = batch.lanes.find((candidate) => Boolean(row.target && candidate.targets.includes(row.target)));
  const presentation = {
    ...row,
    id: `batch-repair-target:${batch.path}:${row.id}`,
    batchId: batch.batchId,
    batchPath: batch.path,
    laneName: lane?.name || row.laneName,
    activityStatus,
    metadata: { ...row.metadata, activity: activityMetadata }
  };
  return { ...presentation, searchText: rowSearchText(presentation) };
}

function buildRepairBatchRow(batch: BatchRecord | undefined, operation: BatchOperation | undefined, nowMs: number): OperatorRow {
  const batchId = batch?.batchId || operation?.batchId || UNKNOWN;
  const repo = batch?.repo || operation?.repo || UNKNOWN;
  const batchPath = batch?.path || operation?.batchPath;
  const lastActivityAt = maxTimestamp(operation?.latestEventAt, batch?.updatedAt, batch?.createdAt);
  const activityStatus = repairActivityStatus(batch, operation);
  const activityMetadata = repairActivityMetadata(batch, operation, activityStatus);
  const baseRow: Omit<OperatorRow, "searchText"> = {
    id: `batch-repair:${batchPath || repo}:${batchId}`,
    source: "batch",
    provenance: operation?.eventCount
      ? { classification: "observed", evidence: ["event"] }
      : batch?.source === "inferred"
        ? { classification: "inferred", evidence: ["inferred_batch"] }
        : batch
          ? { classification: "synthetic", evidence: ["manifest"] }
          : { classification: "unknown", evidence: [] },
    repo,
    type: "unknown",
    title: batch?.objective || `Batch ${batchId}`,
    operatorState: "unknown",
    liveness: "none",
    livenessAge: UNKNOWN,
    activityStatus,
    lastActivityAt,
    lastActivityAge: ageLabel(lastActivityAt, nowMs),
    retentionStatus: activityStatus,
    batchId,
    batchPath,
    dependencies: [],
    blockedOn: [],
    metadata: {
      owner: notApplicable(),
      thread: notApplicable(),
      host: notApplicable(),
      machine: notApplicable(),
      branch: notApplicable(),
      prUrl: notApplicable(),
      batch: batch?.source === "inferred"
        ? { value: batchId, state: "inferred", source: "inferred_batch" }
        : batch
          ? observed(batchId, "manifest")
          : { value: batchId, state: "inferred", source: "event" },
      activity: activityMetadata
    },
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
    const operation = stoppedOperations.find((candidate) => batchMatchesOperation(batch, candidate));
    const activityStatus = repairActivityStatus(batch, operation);
    const activityMetadata = repairActivityMetadata(batch, operation, activityStatus);
    const matchingRows = rows.filter((row) => rowMatchesBatchScope(row, batch) || rowMatchesBatchTarget(row, batch));
    if (matchingRows.length > 0) {
      for (const row of matchingRows) {
        const presentationRow = rowMatchesBatchScope(row, batch)
          ? repairStatusPresentationRow(row, activityStatus, activityMetadata)
          : batchTargetPresentationRow(row, batch, activityStatus, activityMetadata);
        results.set(presentationRow.id, presentationRow);
      }
      continue;
    }
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
        results.set(
          row.id,
          repairStatusPresentationRow(
            row,
            operation.controlStatus,
            repairActivityMetadata(undefined, operation, operation.controlStatus)
          )
        );
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
