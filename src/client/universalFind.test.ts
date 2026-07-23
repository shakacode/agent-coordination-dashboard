import { describe, expect, it } from "vitest";
import type { DashboardModel, WorkItem } from "../shared/types";
import { buildCoordinationView } from "./coordinationView";
import { buildFindResults, exactFindResult } from "./universalFind";

const heartbeat = {
  schemaVersion: 1,
  agentId: "codex-maker",
  machineId: "m1",
  host: "Codex app",
  operator: "justin",
  repo: "repo/dashboard",
  target: "89",
  batchId: "batch-alpha",
  threadHandle: "acd-chat-kite",
  branch: "codex/universal-find",
  prUrl: "https://github.com/repo/dashboard/pull/189",
  status: "implementing",
  updatedAt: "2026-07-23T01:00:00Z",
  expiresAt: "2026-07-23T02:00:00Z",
  path: "heartbeats/codex-maker.json",
  liveness: "live" as const
};

const workItem: WorkItem = {
  id: "repo/dashboard#89",
  repo: "repo/dashboard",
  target: "89",
  type: "issue",
  schedulingState: "in_process",
  heartbeat,
  github: {
    repo: "repo/dashboard",
    target: "89",
    type: "issue",
    title: "Universal find",
    url: "https://github.com/repo/dashboard/issues/89",
    state: "OPEN",
    labels: [],
    loadState: "loaded",
    implementationPr: {
      repo: "repo/dashboard",
      target: "190",
      title: "Implement universal find",
      url: "https://github.com/repo/dashboard/pull/190",
      state: "OPEN",
      labels: [],
      loadState: "loaded"
    }
  },
  warnings: [],
  selected: false
};

const model: DashboardModel = {
  generatedAt: "2026-07-23T01:01:00Z",
  stateRoot: "/state",
  targetRepos: ["repo/dashboard"],
  agents: [{
    agentId: "codex-maker",
    machineId: "m1",
    liveness: "live",
    claims: [],
    currentWork: [workItem],
    warnings: [],
    heartbeat
  }],
  workItems: [workItem],
  batches: [{
    schemaVersion: 1,
    batchId: "batch-alpha",
    repo: "repo/dashboard",
    objective: "Restore operator navigation",
    createdByMachine: "m1",
    lanes: [{
      name: "search-lane",
      owner: "codex-maker",
      targets: ["89"],
      dependsOn: [],
      status: "running",
      liveness: "live",
      blockedOn: [],
      host: "Codex app",
      operator: "justin",
      threadHandle: "acd-chat-kite",
      branch: "codex/universal-find",
      prUrl: "https://github.com/repo/dashboard/pull/190"
    }],
    path: "batches/batch-alpha.json"
  }],
  events: [],
  batchOperations: [],
  qaValidations: [],
  healthItems: [],
  warnings: []
};

