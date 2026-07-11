import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardModel } from "../../shared/types";
import { OperatorView } from "./OperatorView";

const dashboard: DashboardModel = {
  generatedAt: "2026-07-09T20:00:00Z",
  stateRoot: "/state",
  targetRepos: ["repo/app", "repo/api"],
  agents: [],
  workItems: [
    {
      id: "repo/app#123",
      repo: "repo/app",
      target: "123",
      type: "pull_request",
      schedulingState: "in_process",
      warnings: [],
      selected: false,
      claim: {
        schemaVersion: 1,
        repo: "repo/app",
        target: "123",
        agentId: "agent-a",
        machineId: "m5",
        threadHandle: "thread-a",
        host: "codex",
        operator: "justin",
        batchId: "batch-1",
        branch: "feature/operator-view",
        prUrl: "https://github.com/repo/app/pull/123",
        status: "active",
        updatedAt: "2026-07-09T19:55:00Z",
        path: "claims/repo/app/123.json"
      },
      heartbeat: {
        schemaVersion: 1,
        agentId: "agent-a",
        machineId: "m5",
        threadHandle: "thread-a",
        host: "codex",
        operator: "justin",
        repo: "repo/app",
        target: "123",
        batchId: "batch-1",
        branch: "feature/operator-view",
        prUrl: "https://github.com/repo/app/pull/123",
        status: "coding",
        updatedAt: "2026-07-09T19:59:00Z",
        expiresAt: "2026-07-09T20:10:00Z",
        path: "heartbeats/agent-a.json",
        liveness: "live"
      },
      github: {
        repo: "repo/app",
        target: "123",
        type: "pull_request",
        title: "Improve operator view",
        url: "https://github.com/repo/app/pull/123",
        state: "OPEN",
        labels: [],
        loadState: "loaded"
      }
    },
    {
      id: "repo/api#124",
      repo: "repo/api",
      target: "124",
      type: "issue",
      schedulingState: "ready_for_batch",
      warnings: [],
      selected: false,
      github: {
        repo: "repo/api",
        target: "124",
        type: "issue",
        title: "API follow-up",
        url: "https://github.com/repo/api/issues/124",
        state: "OPEN",
        labels: [],
        loadState: "loaded"
      }
    }
  ],
  batches: [],
  events: [],
  batchOperations: [],
  qaValidations: [],
  healthItems: [],
  warnings: []
};

