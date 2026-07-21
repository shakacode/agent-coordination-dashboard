import { describe, expect, it } from "vitest";
import type { AgentSummary, DashboardModel, WorkItem } from "../shared/types";
import { ABSENT, buildCoordinationView, canonicalHostName, hostColor, jobBucketForRow, laneStatusState, targetLabel } from "./coordinationView";
import type { OperatorRow } from "./operatorRows";

const NOW = "2026-07-21T12:00:00.000Z";

function workItem(partial: Partial<WorkItem> & Pick<WorkItem, "id" | "repo" | "target" | "type" | "schedulingState">): WorkItem {
  return { warnings: [], selected: false, ...partial };
}

function liveHeartbeat(agentId: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    agentId,
    status: "in_progress",
    updatedAt,
    expiresAt: "2026-07-21T12:30:00.000Z",
    path: `heartbeats/${agentId}.json`,
    liveness: "live" as const,
    ...extra
  };
}

const model: DashboardModel = {
  generatedAt: NOW,
  stateRoot: "/state",
  targetRepos: ["repo/dashboard"],
  agents: [
    {
      agentId: "codex-live",
      machineId: "m1",
      liveness: "live",
      claims: [{ schemaVersion: 1, repo: "repo/dashboard", target: "10", agentId: "codex-live", status: "active", host: "Codex", operator: "justin", machineId: "m1", path: "claims/codex-live.json" }],
      currentWork: [],
      warnings: [],
      heartbeat: liveHeartbeat("codex-live", "2026-07-21T11:59:00.000Z", { host: "Codex", machineId: "m1", repo: "repo/dashboard", target: "10" })
    },
    {
      agentId: "claude-stale",
      machineId: "m1",
      liveness: "stale",
      claims: [],
      currentWork: [],
      warnings: [],
      heartbeat: liveHeartbeat("claude-stale", "2026-07-21T11:50:00.000Z", { host: "Claude", machineId: "m1", liveness: "stale" })
    },
    {
      agentId: "codex-dead",
      machineId: "m5",
      liveness: "dead",
      claims: [],
      currentWork: [],
      warnings: [],
      heartbeat: liveHeartbeat("codex-dead", "2026-07-21T09:00:00.000Z", { host: "Codex", machineId: "m5", liveness: "dead" })
    }
  ] satisfies AgentSummary[],
  workItems: [
    workItem({
      id: "repo/dashboard#10", repo: "repo/dashboard", target: "10", type: "pull_request", schedulingState: "in_process",
      heartbeat: liveHeartbeat("codex-live", "2026-07-21T11:59:00.000Z", { host: "Codex", machineId: "m1", repo: "repo/dashboard", target: "10" })
    }),
    workItem({
      id: "repo/dashboard#11", repo: "repo/dashboard", target: "11", type: "pull_request", schedulingState: "in_process",
      attention: { kind: "blocked_user_input", label: "Review requested", action: "Open PR" },
      heartbeat: liveHeartbeat("codex-live", "2026-07-21T11:59:00.000Z", { host: "Codex", machineId: "m1", repo: "repo/dashboard", target: "11" })
    }),
    workItem({
      id: "repo/dashboard#12", repo: "repo/dashboard", target: "12", type: "issue", schedulingState: "in_process",
      heartbeat: liveHeartbeat("claude-stale", "2026-07-21T11:40:00.000Z", { host: "Claude", machineId: "m1", repo: "repo/dashboard", target: "12" })
    }),
    workItem({
      id: "repo/dashboard#13", repo: "repo/dashboard", target: "13", type: "pull_request", schedulingState: "in_process",
      heartbeat: liveHeartbeat("claude-stale", "2026-07-21T11:59:00.000Z", { host: "Claude", machineId: "m1", repo: "repo/dashboard", target: "13", status: "blocked" })
    }),
    workItem({
      id: "repo/dashboard#14", repo: "repo/dashboard", target: "14", type: "issue", schedulingState: "ready_for_batch",
      github: { repo: "repo/dashboard", target: "14", type: "issue", title: "Ready item", url: "https://github.com/repo/dashboard/issues/14", state: "OPEN", labels: [], loadState: "loaded" }
    }),
    workItem({
      id: "repo/dashboard#15", repo: "repo/dashboard", target: "15", type: "pull_request", schedulingState: "started_not_processing",
      operatorState: "terminal", terminalState: "done",
      github: { repo: "repo/dashboard", target: "15", type: "pull_request", title: "Merged item", url: "https://github.com/repo/dashboard/pull/15", state: "MERGED", labels: [], loadState: "loaded" }
    })
  ],
  batches: [
    {
      schemaVersion: 1,
      batchId: "b1",
      repo: "repo/dashboard",
      objective: "Land the coordination telemetry contract. Then gate with QA.",
      createdAt: "2026-07-21T10:00:00.000Z",
      createdByMachine: "m1",
      launchPrompt: "/goal\nUse $pr-batch to complete this batch.",
      lanes: [
        { name: "l1", owner: "codex-live", targets: ["201"], dependsOn: [], status: "running", liveness: "live", blockedOn: [], host: "Codex", threadHandle: "b1-coord" },
        { name: "l2", owner: "codex-live", targets: ["202"], dependsOn: ["l1"], status: "blocked", liveness: "no-heartbeat", blockedOn: ["b1:201"], host: "Codex" }
      ],
      path: "batches/b1.json"
    }
  ],
  events: [],
  batchOperations: [
    { batchId: "b1", repo: "repo/dashboard", batchPath: "batches/b1.json", controlStatus: "running", eventCount: 4, qa: { total: 2, missing: 1, requested: 0, inProgress: 0, passed: 1, failed: 0, unknown: 0 } }
  ],
  qaValidations: [],
  healthItems: [],
  warnings: []
};

