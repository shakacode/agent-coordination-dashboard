import { describe, expect, it } from "vitest";
import { generatePrBatchPrompt } from "./prompt";
import type { WorkItem } from "./types";

const baseItem: WorkItem = {
  id: "shakacode/react_on_rails#4005",
  repo: "shakacode/react_on_rails",
  target: "4005",
  type: "pull_request",
  schedulingState: "ready_for_batch",
  selected: true,
  warnings: [],
  github: {
    repo: "shakacode/react_on_rails",
    target: "4005",
    type: "pull_request",
    title: "Fix FOUC integration tests",
    url: "https://github.com/shakacode/react_on_rails/pull/4005",
    state: "OPEN",
    labels: [],
    loadState: "loaded"
  }
};

describe("generatePrBatchPrompt", () => {
  it("creates a compact pr-batch prompt for selected work", () => {
    const prompt = generatePrBatchPrompt([baseItem]);

    expect(prompt).toContain("Use $pr-batch");
    expect(prompt).toContain("Repository: shakacode/react_on_rails");
    expect(prompt).toContain("PR #4005");
    expect(prompt).toContain("Fix FOUC integration tests");
    expect(prompt).toContain("agent-coord status");
    expect(prompt.length).toBeLessThan(4000);
  });

  it("excludes unselected work", () => {
    const prompt = generatePrBatchPrompt([{ ...baseItem, selected: false }]);

    expect(prompt).toContain("No selected items");
    expect(prompt).not.toContain("PR #4005");
  });

  it("excludes selected in-process work", () => {
    const prompt = generatePrBatchPrompt([{ ...baseItem, schedulingState: "in_process", selected: true }]);

    expect(prompt).toContain("No selected items");
    expect(prompt).not.toContain("PR #4005");
  });

  it("excludes selected work already scheduled in a batch", () => {
    const prompt = generatePrBatchPrompt([
      {
        ...baseItem,
        batchSignals: [{ batchId: "batch-1", laneName: "lane-a", status: "queued", blockedOn: [] }]
      }
    ]);

    expect(prompt).toContain("No selected items");
    expect(prompt).not.toContain("PR #4005");
  });
});
