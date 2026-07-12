import type { BatchEvent, BatchOperation, BatchRecord, QaValidationItem, WorkItem, WorkItemOperatorState, WorkItemTerminalState } from "../../shared/types";
import { repoLessBatchLaneMatchesWorkItem } from "../../shared/batchSignal";

export const WEDGED_AFTER_MS = 15 * 60 * 1000;
export const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

interface DeriveWorkItemsInput {
  workItems: WorkItem[];
  now: Date;
  events?: BatchEvent[];
  qaValidations?: QaValidationItem[];
  batchOperations?: BatchOperation[];
  batches?: BatchRecord[];
}

function operationMatchesItem(operation: BatchOperation, item: WorkItem, input: DeriveWorkItemsInput): boolean {
  if (!item.batchSignals?.some((signal) => signal.batchId === operation.batchId)) return false;
  if (operation.repo) return operation.repo === item.repo;
  const batch = input.batches?.find((candidate) =>
    operation.batchPath ? candidate.path === operation.batchPath : candidate.batchId === operation.batchId
  );
  if (batch?.repo) return batch.repo === item.repo;
  const explicitTarget = batch?.targets?.find((target) => target.target === item.target && (target.repo || batch.repo) === item.repo);
  if (explicitTarget) return true;
  if (batch) return repoLessBatchLaneMatchesWorkItem(batch, operation.batchId, item, input.workItems);
  const repos = new Set(input.workItems.filter((candidate) => candidate.batchSignals?.some((signal) => signal.batchId === operation.batchId)).map((candidate) => candidate.repo));
  return repos.size === 1 && repos.has(item.repo);
}

function timestamp(value: string | undefined): number {
  const result = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(result) ? result : 0;
}

function latestTimestamp(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => timestamp(value) > 0).sort((left, right) => timestamp(right) - timestamp(left))[0];
}

function terminalState(statuses: string[]): WorkItemTerminalState | undefined {
  const status = statuses.join(" ").toLowerCase();
  if (/\b(superseded|replaced)\b/.test(status)) return "superseded";
  if (/\b(abandoned|cancelled|canceled)\b/.test(status)) return "abandoned";
  if (/\b(closed)\b/.test(status)) return "closed";
  if (/\b(done|complete|completed|merged)\b/.test(status)) return "done";
  return undefined;
}

function attention(item: WorkItem, statuses: string[], activityAt: string | undefined, input: DeriveWorkItemsInput) {
  const status = statuses.join(" ").toLowerCase();
  const operation = input.batchOperations?.find((candidate) => operationMatchesItem(candidate, item, input));
  const validation = input.qaValidations?.find(
    (candidate) => candidate.repo === item.repo && candidate.target === item.target && ["missing", "failed"].includes(candidate.status)
  );
  const age = input.now.getTime() - timestamp(activityAt);

  if (operation?.controlStatus === "stopped") {
    return { kind: "batch_stopped" as const, label: "Batch is stopped", action: "Copy resume prompt" as const };
  }
  if (operation?.controlStatus === "stop_requested") {
    return { kind: "batch_stop_requested" as const, label: "Batch stop is pending", action: "Open batch operations" as const };
  }
  if (/\bblocked[ _-]?user[ _-]?input\b|\bneeds[ _-]?user[ _-]?input\b/.test(status)) {
    return { kind: "blocked_user_input" as const, label: "Waiting for operator input", action: "Copy resume prompt" as const };
  }
  if (validation) {
    const candidateUrl = item.github?.type === "pull_request" ? item.github.url : item.claim?.prUrl || item.heartbeat?.prUrl;
    const hasPullRequestUrl = Boolean(candidateUrl && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/i.test(candidateUrl));
    return {
      kind: "qa_missing" as const,
      label: "QA evidence is missing or failing",
      action: hasPullRequestUrl ? "Open PR" as const : "Copy resume prompt" as const
    };
  }
  if (item.heartbeat?.liveness === "dead") {
    return { kind: "dead_holder" as const, label: "Holder is no longer live", action: "Copy resume prompt" as const };
  }
  if (/\bwedged\b/.test(status) || (item.heartbeat && ["live", "stale"].includes(item.heartbeat.liveness) && age > WEDGED_AFTER_MS)) {
    return { kind: "wedged" as const, label: "No progress for over 15 minutes", action: "Copy resume prompt" as const };
  }
  return undefined;
}

function operatorState(item: WorkItem, terminal: WorkItemTerminalState | undefined, reason: WorkItem["attention"], activityAt: string | undefined, now: Date): WorkItemOperatorState {
  if (terminal) {
    return now.getTime() - timestamp(activityAt) > ARCHIVE_AFTER_MS ? "archived_view" : "terminal";
  }
  if (reason) return "needs_attention";
  if (item.heartbeat && ["live", "stale"].includes(item.heartbeat.liveness)) return "running";
  return "ready";
}

function mayHaveOpenPullRequest(item: WorkItem): boolean {
  if (item.github?.type === "pull_request") {
    return item.github.loadState !== "loaded" || item.github.state.toLowerCase() === "open";
  }
  return Boolean(item.claim?.prUrl || item.heartbeat?.prUrl);
}

/** Build the single, read-only operator state used by every v2 dashboard surface. */
export function deriveWorkItems(input: DeriveWorkItemsInput): WorkItem[] {
  return input.workItems.map((item) => {
    const matchingEvents = (input.events || []).filter((event) => event.repo === item.repo && event.target === item.target);
    const activityAt = latestTimestamp([
      item.heartbeat?.updatedAt,
      item.claim?.updatedAt,
      item.claim?.claimedAt,
      ...item.batchSignals?.map((signal) => signal.updatedAt) || [],
      ...matchingEvents.map((event) => event.timestamp)
    ]);
    const statuses = [
      item.heartbeat?.status,
      item.claim?.status,
      ...item.batchSignals?.map((signal) => signal.status) || [],
      ...matchingEvents.map((event) => event.status || event.type)
    ].filter((value): value is string => Boolean(value));
    const terminal = terminalState(statuses);
    const deadPastPresentationTtl = item.heartbeat?.liveness === "dead"
      && input.now.getTime() - timestamp(activityAt) > ARCHIVE_AFTER_MS
      && !mayHaveOpenPullRequest(item);
    const reason = terminal || deadPastPresentationTtl ? undefined : attention(item, statuses, activityAt, input);
    return {
      ...item,
      operatorState: deadPastPresentationTtl ? "archived_view" : operatorState(item, terminal, reason, activityAt, input.now),
      terminalState: terminal,
      attention: reason,
      lastActivityAt: activityAt
    };
  });
}
