import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardModel } from "../../shared/types";
import { OverviewTab } from "./OverviewTab";

const dashboard: DashboardModel = {
  generatedAt: "2026-07-09T20:00:00Z",
  stateRoot: "/state",
  targetRepos: ["repo/app"],
  agents: [],
  workItems: [
    {
      id: "repo/app#123",
      repo: "repo/app",
      target: "123",
      type: "issue",
      schedulingState: "ready_for_batch",
      warnings: [],
      selected: false,
      provenance: { classification: "observed", evidence: ["github"] },
      github: {
        repo: "repo/app",
        target: "123",
        type: "issue",
        title: "Observed issue",
        url: "https://github.com/repo/app/issues/123",
        state: "OPEN",
        labels: [],
        loadState: "loaded"
      }
    },
    {
      id: "repo/app#124",
      repo: "repo/app",
      target: "124",
      type: "issue",
      schedulingState: "ready_for_batch",
      warnings: [],
      selected: false,
      provenance: { classification: "inferred", evidence: ["manifest"] }
    },
    {
      id: "repo/app#125",
      repo: "repo/app",
      target: "125",
      type: "issue",
      schedulingState: "ready_for_batch",
      warnings: [],
      selected: false,
      provenance: { classification: "unknown", evidence: [] }
    }
  ],
  batches: [],
  events: [],
  batchOperations: [],
  qaValidations: [],
  healthItems: [],
  warnings: []
};

describe("OverviewTab", () => {
  it("excludes inferred and synthetic rows from default summaries while preserving unknown rows", () => {
    render(<OverviewTab dashboard={dashboard} onOpenOperatorFilter={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Show 2 ready for batch rows in Operator view" })).toBeInTheDocument();
    expect(screen.getByText("Issue #123: Observed issue")).toBeInTheDocument();
    expect(screen.getByText("Issue #125: Issue #125")).toBeInTheDocument();
    expect(screen.queryByText("Issue #124: Issue #124")).not.toBeInTheDocument();
  });

  it("reuses derived target detail in the explicitly diagnostic Batch Repair summary", () => {
    const repairDashboard: DashboardModel = {
      ...dashboard,
      workItems: [
        {
          id: "repo/app#126",
          repo: "repo/app",
          target: "126",
          type: "issue",
          schedulingState: "started_not_processing",
          warnings: [],
          selected: false,
          provenance: { classification: "inferred", evidence: ["inferred_batch"] },
          batchSignals: [{ batchId: "inferred-repair", laneName: "implementation", status: "queued", blockedOn: [] }]
        }
      ],
      batches: [
        {
          schemaVersion: 1,
          batchId: "inferred-repair",
          repo: "repo/app",
          source: "inferred",
          objective: "Generic aggregate detail",
          path: "inferred-batches/repo__app/inferred-repair.json",
          lanes: [
            {
              name: "implementation",
              owner: "agent-a",
              targets: ["126"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ]
    };

    render(<OverviewTab dashboard={repairDashboard} onOpenOperatorFilter={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Show 1 batch repairs in Operator view" })).toBeInTheDocument();
    expect(screen.getByText("Issue #126")).toBeInTheDocument();
    expect(screen.queryByText("Generic aggregate detail")).not.toBeInTheDocument();
  });

});
