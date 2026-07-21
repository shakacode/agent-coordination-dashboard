import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BatchCompletionReport, DashboardModel } from "../../shared/types";
import { buildCoordinationView } from "../coordinationView";
import { BatchDetailDrawer } from "./BatchDetailDrawer";

const NOW = "2026-07-21T12:00:00.000Z";

function cardWith(completion?: BatchCompletionReport) {
  const model: DashboardModel = {
    generatedAt: NOW,
    stateRoot: "/state",
    targetRepos: ["repo/dashboard"],
    agents: [],
    events: [],
    batchOperations: [],
    qaValidations: [],
    healthItems: [],
    warnings: [],
    workItems: [],
    batches: [
      {
        schemaVersion: 1,
        batchId: "b1",
        repo: "repo/dashboard",
        objective: "Ship the release.",
        createdAt: "2026-07-21T10:00:00.000Z",
        lanes: [{ name: "l1", owner: "o", targets: ["1"], dependsOn: [], status: "final", liveness: "dead", blockedOn: [] }],
        path: "batches/b1.json",
        completion
      }
    ]
  };
  return buildCoordinationView(model, NOW).batchCards[0];
}

const completion: BatchCompletionReport = {
  state: { live: "adf0c47a", replay: "complete" },
  audit: { verdict: "clean", author: "justin808 · v1 durable · 2026-07-20T16:24:07Z" },
  receipts: [{ label: "durable-receipt-v1", href: "https://github.com/repo/dashboard/blob/main/receipt.json" }],
  baseline: { path: "main@adf0c47a", href: "https://github.com/repo/dashboard/commit/adf0c47a" },
  outcomes: [{ lane: "l1", route: "sol/xhigh", result: "merged", links: [{ label: "#4751", href: "https://github.com/repo/dashboard/pull/4751" }] }],
  finalReport: "Batch complete.",
  usage: "—",
  tokensTotal: "2.09M",
  cost: "$7.30",
  duration: "5h 1m"
};

describe("BatchDetailDrawer completion report", () => {
  it("renders the audit, receipts, outcome chips, and metrics when completion is present", () => {
    render(<BatchDetailDrawer card={cardWith(completion)} onClose={() => {}} />);
    expect(screen.getByText("audit clean")).toBeInTheDocument();
    expect(screen.getByText(/justin808 · v1 durable/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "durable-receipt-v1" })).toHaveAttribute("href", "https://github.com/repo/dashboard/blob/main/receipt.json");
    // Outcome PR list renders as a chip, not buried prose.
    expect(screen.getByRole("link", { name: "#4751" })).toHaveAttribute("href", "https://github.com/repo/dashboard/pull/4751");
    // Real metrics feed the stat tiles.
    expect(screen.getByText("2.09M")).toBeInTheDocument();
    expect(screen.getByText("$7.30")).toBeInTheDocument();
    expect(screen.getByText("5h 1m")).toBeInTheDocument();
    expect(screen.queryByText(/Audit verdicts, completion reports, and final reports are not emitted/)).not.toBeInTheDocument();
  });

  it("degrades to the not-emitted note when completion is absent", () => {
    render(<BatchDetailDrawer card={cardWith(undefined)} onClose={() => {}} />);
    expect(screen.getByText(/Audit verdicts, completion reports, and final reports are not emitted/)).toBeInTheDocument();
    // Absent metrics stay as the em-dash placeholder, never fabricated.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
