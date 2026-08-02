import { describe, expect, it } from "vitest";
import type { AgentSummary, DashboardModel, WorkItem } from "../shared/types";
import type { BatchCard } from "./coordinationView";
import { ABSENT, aggregateUsage, batchIdentity, buildCoordinationView, canonicalHostName, findBatchCard, formatTokens, hostColor, jobBucketForRow, laneStatusState, targetLabel } from "./coordinationView";
import { buildOperatorRows, type OperatorRow } from "./operatorRows";

const NOW = "2026-07-21T12:00:00.000Z";
const TERMINAL_STATUS_CASES = [
  "final", "merged", "merged (squash)", "done", "done - archived", "closed", "complete",
  "completed", "released", "released - pending qa", "cancelled", "abandoned", "superseded",
  "PR merged", "task done", "auto-merged", "state: closed"
] as const;
const NONTERMINAL_TERMINAL_WORD_CASES = [
  "not final", "final-review", "final review", "not merged", "pre-merged", "almost merged",
  "not done", "almost done", "not closed", "not complete", "almost complete", "not completed",
  "almost completed", "not released", "pre-released", "unreleased", "not cancelled",
  "not abandoned", "not superseded"
] as const;

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

function coordinatedTarget(
  target: string, batchId: string, status: string, updatedAt?: string,
  options: { blockedOn?: string[]; liveness?: "live" | "stale" | "dead"; claimAt?: string } = {}
): WorkItem {
  const agentId = `agent-${target}`;
  return workItem({
    id: `repo/dashboard#${target}`, repo: "repo/dashboard", target,
    type: "pull_request", schedulingState: "in_process",
    claim: { schemaVersion: 1, repo: "repo/dashboard", target, agentId, batchId, status: "active",
      claimedAt: options.claimAt, updatedAt: options.claimAt,
      path: `claims/${agentId}.json` },
    heartbeat: options.liveness && updatedAt
      ? liveHeartbeat(agentId, updatedAt, {
          repo: "repo/dashboard", target, batchId, status, liveness: options.liveness })
      : undefined,
    batchSignals: [{ batchId, laneName: "l", status, blockedOn: options.blockedOn || [], updatedAt }]
  });
}

