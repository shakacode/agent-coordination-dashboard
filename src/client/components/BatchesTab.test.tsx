import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BatchEvent, BatchOperation, BatchRecord } from "../../shared/types";
import { BatchesTab } from "./BatchesTab";

const event: BatchEvent = {
  eventId: "event-1",
  type: "continued",
  batchId: "batch-1",
  batchPath: "batches/batch-1.json",
  laneName: "lane-a",
  repo: "shakacode/react_on_rails",
  target: "4010",
  status: "in_progress",
  message: "Resumed after token-limit pause.",
  timestamp: "2026-06-17T20:00:00Z",
  path: "events/batch-1.jsonl:1"
};

const batch: BatchRecord = {
  schemaVersion: 1,
  batchId: "batch-1",
  repo: "shakacode/react_on_rails",
  objective: "Stabilize a retained batch.",
  targets: [{ type: "pull_request", target: "4010" }],
  launchPrompt: "Use $pr-batch to complete batch-1.\nBatch id: batch-1\nItems:\n- PR #4010",
  path: "batches/batch-1.json",
  lanes: [
    {
      name: "lane-a",
      owner: "worker-a",
      targets: ["4010"],
      dependsOn: [],
      status: "queued",
      liveness: "no-heartbeat",
      blockedOn: []
    }
  ]
};

const operation: BatchOperation = {
  batchId: "batch-1",
  repo: "shakacode/react_on_rails",
  batchPath: "batches/batch-1.json",
  controlStatus: "stop_requested",
  eventCount: 2,
  latestEventAt: "2026-06-17T20:00:00Z",
  latestEventType: "batch.stop_requested",
  stopRequestedAt: "2026-06-17T20:00:00Z",
  qa: {
    total: 1,
    missing: 0,
    requested: 0,
    inProgress: 0,
    passed: 1,
    failed: 0,
    unknown: 0
  }
};