describe("OperatorView", () => {
  beforeEach(() => localStorage.clear());

  it("hides inferred and synthetic rows by default and persists the reveal control per browser", async () => {
    const derivedDashboard: DashboardModel = {
      ...dashboard,
      workItems: dashboard.workItems.map((item, index) => ({
        ...item,
        provenance:
          index === 0
            ? { classification: "observed" as const, evidence: ["claim" as const] }
            : { classification: "inferred" as const, evidence: ["manifest" as const] }
      })),
      batches: [
        {
          schemaVersion: 1,
          batchId: "synthetic-batch",
          repo: "repo/app",
          source: "inferred",
          path: "inferred-batches/repo__app/synthetic-batch.json",
          lanes: [
            {
              name: "standalone",
              owner: "agent-synthetic",
              targets: [],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ]
    };

    localStorage.clear();
    const firstRender = render(<OperatorView dashboard={derivedDashboard} />);

    expect(screen.getByText("PR #123")).toBeInTheDocument();
    expect(screen.queryByText("Issue #124")).not.toBeInTheDocument();
    expect(screen.queryByText("Batch lane")).not.toBeInTheDocument();
    expect(screen.getByText("2 inferred or synthetic rows hidden")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Show inferred and synthetic rows" }));
    expect(screen.getByText("Issue #124")).toBeInTheDocument();
    expect(screen.getByText("Batch lane")).toBeInTheDocument();
    expect(localStorage.getItem("agent-coordination-dashboard:show-derived-operator-rows")).toBe("true");

    firstRender.unmount();
    const persistedRender = render(<OperatorView dashboard={derivedDashboard} />);
    expect(screen.getByRole("checkbox", { name: "Show inferred and synthetic rows" })).toBeChecked();
    expect(screen.getByText("Issue #124")).toBeInTheDocument();

    persistedRender.unmount();
    render(<OperatorView dashboard={derivedDashboard} deepLink={{ overviewFilter: "ready_for_batch" }} />);
    expect(screen.getByRole("checkbox", { name: "Show inferred and synthetic rows" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Show inferred and synthetic rows" })).toBeDisabled();
    expect(screen.queryByText("Issue #124")).not.toBeInTheDocument();
    expect(screen.getByText("1 inferred or synthetic row hidden")).toBeInTheDocument();
    expect(screen.queryByText("2 inferred or synthetic rows hidden")).not.toBeInTheDocument();
    expect(screen.getByText("Overview summary filters use observed and UNKNOWN rows only.")).toBeInTheDocument();
  });

  it("shows row provenance classification and evidence in the accessible disclosure", () => {
    render(<OperatorView dashboard={dashboard} />);

    const row = screen.getByText("PR #123").closest("tr");
    const disclosure = within(row as HTMLElement).getByText("Metadata provenance").closest("details");
    expect(within(disclosure as HTMLElement).getByText("Row provenance: observed")).toBeInTheDocument();
    expect(within(disclosure as HTMLElement).getByText("Row evidence: claim, heartbeat, github")).toBeInTheDocument();
  });

  it("labels Batch Repair as a diagnostic exception when it includes derived evidence", () => {
    const repairDashboard: DashboardModel = {
      ...dashboard,
      workItems: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "inferred-rowless",
          repo: "repo/app",
          source: "inferred",
          path: "inferred-batches/repo__app/inferred-rowless.json",
          lanes: []
        }
      ]
    };

    render(<OperatorView dashboard={repairDashboard} deepLink={{ overviewFilter: "batch_repair" }} />);

    expect(screen.getByText("inferred-rowless")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Show inferred and synthetic rows" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Show inferred and synthetic rows" })).toBeDisabled();
    expect(screen.getByText("Batch repair includes diagnostic inferred and synthetic evidence.")).toBeInTheDocument();
  });


  it("renders operator metadata and filters loaded rows with client search", async () => {
    render(<OperatorView dashboard={dashboard} />);

    expect(screen.getByRole("heading", { name: "Operator View" })).toBeInTheDocument();
    expect(screen.getByText("PR #123")).toBeInTheDocument();
    expect(screen.getByText("Issue #124")).toBeInTheDocument();
    expect(screen.getByText("justin / codex / m5")).toBeInTheDocument();
    expect(screen.getByText("thread-a / agent-a")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Search operator rows"), "feature/operator");

    expect(screen.getByText("PR #123")).toBeInTheDocument();
    expect(screen.queryByText("Issue #124")).not.toBeInTheDocument();
  });

  it("keeps explicit metadata states and chosen sources in an accessible disclosure", () => {
    render(<OperatorView dashboard={dashboard} />);

    const row = screen.getByText("PR #123").closest("tr");
    const disclosure = within(row as HTMLElement).getByText("Metadata provenance").closest("details");

    expect(disclosure).toBeInTheDocument();
    expect(within(disclosure as HTMLElement).getByText("Owner: observed from claim")).toBeInTheDocument();
    expect(within(disclosure as HTMLElement).getByText("Machine: observed from heartbeat")).toBeInTheDocument();
    expect(within(disclosure as HTMLElement).getByText("Activity: observed from heartbeat")).toBeInTheDocument();
  });

  it("names the source of inferred batch metadata in the disclosure", () => {
    const inferredDashboard: DashboardModel = {
      ...dashboard,
      workItems: dashboard.workItems.map((item, index) =>
        index === 0
          ? {
              ...item,
              claim: item.claim ? { ...item.claim, batchId: "inferred-batch" } : undefined,
              heartbeat: undefined,
              batchSignals: [{ batchId: "inferred-batch", laneName: "agent-a", status: "active", blockedOn: [] }]
            }
          : item
      ),
      batches: [
        {
          schemaVersion: 1,
          batchId: "inferred-batch",
          repo: "repo/app",
          source: "inferred",
          path: "inferred/repo/app/inferred-batch.json",
          lanes: [
            {
              name: "agent-a",
              owner: "agent-a",
              targets: ["123"],
              dependsOn: [],
              status: "active",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ]
    };

    render(<OperatorView dashboard={inferredDashboard} />);

    const row = screen.getByText("PR #123").closest("tr");
    const disclosure = within(row as HTMLElement).getByText("Metadata provenance").closest("details");
    expect(within(disclosure as HTMLElement).getByText("Batch: inferred from inferred batch")).toBeInTheDocument();
  });

  it("filters and highlights structured deep links without fetching more data", () => {
    render(<OperatorView dashboard={dashboard} deepLink={{ repo: "repo/api", target: "124" }} />);

    expect(screen.getByText("Issue #124")).toBeInTheDocument();
    expect(screen.queryByText("PR #123")).not.toBeInTheDocument();
    expect(screen.getByText("Issue #124").closest("tr")).toHaveClass("operator-row-highlight");
  });

  it("shows a visible miss for structured links outside the loaded model", () => {
    render(<OperatorView dashboard={dashboard} deepLink={{ batchId: "missing-batch", laneName: "docs" }} />);

    expect(screen.getByText("No loaded row matches this link.")).toBeInTheDocument();
  });

  it("shows, applies, and resets an overview filter", async () => {
    const onResetOverviewFilter = vi.fn();
    render(
      <OperatorView
        dashboard={dashboard}
        deepLink={{ overviewFilter: "ready_for_batch" }}
        onResetOverviewFilter={onResetOverviewFilter}
      />
    );

    expect(screen.getByText("Active filter:").parentElement).toHaveTextContent("Ready for batch");
    expect(screen.getByText("Issue #124")).toBeInTheDocument();
    expect(screen.getByText("Issue #124").closest("tr")).not.toHaveClass("operator-row-highlight");
    expect(screen.queryByText("PR #123")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Reset filter" }));
    expect(onResetOverviewFilter).toHaveBeenCalledOnce();
  });

  it("names an empty active filter and offers a reset", () => {
    render(<OperatorView dashboard={dashboard} deepLink={{ overviewFilter: "qa_attention" }} onResetOverviewFilter={() => undefined} />);

    expect(screen.getByText("No loaded row matches the QA needs attention filter.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset filter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset filter and show all operator rows" })).toHaveTextContent("Reset filter");
  });

  it("renders missing liveness as UNKNOWN instead of the raw none value", () => {
    render(<OperatorView dashboard={dashboard} />);

    const stateCell = screen.getByText("Issue #124").closest("tr")?.querySelector("td");

    expect(stateCell).toHaveTextContent("UNKNOWN");
    expect(stateCell).not.toHaveTextContent("none");
  });

  it("keeps row warning details reachable without hover-only titles", () => {
    const warningDashboard: DashboardModel = {
      ...dashboard,
      workItems: dashboard.workItems.map((item, index) =>
        index === 0
          ? {
              ...item,
              warnings: [{ severity: "warning", message: "Thread UNKNOWN" }]
            }
          : item
      )
    };

    render(<OperatorView dashboard={warningDashboard} />);

    const warningSummary = screen.getByText("1 warning").closest("details");

    expect(warningSummary).toBeInTheDocument();
    expect(warningSummary).not.toHaveAttribute("title");
    expect(screen.getByText("Thread UNKNOWN")).toBeInTheDocument();
  });

  it("does not render unsafe coordination URLs as links", () => {
    const unsafeDashboard: DashboardModel = {
      ...dashboard,
      workItems: dashboard.workItems.map((item, index) =>
        index === 0
          ? {
              ...item,
              claim: item.claim ? { ...item.claim, prUrl: "javascript:alert(1)" } : undefined,
              heartbeat: item.heartbeat ? { ...item.heartbeat, prUrl: "data:text/html,boom" } : undefined,
              github: item.github ? { ...item.github, url: "javascript:alert(2)" } : undefined
            }
          : item
      )
    };
    const { container } = render(<OperatorView dashboard={unsafeDashboard} />);

    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('a[href^="data:"]')).toBeNull();
    expect(screen.getByText("PR #123").closest("a")).toBeNull();
    expect(Array.from(container.querySelectorAll("a")).map((link) => link.textContent)).not.toContain("PR");
  });
});
