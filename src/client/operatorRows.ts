import type {
  BatchEvent,
  BatchLane,
  BatchRecord,
  ClaimRecord,
  DashboardModel,
  HeartbeatRecord,
  Liveness,
  WorkItem,
  WorkItemType
} from "../shared/types";

export const UNKNOWN = "UNKNOWN";
export const WEDGED_THRESHOLD_MS = 15 * 60 * 1000;

export type OperatorState = "running" | "wedged" | "paused" | "blocked" | "stale" | "dead" | "ready" | "done" | "unknown";
export type OperatorRowSource = "target" | "lane";

export interface OperatorDeepLink {
  batchId?: string;
  laneName?: string;
  repo?: string;
  target?: string;
  query?: string;
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

const DONE_PATTERN = /\b(complete|completed|done|merged|closed|passed)\b/i;
const PAUSED_PATTERN = /\b(paused?|token[_\-\s]?limit(?:[_\-\s]?pause)?|context[_\-\s]?limit|context[_\-\s]?window)/i;
const BLOCKED_PATTERN = /\b(blocked|blocking|waiting|needs[_\-\s]?changes|changes[_\-\s]?requested)\b/i;
const READY_PATTERN = /\b(ready|queued|pending)\b/i;

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
  signalStatus?: string;
  blockedOn: string[];
  nowMs: number;
}): OperatorState {
  const text = stateText([
    input.workItem?.schedulingState,
    input.heartbeat?.status,
    input.claim?.status,
    input.lane?.status,
    input.event?.type,
    input.event?.status,
    input.signalStatus,
    ...input.blockedOn
  ]);

  const hasReadySignal = input.workItem?.schedulingState === "ready_for_batch" || READY_PATTERN.test(text);

  if (DONE_PATTERN.test(text)) {
    return "done";
  }
  if (PAUSED_PATTERN.test(text)) {
    return "paused";
  }
  if (input.blockedOn.length > 0 || BLOCKED_PATTERN.test(text)) {
    return "blocked";
  }
  if (input.heartbeat?.liveness === "dead") {
    return "dead";
  }
  if (input.heartbeat?.liveness === "stale") {
    return "stale";
  }
  if (input.heartbeat?.liveness === "live") {
    const transitionAt = input.event?.timestamp || input.heartbeat.updatedAt;
    if (timestampMs(transitionAt) > 0 && input.nowMs - timestampMs(transitionAt) >= WEDGED_THRESHOLD_MS) {
      return "wedged";
    }
    return "running";
  }
  if (!input.claim && !input.heartbeat && hasReadySignal) {
    return "ready";
  }
  if (input.workItem?.schedulingState === "started_not_processing" || input.claim || input.heartbeat) {
    return "dead";
  }
  if (hasReadySignal) {
    return "ready";
  }
  return "unknown";
}

function isActiveOperatorState(state: OperatorState): boolean {
  return ["running", "wedged", "paused", "blocked", "stale", "dead"].includes(state);
}

