import { describe, expect, it } from "vitest";
import type { AgentSummary, DashboardModel, WorkItem } from "../shared/types";
import { ABSENT, aggregateUsage, batchIdentity, buildCoordinationView, canonicalHostName, findBatchCard, formatTokens, hostColor, jobBucketForRow, laneStatusState, targetLabel } from "./coordinationView";
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
    expect(canonicalHostName("Codex app")).toBe("Codex");
    expect(canonicalHostName("claude-code")).toBe("Claude");
    expect(canonicalHostName("  other  ")).toBe("other");
    expect(canonicalHostName(undefined)).toBeUndefined();
  });
});
