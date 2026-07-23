import type {
  AgentSummary,
  BatchCompletionReport,
  BatchOperation,
  BatchRecord,
  DashboardModel,
  Liveness,
  ModelUsage,
  WorkItem
} from "../shared/types";
import { displayAttribution } from "../shared/attribution";
import { isSelectableWorkItem } from "../shared/workItemSelection";
import { buildOperatorRows, type OperatorRow, type OperatorState } from "./operatorRows";

/**
 * coordinationView derives the Coordination Dashboard design's view-models from
 * the real DashboardModel. It reuses buildOperatorRows for the same lifecycle
 * derivation the operator surfaces already trust, then reshapes rows, batches,
 * and agents into the design's host legend, lifecycle buckets, batch cards, and
 * machine groups. Fields the design shows but the coordination protocol does not
 * yet emit (tokens, cost, model route, merge authority, audit, structured
 * blocker) are surfaced as absent markers rather than invented values.
 */

export const ABSENT = "—";
export const CODEX_COLOR = "var(--codex)";
export const CLAUDE_COLOR = "var(--claude)";
export const NEUTRAL_COLOR = "var(--color-neutral-400)";

export type JobBucketId = "running" | "needs_input" | "stuck" | "blocked" | "ready" | "done" | "history";
export type BatchTier = "blocked" | "stuck" | "running" | "archive";

export interface JobBucketMeta {
  id: JobBucketId;
  label: string;
  hint: string;
  color: string;
  icon: string;
  action: string;
  pulse: boolean;
}

export const JOB_BUCKETS: JobBucketMeta[] = [
  { id: "running", label: "Running", hint: "live heartbeat, phase moving", color: "var(--ok)", icon: "●", action: "Timeline", pulse: true },
  { id: "needs_input", label: "Needs you", hint: "waiting on your input", color: "var(--info)", icon: "◆", action: "Review", pulse: true },
  { id: "stuck", label: "Stuck", hint: "no phase change 15m+", color: "var(--warn)", icon: "▲", action: "Resume", pulse: false },
  { id: "blocked", label: "Blocked", hint: "deps & permissions", color: "var(--block)", icon: "▢", action: "Review", pulse: false },
  { id: "ready", label: "Ready to batch", hint: "open, no active holder", color: NEUTRAL_COLOR, icon: "○", action: "Batch", pulse: false },
  { id: "done", label: "Done today", hint: "terminal since local midnight", color: "var(--mut)", icon: "✓", action: "View", pulse: false },
  { id: "history", label: "History", hint: "terminal before today or time UNKNOWN", color: "var(--mut)", icon: "✓", action: "View", pulse: false }
];

const JOB_BUCKET_BY_ID = new Map(JOB_BUCKETS.map((bucket) => [bucket.id, bucket]));

export interface BatchTierMeta {
  id: BatchTier;
  label: string;
  hint: string;
  color: string;
  pulse: boolean;
}

export const BATCH_TIERS: BatchTierMeta[] = [
  { id: "blocked", label: "Blocked", hint: "needs your decision", color: "var(--block)", pulse: true },
  { id: "stuck", label: "Stuck", hint: "may be forgotten", color: "var(--warn)", pulse: true },
  { id: "running", label: "Running", hint: "live & moving", color: "var(--ok)", pulse: false },
  { id: "archive", label: "Ready to archive", hint: "done & clean", color: "var(--mut)", pulse: false }
];

const BATCH_TIER_RANK: Record<BatchTier, number> = { blocked: 0, stuck: 1, running: 2, archive: 3 };

export interface HostLegendItem {
  name: string;
  color: string;
  live: number;
  total: number;
}

export interface JobRow {
  id: string;
  bucket: JobBucketId;
  icon: string;
  iconColor: string;
  targetLabel: string;
  implementationLabel?: string;
  implementationUrl?: string;
  targetColor: string;
  title: string;
  note: string;
  noteColor: string;
  host?: string;
  hostColor: string;
  machine?: string;
  batchId?: string;
  batchLabel?: string;
  age: string;
  action: string;
  selectable: boolean;
  selected: boolean;
  row: OperatorRow;
  workItem?: WorkItem;
}

export interface LaneView {
  id: string;
  branch: string;
  branchName?: string;
  tag: string;
  target: string;
  targetUrl?: string;
  targetColor: string;
  title: string;
  /** Coordination status label shown to the operator. */
  state: string;
  /** Derived lifecycle state that drives color and batch tiering. */
  operatorState: OperatorState;
  stateColor: string;
  age: string;
  note: string;
  noteColor: string;
  route?: string;
  where?: string;
  owner?: string;
  machine?: string;
  host?: string;
  threadHandle?: string;
  prUrl?: string;
  row?: OperatorRow;
  workItem?: WorkItem;
}