describe("buildFindResults", () => {
  const view = buildCoordinationView(model, model.generatedAt);

  it.each([
    ["89", "job"],
    ["https://github.com/repo/dashboard/issues/89", "job"],
    ["repo/dashboard", "job"],
    ["codex/universal-find", "job"],
    ["batch-alpha", "batch"],
    ["search-lane", "job"],
    ["m1", "job"],
    ["codex-maker", "job"],
    ["justin", "job"],
    ["Codex app", "job"],
    ["acd-chat-kite", "job"]
  ])("finds %s with an actionable %s result", (query, kind) => {
    expect(buildFindResults(view, query).some((result) => result.kind === kind)).toBe(true);
  });

  it("returns explicit empty result data for unknown text", () => {
    expect(buildFindResults(view, "definitely-not-observed")).toEqual([]);
  });

  it("finds an observed PR by its preserved declared issue identity", () => {
    const declaredIssue: WorkItem = {
      ...workItem,
      id: "repo/dashboard#202",
      target: "202",
      type: "issue",
      heartbeat: undefined,
      github: {
        ...workItem.github!,
        target: "202",
        type: "pull_request",
        coordinatedType: "issue",
        title: "Observed pull request",
        url: "https://github.com/repo/dashboard/pull/202"
      }
    };
    const declaredIssueView = buildCoordinationView({
      ...model,
      agents: [],
      workItems: [declaredIssue],
      batches: []
    }, model.generatedAt);

    expect(buildFindResults(declaredIssueView, "Issue #202")).toContainEqual(
      expect.objectContaining({
        kind: "job",
        row: expect.objectContaining({
          target: "202",
          type: "pull_request"
        })
      })
    );
  });

  it("does not find rejected implementation previews by their title, target, or URL", () => {
    const rejectedImplementations: WorkItem[] = [
      {
        ...workItem,
        id: "repo/dashboard#215",
        target: "215",
        heartbeat: undefined,
        github: {
          ...workItem.github!,
          target: "215",
          type: "pull_request",
          title: "Root pull request 215",
          url: "https://github.com/repo/dashboard/pull/215",
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
      },
      {
        ...workItem,
        id: "repo/dashboard#216",
        target: "216",
        heartbeat: undefined,
        github: {
          ...workItem.github!,
          target: "216",
          type: "pull_request",
          title: "Root pull request 216",
          url: "https://github.com/repo/dashboard/pull/216",
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
      }
    ];
    const rejectedView = buildCoordinationView({
      ...model,
      agents: [],
      workItems: rejectedImplementations,
      batches: []
    }, model.generatedAt);

    for (const query of [
      "Partial implementation",
      "PR #315",
      "Mismatched implementation",
      "PR #316",
      "https://github.com/repo/api/pull/999"
    ]) {
      expect.soft(buildFindResults(rejectedView, query).filter((result) => result.kind === "job")).toEqual([]);
    }
  });

  it("keeps handle provenance available for copy fallback", () => {
    expect(buildFindResults(view, "acd-chat-kite")).toContainEqual(
      expect.objectContaining({
        kind: "job",
        machine: "m1",
        threadHandle: "acd-chat-kite",
        repo: "repo/dashboard"
      })
    );
  });

  it("prefers the unique exact job even when its containing machine and batch also match", () => {
    const results = buildFindResults(view, "89");
    expect(results.map((result) => result.kind)).toEqual(expect.arrayContaining(["job", "batch", "machine"]));
    expect(exactFindResult(results, "89")).toEqual(expect.objectContaining({
      kind: "job",
      row: expect.objectContaining({ target: "89" })
    }));
  });

  it.each([
    "https://github.com/repo/dashboard/pull/189",
    "https://github.com/repo/dashboard/pull/190",
    "190"
  ])("opens the uniquely matching job for exact custody identity %s", (query) => {
    const results = buildFindResults(view, query);
    expect(exactFindResult(results, query)).toEqual(expect.objectContaining({
      kind: "job",
      row: expect.objectContaining({ target: "89" })
    }));
  });

  it("opens an exact batch id even when the batch's jobs also match", () => {
    const results = buildFindResults(view, "batch-alpha");
    expect(results.map((result) => result.kind)).toEqual(expect.arrayContaining(["job", "batch"]));
    expect(exactFindResult(results, "batch-alpha")).toEqual(expect.objectContaining({
      kind: "batch",
      card: expect.objectContaining({ id: "batch-alpha" })
    }));
  });

  it("continues past ambiguous exact jobs to a uniquely matching machine", () => {
    const secondHeartbeat = {
      ...heartbeat,
      agentId: "codex-maker-2",
      target: "90"
    };
    const secondWorkItem: WorkItem = {
      ...workItem,
      id: "repo/dashboard#90",
      target: "90",
      heartbeat: secondHeartbeat,
      github: {
        ...workItem.github!,
        target: "90",
        title: "Second machine job",
        url: "https://github.com/repo/dashboard/issues/90"
      }
    };
    const sharedMachineView = buildCoordinationView({
      ...model,
      workItems: [workItem, secondWorkItem]
    }, model.generatedAt);
    const results = buildFindResults(sharedMachineView, "m1");

    expect(results.filter((result) => result.kind === "job")).toHaveLength(2);
    expect(exactFindResult(results, "m1")).toEqual(expect.objectContaining({
      kind: "machine",
      machine: "m1"
    }));
  });

  it("uses observed lane host custody for batch find results after a live takeover", () => {
    const takeoverHeartbeat = {
      ...heartbeat,
      host: "Claude",
      machineId: "m2"
    };
    const takeoverView = buildCoordinationView({
      ...model,
      agents: [],
      workItems: [{ ...workItem, heartbeat: takeoverHeartbeat }]
    }, model.generatedAt);

    expect(buildFindResults(takeoverView, "batch-alpha")).toContainEqual(
      expect.objectContaining({
        kind: "batch",
        host: "Claude",
        card: expect.objectContaining({ host: "Claude" })
      })
    );
  });

  it.each(["repo/other#45", "other#45"])("normalizes compact repository references %s", (query) => {
    const other: WorkItem = {
      ...workItem,
      id: "repo/other#45",
      repo: "repo/other",
      target: "45",
      heartbeat: undefined,
      schedulingState: "ready_for_batch",
      github: {
        repo: "repo/other",
        target: "45",
        type: "issue",
        title: "Other repository issue",
        url: "https://github.com/repo/other/issues/45",
        state: "OPEN",
        labels: [],
        loadState: "loaded"
      }
    };
    const compactView = buildCoordinationView({
      ...model,
      targetRepos: ["repo/dashboard", "repo/other"],
      workItems: [...model.workItems, other]
    }, model.generatedAt);

    expect(buildFindResults(compactView, query)).toEqual([
      expect.objectContaining({
        kind: "job",
        repo: "repo/other",
        row: expect.objectContaining({ target: "45" })
      })
    ]);
  });
});
