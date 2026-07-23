import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BatchBlocker, BatchCompletionReport, BatchRecord, DashboardModel } from "../../shared/types";
import { buildCoordinationView } from "../coordinationView";
import { BatchDetailDrawer } from "./BatchDetailDrawer";

const NOW = "2026-07-21T12:00:00.000Z";

/** Build a batch card from a blocked batch (a dead lane makes the tier "blocked"). */
function cardFrom(overrides: Partial<BatchRecord>) {
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
        lanes: [{ name: "l1", owner: "o", targets: ["1"], dependsOn: [], status: "blocked", liveness: "dead", blockedOn: [] }],
        path: "batches/b1.json",
        ...overrides
      }
    ]
  };
  return buildCoordinationView(model, NOW).batchCards[0];
}

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

describe("BatchDetailDrawer merge authority (#81)", () => {
  it("renders the declared merge authority tag", () => {
    render(<BatchDetailDrawer card={cardFrom({ mergeAuthority: "auto" })} onClose={() => {}} />);
    expect(screen.getByText("merge: auto")).toBeInTheDocument();
  });

  it("degrades the merge authority tag when undeclared", () => {
    render(<BatchDetailDrawer card={cardFrom({})} onClose={() => {}} />);
    expect(screen.getByText("merge: —")).toBeInTheDocument();
  });
});

describe("BatchDetailDrawer structured blocker (#83)", () => {
  const blocker: BatchBlocker = {
    message: "Lane l2 needs merge authority to land #4760.",
    decisions: ["Approve auto-merge for l2", "Or take over l2 manually"],
    recommendedReply: "Approved — auto-merge l2 when gates pass."
  };

  it("renders the structured message, decisions, and recommended reply when present", () => {
    render(<BatchDetailDrawer card={cardFrom({ blocker })} onClose={() => {}} />);
    expect(screen.getByText("Lane l2 needs merge authority to land #4760.")).toBeInTheDocument();
    expect(screen.getByText("Approve auto-merge for l2")).toBeInTheDocument();
    expect(screen.getByText("Approved — auto-merge l2 when gates pass.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve recommended/ })).toBeInTheDocument();
    expect(screen.queryByText(/Structured blocker decisions and a recommended reply are not emitted/)).not.toBeInTheDocument();
  });

  it("falls back to the not-emitted note when no structured blocker is present", () => {
    render(<BatchDetailDrawer card={cardFrom({})} onClose={() => {}} />);
    expect(screen.getByText(/Structured blocker decisions and a recommended reply are not emitted/)).toBeInTheDocument();
  });
});

describe("BatchDetailDrawer lane execution map (#88)", () => {
  it("keeps mixed-host and legacy lanes navigable with honest chat fallback", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
    const onOpenRow = vi.fn();
    const onFind = vi.fn();
    const card = cardFrom({
      createdByMachine: "m1",
      targets: [
        { type: "issue", target: "87", repo: "repo/dashboard", title: "Machine drill-down", url: "https://github.com/repo/dashboard/issues/87" },
        { type: "pull_request", target: "88", repo: "repo/dashboard", title: "Batch navigation", url: "https://github.com/repo/dashboard/pull/88" }
      ],
      lanes: [
        {
          name: "codex-lane",
          owner: "codex-maker",
          targets: ["87"],
          dependsOn: [],
          status: "running",
          liveness: "live",
          blockedOn: [],
          host: "Codex",
          threadHandle: "acd-codex-chat",
          branch: "codex/machines",
          prUrl: "https://github.com/repo/dashboard/pull/123"
        },
        {
          name: "claude-lane",
          owner: "claude-maker",
          targets: ["88"],
          dependsOn: [],
          status: "blocked",
          liveness: "stale",
          blockedOn: ["review"],
          host: "Claude",
          threadHandle: "acd-claude-chat",
          prUrl: "https://github.com/repo/dashboard/pull/88"
        },
        {
          name: "legacy-lane",
          owner: "legacy-maker",
          targets: ["89"],
          dependsOn: [],
          status: "running",
          liveness: "no-heartbeat",
          blockedOn: []
        }
      ]
    });

    render(
      <BatchDetailDrawer
        card={card}
        onClose={() => {}}
        onFind={onFind}
        onOpenRow={onOpenRow}
      />
    );

    const map = screen.getByRole("table", { name: "Batch lane execution map" });
    expect(map).toHaveTextContent("codex-lane");
    expect(map).toHaveTextContent("Claude");
    expect(map).toHaveTextContent("machine UNKNOWN");
    expect(screen.getByRole("link", { name: "Issue #87" })).toHaveAttribute("href", "https://github.com/repo/dashboard/issues/87");
    expect(screen.getByRole("link", { name: "PR #123" })).toHaveAttribute("href", "https://github.com/repo/dashboard/pull/123");
    expect(screen.getByRole("link", { name: "PR #88" })).toHaveAttribute("href", "https://github.com/repo/dashboard/pull/88");
    expect(screen.getByRole("link", { name: "codex/machines" })).toHaveAttribute("href", "https://github.com/repo/dashboard/tree/codex/machines");
    expect(screen.queryByText(/Close this drawer to inspect/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open codex-lane job" }));
    expect(onOpenRow).toHaveBeenCalledWith(card.lanes[0].row, undefined);
    await userEvent.click(screen.getByRole("button", { name: "Find chat acd-claude-chat" }));
    expect(onFind).toHaveBeenCalledWith("acd-claude-chat");
    await userEvent.click(screen.getByRole("button", { name: "Copy chat acd-codex-chat" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("acd-codex-chat");
  });
});
