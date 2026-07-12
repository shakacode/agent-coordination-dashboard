import type { BatchWorkSignal } from "./types";

/** Human-readable identity that never invents a missing batch or lane value. */
export function batchSignalIdentity(signal: Pick<BatchWorkSignal, "batchId" | "laneName">): string {
  if (signal.batchId && signal.laneName) return `batch ${signal.batchId}:${signal.laneName}`;
  if (signal.batchId) return `batch ${signal.batchId}`;
  if (signal.laneName) return `lane ${signal.laneName}`;
  return "unattributed batch or lane";
}
