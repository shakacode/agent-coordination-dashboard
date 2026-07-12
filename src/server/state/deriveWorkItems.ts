import type { BatchEvent, BatchOperation, QaValidationItem, WorkItem, WorkItemOperatorState, WorkItemTerminalState } from "../../shared/types";

export const WEDGED_AFTER_MS = 15 * 60 * 1000;
export const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

interface DeriveWorkItemsInput {
  workItems: WorkItem[];
  now: Date;
  events?: BatchEvent[];
  qaValidations?: QaValidationItem[];
  batchOperations?: BatchOperation[];
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
  if (/\b(done|complete|completed|merged|released)\b/.test(status)) return "done";
  return undefined;
}

function attention(item: WorkItem, statuses: string[], activityAt: string | undefined, input: DeriveWorkItemsInput) {
  const status = statuses.join(" ").toLowerCase();
  const operation = input.batchOperations?.find((candidate) => item.batchSignals?.some((signal) => signal.batchId === candidate.batchId));
  const validation = input.qaValidations?.find(
    (candidate) => candidate.repo === item.repo && candidate.target === item.target && ["missing", "failed"].includes(candidate.status)
  );
  const age = input.now.getTime() - timestamp(activityAt);

  if (operation && operation.controlStatus !== "running") {
    return { kind: "batch_stopped" as const, label: "Batch is stopped", action: "Open batch" as const };
  }
  if (/\bblocked[ _-]?user[ _-]?input\b|\bneeds[ _-]?user[ _-]?input\b/.test(status)) {
    return { kind: "blocked_user_input" as const, label: "Waiting for operator input", action: "Copy resume prompt" as const };
  }
  if (validation) {
    return { kind: "qa_missing" as const, label: "QA evidence is missing or failing", action: "Open PR" as const };
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
    const reason = terminal ? undefined : attention(item, statuses, activityAt, input);
    return {
      ...item,
      operatorState: operatorState(item, terminal, reason, activityAt, input.now),
      terminalState: terminal,
      attention: reason,
      lastActivityAt: activityAt
    };
  });
}