export interface BatchCard {
  /** Repository-aware stable identity used for keys, selection, and highlighting. */
  identity: string;
  id: string;
  idAttr: string;
  title: string;
  repo: string;
  thread?: string;
  coordinator: string;
  mergeAuth: string;
  objective?: string;
  launchPrompt?: string;
  promptSaved: boolean;
  started: string;
  duration: string;
  host?: string;
  hostColor: string;
  machine?: string;
  tier: BatchTier;
  tierMeta: BatchTierMeta;
  superColor: string;
  superLabel: string;
  superPulse: boolean;
  convoLabel: string;
  convoColor: string;
  convoHint: string;
  done: number;
  running: number;
  total: number;
  donePct: string;
  runPct: string;
  qa: string;
  tokensTotal: string;
  cost: string;
  lanes: LaneView[];
  completion?: BatchCompletionReport;
  operation?: BatchOperation;
  batch: BatchRecord;
}

export function metric(value: string | null | undefined): string {
  return value == null || value === "" ? ABSENT : value;
}

export interface AgentCard {
  id: string;
  state: Liveness;
  color: string;
  work: string;
  beat: string;
  machine?: string;
  host?: string;
  target?: string;
  repo?: string;
  batchId?: string;
  batchPath?: string;
  threadHandle?: string;
  operator?: string;
  row?: OperatorRow;
  workItem?: WorkItem;
}

export interface MachineHostGroup {
  name: string;
  color: string;
  live: number;
  total: number;
  dead: number;
  agents: AgentCard[];
}

export interface MachineCard {
  id: string;
  label: string;
  user: string;
  live: number;
  total: number;
  dead: number;
  hosts: MachineHostGroup[];
}

export interface CoordinationView {
  hostLegend: HostLegendItem[];
  jobRows: JobRow[];
  jobCounts: Record<JobBucketId, number>;
  batchCards: BatchCard[];
  batchTierCounts: Record<BatchTier, number>;
  machines: MachineCard[];
}

// ── helpers ────────────────────────────────────────────────────────────

/** Normalize a host string to its canonical display name (Codex/Claude), else the trimmed input. */
export function canonicalHostName(host: string | undefined): string | undefined {
  const normalized = host?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/^codex(?:\b|[-_])/.test(normalized)) return "Codex";
  if (/^claude(?:\b|[-_])/.test(normalized)) return "Claude";
  return host?.trim();
}

export function hostColor(host: string | undefined): string {
  const canonical = canonicalHostName(host);
  if (canonical === "Codex") return CODEX_COLOR;
  if (canonical === "Claude") return CLAUDE_COLOR;
  return NEUTRAL_COLOR;
}

export function devToolForHost(host: string | undefined): string | undefined {
  const canonical = canonicalHostName(host);
  if (canonical === "Codex") return "Codex CLI";
  if (canonical === "Claude") return "Claude Code";
  return undefined;
}

const TERMINAL_STATUS_PATTERN = /\b(final|merged|done|closed|complete|completed|released|cancelled)\b/;
const BLOCKED_STATUS_PATTERN = /\b(block|blocked|blocking|waiting|depends|needs[_\- ]?changes)\b/;
const STUCK_STATUS_PATTERN = /\b(stuck|stale)\b/;
const PAUSED_STATUS_PATTERN = /\b(paused?|token[_\- ]?limit|context[_\- ]?limit|context[_\- ]?window)\b/;
const READY_STATUS_PATTERN = /\b(ready|queued|pending)\b/;
const RUNNING_STATUS_PATTERN = /\b(running|in[_\- ]?progress|coding|working|started|validating|pr[_\- ]?open|claim|review|implementing|discovery)\b/;

