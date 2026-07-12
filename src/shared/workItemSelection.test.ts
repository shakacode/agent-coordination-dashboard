import { describe, expect, it } from "vitest";
import type { WorkItem } from "./types";
import { isSelectableWorkItem } from "./workItemSelection";

const item: WorkItem = {
  id: "repo/app#43",
  repo: "repo/app",
  target: "43",
  type: "issue",
  schedulingState: "ready_for_batch",
  warnings: [],
  selected: false
};

describe("isSelectableWorkItem", () => {
  it("accepts only unscheduled, nonterminal work", () => {
    expect(isSelectableWorkItem(item)).toBe(true);
    expect(isSelectableWorkItem({ ...item, schedulingState: "in_process" })).toBe(false);
    expect(isSelectableWorkItem({
      ...item,
      batchSignals: [{ batchId: "batch-1", status: "queued", blockedOn: [] }]
    })).toBe(false);
    expect(isSelectableWorkItem({ ...item, terminalState: "done" })).toBe(false);
    expect(isSelectableWorkItem({ ...item, operatorState: "terminal" })).toBe(false);
    expect(isSelectableWorkItem({ ...item, operatorState: "archived_view" })).toBe(false);
  });
});