describe("buildCoordinationView", () => {
  const view = buildCoordinationView(model, NOW);
  const byTarget = (target: string) => view.jobRows.find((row) => row.row.target === target);

  it("builds a host legend with live and total counts per host", () => {
    expect(view.hostLegend).toEqual([
      { name: "Codex", color: "var(--codex)", live: 1, total: 2 },
      { name: "Claude", color: "var(--claude)", live: 0, total: 1 }
    ]);
  });

  it("routes each work item to its lifecycle bucket", () => {
    expect(byTarget("10")?.bucket).toBe("running");
    expect(byTarget("11")?.bucket).toBe("needs_input");
    expect(byTarget("12")?.bucket).toBe("stuck");
    expect(byTarget("13")?.bucket).toBe("blocked");
    expect(byTarget("14")?.bucket).toBe("ready");
    expect(byTarget("15")?.bucket).toBe("done");
  });

  it("promotes attention items to needs_input regardless of derived state", () => {
    const runningRow = { operatorState: "running", blockedOn: [] } as unknown as OperatorRow;
    expect(jobBucketForRow(runningRow)).toBe("running");
    expect(jobBucketForRow(runningRow, "blocked_user_input")).toBe("needs_input");
    expect(jobBucketForRow(runningRow, "qa_missing")).toBe("needs_input");
  });

  it("counts jobs per bucket", () => {
    expect(view.jobCounts.running).toBeGreaterThanOrEqual(1);
    expect(view.jobCounts.needs_input).toBe(1);
    expect(view.jobCounts.ready).toBe(1);
    expect(view.jobCounts.done).toBe(1);
  });

  it("builds a batch card with real lanes, qa, and tier, degrading absent fields", () => {
    expect(view.batchCards).toHaveLength(1);
    const card = view.batchCards[0];
    expect(card.id).toBe("b1");
    expect(card.title).toBe("Land the coordination telemetry contract.");
    expect(card.tier).toBe("blocked");
    expect(card.total).toBe(2);
    expect(card.done).toBe(0);
    expect(card.qa).toBe("1/2");
    expect(card.promptSaved).toBe(true);
    expect(card.thread).toBe("b1-coord");
    // Fields with no coordination backing degrade rather than fabricating values.
    expect(card.tokensTotal).toBe(ABSENT);
    expect(card.cost).toBe(ABSENT);
    expect(card.coordinator).toBe(ABSENT);
    expect(card.mergeAuth).toBe(ABSENT);
    expect(card.lanes).toHaveLength(2);
    expect(card.lanes[1].stateColor).toBe("var(--block)");
  });

  it("groups agents into machines and collapses dead agents to a count", () => {
    const m1 = view.machines.find((machine) => machine.id === "m1");
    const m5 = view.machines.find((machine) => machine.id === "m5");
    expect(m1?.live).toBe(1);
    expect(m1?.hosts.map((host) => host.name).sort()).toEqual(["Claude", "Codex"]);
    expect(m5?.dead).toBe(1);
    expect(m5?.hosts[0].agents).toHaveLength(0);
  });

  it("maps host names to their design colors", () => {
    expect(hostColor("Codex")).toBe("var(--codex)");
    expect(hostColor("claude")).toBe("var(--claude)");
    expect(hostColor(undefined)).toBe("var(--color-neutral-400)");
  });

  it("labels targets by work type", () => {
    expect(targetLabel({ target: "42", type: "pull_request", title: "x" } as OperatorRow)).toBe("PR #42");
    expect(targetLabel({ target: "42", type: "issue", title: "x" } as OperatorRow)).toBe("Issue #42");
  });

  it("passes a completion report through and prefers its metrics", () => {
    const withCompletion: DashboardModel = {
      ...model,
      batches: [
        {
          ...model.batches[0],
          completion: {
            state: { live: "adf0c47a", replay: "—" },
            audit: { verdict: "clean", author: "justin808 · v1 durable" },
            receipts: [{ label: "receipt-v1" }],
            tokensTotal: "2.09M",
            cost: "$7.30",
            duration: "5h 1m",
            usage: null
          }
        }
      ]
    };
    const card = buildCoordinationView(withCompletion, NOW).batchCards[0];
    expect(card.completion?.audit.verdict).toBe("clean");
    expect(card.tokensTotal).toBe("2.09M");
    expect(card.cost).toBe("$7.30");
    expect(card.duration).toBe("5h 1m");
  });

  it("keeps degraded metrics when there is no completion report", () => {
    const card = view.batchCards[0];
    expect(card.completion).toBeUndefined();
    expect(card.tokensTotal).toBe(ABSENT);
    expect(card.cost).toBe(ABSENT);
  });

  it("derives a manifest lane's state from its status when no operator row exists", () => {
    // A lane targeting an already-terminal work item produces no synthetic lane
    // row, so the state must fall back to the manifest status, not "unknown".
    const doneBatch: DashboardModel = {
      ...model,
      workItems: [
        workItem({
          id: "repo/dashboard#300", repo: "repo/dashboard", target: "300", type: "pull_request",
          schedulingState: "started_not_processing", operatorState: "terminal", terminalState: "done",
          github: { repo: "repo/dashboard", target: "300", type: "pull_request", title: "Merged", url: "https://github.com/repo/dashboard/pull/300", state: "MERGED", labels: [], loadState: "loaded" }
        })
      ],
      batches: [
        {
          schemaVersion: 1, batchId: "b2", repo: "repo/dashboard", objective: "Done batch.", createdAt: "2026-07-21T10:00:00.000Z",
          lanes: [{ name: "l", owner: "o", targets: ["300"], dependsOn: [], status: "final", liveness: "no-heartbeat", blockedOn: [] }],
          path: "batches/b2.json"
        }
      ],
      batchOperations: []
    };
    const card = buildCoordinationView(doneBatch, NOW).batchCards[0];
    expect(card.lanes[0].operatorState).toBe("done");
    expect(card.done).toBe(1);
    expect(card.tier).toBe("archive");
  });

  it("maps lane status text to a lifecycle state", () => {
    expect(laneStatusState("final")).toBe("done");
    expect(laneStatusState("PR-open")).toBe("running");
    expect(laneStatusState("blocked")).toBe("blocked");
    expect(laneStatusState("queued")).toBe("ready");
    expect(laneStatusState("")).toBe("unknown");
  });

  it("canonicalizes host names once", () => {
    expect(canonicalHostName("codex")).toBe("Codex");
    expect(canonicalHostName("CLAUDE")).toBe("Claude");
    expect(canonicalHostName("  other  ")).toBe("other");
    expect(canonicalHostName(undefined)).toBeUndefined();
  });
});
