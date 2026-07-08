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
    expect(prompt).toMatch(/Batch id: batch-shakacode-react-on-rails-[a-z0-9]+/);
    expect(prompt).toContain("PR #4005");
    expect(prompt).toContain("Fix FOUC integration tests");
    expect(prompt).toContain("Before starting workers, save this batch plan");
    expect(prompt).toContain("Every worker must use this batch id");
    expect(prompt).toContain("agent-coord status");
    expect(prompt).toContain(
      "agent-coord claim before creating worktrees or branches when the `agent-coord` CLI is available in this repo"
    );
    expect(prompt).not.toContain("current coordination command");
    expect(prompt).not.toContain("launch_prompt");
    expect(prompt).not.toContain("coordination backend");
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

  it("refuses ambiguous multi-repo prompts with duplicate PR or issue numbers", () => {
    const prompt = generatePrBatchPrompt([
      {
        ...baseItem,
        id: "repo-a/app#12",
        repo: "repo-a/app",
        target: "12",
        type: "pull_request",
        github: {
          ...baseItem.github!,
          repo: "repo-a/app",
          target: "12",
          type: "pull_request",
          url: "https://github.com/repo-a/app/pull/12"
        }
      },
      {
        ...baseItem,
        id: "repo-b/api#12",
        repo: "repo-b/api",
        target: "12",
        type: "issue",
        github: {
          ...baseItem.github!,
          repo: "repo-b/api",
          target: "12",
          type: "issue",
          url: "https://github.com/repo-b/api/issues/12"
        }
      }
    ]);

    expect(prompt).toContain("Cannot generate a single $pr-batch prompt");
    expect(prompt).toContain("#12 in repo-a/app, repo-b/api");
    expect(prompt).not.toContain("Suggested lanes:");
  });
});
