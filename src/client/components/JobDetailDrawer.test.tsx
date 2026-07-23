import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkItem } from "../../shared/types";
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

  it("degrades route, merge authority, and tokens to the em-dash placeholder when absent (#79/#80/#81)", () => {
    render(<JobDetailDrawer row={row} onClose={() => {}} />);
    expect(screen.getByText(/Token and cost accounting is not emitted by the coordination protocol yet/)).toBeInTheDocument();
    // Route and Merge auth rows both fall back to the em-dash, never fabricated.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