function signalledTarget(target: string, batchId: string, status: string, updatedAt?: string): WorkItem {
  return workItem({
    id: `repo/dashboard#${target}`, repo: "repo/dashboard", target, type: "pull_request",
    schedulingState: "started_not_processing",
    batchSignals: [{ batchId, laneName: "l", status, blockedOn: [], updatedAt }]
  });
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
      operatorState: "terminal", terminalState: "done", completedAt: "2026-07-21T11:00:00.000Z",
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

type TestLane = DashboardModel["batches"][number]["lanes"][number];
type TestEvent = DashboardModel["events"][number];
function testLane(partial: Partial<TestLane> = {}): TestLane {
  return { name: "l", owner: "agent", targets: ["300"], dependsOn: [], status: "final",
    liveness: "dead", blockedOn: [], ...partial };
}
function lifecycleEvent(batchId: string, status: string, timestamp: string,
  partial: Partial<TestEvent> = {}): TestEvent {
  return { eventId: `${batchId}-${status}`, type: "phase", status, batchId,
    repo: "repo/dashboard", laneName: "l", timestamp,
    path: `events/${batchId}.jsonl:1`, ...partial };
}
function coordinationFixture(options: {
  batchId: string; lanes?: TestLane[]; workItems?: WorkItem[]; events?: TestEvent[];
  createdAt?: string; updatedAt?: string;
  blocker?: DashboardModel["batches"][number]["blocker"];
}): DashboardModel {
  const { batchId } = options;
  return { ...model,
    workItems: options.workItems || [],
    batches: [{
      schemaVersion: 1, batchId, repo: "repo/dashboard", objective: `Fixture ${batchId}`,
      createdAt: options.createdAt, updatedAt: options.updatedAt,
      lanes: options.lanes || [testLane()], blocker: options.blocker,
      path: `batches/${batchId}.json`
    }],
    events: options.events || [],
    batchOperations: [] };
}
const fixtureLane = (fixture: DashboardModel) => buildCoordinationView(fixture, NOW).batchCards[0].lanes[0];

describe("buildCoordinationView", () => {
  const view = buildCoordinationView(model, NOW);
  const byTarget = (target: string) => view.jobRows.find((row) => row.row.target === target);

  it("builds a host legend with live and total counts per host", () => {
    expect(view.hostLegend).toEqual([
      { name: "Codex", color: "var(--codex)", live: 1, total: 2 },
      { name: "Claude", color: "var(--claude)", live: 0, total: 1 }
    ]);
  });

  it("groups host surface variants into stable Codex and Claude families", () => {
    const variantModel: DashboardModel = {
      ...model,
      agents: model.agents.map((agent, index) => ({
        ...agent,
        heartbeat: agent.heartbeat
          ? { ...agent.heartbeat, host: index === 0 ? "Codex app" : index === 1 ? "claude-code" : "Codex CLI" }
          : undefined
      }))
    };
    expect(buildCoordinationView(variantModel, NOW).hostLegend).toEqual([
      { name: "Codex", color: "var(--codex)", live: 1, total: 2 },
      { name: "Claude", color: "var(--claude)", live: 0, total: 1 }
    ]);
  });

  it("binds machine agent cards to matching job rows without inventing missing custody", () => {
    const currentWork = model.workItems[0];
    const machineModel: DashboardModel = {
      ...model,
      agents: model.agents.map((agent, index) => index === 0
        ? {
            ...agent,
            currentWork: [currentWork],
            heartbeat: {
              ...agent.heartbeat!,
              batchId: "b1",
              threadHandle: "acd-machine-chat",
              operator: "justin"
            }
          }
        : agent)
    };
    const agent = buildCoordinationView(machineModel, NOW).machines
      .find((machine) => machine.id === "m1")?.hosts
      .flatMap((host) => host.agents)
      .find((candidate) => candidate.id === "codex-live");
    expect(agent).toMatchObject({
      machine: "m1",
      host: "Codex",
      target: "repo/dashboard#10",
      batchId: "b1",
      threadHandle: "acd-machine-chat",
      row: expect.objectContaining({ target: "10" }),
      workItem: expect.objectContaining({ id: "repo/dashboard#10" })
    });
  });

  it("does not bind an unattributed machine agent to an arbitrary one of several owned rows", () => {
    const unattributedHeartbeat = liveHeartbeat("shared-agent", "2026-07-21T11:59:00.000Z", {
      host: "Codex",
      machineId: "m1"
    });
    const ownedWork = ["401", "402"].map((target) => workItem({
      id: `repo/dashboard#${target}`,
      repo: "repo/dashboard",
      target,
      type: "issue",
      schedulingState: "in_process",
      heartbeat: liveHeartbeat("shared-agent", "2026-07-21T11:59:00.000Z", {
        host: "Codex",
        machineId: "m1",
        repo: "repo/dashboard",
        target
      })
    }));
    const ambiguousModel: DashboardModel = {
      ...model,
      agents: [{
        agentId: "shared-agent",
        machineId: "m1",
        liveness: "live",
        claims: [],
        currentWork: [],
        warnings: [],
        heartbeat: unattributedHeartbeat
      }],
      workItems: ownedWork,
      batches: [],
      batchOperations: []
    };

    const agent = buildCoordinationView(ambiguousModel, NOW).machines[0].hosts[0].agents[0];
    expect(agent.row).toBeUndefined();
    expect(agent.workItem).toBeUndefined();
  });

  it.each([
    ["repository", { repo: "repo/dashboard" }],
    ["target", { target: "401" }]
  ])("does not bind an agent using only an ambiguous %s hint", (_label, identity) => {
    const ownedWork = ["401", "402"].map((target) => workItem({
      id: `repo/dashboard#${target}`,
      repo: "repo/dashboard",
      target,
      type: "issue",
      schedulingState: "in_process",
      heartbeat: liveHeartbeat("shared-agent", "2026-07-21T11:59:00.000Z", {
        host: "Codex",
        machineId: "m1",
        repo: "repo/dashboard",
        target
      })
    }));
    if ("target" in identity) {
      ownedWork[1] = {
        ...ownedWork[1],
        id: "repo/other#401",
        repo: "repo/other",
        target: "401",
        heartbeat: {
          ...ownedWork[1].heartbeat!,
          repo: "repo/other",
          target: "401"
        }
      };
    }
    const ambiguousModel: DashboardModel = {
      ...model,
      targetRepos: ["repo/dashboard", "repo/other"],
      agents: [{
        agentId: "shared-agent",
        machineId: "m1",
        liveness: "live",
        claims: [],
        currentWork: [],
        warnings: [],
        heartbeat: liveHeartbeat("shared-agent", "2026-07-21T11:59:00.000Z", {
          host: "Codex",
          machineId: "m1",
          ...identity
        })
      }],
      workItems: ownedWork,
      batches: [],
      batchOperations: []
    };

    const agent = buildCoordinationView(ambiguousModel, NOW).machines[0].hosts[0].agents[0];
    expect(agent.row).toBeUndefined();
    expect(agent.workItem).toBeUndefined();
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

  it("routes dead jobs to stuck rather than decision-required blocked", () => {
    const deadRow = { operatorState: "dead", blockedOn: [] } as unknown as OperatorRow;
    expect(jobBucketForRow(deadRow)).toBe("stuck");
  });

  it("counts jobs per bucket", () => {
    expect(view.jobCounts.running).toBeGreaterThanOrEqual(1);
    expect(view.jobCounts.needs_input).toBe(1);
    expect(view.jobCounts.ready).toBe(1);
    expect(view.jobCounts.done).toBe(1);
  });

  it("keeps Done today to the local calendar day and sends older or untimed terminal work to History", () => {
    const terminal = (target: string, completedAt?: string) =>
      workItem({
        id: `repo/dashboard#${target}`,
        repo: "repo/dashboard",
        target,
        type: "pull_request",
        schedulingState: "started_not_processing",
        operatorState: "terminal",
        terminalState: "done",
        completedAt
      });
    const bounded = buildCoordinationView({
      ...model,
      workItems: [
        terminal("21", "2026-07-21T03:00:00.000Z"),
        terminal("22", "2026-07-20T03:00:00.000Z"),
        terminal("23")
      ],
      batches: [],
      batchOperations: []
    }, NOW);
    const bucket = (target: string) => bounded.jobRows.find((row) => row.row.target === target)?.bucket;

    expect(bucket("21")).toBe("done");
    expect(bucket("22")).toBe("history");
    expect(bucket("23")).toBe("history");
  });

  it("uses the local-midnight boundary for Done today", () => {
    const now = new Date(2026, 6, 21, 12, 0, 0, 0);
    const atMidnight = new Date(2026, 6, 21, 0, 0, 0, 0).toISOString();
    const beforeMidnight = new Date(2026, 6, 20, 23, 59, 59, 999).toISOString();
    const row = (completedAt?: string) => ({ operatorState: "done", completedAt, blockedOn: [] }) as unknown as OperatorRow;

    expect(jobBucketForRow(row(atMidnight), undefined, now.getTime())).toBe("done");
    expect(jobBucketForRow({ ...row(atMidnight), operatorState: "archived" } as OperatorRow, undefined, now.getTime())).toBe("done");
    expect(jobBucketForRow(row(beforeMidnight), undefined, now.getTime())).toBe("history");
    expect(jobBucketForRow(row(), undefined, now.getTime())).toBe("history");
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
    expect(card).not.toHaveProperty("thread");
    // Fields with no coordination backing degrade rather than fabricating values.
    expect(card.tokensTotal).toBe(ABSENT);
    expect(card.cost).toBe(ABSENT);
    expect(card.coordinator).toBe(ABSENT);
    expect(card.mergeAuth).toBe(ABSENT);
    expect(card.lanes).toHaveLength(2);
    expect(card.lanes[1].stateColor).toBe("var(--block)");
  });

  it("prefers observed live lane custody over stale manifest metadata", () => {
    const takeoverWork = workItem({
      id: "repo/dashboard#201",
      repo: "repo/dashboard",
      target: "201",
      type: "issue",
      schedulingState: "in_process",
      heartbeat: liveHeartbeat("takeover-agent", "2026-07-21T11:59:30.000Z", {
        batchId: "b1",
        repo: "repo/dashboard",
        target: "201",
        host: "Claude",
        machineId: "m2",
        threadHandle: "live-takeover-thread",
        branch: "codex/live-takeover",
        prUrl: "https://github.com/repo/dashboard/pull/201"
      })
    });
    const card = buildCoordinationView({
      ...model,
      workItems: [...model.workItems, takeoverWork]
    }, NOW).batchCards[0];

    expect(card.lanes[0]).toMatchObject({
      owner: "takeover-agent",
      host: "Claude",
      machine: "m2",
      threadHandle: "live-takeover-thread",
      branchName: "codex/live-takeover",
      prUrl: "https://github.com/repo/dashboard/pull/201"
    });
    expect(card).not.toHaveProperty("thread");
    expect(card.host).toBe("Claude");
    expect(card.hostColor).toBe("var(--claude)");
  });

  it("reconciles same-repository manifest and inferred observations into one stable card", () => {
    const manifest = {
      ...model.batches[0],
      source: "manifest" as const,
      lanes: model.batches[0].lanes.map((lane, index) => index === 0 ? { ...lane, status: "running", blockedOn: [] } : lane)
    };
    const inferred = {
      ...manifest,
      source: "inferred" as const,
      updatedAt: "2026-07-21T11:59:59.000Z",
      path: "inferred-batches/repo__dashboard/b1.json",
      lanes: manifest.lanes.map((lane, index) => index === 0 ? { ...lane, status: "blocked", blockedOn: ["inferred-only"] } : lane)
    };
    const forward = buildCoordinationView({ ...model, batches: [inferred, manifest] }, NOW);
    const reversed = buildCoordinationView({ ...model, batches: [manifest, inferred] }, NOW);

    expect(forward.batchCards).toHaveLength(1);
    expect(forward.batchCards[0].batch.source).toBe("manifest");
    expect(forward.batchCards[0].identity).toBe(batchIdentity(manifest));
    expect(forward.batchCards[0].lanes[0]).toMatchObject({
      operatorState: "running",
      state: "running",
      row: {
        batchPath: manifest.path,
        operatorState: "running"
      }
    });
    expect(reversed.batchCards[0]).toMatchObject({
      identity: forward.batchCards[0].identity,
      tier: forward.batchCards[0].tier
    });
    expect(reversed.batchCards[0].lanes[0]).toMatchObject({
      operatorState: "running",
      state: "running",
      row: {
        batchPath: manifest.path,
        operatorState: "running"
      }
    });
  });

  it("keeps same-ID batches in different repositories distinct and scoped", () => {
    const first = {
      ...model.batches[0],
      source: "manifest" as const,
      targets: [{ type: "issue" as const, target: "201", repo: "repo/dashboard" }]
    };
    const second = {
      ...first,
      // Explicit target scope is authoritative over a stale top-level repo.
      targets: [{ type: "issue" as const, target: "2010", repo: "repo/other" }],
      path: "batches/other-b1.json",
      lanes: first.lanes.map((lane) => ({ ...lane, targets: lane.targets.map((target) => `${target}0`) }))
    };
    const cards = buildCoordinationView({ ...model, batches: [first, second], batchOperations: [] }, NOW).batchCards;

    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((card) => card.identity)).size).toBe(2);
    expect(new Set(cards.map((card) => card.idAttr)).size).toBe(2);
    expect(findBatchCard(cards, { batchId: "b1" })).toBeUndefined();
    expect(findBatchCard(cards, { batchId: "b1", repo: "repo/dashboard" })?.batch.path).toBe(first.path);
    expect(findBatchCard(cards, { batchId: "b1", repo: "repo/other" })?.batch.path).toBe(second.path);
    expect(findBatchCard(cards, { batchId: "b1", repo: "repo/dashboard" })?.repo).toBe("repo/dashboard");
    expect(findBatchCard(cards, { batchId: "b1", repo: "repo/other" })?.repo).toBe("repo/other");
  });

  it("keeps repo-less targets in the effective batch repository scope", () => {
    const knownFallback = {
      ...model.batches[0],
      batchId: "known-fallback",
      repo: "repo/dashboard",
      targets: [
        { type: "issue" as const, target: "201", repo: "repo/other" },
        { type: "issue" as const, target: "202" }
      ]
    };
    const unresolvedFallback = {
      ...knownFallback,
      batchId: "unknown-fallback",
      repo: undefined,
      path: "batches/unknown-fallback.json"
    };
    const cards = buildCoordinationView({
      ...model,
      batches: [knownFallback, unresolvedFallback],
      batchOperations: []
    }, NOW).batchCards;

    expect(batchIdentity(knownFallback)).toBe(JSON.stringify([
      "MULTI:repo/dashboard,repo/other",
      "known-fallback"
    ]));
    expect(batchIdentity(unresolvedFallback)).toBe(JSON.stringify([
      "UNKNOWN:batches/unknown-fallback.json",
      "unknown-fallback"
    ]));
    expect(cards.map((card) => card.repo)).toEqual(["UNKNOWN", "UNKNOWN"]);
  });

  it("keeps an unambiguous cross-repository manifest target link available to its lane", () => {
    const crossRepoBatch = {
      ...model.batches[0],
      batchId: "cross-repo-link",
      repo: "repo/dashboard",
      targets: [
        {
          type: "issue" as const,
          target: "201",
          repo: "repo/other",
          url: "https://github.com/repo/other/issues/201"
        }
      ]
    };
    const card = buildCoordinationView({
      ...model,
      batches: [crossRepoBatch],
      batchOperations: []
    }, NOW).batchCards[0];

    expect(card.lanes[0].targetUrl).toBe("https://github.com/repo/other/issues/201");
  });

  it("does not link a repo-less lane target when same-number manifest URLs disagree", () => {
    const ambiguousBatch = {
      ...model.batches[0],
      batchId: "ambiguous-cross-repo-link",
      repo: undefined,
      targets: [
        {
          type: "issue" as const,
          target: "201",
          repo: "repo/dashboard",
          url: "https://github.com/repo/dashboard/issues/201"
        },
        {
          type: "issue" as const,
          target: "201",
          repo: "repo/other",
          url: "https://github.com/repo/other/issues/201"
        }
      ]
    };
    const card = buildCoordinationView({
      ...model,
      batches: [ambiguousBatch],
      batchOperations: []
    }, NOW).batchCards[0];

    expect(card.lanes[0].targetUrl).toBeUndefined();
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

  it("keeps an issue target label separate from its implementation PR label and destination", () => {
    const linked = buildCoordinationView({
      ...model,
      workItems: [workItem({
        id: "repo/dashboard#45",
        repo: "repo/dashboard",
        target: "45",
        type: "issue",
        schedulingState: "in_process",
        github: {
          repo: "repo/dashboard",
          target: "45",
          type: "issue",
          title: "Coordinated issue",
          url: "https://github.com/repo/dashboard/issues/45",
          state: "OPEN",
          labels: [],
          loadState: "loaded",
          implementationPr: {
            repo: "repo/dashboard",
            target: "54",
            title: "Implementation",
            url: "https://github.com/repo/dashboard/pull/54",
            state: "OPEN",
            labels: [],
            loadState: "loaded"
          }
        }
      })],
      batches: [],
      batchOperations: []
    }, NOW).jobRows[0];

    expect(linked.targetLabel).toBe("Issue #45");
    expect(linked.implementationLabel).toBe("PR #54");
    expect(linked.implementationUrl).toBe("https://github.com/repo/dashboard/pull/54");
  });

  it("does not expose rejected implementation previews to job consumers", () => {
    const invalidImplementationItems = [
      workItem({
        id: "repo/dashboard#215",
        repo: "repo/dashboard",
        target: "215",
        type: "pull_request",
        schedulingState: "ready_for_batch",
        github: {
          repo: "repo/dashboard",
          target: "215",
          type: "pull_request",
          title: "Root pull request 215",
          url: "https://github.com/repo/dashboard/pull/215",
          state: "OPEN",
          labels: [],
          loadState: "loaded",
          implementationPr: {
            repo: "repo/dashboard",
            target: "315",
            title: "Partial implementation",
            url: "https://github.com/repo/dashboard/pull/315",
            state: "UNKNOWN",
            labels: [],
            loadState: "unknown"
          }
        }
      }),
      workItem({
        id: "repo/dashboard#216",
        repo: "repo/dashboard",
        target: "216",
        type: "pull_request",
        schedulingState: "ready_for_batch",
        github: {
          repo: "repo/dashboard",
          target: "216",
          type: "pull_request",
          title: "Root pull request 216",
          url: "https://github.com/repo/dashboard/pull/216",
          state: "OPEN",
          labels: [],
          loadState: "loaded",
          implementationPr: {
            repo: "repo/dashboard",
            target: "316",
            title: "Mismatched implementation",
            url: "https://github.com/repo/api/pull/999",
            state: "OPEN",
            labels: [],
            loadState: "loaded"
          }
        }
      })
    ];
    const jobs = buildCoordinationView({
      ...model,
      agents: [],
      workItems: invalidImplementationItems,
      batches: [],
      batchOperations: []
    }, NOW).jobRows;

    for (const job of jobs) {
      expect.soft(job.implementationLabel).toBeUndefined();
      expect.soft(job.implementationUrl).toBeUndefined();
      expect.soft(job.row.implementationPr).toBeUndefined();
    }
  });

  it("uses a loaded same-target PR as the interactive identity while preserving declared issue provenance", () => {
    const declaredIssue = workItem({
      id: "repo/dashboard#202",
      repo: "repo/dashboard",
      target: "202",
      type: "issue",
      schedulingState: "in_process",
      batchSignals: [{
        batchId: "b1",
        laneName: "l2",
        status: "blocked",
        blockedOn: ["b1:201"]
      }],
      github: {
        repo: "repo/dashboard",
        target: "202",
        type: "pull_request",
        coordinatedType: "issue",
        title: "Merged QA lane",
        url: "https://github.com/repo/dashboard/pull/202",
        state: "MERGED",
        mergedAt: "2026-07-21T11:00:00.000Z",
        labels: [],
        loadState: "loaded"
      }
    });
    const observed = buildCoordinationView({
      ...model,
      workItems: [declaredIssue],
      batches: [{
        ...model.batches[0],
        targets: [{ type: "issue", target: "202" }],
        lanes: [{ ...model.batches[0].lanes[1], targets: ["202"] }]
      }],
      batchOperations: []
    }, NOW);
    const job = observed.jobRows[0];
    const lane = observed.batchCards[0].lanes[0];

    expect(declaredIssue.type).toBe("issue");
    expect(declaredIssue.github?.coordinatedType).toBe("issue");
    expect(job.row.type).toBe("pull_request");
    expect(job.targetLabel).toBe("PR #202");
    expect(job.implementationLabel).toBeUndefined();
    expect(lane.target).toBe("PR #202");
    expect(lane.targetUrl).toBe("https://github.com/repo/dashboard/pull/202");
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

  it("leaves lane route undefined when neither the lane nor its work item declares one (#80)", () => {
    const card = view.batchCards[0];
    expect(card.lanes[0].route).toBeUndefined();
    expect(card.lanes[1].route).toBeUndefined();
  });

  it("surfaces route from the lane manifest, falling back to the work item (#80)", () => {
    const base = model.batches[0];
    const routed: DashboardModel = {
      ...model,
      workItems: [
        ...model.workItems,
        workItem({ id: "repo/dashboard#201", repo: "repo/dashboard", target: "201", type: "pull_request", schedulingState: "in_process", route: "claude-opus-4.6/high" }),
        workItem({ id: "repo/dashboard#202", repo: "repo/dashboard", target: "202", type: "pull_request", schedulingState: "in_process", route: "gpt-5.6-sol/high" })
      ],
      batches: [
        {
          ...base,
          lanes: [
            { ...base.lanes[0], route: "gpt-5.6-sol/xhigh" },
            { ...base.lanes[1] }
          ]
        }
      ]
    };
    const card = buildCoordinationView(routed, NOW).batchCards[0];
    expect(card.lanes[0].route).toBe("gpt-5.6-sol/xhigh"); // lane manifest route wins
    expect(card.lanes[1].route).toBe("gpt-5.6-sol/high"); // falls back to the work item's route
  });

  it("surfaces the declared batch merge authority, degrading when absent (#81)", () => {
    expect(view.batchCards[0].mergeAuth).toBe(ABSENT);
    const withAuth: DashboardModel = { ...model, batches: [{ ...model.batches[0], mergeAuthority: "auto" }] };
    expect(buildCoordinationView(withAuth, NOW).batchCards[0].mergeAuth).toBe("auto");
  });

  it("aggregates batch tokens and cost from observed per-lane usage (#79)", () => {
    const withUsage: DashboardModel = {
      ...model,
      workItems: [
        ...model.workItems,
        workItem({ id: "repo/dashboard#201", repo: "repo/dashboard", target: "201", type: "pull_request", schedulingState: "in_process", usage: [{ model: "gpt-5.6-sol", tokensIn: 1_000_000, tokensOut: 500_000, costUsd: 4 }] }),
        workItem({ id: "repo/dashboard#202", repo: "repo/dashboard", target: "202", type: "pull_request", schedulingState: "in_process", usage: [{ model: "claude-opus-4.6", tokensIn: 400_000, tokensOut: 190_000, costUsd: 3.3 }] })
      ]
    };
    const card = buildCoordinationView(withUsage, NOW).batchCards[0];
    expect(card.tokensTotal).toBe("2.09M"); // (1.5M + 0.59M)
    expect(card.cost).toBe("$7.30"); // 4 + 3.3
  });

  it("prefers a completion report's metrics over the live usage rollup (#79)", () => {
    const withBoth: DashboardModel = {
      ...model,
      workItems: [
        ...model.workItems,
        workItem({ id: "repo/dashboard#201", repo: "repo/dashboard", target: "201", type: "pull_request", schedulingState: "in_process", usage: [{ model: "gpt-5.6-sol", tokensIn: 10, tokensOut: 5 }] })
      ],
      batches: [
        {
          ...model.batches[0],
          completion: {
            state: { live: "adf0c47a" },
            audit: { verdict: "clean", author: "justin808 · v1 durable" },
            receipts: [{ label: "receipt-v1" }],
            tokensTotal: "2.09M",
            cost: "$7.30"
          }
        }
      ]
    };
    const card = buildCoordinationView(withBoth, NOW).batchCards[0];
    expect(card.tokensTotal).toBe("2.09M");
    expect(card.cost).toBe("$7.30");
  });

  it("falls back to the live usage rollup when a completion report degrades metrics to — (#79)", () => {
    const degraded: DashboardModel = {
      ...model,
      workItems: [
        ...model.workItems,
        workItem({ id: "repo/dashboard#201", repo: "repo/dashboard", target: "201", type: "pull_request", schedulingState: "in_process", usage: [{ model: "gpt-5.6-sol", tokensIn: 1_000_000, tokensOut: 500_000, costUsd: 4 }] }),
        workItem({ id: "repo/dashboard#202", repo: "repo/dashboard", target: "202", type: "pull_request", schedulingState: "in_process", usage: [{ model: "claude-opus-4.6", tokensIn: 400_000, tokensOut: 190_000, costUsd: 3.3 }] })
      ],
      batches: [
        {
          ...model.batches[0],
          completion: {
            state: { live: "adf0c47a" },
            audit: { verdict: "clean", author: "justin808 · v1 durable" },
            receipts: [{ label: "receipt-v1" }],
            tokensTotal: ABSENT, // producer signaled "unknown" per the contract
            cost: null
          }
        }
      ]
    };
    const card = buildCoordinationView(degraded, NOW).batchCards[0];
    expect(card.tokensTotal).toBe("2.09M"); // live rollup used, not the "—" from the report
    expect(card.cost).toBe("$7.30");
  });

  it("formats token counts and never fabricates usage (#79)", () => {
    expect(formatTokens(2_090_000)).toBe("2.09M");
    expect(formatTokens(1200)).toBe("1.2K");
    expect(formatTokens(940)).toBe("940");
    expect(aggregateUsage(undefined)).toBeUndefined();
    expect(aggregateUsage([])).toBeUndefined();
    const totals = aggregateUsage([{ model: "m", tokensIn: 10, tokensOut: 5 }]);
    expect(totals?.tokensTotal).toBe("15");
    expect(totals?.cost).toBeUndefined(); // no costUsd → cost omitted, never $0.00
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

  it.each([
    ["keeps a lane that declared a terminal status done after its heartbeat dies",
      coordinationFixture({ batchId: "b3", lanes: [
        testLane({ name: "l1", targets: ["301"], status: "merged" }),
        testLane({ name: "qa", targets: ["301"], status: "complete" })
      ] }), { states: ["done", "done"], done: 2, tier: "archive" }],
    ["clears a stale dependency once the lane itself reports terminal",
      coordinationFixture({ batchId: "b4", lanes: [
        testLane({ targets: ["303"], status: "done", blockedOn: ["b4:other"] }),
        testLane({ name: "qa", targets: ["303"], status: "done" })
      ] }), { state: "done", tier: "archive" }],
    ["still reports a dead lane that never reached a terminal status",
      coordinationFixture({ batchId: "b5", lanes: [
        testLane({ targets: ["304"], status: "in_progress" }),
        testLane({ name: "qa", targets: ["304"], status: "in_progress" })
      ] }), { state: "dead", tier: "stuck" }],
    ["does not let a manifest claim release clear a lane's blocker",
      coordinationFixture({ batchId: "b7", workItems: [workItem({
        id: "repo/dashboard#320", repo: "repo/dashboard", target: "320",
        type: "pull_request", schedulingState: "in_process"
      })], lanes: [
        testLane({ targets: ["320"], status: "released - pending qa", blockedOn: ["b7:other"] }),
        testLane({ name: "other", targets: ["321"], status: "in_progress" })
      ] }), { state: "blocked", tierNot: "archive" }],
    ["still treats a claim release as terminal when the lane records no blocker",
      coordinationFixture({ batchId: "b8", lanes: [
        testLane({ targets: ["330"], status: "released" }),
        testLane({ name: "qa", targets: ["330"], status: "released" })
      ] }), { states: ["done", "done"] }],
    ["still treats a qualified claim release as terminal when the lane records no blocker",
      coordinationFixture({ batchId: "b8-qualified", lanes: [
        testLane({ targets: ["331"], status: "released - pending qa" })
      ] }), { state: "done", tier: "archive" }]
  ] as const)("%s", (_name, fixture, expected) => {
    const card = buildCoordinationView(fixture, NOW).batchCards[0];
    if ("state" in expected) expect(card.lanes[0].operatorState).toBe(expected.state);
    if ("states" in expected) expect(card.lanes.map((lane) => lane.operatorState)).toEqual(expected.states);
    if ("done" in expected) expect(card.done).toBe(expected.done);
    if ("tier" in expected) expect(card.tier).toBe(expected.tier);
    if ("tierNot" in expected) expect(card.tier).not.toBe(expected.tierNot);
  });

  it("keeps a blocker-free qualified release terminal over older active-claim evidence", () => {
    const released = coordinationFixture({
      batchId: "b8-qualified-older",
      createdAt: "2026-07-21T10:00:00.000Z",
      workItems: [coordinatedTarget("333", "b8-qualified-older", "coding", "2026-07-21T09:00:00.000Z")],
      lanes: [testLane({ owner: "agent-333", targets: ["333"], status: "released - pending qa" })]
    });
    const representative = buildOperatorRows(released, { now: new Date(NOW) }).find((row) => row.target === "333");
    expect(representative?.operatorState).toBe("done");
    const card = buildCoordinationView(released, NOW).batchCards[0];
    expect(card.lanes[0].operatorState).toBe("done");
    expect(card.tier).toBe("archive");
  });

  it.each(NONTERMINAL_TERMINAL_WORD_CASES)(
    "does not let the non-release manifest status %s clear a lane blocker",
    (status) => {
      const card = buildCoordinationView(coordinationFixture({
        batchId: `b8-${status}`,
        lanes: [testLane({ targets: ["331"], status, blockedOn: ["repo/dashboard#330"] })]
      }), NOW).batchCards[0];
      expect(card.lanes[0].operatorState).toBe("blocked");
      expect(card.lanes[0].row?.blockedOn).toEqual(["repo/dashboard#330"]);
      expect(card.tier).toBe("blocked");
    }
  );

  it.each(NONTERMINAL_TERMINAL_WORD_CASES)(
    "does not archive the blocker-free non-release manifest status %s",
    (status) => {
      const card = buildCoordinationView(coordinationFixture({
        batchId: `b8-open-${status}`,
        lanes: [testLane({ targets: ["332"], status, liveness: "unknown" })]
      }), NOW).batchCards[0];
      expect(card.lanes[0].operatorState).not.toBe("done");
      expect(card.tier).not.toBe("archive");
    }
  );

  it("keeps a terminal batch blocked while it carries an explicit operator blocker", () => {
    const card = buildCoordinationView(coordinationFixture({
      batchId: "b8-authority",
      blocker: {
        message: "Choose how to complete the batch.",
        decisions: ["Approve the final action"],
        recommendedReply: "Approved."
      },
      lanes: [testLane({ targets: ["332"] })]
    }), NOW).batchCards[0];
    expect(card.lanes[0].operatorState).toBe("done");
    expect(card.tier).toBe("blocked");
  });

  it("still reports a dead lane that never reached a terminal status", () => {
    const abandoned: DashboardModel = {
      ...model,
      workItems: [],
      batches: [
        {
          schemaVersion: 1, batchId: "b5", repo: "repo/dashboard", objective: "Abandoned batch.", createdAt: "2026-07-21T10:00:00.000Z",
          lanes: [
            { name: "l", owner: "o", targets: ["304"], dependsOn: [], status: "in_progress", liveness: "dead", blockedOn: [] },
            { name: "qa", owner: "o2", targets: ["304"], dependsOn: [], status: "in_progress", liveness: "dead", blockedOn: [] }
          ],
          path: "batches/b5.json"
        }
      ],
      batchOperations: []
    };
    const card = buildCoordinationView(abandoned, NOW).batchCards[0];
    expect(card.lanes[0].operatorState).toBe("dead");
    // Dead mid-flight work is forgotten, not awaiting an operator decision.
    expect(card.tier).toBe("stuck");
    // An abandoned lane is not progress: it must not widen the running bar.
    expect(card.running).toBe(0);
    expect(card.runPct).toBe("0%");
  });

  describe("blocker resolution", () => {
    function blockedModel(batches: DashboardModel["batches"]): DashboardModel {
      return { ...model, workItems: [], batches, batchOperations: [] };
    }

    function batch(batchId: string, lanes: DashboardModel["batches"][number]["lanes"]) {
      return {
        schemaVersion: 1 as const, batchId, repo: "repo/dashboard", objective: `${batchId} objective.`,
        createdAt: "2026-07-21T10:00:00.000Z", lanes, path: `batches/${batchId}.json`
      };
    }

    function lane(name: string, status: string, liveness: string, blockedOn: string[] = []) {
      return { name, owner: `owner-${name}`, targets: [], dependsOn: [], status, liveness: liveness as never, blockedOn };
    }

    const laneByTag = (card: BatchCard, tag: string) => card.lanes.find((candidate) => candidate.tag === tag)!;

    it("names the root blocker when a dependency chain bottoms out on a dead lane", () => {
      const view = buildCoordinationView(blockedModel([
        batch("rel", [
          lane("smoke", "heartbeat", "dead"),
          lane("ledger", "blocked", "no-heartbeat", ["rel:smoke"]),
          lane("qa", "blocked", "no-heartbeat", ["rel:ledger"])
        ])
      ]), NOW);
      const card = view.batchCards[0];
      expect(laneByTag(card, "ledger").note).toBe("blocked by smoke, which is dead — relaunch or drop smoke");
      // qa is two hops out, so the note must name the root, not its neighbour.
      expect(laneByTag(card, "qa").note).toBe("blocked by ledger → root smoke, which is dead — relaunch or drop smoke");
    });

    it("reports a lane whose dependencies have all finished as ready to relaunch", () => {
      const view = buildCoordinationView(blockedModel([
        batch("rel", [
          lane("build", "merged", "dead"),
          lane("qa", "blocked", "no-heartbeat", ["rel:build"])
        ])
      ]), NOW);
      expect(laneByTag(view.batchCards[0], "qa").note).toBe("dependencies satisfied — ready to relaunch");
    });

    it("resolves a dependency that points at a lane in another batch", () => {
      const view = buildCoordinationView(blockedModel([
        batch("upstream", [lane("b1", "in_progress", "dead")]),
        batch("downstream", [lane("c1", "blocked", "no-heartbeat", ["upstream:b1"])])
      ]), NOW);
      const downstream = view.batchCards.find((candidate) => candidate.id === "downstream")!;
      expect(laneByTag(downstream, "c1").note).toBe("blocked by upstream:b1, which is dead — relaunch or drop upstream:b1");
    });

    it("resolves a repository-qualified work-item dependency by target", () => {
      const implementation = { ...lane("impl", "in_progress", "dead"), targets: ["440"] };
      const view = buildCoordinationView(blockedModel([
        batch("rel", [
          implementation,
          lane("qa", "blocked", "no-heartbeat", ["repo/dashboard#440"])
        ])
      ]), NOW);
      expect(laneByTag(view.batchCards[0], "qa").note).toBe("blocked by impl, which is dead — relaunch or drop impl");
    });

    it("resolves a repository-qualified work-item dependency across batches", () => {
      const implementation = { ...lane("impl", "in_progress", "dead"), targets: ["440"] };
      const view = buildCoordinationView(blockedModel([
        batch("upstream", [implementation]),
        batch("downstream", [lane("qa", "blocked", "no-heartbeat", ["repo/dashboard#440"])])
      ]), NOW);
      const downstream = view.batchCards.find((candidate) => candidate.id === "downstream")!;
      expect(laneByTag(downstream, "qa").note)
        .toBe("blocked by upstream:impl, which is dead — relaunch or drop upstream:impl");
    });

    it("keeps repository context when a qualified target resolves in another repository", () => {
      const implementation = { ...lane("impl", "in_progress", "dead"), targets: ["440"] };
      const view = buildCoordinationView(blockedModel([
        { ...batch("rel", [lane("qa", "blocked", "no-heartbeat", ["repo/other#440"])]), repo: "repo/dashboard" },
        { ...batch("rel", [implementation]), repo: "repo/other" }
      ]), NOW);
      const own = view.batchCards.find((candidate) => candidate.repo === "repo/dashboard")!;
      expect(laneByTag(own, "qa").note)
        .toBe("blocked by repo/other#rel:impl, which is dead — relaunch or drop repo/other#rel:impl");
    });

    it("does not guess when a repository-qualified target matches several batches", () => {
      const first = { ...lane("first", "in_progress", "dead"), targets: ["440"] };
      const second = { ...lane("second", "in_progress", "dead"), targets: ["440"] };
      const view = buildCoordinationView(blockedModel([
        batch("one", [first]),
        batch("two", [second]),
        batch("downstream", [lane("qa", "blocked", "no-heartbeat", ["repo/dashboard#440"])])
      ]), NOW);
      const downstream = view.batchCards.find((candidate) => candidate.id === "downstream")!;
      expect(laneByTag(downstream, "qa").note)
        .toBe("blocked by repo/dashboard#440, which is not in coordination state");
    });

    it("says so plainly when a dependency cannot be found in coordination state", () => {
      const view = buildCoordinationView(blockedModel([
        batch("rel", [lane("qa", "blocked", "no-heartbeat", ["ghost:missing"])])
      ]), NOW);
      expect(laneByTag(view.batchCards[0], "qa").note).toBe("blocked by ghost:missing, which is not in coordination state");
    });

    it("does not hide a blocked lane that recorded no blocker at all", () => {
      const view = buildCoordinationView(blockedModel([
        batch("rel", [lane("a1", "blocked", "dead")])
      ]), NOW);
      expect(laneByTag(view.batchCards[0], "a1").note).toBe("blocked, no blocker recorded — check the PR or drop the lane");
    });

    it("does not name a redundant root when the chain never moved past the first edge", () => {
      const view = buildCoordinationView(blockedModel([
        batch("upstream", [lane("b3", "blocked", "dead")]),
        batch("downstream", [lane("c2", "blocked", "no-heartbeat", ["upstream:b3"])])
      ]), NOW);
      const downstream = view.batchCards.find((candidate) => candidate.id === "downstream")!;
      expect(laneByTag(downstream, "c2").note).toBe("blocked by upstream:b3, which is blocked with no blocker recorded");
    });


    it("leaves a finished lane's note alone when its manifest kept a stale dependency", () => {
      const view = buildCoordinationView(blockedModel([
        batch("rel", [
          lane("server", "in_progress", "dead"),
          lane("qa", "done", "dead", ["rel:server"])
        ])
      ]), NOW);
      const qa = laneByTag(view.batchCards[0], "qa");
      expect(qa.operatorState).toBe("done");
      expect(qa.note).not.toMatch(/waiting on|blocked by/);
    });

    it("does not resolve a dependency against a same-id batch in another repository", () => {
      // findBatchCard already refuses to pick a same-ID batch from another repo;
      // blocker resolution must not quietly reintroduce that confusion.
      const crossRepo: DashboardModel = {
        ...model,
        workItems: [],
        batches: [
          { ...batch("rel", [lane("smoke", "in_progress", "dead")]), repo: "repo/other" },
          { ...batch("rel", [lane("qa", "blocked", "no-heartbeat", ["rel:smoke"])]), repo: "repo/dashboard" }
        ],
        batchOperations: []
      };
      const own = buildCoordinationView(crossRepo, NOW).batchCards
        .find((candidate) => candidate.repo === "repo/dashboard")!;
      // The only "rel:smoke" lives in a different repo, so it must read as
      // unresolvable rather than borrowing that repo's lane state.
      expect(laneByTag(own, "qa").note).toBe("blocked by smoke, which is not in coordination state");
    });

    it("reports an actionable dead blocker ahead of an unresolvable one", () => {
      const view = buildCoordinationView(blockedModel([
        batch("rel", [
          lane("impl", "in_progress", "dead"),
          lane("qa", "blocked", "no-heartbeat", ["ghost:missing", "rel:impl"])
        ])
      ]), NOW);
      expect(laneByTag(view.batchCards[0], "qa").note).toBe("blocked by impl, which is dead — relaunch or drop impl");
    });

    it("reports an unresolvable dependency ahead of a known live one", () => {
      const view = buildCoordinationView(blockedModel([
        batch("rel", [
          lane("running", "in_progress", "live"),
          lane("qa", "blocked", "no-heartbeat", ["rel:running", "ghost:missing"])
        ])
      ]), NOW);
      expect(laneByTag(view.batchCards[0], "qa").note)
        .toBe("blocked by ghost:missing, which is not in coordination state");
    });

    it("reports an unfinished dependency ahead of a finished one", () => {
      const view = buildCoordinationView(blockedModel([
        batch("rel", [
          lane("finished", "merged", "dead"),
          lane("running", "in_progress", "live"),
          lane("qa", "blocked", "no-heartbeat", ["rel:finished", "rel:running"])
        ])
      ]), NOW);
      // The finished edge sorts first in the manifest; it must not win and claim
      // the lane is ready while another dependency is still going.
      expect(laneByTag(view.batchCards[0], "qa").note).toBe("blocked by running, which is running");
    });

    it("keeps a blocker recorded only on the representative row", () => {
      const signalOnly: DashboardModel = {
        ...model,
        workItems: [
          workItem({
            id: "repo/dashboard#340", repo: "repo/dashboard", target: "340", type: "pull_request", schedulingState: "in_process",
            batchSignals: [{ batchId: "rel", laneName: "qa", status: "blocked", blockedOn: ["rel:impl"], updatedAt: "2026-07-21T11:00:00.000Z" }]
          })
        ],
        batches: [batch("rel", [
          lane("impl", "in_progress", "dead"),
          // The manifest predates the signal, so it records no dependency at all.
          { ...lane("qa", "blocked", "no-heartbeat", []), targets: ["340"] }
        ])],
        batchOperations: []
      };
      const qa = laneByTag(buildCoordinationView(signalOnly, NOW).batchCards[0], "qa");
      expect(qa.note).toBe("blocked by impl, which is dead — relaunch or drop impl");
    });

    function sourceSnapshotModel(
      target: string,
      manifestStatus: string,
      manifestBlockedOn: string[],
      manifestAt: string,
      signalStatus: string,
      signalBlockedOn: string[],
      signalAt: string,
      oldStatus = "in_progress"
    ): DashboardModel {
      return {
        ...model,
        workItems: [workItem({
          id: `repo/dashboard#${target}`, repo: "repo/dashboard", target, type: "pull_request", schedulingState: "in_process",
          batchSignals: [{ batchId: "rel", laneName: "qa", status: signalStatus, blockedOn: signalBlockedOn, updatedAt: signalAt }]
        })],
        batches: [{
          ...batch("rel", [
            lane("old", oldStatus, "dead"),
            lane("new", "in_progress", "live"),
            { ...lane("qa", manifestStatus, "live", manifestBlockedOn), targets: [target] }
          ]),
          updatedAt: manifestAt
        }],
        batchOperations: []
      };
    }

    it("uses a newer manifest blocker instead of retaining an older signal blocker", () => {
      const view = buildCoordinationView(sourceSnapshotModel(
        "341", "blocked", ["rel:new"], "2026-07-21T11:30:00.000Z",
        "blocked", ["rel:old"], "2026-07-21T11:00:00.000Z"
      ), NOW);
      const qa = laneByTag(view.batchCards[0], "qa");
      expect(qa.note).toBe("blocked by new, which is running");
    });

    it("uses a newer signal blocker instead of retaining an older manifest blocker", () => {
      const view = buildCoordinationView(sourceSnapshotModel(
        "342", "blocked", ["rel:old"], "2026-07-21T11:00:00.000Z",
        "blocked", ["rel:new"], "2026-07-21T11:30:00.000Z"
      ), NOW);
      const qa = laneByTag(view.batchCards[0], "qa");
      expect(qa.note).toBe("blocked by new, which is running");
    });

    it.each(["blocked", "paused"])("lets a newer active signal clear an older %s manifest across Jobs and Batches", (status) => {
      const view = buildCoordinationView(sourceSnapshotModel(
        "343", status, ["rel:old"], "2026-07-21T11:00:00.000Z",
        "in_progress", [], "2026-07-21T11:30:00.000Z", "merged"
      ), NOW);
      const job = view.jobRows.find((candidate) => candidate.row.target === "343")!;
      expect(job.row).toMatchObject({ blockedOn: [], operatorState: "running", activityStatus: "in_progress" });
      expect(job).toMatchObject({ bucket: "running" });
      expect(job.note).not.toMatch(/blocked|paused|rel:old/);
      const card = view.batchCards[0];
      expect(laneByTag(card, "qa")).toMatchObject({ operatorState: "running" });
      expect(laneByTag(card, "qa").note).not.toMatch(/blocked|paused|rel:old/);
      expect(card.tier).toBe("running");
    });

    it.each([["merged", "done"], ["paused", "paused"]])(
      "uses an equal-timestamp %s manifest coherently for retention",
      (status, operatorState) => {
        const view = buildCoordinationView(sourceSnapshotModel(
          "344", status, [], "2026-07-21T11:30:00.000Z",
          "in_progress", [], "2026-07-21T11:30:00.000Z", "merged"
        ), NOW);
        expect(view.jobRows.find((candidate) => candidate.row.target === "344")?.row)
          .toMatchObject({ operatorState, activityStatus: status, retentionStatus: status });
      }
    );

    it("keeps the agent's own explanation when a lane is blocked by status text alone", () => {
      const explained: DashboardModel = {
        ...model,
        workItems: [
          workItem({
            id: "repo/dashboard#350", repo: "repo/dashboard", target: "350", type: "pull_request", schedulingState: "in_process",
            batchSignals: [{ batchId: "rel", laneName: "a1", status: "blocked", blockedOn: [], updatedAt: "2026-07-21T11:59:00.000Z" }],
            heartbeat: liveHeartbeat("codex-live", "2026-07-21T11:59:00.000Z", { host: "Codex", machineId: "m1", repo: "repo/dashboard", target: "350", status: "blocked", batchId: "rel" })
          })
        ],
        events: [
          { eventId: "e1", type: "phase.changed", batchId: "rel", laneName: "a1", timestamp: "2026-07-21T11:59:00.000Z", repo: "repo/dashboard", target: "350", message: "waiting on design review from the platform team", status: "blocked", path: "events/e1.json" }
        ],
        batches: [batch("rel", [{ ...lane("a1", "blocked", "live", []), targets: ["350"] }])],
        batchOperations: []
      };
      const a1 = laneByTag(buildCoordinationView(explained, NOW).batchCards[0], "a1");
      expect(a1.operatorState).toBe("blocked");
      // Generic guidance must not bulldoze what the agent actually reported.
      expect(a1.note).toBe("waiting on design review from the platform team");
    });

    it("names the root's own batch when a chain crosses into it", () => {
      const view = buildCoordinationView(blockedModel([
        batch("upstream", [
          lane("root", "in_progress", "dead"),
          lane("mid", "blocked", "no-heartbeat", ["root"])
        ]),
        batch("downstream", [lane("qa", "blocked", "no-heartbeat", ["upstream:mid"])])
      ]), NOW);
      const downstream = view.batchCards.find((candidate) => candidate.id === "downstream")!;
      // "root" is unqualified inside upstream, but from downstream's point of view
      // it is another batch's lane and must stay qualified in the instruction.
      expect(laneByTag(downstream, "qa").note)
        .toBe("blocked by upstream:mid → root upstream:root, which is dead — relaunch or drop upstream:root");
    });

    it("follows a blocker recorded only on an intermediate lane's representative row", () => {
      const signalOnly: DashboardModel = {
        ...model,
        workItems: [
          workItem({
            id: "repo/dashboard#360", repo: "repo/dashboard", target: "360", type: "pull_request", schedulingState: "in_process",
            batchSignals: [{ batchId: "rel", laneName: "mid", status: "blocked", blockedOn: ["rel:root"], updatedAt: "2026-07-21T11:00:00.000Z" }]
          })
        ],
        batches: [batch("rel", [
          lane("root", "in_progress", "dead"),
          // The manifest predates the signal, so the intermediate hop looks empty.
          { ...lane("mid", "blocked", "no-heartbeat", []), targets: ["360"] },
          lane("qa", "blocked", "no-heartbeat", ["rel:mid"])
        ])],
        batchOperations: []
      };
      const qa = laneByTag(buildCoordinationView(signalOnly, NOW).batchCards[0], "qa");
      expect(qa.note).toBe("blocked by mid → root root, which is dead — relaunch or drop root");
    });

    it("picks the dependency chain that is still outstanding, not the one that finished", () => {
      const view = buildCoordinationView(blockedModel([
        batch("rel", [
          lane("done-root", "merged", "dead"),
          lane("dead-root", "in_progress", "dead"),
          // Both branches are blocked, so neither wins on its own state; the
          // manifest lists the satisfied branch first.
          lane("via-done", "blocked", "no-heartbeat", ["rel:done-root"]),
          lane("via-dead", "blocked", "no-heartbeat", ["rel:dead-root"]),
          lane("qa", "blocked", "no-heartbeat", ["rel:via-done", "rel:via-dead"])
        ])
      ]), NOW);
      expect(laneByTag(view.batchCards[0], "qa").note)
        .toBe("blocked by via-dead → root dead-root, which is dead — relaunch or drop dead-root");
    });

    it("keeps a lane's recorded activity when no dependency is declared", () => {
      const described: DashboardModel = {
        ...model,
        workItems: [
          workItem({
            id: "repo/dashboard#370", repo: "repo/dashboard", target: "370", type: "pull_request", schedulingState: "in_process",
            batchSignals: [{ batchId: "rel", laneName: "a1", status: "changes_requested", blockedOn: [], updatedAt: "2026-07-21T11:59:00.000Z" }],
            heartbeat: liveHeartbeat("codex-live", "2026-07-21T11:59:00.000Z", { host: "Codex", machineId: "m1", repo: "repo/dashboard", target: "370", status: "changes_requested", batchId: "rel" })
          })
        ],
        batches: [batch("rel", [{ ...lane("a1", "blocked", "live", []), targets: ["370"] }])],
        batchOperations: []
      };
      const a1 = laneByTag(buildCoordinationView(described, NOW).batchCards[0], "a1");
      expect(a1.operatorState).toBe("blocked");
      // The row reports something more specific than the lane's own "blocked".
      expect(a1.note).not.toBe("blocked, no blocker recorded — check the PR or drop the lane");
      expect(a1.note).toContain("changes");
    });

    it("resolves a dependency carried only by a paused lane's row", () => {
      // A paused row outranks its own dependency, so the lane is not "blocked",
      // but jobNote still rendered that dependency as raw keys. Resolution
      // replaces raw keys with the root and its action for these lanes too.
      const paused: DashboardModel = {
        ...model,
        workItems: [
          workItem({
            id: "repo/dashboard#380", repo: "repo/dashboard", target: "380", type: "pull_request", schedulingState: "in_process",
            batchSignals: [{ batchId: "rel", laneName: "impl", status: "token_limit_pause", blockedOn: ["rel:other"], updatedAt: "2026-07-21T11:59:00.000Z" }],
            heartbeat: liveHeartbeat("codex-live", "2026-07-21T11:59:00.000Z", { host: "Codex", machineId: "m1", repo: "repo/dashboard", target: "380", status: "token_limit_pause", batchId: "rel" })
          })
        ],
        events: [
          { eventId: "e2", type: "phase.changed", batchId: "rel", laneName: "impl", timestamp: "2026-07-21T11:59:00.000Z", repo: "repo/dashboard", target: "380", message: "hit the context limit mid-rebase", status: "token_limit_pause", path: "events/e2.json" }
        ],
        batches: [batch("rel", [
          lane("other", "in_progress", "dead"),
          { ...lane("impl", "token_limit_pause", "live", []), targets: ["380"] }
        ])],
        batchOperations: []
      };
      const impl = laneByTag(buildCoordinationView(paused, NOW).batchCards[0], "impl");
      expect(impl.operatorState).toBe("paused");
      // Not "blocked on rel:other", and phrased as waiting since it never
      // declared itself blocked.
      expect(impl.note).toBe("waiting on other, which is dead — relaunch or drop other");
    });

    it("resolves a dependency that names a target instead of a lane", () => {
      const view = buildCoordinationView(blockedModel([
        {
          ...batch("rel", [
            { ...lane("impl", "in_progress", "dead"), targets: ["201"] },
            lane("qa", "blocked", "no-heartbeat", ["rel:201"])
          ])
        }
      ]), NOW);
      expect(laneByTag(view.batchCards[0], "qa").note).toBe("blocked by impl, which is dead — relaunch or drop impl");
    });

    it("refuses to guess when a target belongs to more than one lane", () => {
      const view = buildCoordinationView(blockedModel([
        {
          ...batch("rel", [
            { ...lane("impl", "in_progress", "dead"), targets: ["201"] },
            { ...lane("audit", "in_progress", "dead"), targets: ["201"] },
            lane("qa", "blocked", "no-heartbeat", ["rel:201"])
          ])
        }
      ]), NOW);
      expect(laneByTag(view.batchCards[0], "qa").note).toBe("blocked by 201, which is not in coordination state");
    });

    it("ranks nested branches by their roots, not by manifest order", () => {
      const view = buildCoordinationView(blockedModel([
        batch("rel", [
          lane("done-root", "merged", "dead"),
          lane("dead-root", "in_progress", "dead"),
          lane("via-done", "blocked", "no-heartbeat", ["rel:done-root"]),
          lane("via-dead", "blocked", "no-heartbeat", ["rel:dead-root"]),
          // One hop deeper than the top-level case: the competing branches sit
          // under mid, so only a nested walk can tell them apart.
          lane("mid", "blocked", "no-heartbeat", ["rel:via-done", "rel:via-dead"]),
          lane("qa", "blocked", "no-heartbeat", ["rel:mid"])
        ])
      ]), NOW);
      expect(laneByTag(view.batchCards[0], "qa").note)
        .toBe("blocked by mid → root dead-root, which is dead — relaunch or drop dead-root");
    });

    it("survives a dependency cycle without hanging", () => {
      const view = buildCoordinationView(blockedModel([
        batch("rel", [
          lane("x", "blocked", "no-heartbeat", ["rel:y"]),
          lane("y", "blocked", "no-heartbeat", ["rel:x"])
        ])
      ]), NOW);
      expect(laneByTag(view.batchCards[0], "x").note).toBe("blocked by y → dependency cycle back to x");
    });

    it("keeps repository and batch context when a dependency cycle closes across batches", () => {
      const view = buildCoordinationView(blockedModel([
        { ...batch("A", [lane("qa", "blocked", "no-heartbeat", ["repo/other#440"])]), repo: "repo/dashboard" },
        {
          ...batch("B", [
            { ...lane("start", "blocked", "no-heartbeat", ["C:dup"]), targets: ["440"] }
          ]),
          repo: "repo/other"
        },
        { ...batch("C", [lane("dup", "blocked", "no-heartbeat", ["D:mid"])]), repo: "repo/other" },
        { ...batch("D", [lane("mid", "blocked", "no-heartbeat", ["C:dup"])]), repo: "repo/other" }
      ]), NOW);
      const own = view.batchCards.find((candidate) => candidate.repo === "repo/dashboard")!;
      expect(laneByTag(own, "qa").note)
        .toBe("blocked by repo/other#B:start → dependency cycle back to repo/other#C:dup");
    });
  });

  it("does not narrate a stale dependency on a lane that already finished", () => {
    const view = fixtureLane(coordinationFixture({
      batchId: "b9",
      lanes: [testLane({ targets: [], status: "merged", blockedOn: ["b9:other"] })]
    }));
    expect(view.operatorState).toBe("done");
    // A done badge beside "depends on b9:other" reads as self-contradictory.
    expect(view.note).not.toMatch(/depends on|blocked on/);
  });

  it("maps lane status text to a lifecycle state", () => {
    expect(laneStatusState("final")).toBe("done");
    expect(laneStatusState("final-review")).toBe("running");
    expect(laneStatusState("final review")).toBe("running");
    expect(laneStatusState("PR-open")).toBe("running");
    expect(laneStatusState("blocked")).toBe("blocked");
    expect(laneStatusState("queued")).toBe("ready");
    expect(laneStatusState("")).toBe("unknown");
  });

  it.each(TERMINAL_STATUS_CASES)("recognizes the accepted terminal status %s", (status) => {
    // Lane and row lifecycle derivation must agree on what counts as finished,
    // or the same status lands in a different tier depending on whether custody
    // produced a representative row for the lane.
    expect(laneStatusState(status)).toBe("done");
  });

  it.each(NONTERMINAL_TERMINAL_WORD_CASES)(
    "does not treat the nonterminal terminal-word status %s as done",
    (status) => {
      expect(laneStatusState(status)).not.toBe("done");
    }
  );

  it.each([
    ["keeps a manifest lane terminal when its representative only has stale non-terminal telemetry",
      coordinationFixture({ batchId: "b6", createdAt: "2026-07-21T10:00:00.000Z",
        workItems: [coordinatedTarget("310", "b6", "coding", "2026-07-21T09:00:00.000Z", { liveness: "dead" })],
        lanes: [testLane({ targets: ["310"] })] }),
      { representative: { batchId: "b6", laneName: "l", operatorState: "done" }, rowState: "done", laneState: "done", tier: "archive" }],
    ["keeps untimestamped active custody visible beneath an untimestamped terminal manifest",
      coordinationFixture({ batchId: "b6-untimestamped-custody",
        workItems: [coordinatedTarget("309", "b6-untimestamped-custody", "final")],
        lanes: [testLane({ owner: "agent-309", targets: ["309"] })] }),
      { representative: { operatorState: "dead" }, rowState: "done", laneState: "done", tier: "archive" }],
    ["keeps timestamped active claims current when terminal manifest freshness is unavailable",
      coordinationFixture({ batchId: "b6-timestamped-claim",
        workItems: [coordinatedTarget("308", "b6-timestamped-claim", "coding", "2026-07-21T11:00:00.000Z", {
          claimAt: "2026-07-21T11:00:00.000Z"
        })], lanes: [testLane({ owner: "agent-308", targets: ["308"] })] }),
      { representative: { operatorState: "dead" }, laneState: "dead", tier: "stuck" }],
    ["keeps timestamped lifecycle events current when terminal manifest freshness is unavailable",
      coordinationFixture({ batchId: "b6-timestamped-event",
        workItems: [signalledTarget("307", "b6-timestamped-event", "final")],
        lanes: [testLane({ owner: "codex-event", targets: ["307"] })],
        events: [lifecycleEvent("b6-timestamped-event", "coding", "2026-07-21T11:00:00.000Z", { target: "307" })] }),
      { representative: { operatorState: "dead" }, laneState: "dead", tier: "stuck" }],
    ["lets current live custody outrank a stale terminal manifest",
      coordinationFixture({ batchId: "b10", createdAt: "2026-07-21T10:00:00.000Z",
        workItems: [coordinatedTarget("311", "b10", "coding", "2026-07-21T11:59:00.000Z", { liveness: "live" })],
        lanes: [testLane({ owner: "old-agent", targets: ["311"] })] }),
      { rowState: "running", laneState: "running", tier: "running" }]
  ] as const)("%s", (_name, fixture, expected) => {
    const row = buildOperatorRows(fixture, { now: new Date(NOW) })[0];
    if ("representative" in expected) expect(row).toMatchObject(expected.representative);
    const card = buildCoordinationView(fixture, NOW).batchCards[0];
    if ("rowState" in expected) expect(card.lanes[0].row?.operatorState).toBe(expected.rowState);
    expect(card.lanes[0].operatorState).toBe(expected.laneState);
    expect(card.tier).toBe(expected.tier);
  });

  it("finds current custody beyond the first sorted row in a multi-target lane", () => {
    const multiTarget = coordinationFixture({
      batchId: "b12",
      createdAt: "2026-07-21T10:00:00.000Z",
      workItems: [
        coordinatedTarget("313", "b12", "blocked", "2026-07-21T09:00:00.000Z", { blockedOn: ["repo/dashboard#9"] }),
        coordinatedTarget("314", "b12", "coding", "2026-07-21T11:59:00.000Z", { liveness: "live" })
      ],
      lanes: [testLane({ owner: "old-agent", targets: ["313", "314"] })]
    });
    const rows = buildOperatorRows(multiTarget, { now: new Date(NOW) })
      .filter((row) => row.batchId === "b12" && row.laneName === "l");
    expect(rows.map((row) => row.operatorState)).toEqual(["running", "done"]);
    const lane = buildCoordinationView(multiTarget, NOW).batchCards[0].lanes[0];
    expect(lane.row).toMatchObject({ target: "314", operatorState: "running" });
    expect(lane.operatorState).toBe("running");
  });

  it.each([
    ["keeps a current blocker visible with 'blocked before live' custody", "terminal", "blocked-first", "live"],
    ["keeps a current blocker visible with 'live before blocked' custody", "terminal", "custody-first", "live"],
    ["keeps a current dead row ahead of newer live custody", "terminal", "dead-first", "live"],
    ["keeps a current blocker visible with 'stale before blocked' custody", "terminal", "custody-first", "stale"],
    ["keeps a nonterminal multi-target lane blocked for the blocked-first input permutation", "open", "blocked-first", "live"],
    ["keeps a nonterminal multi-target lane blocked for the live-first input permutation", "open", "custody-first", "live"]
  ] as const)("%s", (_name, kind, order, liveness) => {
    const batchId = kind === "terminal" ? "b12-current-blocker" : "b12-mixed";
    const blockedTarget = kind === "terminal" ? "342" : "340";
    const custodyTarget = kind === "terminal" ? "343" : "341";
    const deadRow = order === "dead-first";
    const blocked = coordinatedTarget(blockedTarget, batchId, deadRow ? "coding" : "blocked", "2026-07-21T11:00:00.000Z",
      { blockedOn: deadRow ? [] : ["repo/dashboard#9"], claimAt: deadRow ? "2026-07-21T11:00:00.000Z" : undefined });
    const custody = coordinatedTarget(custodyTarget, batchId, "coding", "2026-07-21T11:59:00.000Z", { liveness });
    const fixture = coordinationFixture({
      batchId, workItems: order === "blocked-first" ? [blocked, custody] : [custody, blocked],
      createdAt: kind === "terminal" ? "2026-07-21T09:00:00.000Z" : "2026-07-21T10:00:00.000Z",
      updatedAt: kind === "terminal" ? "2026-07-21T10:00:00.000Z" : undefined,
      lanes: [testLane(kind === "terminal"
        ? { owner: "old-agent", targets: ["342", "343"] }
        : { owner: "agent-340", targets: ["340", "341"], status: "in_progress", liveness: "live" })]
    });
    const lane = fixtureLane(fixture);
    expect(lane.row).toMatchObject({
      target: blockedTarget, operatorState: deadRow ? "dead" : "blocked", blockedOn: deadRow ? [] : ["repo/dashboard#9"]
    });
    expect(lane.operatorState).toBe(deadRow ? "dead" : "blocked");
  });

  it.each([
    ["prefers live over stale custody when 'stale sorted first'", "liveness", "350", "351", "351"],
    ["prefers live over stale custody when 'live sorted first'", "liveness", "351", "350", "350"],
    ["ranks same-liveness custody when 'newer target sorts second'", "recency", "11:40", "11:59", "361"],
    ["ranks same-liveness custody when 'newer target sorts first'", "recency", "11:59", "11:40", "360"],
    ["ranks same-liveness custody when 'recency ties preserve deterministic ranking'", "recency", "11:59", "11:59", "360"]
  ] as const)("%s", (_name, kind, firstValue, secondValue, expectedTarget) => {
    const at = (minute: string) => `2026-07-21T${minute}:00.000Z`;
    const batchId = kind === "liveness" ? "b12-liveness" : "b12-recency";
    const first = kind === "liveness"
      ? coordinatedTarget(firstValue, batchId, "coding", at("11:40"), { liveness: "stale" })
      : coordinatedTarget("360", batchId, "coding", at(firstValue), { liveness: "live" });
    const second = kind === "liveness"
      ? coordinatedTarget(secondValue, batchId, "coding", at("11:59"), { liveness: "live" })
      : coordinatedTarget("361", batchId, "coding", at(secondValue), { liveness: "live" });
    const targets = kind === "liveness" ? ["350", "351"] : ["360", "361"];
    const lane = fixtureLane(coordinationFixture({
      batchId, workItems: kind === "liveness" ? [first, second] : [second, first],
      createdAt: "2026-07-21T10:00:00.000Z",
      lanes: [testLane({ owner: "old-agent", targets })]
    }));
    expect(lane.row).toMatchObject({ target: expectedTarget, operatorState: "running" });
    if (kind === "liveness") expect(lane.operatorState).toBe("running");
  });

  it.each([
    ["compares terminal manifest freshness with 'older live custody'", "live", "09:00", true, "done", undefined],
    ["compares terminal manifest freshness with 'older stale custody'", "stale", "09:00", true, "done", undefined],
    ["compares terminal manifest freshness with 'equal live custody'", "live", "10:00", true, "done", undefined],
    ["compares terminal manifest freshness with 'equal stale custody'", "stale", "10:00", true, "done", undefined],
    ["compares terminal manifest freshness with 'newer live custody'", "live", "11:59", true, "running", undefined],
    ["compares terminal manifest freshness with 'newer stale custody'", "stale", "11:59", true, "stale", undefined],
    ["keeps 'live' custody current when terminal manifest freshness is unavailable", "live", "11:59", false, "running", "running"],
    ["keeps 'stale' custody current when terminal manifest freshness is unavailable", "stale", "11:59", false, "stale", "stuck"]
  ] as const)("%s", (_name, liveness, minute, hasManifestTime, expectedState, expectedTier) => {
    const custodyAt = `2026-07-21T${minute}:00.000Z`;
    const target = hasManifestTime ? "365" : "366", batchId = hasManifestTime ? `b12-${liveness}-${custodyAt}` : `b12-unknown-manifest-${liveness}`;
    const fixture = coordinationFixture({
      batchId,
      createdAt: hasManifestTime ? "2026-07-21T08:00:00.000Z" : undefined,
      updatedAt: hasManifestTime ? "2026-07-21T10:00:00.000Z" : undefined,
      workItems: [coordinatedTarget(target, batchId, "coding", custodyAt, { liveness })],
      lanes: [testLane({ owner: `agent-${target}`, targets: [target], status: "merged" })]
    });
    const [row, card] = [buildOperatorRows(fixture, { now: new Date(NOW) })[0], buildCoordinationView(fixture, NOW).batchCards[0]];
    expect([row.operatorState, card.lanes[0].operatorState]).toEqual([expectedState, expectedState]);
    if (expectedTier) expect(card.tier).toBe(expectedTier);
  });

  it("does not narrate a representative's stale blocker after the manifest lane finishes", () => {
    const blocker = ["outside saved target repositories"];
    const finished = coordinationFixture({
      batchId: "b11",
      createdAt: "2026-07-21T10:00:00.000Z",
      workItems: [coordinatedTarget("312", "b11", "coding", "2026-07-21T09:00:00.000Z", { blockedOn: blocker })],
      lanes: [testLane({ owner: "old-agent", targets: ["312"], blockedOn: blocker })]
    });
    const representative = buildOperatorRows(finished, { now: new Date(NOW) }).find((row) => row.target === "312");
    expect(representative).toMatchObject({
      operatorState: "done",
      blockedOn: []
    });
    const lane = buildCoordinationView(finished, NOW).batchCards[0].lanes[0];
    expect(lane.row).toMatchObject({ operatorState: "done", blockedOn: [] });
    expect(lane.operatorState).toBe("done");
    expect(lane.note).not.toMatch(/blocked on|depends on/);
  });

  it("lets newer blocked evidence outrank an older terminal manifest", () => {
    const blocked = coordinationFixture({
      batchId: "b13",
      createdAt: "2026-07-21T10:00:00.000Z",
      workItems: [coordinatedTarget("315", "b13", "blocked", "2026-07-21T11:00:00.000Z", {
        blockedOn: ["repo/dashboard#9"]
      })],
      lanes: [testLane({ owner: "agent-315", targets: ["315"], blockedOn: ["repo/dashboard#9"] })]
    });
    const lane = buildCoordinationView(blocked, NOW).batchCards[0].lanes[0];
    expect(lane.row).toMatchObject({ operatorState: "blocked", blockedOn: ["repo/dashboard#9"] });
    expect(lane.operatorState).toBe("blocked");
    expect(lane.note).toBe("blocked by repo/dashboard#9, which is not in coordination state");
  });

  it("lets a strictly newer coding event reopen a retained terminal lane", () => {
    const batchId = "b13-newer-coding";
    const reopened = coordinationFixture({
      batchId, createdAt: "2026-07-21T08:00:00.000Z", updatedAt: "2026-07-21T10:00:00.000Z",
      workItems: [signalledTarget("369", batchId, "final", "2026-07-21T10:00:00.000Z")],
      lanes: [testLane({ owner: "agent-369", targets: ["369"] })],
      events: [lifecycleEvent(batchId, "coding", "2026-07-21T11:00:00.000Z", { target: "369" })]
    });
    expect(buildOperatorRows(reopened, { now: new Date(NOW) })[0].operatorState).toBe("dead");
    const card = buildCoordinationView(reopened, NOW).batchCards[0];
    expect(card.lanes[0].operatorState).toBe("dead");
    expect(card.lanes[0].state).toBe("coding");
    expect(card.tier).toBe("stuck");
  });

  it("shows a newer typed terminal transition instead of a stale paused manifest", () => {
    const batchId = "b13-paused-then-done";
    const card = buildCoordinationView(coordinationFixture({
      batchId, updatedAt: "2026-07-21T10:00:00.000Z",
      lanes: [testLane({ targets: [], status: "paused" })],
      events: [lifecycleEvent(batchId, "done", "2026-07-21T11:00:00.000Z",
        { type: "lane_closed", target: undefined })]
    }), NOW).batchCards[0];
    expect(card.lanes[0]).toMatchObject({ operatorState: "done", state: "done" });
  });

  it("does not show an older terminal event over newer active custody", () => {
    const batchId = "b13-active-after-done";
    const card = buildCoordinationView(coordinationFixture({
      batchId, updatedAt: "2026-07-21T10:00:00.000Z",
      workItems: [coordinatedTarget("370", batchId, "final", undefined,
        { claimAt: "2026-07-21T11:00:00.000Z" })],
      lanes: [testLane({ targets: ["370"] })],
      events: [lifecycleEvent(batchId, "done", "2026-07-21T09:00:00.000Z", { target: "370" })]
    }), NOW).batchCards[0];
    expect(card.lanes[0]).toMatchObject({ operatorState: "dead", state: "dead" });
  });

  it("keeps a targetless terminal lane out of the archive when a newer event reopens it", () => {
    const batchId = "b13-targetless-reopened";
    const reopened = coordinationFixture({
      batchId, createdAt: "2026-07-21T08:00:00.000Z", updatedAt: "2026-07-21T10:00:00.000Z",
      lanes: [testLane({ owner: "agent-targetless", targets: [], liveness: "no-heartbeat" })],
      events: [lifecycleEvent(batchId, "coding", "2026-07-21T11:00:00.000Z")]
    });
    expect(buildOperatorRows(reopened, { now: new Date(NOW) })[0].operatorState).toBe("dead");
    const card = buildCoordinationView(reopened, NOW).batchCards[0];
    expect(card.lanes[0].operatorState).toBe("dead");
    expect(card.tier).toBe("stuck");
  });

  it.each([
    ["'newer evidence'", "2026-07-21T10:00:00.000Z", undefined, "2026-07-21T11:00:00.000Z", "blocked"],
    ["'older evidence'", "2026-07-21T10:00:00.000Z", "2026-07-21T11:00:00.000Z", "2026-07-21T09:00:00.000Z", "done"],
    ["'equal-timestamp evidence'", "2026-07-21T10:00:00.000Z", undefined, "2026-07-21T10:00:00.000Z", "done"],
    ["'missing manifest freshness'", undefined, undefined, "2026-07-21T09:00:00.000Z", "done"],
    ["'invalid manifest freshness'", "not-a-date", "also-not-a-date", "2026-07-21T09:00:00.000Z", "done"],
    ["'valid createdAt fallback'", "2026-07-21T10:00:00.000Z", "not-a-date", "2026-07-21T09:00:00.000Z", "done"]
  ] as const)(
    "reconciles terminal freshness for %s",
    (_name, createdAt, updatedAt, evidenceAt, expectedState) => {
      const batchId = `b13-${expectedState}-${evidenceAt}`;
      const freshness = coordinationFixture({
        batchId, createdAt, updatedAt,
        workItems: [coordinatedTarget("370", batchId, "blocked", evidenceAt, {
          blockedOn: ["repo/dashboard#9"]
        })],
        lanes: [testLane({ owner: "agent-370", targets: ["370"] })]
      });
      const lane = buildCoordinationView(freshness, NOW).batchCards[0].lanes[0];
      expect(lane.operatorState).toBe(expectedState);
    }
  );

  it("finds newer nonterminal evidence beyond the first sorted lane row", () => {
    const multiTarget = coordinationFixture({
      batchId: "b14",
      createdAt: "2026-07-21T10:00:00.000Z",
      workItems: [
        coordinatedTarget("316", "b14", "blocked", "2026-07-21T09:00:00.000Z", { blockedOn: ["repo/dashboard#8"] }),
        coordinatedTarget("317", "b14", "blocked", "2026-07-21T11:00:00.000Z", { blockedOn: ["repo/dashboard#9"] })
      ],
      lanes: [testLane({ owner: "old-agent", targets: ["316", "317"] })]
    });
    const rows = buildOperatorRows(multiTarget, { now: new Date(NOW) })
      .filter((row) => row.batchId === "b14" && row.laneName === "l");
    expect(rows.map((row) => row.target)).toEqual(["317", "316"]);
    const lane = buildCoordinationView(multiTarget, NOW).batchCards[0].lanes[0];
    expect(lane.row).toMatchObject({
      target: "317",
      operatorState: "blocked",
      blockedOn: ["repo/dashboard#9"]
    });
    expect(lane.operatorState).toBe("blocked");
  });

  it("does not use another batch's later signal to supersede this lane's terminal manifest", () => {
    const target = coordinatedTarget("318", "b15", "blocked", "2026-07-21T09:00:00.000Z", {
      blockedOn: ["repo/dashboard#9"]
    });
    target.batchSignals?.push({
      batchId: "other-batch", laneName: "other", status: "coding",
      blockedOn: [], updatedAt: "2026-07-21T11:00:00.000Z"
    });
    const retained = coordinationFixture({
      batchId: "b15",
      createdAt: "2026-07-21T10:00:00.000Z",
      workItems: [target],
      lanes: [testLane({ owner: "old-agent", targets: ["318"], blockedOn: ["repo/dashboard#9"] })]
    });
    const row = buildOperatorRows(retained, { now: new Date(NOW) }).find((candidate) => candidate.target === "318");
    expect(row).toMatchObject({ batchId: "b15", operatorState: "done" });
    const lane = buildCoordinationView(retained, NOW).batchCards[0].lanes[0];
    expect(lane.row).toMatchObject({ operatorState: "done", blockedOn: [] });
    expect(lane.operatorState).toBe("done");
  });

  it("canonicalizes host names once", () => {
    expect(canonicalHostName("codex")).toBe("Codex");
    expect(canonicalHostName("CLAUDE")).toBe("Claude");
    expect(canonicalHostName("Codex app")).toBe("Codex");
    expect(canonicalHostName("claude-code")).toBe("Claude");
    expect(canonicalHostName("  other  ")).toBe("other");
    expect(canonicalHostName(undefined)).toBeUndefined();
  });
});