describe("BatchesTab", () => {
  it("renders event status and message separately", () => {
    render(<BatchesTab batches={[batch]} events={[event]} />);

    expect(screen.getByText("continued")).toBeInTheDocument();
    expect(screen.getByText("in_progress")).toBeInTheDocument();
    expect(screen.getByText("Resumed after token-limit pause.")).toBeInTheDocument();
  });

  it("renders scoped event history even when no saved batch plan is available", () => {
    render(<BatchesTab batches={[]} events={[{ ...event, batchPath: undefined }]} />);

    expect(screen.getByRole("heading", { name: "Recent history" })).toBeInTheDocument();
    expect(screen.getByText("No saved batch plan")).toBeInTheDocument();
    expect(screen.getByText("Resumed after token-limit pause.")).toBeInTheDocument();
  });

  it("labels inferred batches", () => {
    render(<BatchesTab batches={[{ ...batch, source: "inferred" }]} events={[]} />);

    expect(screen.getByText("Inferred")).toBeInTheDocument();
  });

  it("shows, expands, and copies saved coordination prompts", async () => {
    const clipboard = { writeText: vi.fn() };
    Object.assign(navigator, { clipboard });
    render(<BatchesTab batches={[batch]} events={[]} />);

    expect(screen.getByText("Coordination prompt saved")).toBeInTheDocument();
    expect(screen.getByText("Use $pr-batch to complete batch-1.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Copy coordination prompt for batch-1" }));

    expect(clipboard.writeText).toHaveBeenCalledWith(batch.launchPrompt);
  });

  it("shows audit/control status and requests a local stop explicitly", async () => {
    const onRequestStop = vi.fn().mockResolvedValue(undefined);
    render(<BatchesTab batches={[batch]} events={[event]} operations={[operation]} onRequestStop={onRequestStop} />);

    expect(screen.getByText("Stop requested")).toBeInTheDocument();
    expect(screen.getByText("2 events")).toBeInTheDocument();
    expect(screen.getByText("QA 1 passed / 0 missing")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Request stop for batch-1 in shakacode/react_on_rails" }));

    expect(onRequestStop).toHaveBeenCalledWith({
      batchId: "batch-1",
      repo: "shakacode/react_on_rails",
      reason: "Stop requested from dashboard so this batch can be restarted."
    });
  });

  it("keeps same-repo same-ID batch operations associated by manifest path", () => {
    const firstBatch = {
      ...batch,
      path: "batches/first/batch-1.json",
      lanes: [{ ...batch.lanes[0], name: "lane-first" }]
    };
    const secondBatch = {
      ...batch,
      path: "batches/second/batch-1.json",
      lanes: [{ ...batch.lanes[0], name: "lane-second" }]
    };
    const firstOperation = {
      ...operation,
      batchPath: firstBatch.path,
      eventCount: 2,
      controlStatus: "stop_requested" as const
    };
    const secondOperation = {
      ...operation,
      batchPath: secondBatch.path,
      eventCount: 7,
      controlStatus: "stopped" as const,
      qa: { ...operation.qa, passed: 0, failed: 1 }
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = render(
      <BatchesTab batches={[firstBatch, secondBatch]} events={[]} operations={[firstOperation, secondOperation]} />
    );

    const assertAssociations = () => {
      const firstPanel = screen.getByText("lane-first").closest("article");
      const secondPanel = screen.getByText("lane-second").closest("article");
      expect(firstPanel).not.toBeNull();
      expect(secondPanel).not.toBeNull();
      expect(within(firstPanel!).getByText("Stop requested")).toBeInTheDocument();
      expect(within(firstPanel!).getByText("2 events")).toBeInTheDocument();
      expect(within(secondPanel!).getByText("Stopped")).toBeInTheDocument();
      expect(within(secondPanel!).getByText("7 events")).toBeInTheDocument();
      expect(within(secondPanel!).getByText("QA 0 passed / 1 failed / 0 missing")).toBeInTheDocument();
    };

    assertAssociations();
    rerender(<BatchesTab batches={[secondBatch, firstBatch]} events={[]} operations={[secondOperation, firstOperation]} />);
    assertAssociations();
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
    consoleError.mockRestore();
  });

  it("requests repo-scoped stops for repo-less multi-repo batches", async () => {
    const onRequestStop = vi.fn().mockResolvedValue(undefined);
    render(
      <BatchesTab
        batches={[
          {
            ...batch,
            repo: undefined,
            targets: [
              { type: "pull_request", target: "12", repo: "repo-a/app" },
              { type: "pull_request", target: "34", repo: "repo-b/api" }
            ]
          }
        ]}
        events={[]}
        operations={[{ ...operation, repo: undefined }]}
        onRequestStop={onRequestStop}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Request stop for batch-1 in repo-b/api" }));

    expect(onRequestStop).toHaveBeenCalledWith({
      batchId: "batch-1",
      repo: "repo-b/api",
      reason: "Stop requested from dashboard so this batch can be restarted."
    });
  });

  it("includes per-target stop scopes for mixed top-level repo batches", async () => {
    const onRequestStop = vi.fn().mockResolvedValue(undefined);
    render(
      <BatchesTab
        batches={[
          {
            ...batch,
            repo: "repo-a/app",
            targets: [
              { type: "pull_request", target: "12", repo: "repo-a/app" },
              { type: "pull_request", target: "34", repo: "repo-b/api" }
            ]
          }
        ]}
        events={[]}
        operations={[{ ...operation, repo: "repo-a/app" }]}
        onRequestStop={onRequestStop}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Request stop for batch-1 in repo-b/api" }));

    expect(onRequestStop).toHaveBeenCalledWith({
      batchId: "batch-1",
      repo: "repo-b/api",
      reason: "Stop requested from dashboard so this batch can be restarted."
    });
  });

  it("surfaces failed and active QA counts in the batch summary", () => {
    render(
      <BatchesTab
        batches={[batch]}
        events={[]}
        operations={[
          {
            ...operation,
            qa: {
              total: 4,
              missing: 0,
              requested: 1,
              inProgress: 1,
              passed: 0,
              failed: 1,
              unknown: 1
            }
          }
        ]}
      />
    );

    expect(screen.getByText("QA 0 passed / 1 failed / 1 in progress / 1 requested / 1 unknown / 0 missing")).toBeInTheDocument();
  });

  it("reviews pasted coordination prompts before saving batch plans", async () => {
    const onImportBatch = vi.fn().mockResolvedValue(undefined);
    render(<BatchesTab batches={[]} events={[]} onImportBatch={onImportBatch} />);

    await userEvent.type(
      screen.getByLabelText("Paste coordination prompt"),
      [
        "Use $pr-batch to complete this batch with subagents.",
        "Repository: shakacode/react_on_rails",
        "Batch id: batch-import-1",
        "Batch objective: Import retained metadata.",
        "Items:",
        "- PR #4005: https://github.com/shakacode/react_on_rails/pull/4005",
        "Suggested lanes:",
        "- tests (owner: worker-a): PR #4005"
      ].join("\n")
    );
    await userEvent.click(screen.getByRole("button", { name: "Review batch plan" }));

    expect(screen.getByDisplayValue("batch-import-1")).toBeInTheDocument();
    expect(screen.getByLabelText("Plan details")).toHaveDisplayValue(/\"repo\": \"shakacode\/react_on_rails\"/);

    await userEvent.click(screen.getByRole("button", { name: "Save batch plan" }));

    expect(onImportBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: "batch-import-1",
        repo: "shakacode/react_on_rails",
        objective: "Import retained metadata.",
        targets: [expect.objectContaining({ target: "4005", type: "pull_request" })],
        launchPrompt: expect.stringContaining("Batch id: batch-import-1")
      })
    );
  });
});
