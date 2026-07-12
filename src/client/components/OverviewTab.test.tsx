import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardModel } from "../../shared/types";
import { OverviewTab, sortRecentTerminalRows } from "./OverviewTab";

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
  it("sorts recent terminal rows newest first and invalid or missing timestamps last", () => {
    const rows = [
      { id: "missing" },
      { id: "older", lastActivityAt: "2026-07-10T18:00:00Z" },
      { id: "invalid", lastActivityAt: "not-a-date" },
      { id: "newest", lastActivityAt: "2026-07-10T19:00:00Z" }
    ] as any;

    expect(sortRecentTerminalRows(rows).map((row) => row.id)).toEqual(["newest", "older", "missing", "invalid"]);
  });

  it("renders friendly styled badges for every accepted terminal token", () => {
    const statuses = ["done", "merged", "closed", "cancelled"] as const;
    const terminalDashboard: DashboardModel = {
      ...dashboard,
      generatedAt: "2026-07-10T20:00:00Z",
      workItems: [],
      batches: statuses.map((status, index) => ({
        schemaVersion: 1,
        batchId: `terminal-${status}`,
        repo: "repo/app",
        updatedAt: `2026-07-10T19:0${index}:00Z`,
        path: `batches/terminal-${status}.json`,
        lanes: [
          {
            name: status,
            owner: "agent-a",
            targets: [],
            dependsOn: [],
            status,
            liveness: "no-heartbeat" as const,
            blockedOn: []
          }
        ]
      })),
      events: statuses.map((status, index) => ({
        eventId: `terminal-${status}`,
        type: status,
        status,
        batchId: `terminal-${status}`,
        repo: "repo/app",
        laneName: status,
        timestamp: `2026-07-10T19:0${index}:00Z`,
        path: `events/terminal-${status}.json`
      }))
    };

    render(<OverviewTab dashboard={terminalDashboard} onOpenOperatorFilter={vi.fn()} />);
    const panel = within(screen.getByRole("heading", { name: "Recent Terminal Work" }).closest("article") as HTMLElement);
    for (const status of statuses) {
      const label = `${status[0].toUpperCase()}${status.slice(1)}`;
      expect(panel.getByText(label)).toHaveClass("status-badge", "status-terminal", `status-${status}`);
    }
  });
  it("excludes inferred and synthetic rows from default summaries while preserving unknown rows", () => {
    render(<OverviewTab dashboard={dashboard} onOpenOperatorFilter={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Show 2 ready for batch rows in Operator view" })).toBeInTheDocument();
    expect(screen.getByText("Issue #123: Observed issue")).toBeInTheDocument();
    expect(screen.getByText("Issue #125: Issue #125")).toBeInTheDocument();
    expect(screen.queryByText("Issue #124: Issue #124")).not.toBeInTheDocument();
  });

  it("applies the same age-out snapshot and reveal preference to overview results", async () => {
    const terminalDashboard: DashboardModel = {
      ...dashboard,
      generatedAt: "2026-07-10T20:00:00Z",
      workItems: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "terminal-batch",
          repo: "repo/app",
          launchPrompt: "Use $pr-batch",
          updatedAt: "2026-07-08T20:00:00Z",
          path: "batches/terminal.json",
          lanes: [
            {
              name: "closeout",
              owner: "agent-old",
              targets: [],
              dependsOn: [],
              status: "done",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "closed-123",
          type: "done",
          status: "done",
          batchId: "terminal-batch",
          repo: "repo/app",
          laneName: "closeout",
          timestamp: "2026-07-08T20:00:00Z",
          path: "events/closed.json"
        }
      ]
    };

    const { rerender } = render(
      <OverviewTab dashboard={terminalDashboard} onOpenOperatorFilter={vi.fn()} revealOlderTerminalRows={false} />
    );
    expect(screen.queryByText("Target #UNKNOWN: Batch lane closeout")).not.toBeInTheDocument();
    expect(screen.getByText("1 older terminal row hidden")).toBeInTheDocument();

    rerender(<OverviewTab dashboard={terminalDashboard} onOpenOperatorFilter={vi.fn()} revealOlderTerminalRows />);
    expect(screen.getByText("Target #UNKNOWN: Batch lane closeout")).toBeInTheDocument();
  });

  it("does not list current recovery work as recent terminal work when history says done", () => {
    const recoveryDashboard: DashboardModel = {
      ...dashboard,
      generatedAt: "2026-07-10T20:00:00Z",
      workItems: [
        {
          ...dashboard.workItems[0],
          github: undefined,
          schedulingState: "started_not_processing"
        }
      ],
      events: [
        {
          eventId: "old-done",
          type: "done",
          status: "done",
          repo: "repo/app",
          target: "123",
          timestamp: "2026-07-08T20:00:00Z",
          path: "events/old-done.json"
        }
      ]
    };

    render(<OverviewTab dashboard={recoveryDashboard} onOpenOperatorFilter={vi.fn()} revealOlderTerminalRows />);

    expect(screen.queryByRole("heading", { name: "Recent Terminal Work" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current Work" }).closest("article")).toHaveTextContent("Issue #123");
  });

  it("counts an old derived terminal row that the shared control can reveal through Batch Repair", () => {
    const derivedDashboard: DashboardModel = {
      ...dashboard,
      generatedAt: "2026-07-10T20:00:00Z",
      workItems: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "old-derived",
          repo: "repo/app",
          source: "inferred",
          createdAt: "2026-07-08T20:00:00Z",
          path: "inferred/old-derived.json",
          lanes: [
            {
              name: "closeout",
              owner: "agent-old",
              targets: [],
              dependsOn: [],
              status: "done",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ]
    };

    render(<OverviewTab dashboard={derivedDashboard} onOpenOperatorFilter={vi.fn()} />);

    expect(screen.getByText("1 older terminal row hidden")).toBeInTheDocument();
  });

  it("does not count an old healthy synthetic lane that no default surface can reveal", () => {
    const healthyDashboard: DashboardModel = {
      ...dashboard,
      generatedAt: "2026-07-10T20:00:00Z",
      workItems: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "healthy-terminal",
          repo: "repo/app",
          launchPrompt: "Use $pr-batch",
          createdAt: "2026-07-08T20:00:00Z",
          path: "batches/healthy-terminal.json",
          lanes: [
            {
              name: "closeout",
              owner: "agent-old",
              targets: [],
              dependsOn: [],
              status: "done",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ]
    };

    render(<OverviewTab dashboard={healthyDashboard} onOpenOperatorFilter={vi.fn()} />);

    expect(screen.getByText("0 older terminal rows hidden")).toBeInTheDocument();
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
