import type { BatchRecord, BatchWorkSignal, WorkItem } from "./types";

/** Human-readable identity that never invents a missing batch or lane value. */
export function batchSignalIdentity(signal: Pick<BatchWorkSignal, "batchId" | "laneName">): string {
  if (signal.batchId && signal.laneName) return `batch ${signal.batchId}:${signal.laneName}`;
  if (signal.batchId) return `batch ${signal.batchId}`;
  if (signal.laneName) return `lane ${signal.laneName}`;
  return "unattributed batch or lane";
}

/**
 * Resolves lane-only membership for a repo-less batch only when its signals
 * corroborate exactly one repository.
 */
export function repoLessBatchLaneMatchesWorkItem(
  batch: Pick<BatchRecord, "repo" | "lanes">,
  signalBatchId: string,
  item: Pick<WorkItem, "repo" | "target" | "batchSignals">,
  workItems: ReadonlyArray<Pick<WorkItem, "repo" | "target" | "batchSignals">>
): boolean {
  if (batch.repo || !batch.lanes.some((lane) => lane.targets.includes(item.target))) return false;
  if (!item.batchSignals?.some((signal) => signal.batchId === signalBatchId)) return false;
  const laneTargets = new Set(batch.lanes.flatMap((lane) => lane.targets));
  const corroboratedRepos = new Set(workItems.filter((candidate) =>
    laneTargets.has(candidate.target)
    && candidate.batchSignals?.some((signal) => signal.batchId === signalBatchId)
  ).map((candidate) => candidate.repo));
  return corroboratedRepos.size === 1 && corroboratedRepos.has(item.repo);
}
