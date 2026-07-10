import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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

  it("renders missing liveness as UNKNOWN instead of the raw none value", () => {
    render(<OperatorView dashboard={dashboard} />);

    const stateCell = screen.getByText("Issue #124").closest("tr")?.querySelector("td");

    expect(stateCell).toHaveTextContent("UNKNOWN");
    expect(stateCell).not.toHaveTextContent("none");
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