/** Derive a lifecycle state from a lane's coordination status when no live operator row exists. */
export function laneStatusState(status: string | undefined): OperatorState {
  const normalized = (status || "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (TERMINAL_STATUS_PATTERN.test(normalized)) return "done";
  if (PAUSED_STATUS_PATTERN.test(normalized)) return "paused";
  if (BLOCKED_STATUS_PATTERN.test(normalized)) return "blocked";
  if (STUCK_STATUS_PATTERN.test(normalized)) return "stale";
  if (READY_STATUS_PATTERN.test(normalized)) return "ready";
  if (RUNNING_STATUS_PATTERN.test(normalized)) return "running";
  return "unknown";
}

export function stateColor(state: OperatorState | string | undefined): string {
  switch (state) {
    case "running":
    case "done":
      return "var(--ok)";
    case "wedged":
    case "stale":
    case "paused":
      return "var(--warn)";
    case "blocked":
      return "var(--block)";
    case "dead":
      return "var(--bad)";
    case "ready":
      return "var(--info)";
    case "archived":
      return "var(--mut)";
    default:
      return "var(--mut)";
  }
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function ageLabel(value: string | undefined, nowMs: number): string {
  const valueMs = timestampMs(value);
  if (!valueMs) return ABSENT;
  const diffSeconds = Math.max(0, Math.floor((nowMs - valueMs) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
}

export function durationLabel(fromValue: string | undefined, nowMs: number): string {
  const fromMs = timestampMs(fromValue);
  if (!fromMs || nowMs <= fromMs) return ABSENT;
  const minutes = Math.floor((nowMs - fromMs) / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remMinutes}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function startedLabel(value: string | undefined): string {
  const ms = timestampMs(value);
  if (!ms) return ABSENT;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function typeWord(type: OperatorRow["type"]): string {
  if (type === "pull_request") return "PR";
  if (type === "issue") return "Issue";
  return "Work";
}

export function targetLabel(row: OperatorRow): string {
  if (!row.target) return row.title;
  const shown = displayAttribution(row.target, row.target);
  return /^\d+$/.test(shown) ? `${typeWord(row.type)} #${shown}` : `${typeWord(row.type)} ${shown}`;
}

function agentHost(agent: AgentSummary): string | undefined {
  return agent.heartbeat?.host || agent.claims.find((claim) => claim.host)?.host;
}

function agentMachine(agent: AgentSummary): string {
  return agent.machineId || agent.heartbeat?.machineId || (agent.machineMetadata?.state === "observed" ? agent.machineMetadata.value : "") || "";
}

// ── host legend ────────────────────────────────────────────────────────

const HOST_ORDER = ["Codex", "Claude"];

export function buildHostLegend(agents: AgentSummary[]): HostLegendItem[] {
  const groups = new Map<string, { live: number; total: number }>();
  for (const agent of agents) {
    const host = agentHost(agent);
    if (!host) continue;
    const canonical = canonicalHostName(host) ?? host;
    const group = groups.get(canonical) || { live: 0, total: 0 };
    group.total += 1;
    if (agent.liveness === "live") group.live += 1;
    groups.set(canonical, group);
  }
  return Array.from(groups.entries())
    .map(([name, counts]) => ({ name, color: hostColor(name), live: counts.live, total: counts.total }))
    .sort((left, right) => {
      const leftRank = HOST_ORDER.indexOf(left.name);
      const rightRank = HOST_ORDER.indexOf(right.name);
      return (leftRank === -1 ? 99 : leftRank) - (rightRank === -1 ? 99 : rightRank) || left.name.localeCompare(right.name);
    });
}

// ── jobs ───────────────────────────────────────────────────────────────

const NEEDS_INPUT_ATTENTION = new Set(["blocked_user_input", "qa_missing", "batch_stopped", "batch_stop_requested"]);

function completedOnLocalCalendarDay(value: string | undefined, nowMs: number): boolean {
  const completedMs = timestampMs(value);
  if (!completedMs || !nowMs) return false;
  const completed = new Date(completedMs);
  const now = new Date(nowMs);
  return completed.getFullYear() === now.getFullYear()
    && completed.getMonth() === now.getMonth()
    && completed.getDate() === now.getDate();
}

export function jobBucketForRow(row: OperatorRow, attentionKind?: string, nowMs = Date.now()): JobBucketId {
  if (attentionKind && NEEDS_INPUT_ATTENTION.has(attentionKind)) return "needs_input";
  switch (row.operatorState) {
    case "running":
      return "running";
    case "wedged":
    case "stale":
    case "paused":
    case "unknown":
      return "stuck";
    case "blocked":
    case "dead":
      return "blocked";
    case "ready":
      return "ready";
    case "done":
    case "archived":
      return completedOnLocalCalendarDay(row.completedAt, nowMs) ? "done" : "history";
    default:
      return "stuck";
  }
}

function jobNote(row: OperatorRow): string {
  if (row.blockedOn.length > 0) return `blocked on ${row.blockedOn.join(", ")}`;
  const activity = displayAttribution(row.activityStatus, "");
  return row.activityMessage || activity || row.retentionStatus || "";
}

function buildJobRow(row: OperatorRow, workItem: WorkItem | undefined, nowMs: number): JobRow {
  const bucket = jobBucketForRow(row, workItem?.attention?.kind, nowMs);
  const meta = JOB_BUCKET_BY_ID.get(bucket)!;
  const isTerminal = bucket === "done" || bucket === "history" || bucket === "ready";
  return {
    id: row.id,
    bucket,
    icon: meta.icon,
    iconColor: meta.color,
    targetLabel: targetLabel(row),
    implementationLabel: row.implementationPr ? `PR #${displayAttribution(row.implementationPr.target)}` : undefined,
    implementationUrl: row.implementationPr?.url,
    targetColor: isTerminal ? NEUTRAL_COLOR : hostColor(row.host),
    title: row.title,
    note: jobNote(row),
    noteColor: bucket === "blocked" ? "var(--block)" : bucket === "stuck" ? "var(--warn)" : "var(--mut)",
    host: row.host,
    hostColor: hostColor(row.host),
    machine: row.machineId,
    batchId: row.batchId,
    batchLabel: row.batchId ? displayAttribution(row.batchId) : undefined,
    age: row.lastActivityAge,
    action: meta.action,
    selectable: Boolean(workItem && isSelectableWorkItem(workItem)),
    selected: Boolean(workItem?.selected),
    row,
    workItem
  };
}

// ── batches ────────────────────────────────────────────────────────────

const TERMINAL_LANE_STATES = new Set<OperatorState>(["done", "archived"]);
const BLOCKED_LANE_STATES = new Set<OperatorState>(["blocked", "dead"]);
const STUCK_LANE_STATES = new Set<OperatorState>(["wedged", "stale", "paused"]);

function batchTitle(batch: BatchRecord): string {
  const objective = batch.objective?.trim();
  if (objective) {
    const firstSentence = objective.split(/(?<=[.!?])\s/)[0];
    return firstSentence.length > 68 ? `${firstSentence.slice(0, 65)}…` : firstSentence;
  }
  return displayAttribution(batch.batchId);
}

function operationMatchesBatch(operation: BatchOperation, batch: BatchRecord): boolean {
  if (operation.batchId !== batch.batchId) return false;
  if (operation.batchPath && batch.path) return operation.batchPath === batch.path;
  if (operation.repo && batch.repo) return operation.repo === batch.repo;
  return true;
}

function batchRepositoryScope(batch: BatchRecord): string {
  const fallbackRepo = batch.repo?.trim();
  const effectiveTargetRepos = (batch.targets || []).map((target) => target.repo?.trim() || fallbackRepo);
  if (effectiveTargetRepos.some((repo) => !repo)) return `UNKNOWN:${batch.path}`;
  const targetRepos = Array.from(new Set(effectiveTargetRepos.filter((repo): repo is string => Boolean(repo)))).sort();
  if (targetRepos.length === 1) return targetRepos[0];
  if (targetRepos.length > 1) return `MULTI:${targetRepos.join(",")}`;
  if (fallbackRepo) return fallbackRepo;
  // With no repository evidence, the source path is the only honest namespace.
  return `UNKNOWN:${batch.path}`;
}

function batchDisplayRepository(batch: BatchRecord): string {
  const scope = batchRepositoryScope(batch);
  return scope.startsWith("UNKNOWN:") || scope.startsWith("MULTI:")
    ? "UNKNOWN"
    : displayAttribution(scope, "UNKNOWN");
}

export function batchIdentity(batch: BatchRecord): string {
  return JSON.stringify([batchRepositoryScope(batch), batch.batchId]);
}

function batchDomToken(identity: string): string {
  return identity.replace(/[^A-Za-z0-9_-]/g, (character) => `-${character.codePointAt(0)!.toString(16)}-`);
}

function batchPreference(left: BatchRecord, right: BatchRecord): number {
  const sourceRank = (batch: BatchRecord) => batch.source === "inferred" ? 0 : 1;
  return sourceRank(right) - sourceRank(left)
    || timestampMs(right.updatedAt) - timestampMs(left.updatedAt)
    || timestampMs(right.createdAt) - timestampMs(left.createdAt)
    || right.lanes.length - left.lanes.length
    || left.path.localeCompare(right.path);
}

/**
 * Reconcile duplicate observations of the same repository-scoped batch before
 * rendering. A saved manifest is authoritative over an inferred observation;
 * ties are resolved from durable timestamps and paths, never array position.
 */
export function reconcileBatchRecords(batches: BatchRecord[]): BatchRecord[] {
  const grouped = new Map<string, BatchRecord[]>();
  for (const batch of batches) {
    const identity = batchIdentity(batch);
    const candidates = grouped.get(identity) || [];
    candidates.push(batch);
    grouped.set(identity, candidates);
  }
  return Array.from(grouped.values(), (candidates) => [...candidates].sort(batchPreference)[0]);
}

export interface BatchReference {
  batchId: string;
  repo?: string;
  path?: string;
}

/** Resolve a batch reference without silently choosing a same-ID batch in another repository. */
export function findBatchCard(cards: BatchCard[], reference: BatchReference): BatchCard | undefined {
  const candidates = cards.filter((card) => card.id === reference.batchId);
  if (reference.path) {
    const byPath = candidates.find((card) => card.batch.path === reference.path);
    if (byPath) return byPath;
  }
  if (reference.repo) {
    const byRepo = candidates.filter((card) =>
      batchRepositoryScope(card.batch) === reference.repo
      || (card.batch.targets || []).some((target) => target.repo === reference.repo)
    );
    return byRepo.length === 1 ? byRepo[0] : undefined;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function rowMatchesBatch(row: OperatorRow, batch: BatchRecord): boolean {
  if (row.batchId !== batch.batchId) return false;
  if (row.batchPath && batch.path) return row.batchPath === batch.path;
  const scope = batchRepositoryScope(batch);
  return !scope.startsWith("UNKNOWN:") && !scope.startsWith("MULTI:")
    ? row.repo === scope
    : (batch.targets || []).some((target) => target.repo === row.repo);
}

function laneRowsIndex(rows: OperatorRow[], batches: BatchRecord[]): Map<string, OperatorRow[]> {
  const index = new Map<string, OperatorRow[]>();
  for (const batch of batches) {
    for (const lane of batch.lanes) {
      const key = `${batchIdentity(batch)}\u0000${lane.name}`;
      index.set(key, rows.filter((row) => {
        if (!rowMatchesBatch(row, batch)) return false;
        if (row.laneName === lane.name) return true;
        if (row.laneName || !row.target || !lane.targets.includes(row.target)) return false;
        // Legacy custody may omit lane_name. A target is an honest fallback only
        // when the manifest assigns it to exactly one lane in this batch.
        return batch.lanes.filter((candidate) => candidate.targets.includes(row.target!)).length === 1;
      }));
    }
  }
  return index;
}

const LANE_BRANCH_CHARS = (index: number, total: number): string => (index === total - 1 ? "└" : "├");

function laneTargetUrl(batch: BatchRecord, target: string | undefined): string | undefined {
  if (!target) return undefined;
  const candidates = (batch.targets || []).filter((candidate) => candidate.target === target && candidate.url);
  const scoped = candidates.find((candidate) => !candidate.repo || !batch.repo || candidate.repo === batch.repo);
  if (scoped) return scoped.url;
  const urls = [...new Set(candidates.map((candidate) => candidate.url))];
  return urls.length === 1 ? urls[0] : undefined;
}

function buildLaneView(
  batch: BatchRecord,
  laneIndex: number,
  laneCount: number,
  laneRows: OperatorRow[],
  workItemByKey: Map<string, WorkItem>
): LaneView {
  const lane = batch.lanes[laneIndex];
  const representative = laneRows[0];
  const state: OperatorState = representative?.operatorState
    || (lane.blockedOn.length > 0 ? "blocked" : lane.liveness === "dead" ? "dead" : laneStatusState(lane.status));
  const firstTarget = lane.targets[0];
  const workItem = representative?.target
    ? workItemByKey.get(`${representative.repo}#${representative.target}`)
    : firstTarget
      ? workItemByKey.get(`${batch.repo}#${firstTarget}`)
      : undefined;
  const targetText = representative
    ? targetLabel(representative)
    : firstTarget
      ? `#${displayAttribution(firstTarget, firstTarget)}`
      : displayAttribution(lane.name);
  const note = lane.blockedOn.length > 0
    ? `depends on ${lane.blockedOn.join(", ")}`
    : representative
      ? jobNote(representative)
      : displayAttribution(lane.status, "");
  return {
    id: JSON.stringify([batchIdentity(batch), lane.name, [...lane.targets].sort(), lane.owner, lane.branch || ""]),
    branch: LANE_BRANCH_CHARS(laneIndex, laneCount),
    tag: displayAttribution(lane.name),
    target: targetText,
    targetColor: hostColor(representative?.host || lane.host),
    title: representative?.title || displayAttribution(lane.status, "Lane"),
    state: displayAttribution(lane.status, state),
    operatorState: state,
    stateColor: stateColor(state),
    age: representative?.lastActivityAge || ABSENT,
    note,
    noteColor: BLOCKED_LANE_STATES.has(state) ? "var(--block)" : STUCK_LANE_STATES.has(state) ? "var(--warn)" : "var(--mut)",
    route: lane.route || workItem?.route,
    where: displayAttribution(representative?.host || lane.host, ""),
    branchName: representative?.branch || lane.branch,
    targetUrl: representative?.url || laneTargetUrl(batch, firstTarget),
    owner: representative?.agentId || lane.owner,
    machine: representative?.machineId,
    host: representative?.host || lane.host,
    threadHandle: representative?.threadHandle || lane.threadHandle,
    prUrl: representative?.prUrl || representative?.implementationPr?.url || lane.prUrl,
    row: representative,
    workItem
  };
}

function batchTierFromLanes(laneStates: OperatorState[], operation: BatchOperation | undefined): BatchTier {
  if (operation && operation.controlStatus !== "running") return "blocked";
  if (laneStates.some((state) => BLOCKED_LANE_STATES.has(state))) return "blocked";
  if (laneStates.some((state) => STUCK_LANE_STATES.has(state))) return "stuck";
  if (laneStates.length > 0 && laneStates.every((state) => TERMINAL_LANE_STATES.has(state))) return "archive";
  return "running";
}

const BATCH_TIER_META = new Map(BATCH_TIERS.map((tier) => [tier.id, tier]));

function convoStatusFor(tier: BatchTier): { label: string; color: string; hint: string; superLabel: string } {
  switch (tier) {
    case "blocked":
      return { label: "Blocked on your authority", color: "var(--block)", hint: "Awaiting merge / takeover approval", superLabel: "blocked — needs your decision" };
    case "stuck":
      return { label: "Stuck — may be forgotten", color: "var(--warn)", hint: "A lane has no recent phase change", superLabel: "stale · check the stuck lane" };
    case "archive":
      return { label: "Ready for archiving", color: "var(--info)", hint: "Lanes done · review complete", superLabel: "complete · ready to archive" };
    default:
      return { label: "In progress", color: "var(--ok)", hint: "Coordinator live · lanes moving", superLabel: "live · lanes moving" };
  }
}

/** Compact token count, e.g. 2_090_000 -> "2.09M", 1200 -> "1.2K". */
export function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(2)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`;
  return `${total}`;
}

/** USD cost, e.g. 7.3 -> "$7.30". */
export function formatCost(total: number): string {
  return `$${total.toFixed(2)}`;
}

export interface UsageTotals {
  tokens: number;
  tokensTotal: string;
  cost?: string;
}

/**
 * Sum observed per-model usage into display totals. Returns undefined when the
 * list is empty so batches/items with no reported usage degrade rather than
 * showing a fabricated zero. Cost is omitted unless at least one entry carried it.
 */
export function aggregateUsage(usage: ModelUsage[] | undefined): UsageTotals | undefined {
  if (!usage || usage.length === 0) return undefined;
  let tokens = 0;
  let cost = 0;
  let sawCost = false;
  for (const entry of usage) {
    tokens += entry.tokensIn + entry.tokensOut;
    if (entry.costUsd !== undefined) {
      sawCost = true;
      cost += entry.costUsd;
    }
  }
  return { tokens, tokensTotal: formatTokens(tokens), cost: sawCost ? formatCost(cost) : undefined };
}

/** Roll a batch's per-lane usage up into total tokens/cost, deduping shared work items. */
function aggregateBatchUsage(lanes: LaneView[]): { tokensTotal?: string; cost?: string } {
  const seen = new Set<string>();
  const merged: ModelUsage[] = [];
  for (const lane of lanes) {
    const item = lane.workItem;
    if (!item?.usage || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(...item.usage);
  }
  const totals = aggregateUsage(merged);
  return { tokensTotal: totals?.tokensTotal, cost: totals?.cost };
}

export function buildBatchCard(
  batch: BatchRecord,
  operation: BatchOperation | undefined,
  rowsByLane: Map<string, OperatorRow[]>,
  workItemByKey: Map<string, WorkItem>,
  nowMs: number
): BatchCard {
  const laneCount = batch.lanes.length;
  const lanes = batch.lanes.map((lane, index) =>
    buildLaneView(batch, index, laneCount, rowsByLane.get(`${batchIdentity(batch)}\u0000${lane.name}`) || [], workItemByKey)
  );
  const laneStates = lanes.map((lane) => lane.operatorState);
  const tier = batchTierFromLanes(laneStates, operation);
  const tierMeta = BATCH_TIER_META.get(tier)!;
  const done = laneStates.filter((state) => TERMINAL_LANE_STATES.has(state)).length;
  const running = laneStates.filter((state) => state === "running" || STUCK_LANE_STATES.has(state)).length;
  const total = laneCount || 1;
  const convo = convoStatusFor(tier);
  const host = batch.lanes.find((lane) => lane.host)?.host;
  const completion = batch.completion;
  const usageRollup = aggregateBatchUsage(lanes);
  const latestLaneActivity = lanes
    .map((lane) => lane.row?.lastActivityAt)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => timestampMs(right) - timestampMs(left))[0];
  return {
    identity: batchIdentity(batch),
    id: batch.batchId,
    idAttr: `batch-${batchDomToken(batchIdentity(batch))}`,
    title: batchTitle(batch),
    repo: batchDisplayRepository(batch),
    thread: undefined,
    coordinator: ABSENT,
    mergeAuth: batch.mergeAuthority || ABSENT,
    objective: batch.objective,
    launchPrompt: batch.launchPrompt,
    promptSaved: Boolean(batch.launchPrompt),
    started: startedLabel(batch.createdAt),
    duration: completion?.duration != null && completion.duration !== "" ? completion.duration : durationLabel(batch.createdAt, nowMs),
    host,
    hostColor: hostColor(host),
    machine: batch.createdByMachine,
    tier,
    tierMeta,
    superColor: tierMeta.color,
    superLabel: latestLaneActivity ? `${convo.superLabel} · beat ${ageLabel(latestLaneActivity, nowMs)}` : convo.superLabel,
    superPulse: tier === "running",
    convoLabel: convo.label,
    convoColor: convo.color,
    convoHint: convo.hint,
    done,
    running,
    total,
    donePct: `${Math.round((done / total) * 100)}%`,
    runPct: `${Math.round((running / total) * 100)}%`,
    qa: operation ? `${operation.qa.passed}/${operation.qa.total}` : ABSENT,
    // A completion report may signal "unknown" as "—"/null (per BatchCompletionReport);
    // in that case fall back to the live per-lane usage rollup rather than showing "—".
    tokensTotal: metric(completion?.tokensTotal && completion.tokensTotal !== ABSENT ? completion.tokensTotal : usageRollup.tokensTotal),
    cost: metric(completion?.cost && completion.cost !== ABSENT ? completion.cost : usageRollup.cost),
    lanes,
    completion,
    operation,
    batch
  };
}

// ── machines ───────────────────────────────────────────────────────────

const MACHINE_LIVE_STATES = new Set<Liveness>(["live", "stale", "unknown"]);

function agentWorkLabel(agent: AgentSummary): string {
  const work = agent.currentWork[0];
  if (work) {
    const title = work.github?.title;
    return title ? `${work.repo}#${work.target} · ${title}` : `${work.repo}#${work.target}`;
  }
  const event = agent.latestEvent;
  if (event?.target) return `${displayAttribution(event.repo)}#${event.target}`;
  return "No active work";
}

export function buildMachineCards(agents: AgentSummary[], nowMs: number, jobRows: JobRow[] = []): MachineCard[] {
  const machineGroups = new Map<string, AgentSummary[]>();
  for (const agent of agents) {
    const machine = agentMachine(agent) || "unassigned";
    const group = machineGroups.get(machine) || [];
    group.push(agent);
    machineGroups.set(machine, group);
  }

  return Array.from(machineGroups.entries())
    .map(([machine, machineAgents]) => {
      const hostGroups = new Map<string, AgentSummary[]>();
      for (const agent of machineAgents) {
        const host = agentHost(agent) || "unattributed";
        const canonical = canonicalHostName(host) ?? host;
        const group = hostGroups.get(canonical) || [];
        group.push(agent);
        hostGroups.set(canonical, group);
      }
      const hosts: MachineHostGroup[] = Array.from(hostGroups.entries())
        .map(([name, hostAgents]) => {
          const live = hostAgents.filter((agent) => agent.liveness === "live").length;
          const dead = hostAgents.filter((agent) => !MACHINE_LIVE_STATES.has(agent.liveness)).length;
          const cards: AgentCard[] = hostAgents
            .filter((agent) => MACHINE_LIVE_STATES.has(agent.liveness))
            .map((agent) => {
              const currentWork = agent.currentWork[0];
              const claim = agent.claims.find((candidate) => candidate.status === "active") || agent.claims[0];
              const repo = currentWork?.repo || agent.heartbeat?.repo || claim?.repo;
              const target = currentWork?.target || agent.heartbeat?.target || claim?.target;
              const job = currentWork
                ? jobRows.find((candidate) => candidate.workItem?.id === currentWork.id)
                : (() => {
                    const candidates = jobRows.filter((candidate) =>
                      candidate.row.agentId === agent.agentId
                      && (!repo || candidate.row.repo === repo)
                      && (!target || candidate.row.target === target)
                    );
                    return repo && target ? candidates[0] : candidates.length === 1 ? candidates[0] : undefined;
                  })();
              const row = job?.row;
              const workItem = job?.workItem || currentWork;
              return {
                id: displayAttribution(agent.agentId),
                state: agent.liveness,
                color: agent.liveness === "live" ? "var(--ok)" : agent.liveness === "stale" ? "var(--warn)" : "var(--mut)",
                work: agentWorkLabel(agent),
                beat: agent.heartbeat ? `beat ${ageLabel(agent.heartbeat.updatedAt, nowMs)} ago` : "no heartbeat",
                machine,
                host: name,
                repo,
                target: repo && target ? `${repo}#${target}` : undefined,
                batchId: row?.batchId || agent.heartbeat?.batchId || claim?.batchId,
                batchPath: row?.batchPath,
                threadHandle: row?.threadHandle || agent.heartbeat?.threadHandle || claim?.threadHandle,
                operator: row?.operator || agent.heartbeat?.operator || claim?.operator,
                row,
                workItem
              };
            });
          return { name, color: hostColor(name), live, total: hostAgents.length, dead, agents: cards };
        })
        .sort((left, right) => {
          const leftRank = HOST_ORDER.indexOf(left.name);
          const rightRank = HOST_ORDER.indexOf(right.name);
          return (leftRank === -1 ? 99 : leftRank) - (rightRank === -1 ? 99 : rightRank) || left.name.localeCompare(right.name);
        });
      const owner = machineAgents.find((agent) => agent.claims.find((claim) => claim.operator))?.claims.find((claim) => claim.operator)?.operator
        || machineAgents.find((agent) => agent.heartbeat?.operator)?.heartbeat?.operator;
      return {
        id: machine,
        label: machine === "unassigned" ? "unassigned" : displayAttribution(machine),
        user: owner ? displayAttribution(owner) : ABSENT,
        live: hosts.reduce((total, host) => total + host.live, 0),
        total: hosts.reduce((total, host) => total + host.total, 0),
        dead: hosts.reduce((total, host) => total + host.dead, 0),
        hosts
      };
    })
    .sort((left, right) => right.live - left.live || left.label.localeCompare(right.label));
}

// ── top-level builder ──────────────────────────────────────────────────

export function buildCoordinationView(dashboard: DashboardModel, now?: Date | string | number): CoordinationView {
  const nowMs = now === undefined
    ? timestampMs(dashboard.generatedAt) || Date.now()
    : typeof now === "number"
      ? now
      : now instanceof Date
        ? now.getTime()
        : timestampMs(now) || Date.now();

  const reconciledBatches = reconcileBatchRecords(dashboard.batches);
  const rows = buildOperatorRows({ ...dashboard, batches: reconciledBatches }, { now: new Date(nowMs) });
  const workItemByKey = new Map(dashboard.workItems.map((item) => [`${item.repo}#${item.target}`, item]));

  const jobRows = rows.map((row) => buildJobRow(row, row.target ? workItemByKey.get(`${row.repo}#${row.target}`) : undefined, nowMs));
  const jobCounts = JOB_BUCKETS.reduce((counts, bucket) => {
    counts[bucket.id] = jobRows.filter((row) => row.bucket === bucket.id).length;
    return counts;
  }, {} as Record<JobBucketId, number>);

  const rowsByLane = laneRowsIndex(rows, reconciledBatches);
  const batchCards = reconciledBatches
    .map((batch) => {
      const operation = dashboard.batchOperations.find((candidate) => operationMatchesBatch(candidate, batch));
      return buildBatchCard(batch, operation, rowsByLane, workItemByKey, nowMs);
    })
    .sort((left, right) => BATCH_TIER_RANK[left.tier] - BATCH_TIER_RANK[right.tier]);
  const batchTierCounts = BATCH_TIERS.reduce((counts, tier) => {
    counts[tier.id] = batchCards.filter((card) => card.tier === tier.id).length;
    return counts;
  }, {} as Record<BatchTier, number>);

  const machines = buildMachineCards(dashboard.agents, nowMs, jobRows);

  return { hostLegend: buildHostLegend(dashboard.agents), jobRows, jobCounts, batchCards, batchTierCounts, machines };
}
