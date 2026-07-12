import type { WorkItem } from "./types";

export function isSelectableWorkItem(item: WorkItem): boolean {
  return item.schedulingState !== "in_process"
    && !item.batchSignals?.length
    && !item.terminalState
    && !["terminal", "archived_view"].includes(item.operatorState || "");
}