function metadataWarnings(row: Pick<OperatorRow, "operatorState" | "threadHandle" | "operator" | "host" | "prUrl">): string[] {
  if (!isActiveOperatorState(row.operatorState)) {
    return [];
  }
  return [
    row.threadHandle ? "" : "Thread UNKNOWN",
    row.operator ? "" : "Operator UNKNOWN",
    row.host ? "" : "Host UNKNOWN",
    row.prUrl ? "" : "PR URL UNKNOWN"
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

function matchingEventsForWork(item: WorkItem, events: BatchEvent[]): BatchEvent[] {
  const signals = item.batchSignals || [];
  return events.filter((event) => {
    const targetMatch = event.target === item.target && (!event.repo || event.repo === item.repo);
    const laneMatch = !event.target && signals.some((signal) => event.batchId === signal.batchId && event.laneName === signal.laneName);
    return targetMatch || laneMatch;
  });
}

function matchingEventsForLane(batch: BatchRecord, lane: BatchLane, events: BatchEvent[]): BatchEvent[] {
  return events.filter((event) => {
    if (event.batchId !== batch.batchId) {
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

function findSignalLane(item: WorkItem, batches: BatchRecord[]): { batch?: BatchRecord; lane?: BatchLane } {
  const signal = item.batchSignals?.[0];
  if (!signal) {
    return {};
  }
  const batch = batches.find((candidate) => candidate.batchId === signal.batchId);
  return {
    batch,
    lane: batch?.lanes.find((lane) => lane.name === signal.laneName)
  };
}

function workTitle(item: WorkItem): string {
  return item.github?.title || `${item.type === "pull_request" ? "Pull request" : item.type === "issue" ? "Issue" : "Target"} #${item.target}`;
}

function buildTargetRow(item: WorkItem, dashboard: DashboardModel, nowMs: number): OperatorRow {
  const latest = latestEvent(matchingEventsForWork(item, dashboard.events));
  const { batch, lane } = findSignalLane(item, dashboard.batches);
  const signal = item.batchSignals?.[0];
  const blockedOn = [...(signal?.blockedOn || []), ...(lane?.blockedOn || [])].filter(Boolean);
  const metadata = metadataFrom(item.claim, item.heartbeat, laneMetadata(lane), eventMetadata(latest));
  const state = deriveOperatorState({
    workItem: item,
    heartbeat: item.heartbeat,
    claim: item.claim,
    lane,
    event: latest,
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
    type: item.type,
    title: workTitle(item),
    url: item.github?.url,
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
  const latest = latestEvent(matchingEventsForLane(batch, lane, events));
  const firstTarget = lane.targets[0];
  const repo = (firstTarget && uniqueManifestRepoForTarget(batch, firstTarget)) || batch.repo || UNKNOWN;
  const target = firstTarget || undefined;
  const type = firstTarget ? targetTypeFromBatch(batch, firstTarget) : "unknown";
  const metadata = metadataFrom(laneMetadata(lane), eventMetadata(latest));
  const state = deriveOperatorState({
    lane,
    event: latest,
    blockedOn: lane.blockedOn,
    nowMs
  });
  const lastActivityAt = maxTimestamp(latest?.timestamp, batch.updatedAt, batch.createdAt);
  const title = firstValue(target ? targetTitleFromBatch(batch, target) : undefined, batch.objective, `Batch lane ${lane.name}`) || UNKNOWN;
  const baseRow: Omit<OperatorRow, "searchText"> = {
    id: `lane:${batch.batchId}:${lane.name}`,
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

export function filterOperatorRows(rows: OperatorRow[], query: string): OperatorRow[] {
  const normalized = normalizeSearch(query);
  if (!normalized) {
    return rows;
  }
  const exactTarget = searchTarget(query);
  const filtered = exactTarget
    ? rows.filter((row) => row.target === exactTarget || Boolean(row.prUrl?.endsWith(`/pull/${exactTarget}`)))
    : rows.filter((row) => row.searchText.includes(normalized));
  return sortRows(filtered, Array.from(new Set(rows.map((row) => row.repo))));
}

export function operatorDeepLinkFromSearchParams(params: URLSearchParams): OperatorDeepLink {
  return {
    batchId: params.get("batch") || undefined,
    laneName: params.get("lane") || undefined,
    repo: params.get("repo") || undefined,
    target: params.get("target") || undefined,
    query: params.get("q") || undefined
  };
}

export function hasStructuredOperatorDeepLink(deepLink?: OperatorDeepLink): boolean {
  return Boolean(deepLink?.batchId || deepLink?.laneName || deepLink?.repo || deepLink?.target);
}

export function operatorRowMatchesDeepLink(row: OperatorRow, deepLink?: OperatorDeepLink): boolean {
  if (!hasStructuredOperatorDeepLink(deepLink)) {
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
