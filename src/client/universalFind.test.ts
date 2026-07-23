import { describe, expect, it } from "vitest";
import type { DashboardModel, WorkItem } from "../shared/types";
import { buildCoordinationView } from "./coordinationView";
import { buildFindResults, exactFindResult, exactJobFindResult } from "./universalFind";

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
    expect(exactJobFindResult(results, "89")).toEqual(expect.objectContaining({
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
