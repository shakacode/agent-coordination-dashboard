import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DashboardModel, GitHubImplementationPullRequest, WorkItem } from "../../shared/types";
import { buildCoordinationView } from "../coordinationView";
import type { OperatorRow } from "../operatorRows";
import { JobDetailDrawer } from "./JobDetailDrawer";

const row = {
  id: "repo/dashboard#10",
  repo: "repo/dashboard",
  target: "10",
  type: "pull_request",
  title: "Wire telemetry",
  operatorState: "running",
  blockedOn: [],
  lastActivityAge: "3m",
  host: "Codex",
  machineId: "m1",
  operator: "justin",
  branch: "feature/telemetry",
  activityStatus: "coding",
  threadHandle: "b1-coord",
  batchId: "b1",
  url: "https://github.com/repo/dashboard/pull/10"
} as unknown as OperatorRow;

function workItem(partial: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "repo/dashboard#10",
    repo: "repo/dashboard",
    target: "10",
    type: "pull_request",
    schedulingState: "in_process",
    provenance: { classification: "observed", evidence: ["heartbeat"] },
    warnings: [],
    selected: false,
    ...partial
  };
}

function rowWithImplementationPreview(implementationPr: GitHubImplementationPullRequest): OperatorRow {
  const item = workItem({
    id: "repo/dashboard#215",
    target: "215",
    github: {
      repo: "repo/dashboard",
      target: "215",
      type: "pull_request",
      title: "Root pull request 215",
      url: "https://github.com/repo/dashboard/pull/215",
      state: "OPEN",
      labels: [],
      loadState: "loaded",
      implementationPr
    }
  });
  const model: DashboardModel = {
    generatedAt: "2026-07-23T01:01:00Z",
    stateRoot: "/state",
    targetRepos: ["repo/dashboard"],
    agents: [],
    workItems: [item],
    batches: [],
    events: [],
    batchOperations: [],
    qaValidations: [],
    healthItems: [],
    warnings: []
  };
  return buildCoordinationView(model, model.generatedAt).jobRows[0].row;
}

describe("JobDetailDrawer provenance rows", () => {
  it("renders the route, merge authority, and per-model token bars when present (#79/#80/#81)", () => {
    render(
      <JobDetailDrawer
        row={row}
        workItem={workItem({ route: "gpt-5.6-sol/xhigh", usage: [{ model: "gpt-5.6-sol", tokensIn: 1_200_000, tokensOut: 400_000, costUsd: 5.1 }] })}
        mergeAuth="auto"
        onClose={() => {}}
      />
    );
    expect(screen.getByText("gpt-5.6-sol/xhigh")).toBeInTheDocument(); // Route row
    expect(screen.getByText("auto")).toBeInTheDocument(); // Merge auth row
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument(); // token bar model label
    expect(screen.getAllByText(/1\.60M/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/\$5\.10/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/Token and cost accounting is not emitted/)).not.toBeInTheDocument();
  });

  it("shows the manifest lane route when the work item has none (#80)", () => {
    render(<JobDetailDrawer row={row} workItem={workItem()} route="gpt-5.6-sol/xhigh" onClose={() => {}} />);
    expect(screen.getByText("gpt-5.6-sol/xhigh")).toBeInTheDocument();
  });

  it("shows an issue target separately from its linked implementation PR", () => {
    const issueRow = {
      ...row,
      type: "issue",
      target: "47",
      url: "https://github.com/repo/dashboard/issues/47",
      implementationPr: {
        repo: "repo/dashboard",
        target: "91",
        title: "Implementation",
        url: "https://github.com/repo/dashboard/pull/91",
        state: "OPEN",
        labels: [],
        loadState: "loaded"
      }
    } as OperatorRow;
    render(<JobDetailDrawer row={issueRow} onClose={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Issue #47 detail" })).toBeInTheDocument();
    expect(screen.getByText("Implementation PR")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR #91" })).toHaveAttribute("href", "https://github.com/repo/dashboard/pull/91");
  });

  it.each([
    ["unknown-load-state", {
      repo: "repo/dashboard",
      target: "315",
      title: "Partial implementation",
      url: "https://github.com/repo/dashboard/pull/315",
      state: "UNKNOWN",
      labels: [],
      loadState: "unknown"
    }],
    ["mismatched-url", {
      repo: "repo/dashboard",
      target: "316",
      title: "Mismatched implementation",
      url: "https://github.com/repo/api/pull/999",
      state: "OPEN",
      labels: [],
      loadState: "loaded"
    }]
  ] satisfies Array<[string, GitHubImplementationPullRequest]>)(
    "does not render a rejected %s implementation preview",
    (_case, implementationPr) => {
      render(<JobDetailDrawer row={rowWithImplementationPreview(implementationPr)} onClose={() => {}} />);

      expect(screen.queryByText("Implementation PR")).not.toBeInTheDocument();
      expect(screen.queryByText(`PR #${implementationPr.target}`)).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: `PR #${implementationPr.target}` })).not.toBeInTheDocument();
    }
  );

  it("degrades route, merge authority, and tokens to the em-dash placeholder when absent (#79/#80/#81)", () => {
    render(<JobDetailDrawer row={row} onClose={() => {}} />);
    expect(screen.getByText(/Token and cost accounting is not emitted by the coordination protocol yet/)).toBeInTheDocument();
    // Route and Merge auth rows both fall back to the em-dash, never fabricated.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
