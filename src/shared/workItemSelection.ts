import type { WorkItem } from "./types";

export function isOperationalWorkItem(item: WorkItem): boolean {
  return !item.terminalState && !["terminal", "archived_view"].includes(item.operatorState || "");
}

export function isSelectableWorkItem(item: WorkItem): boolean {
  return item.schedulingState !== "in_process"
    && !item.batchSignals?.length
    && isOperationalWorkItem(item);
}
