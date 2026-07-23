import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardModel } from "../../shared/types";
import { buildCoordinationView } from "../coordinationView";
import { DashboardShell } from "./DashboardShell";

const NOW = "2026-07-21T12:00:00.000Z";

describe("DashboardShell fleet filtering", () => {
  function takeoverModel(): DashboardModel {
    return {
      generatedAt: NOW,
      stateRoot: "/state",
      targetRepos: ["repo/dashboard"],
      agents: [],
      events: [],
      batchOperations: [],
      qaValidations: [],
      healthItems: [],
      warnings: [],
      workItems: [{
        id: "repo/dashboard#87",
        repo: "repo/dashboard",
        target: "87",
        type: "issue",
        schedulingState: "in_process",
        heartbeat: {
          schemaVersion: 1,
          agentId: "live-holder",
          machineId: "m2",
          host: "Codex",
          repo: "repo/dashboard",
          target: "87",
          batchId: "batch-alpha",
          status: "in_progress",
          updatedAt: "2026-07-21T11:59:00.000Z",
          expiresAt: "2026-07-21T12:30:00.000Z",
          path: "heartbeats/live-holder.json",
          liveness: "live"
        },
        warnings: [],
        selected: false
      }],
      batches: [{
        schemaVersion: 1,
        batchId: "batch-alpha",
        repo: "repo/dashboard",
        objective: "Test current custody.",
        createdByMachine: "m1",
        lanes: [{
          name: "lane-a",
          owner: "planned-holder",
          targets: ["87"],
          dependsOn: [],
          status: "running",
          liveness: "live",
          blockedOn: []
        }],
        path: "batches/batch-alpha.json"
      }]
    };
  }

  function renderShell(fleetFilter: { host?: string; machine?: string }) {
    render(
      <DashboardShell
        batchFilter="all"
        fleetFilter={fleetFilter}
        jobFilter="all"
        onFind={vi.fn()}
        onOpenBatch={vi.fn()}
        onOpenBatchById={vi.fn()}
        onOpenRow={vi.fn()}
        onSetBatchFilter={vi.fn()}
        onSetFleetFilter={vi.fn()}
        onSetJobFilter={vi.fn()}
        onSetTab={vi.fn()}
        tab="batches"
        view={buildCoordinationView(takeoverModel(), NOW)}
      />
    );
  }

  it("does not match a batch by its creator machine when live lane custody is elsewhere", () => {
    renderShell({ machine: "m1" });
    expect(screen.getByText("No batches in this view.")).toBeInTheDocument();
    expect(screen.queryByText("Test current custody.")).not.toBeInTheDocument();
  });

  it("uses observed live lane hosts instead of stale manifest hosts", () => {
    const model = takeoverModel();
    model.workItems[0].heartbeat = {
      ...model.workItems[0].heartbeat!,
      host: "Claude"
    };
    model.batches[0].lanes[0].host = "Codex";
    const view = buildCoordinationView(model, NOW);
    const props = {
      batchFilter: "all" as const,
      jobFilter: "all" as const,
      onFind: vi.fn(),
      onOpenBatch: vi.fn(),
      onOpenBatchById: vi.fn(),
      onOpenRow: vi.fn(),
      onSetBatchFilter: vi.fn(),
      onSetFleetFilter: vi.fn(),
      onSetJobFilter: vi.fn(),
      onSetTab: vi.fn(),
      tab: "batches" as const,
      view
    };
    const { rerender } = render(<DashboardShell {...props} fleetFilter={{ host: "Codex" }} />);

    expect(screen.getByText("No batches in this view.")).toBeInTheDocument();
    rerender(<DashboardShell {...props} fleetFilter={{ host: "Claude" }} />);
    expect(screen.getByText("Test current custody.")).toBeInTheDocument();
  });
});
