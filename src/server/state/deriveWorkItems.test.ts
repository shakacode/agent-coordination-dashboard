import { describe, expect, it } from "vitest";
import type { WorkItem } from "../../shared/types";
import { ARCHIVE_AFTER_MS, deriveWorkItems } from "./deriveWorkItems";

const BASE_ITEM: WorkItem = {
  id: "shakacode/dashboard#43",
  repo: "shakacode/dashboard",
  target: "43",
  type: "issue",
  schedulingState: "in_process",
  selected: false,
  warnings: []
};

describe("deriveWorkItems", () => {
  it("derives merged pull requests as done and closed issues as closed", () => {
    const [merged, closed] = deriveWorkItems({
      now: new Date("2026-07-12T12:00:00Z"),
      workItems: [
        {
          ...BASE_ITEM,
          type: "pull_request",
          github: { repo: BASE_ITEM.repo, target: BASE_ITEM.target, type: "pull_request", title: "Merged", url: "https://github.com/repo/app/pull/43", state: "MERGED", mergedAt: "2026-07-12T11:00:00Z", labels: [], loadState: "loaded" }
        },
        {
          ...BASE_ITEM,
          id: "repo/app#44",
          target: "44",
          type: "issue",
          github: { repo: BASE_ITEM.repo, target: "44", type: "issue", title: "Closed", url: "https://github.com/repo/app/issues/44", state: "CLOSED", closedAt: "2026-07-12T10:00:00Z", labels: [], loadState: "loaded" }
        }
      ]
    });

    expect(merged).toMatchObject({ operatorState: "terminal", terminalState: "done", terminalProvenance: { source: "github", url: "https://github.com/repo/app/pull/43" }, completedAt: "2026-07-12T11:00:00Z", lastActivityAt: "2026-07-12T11:00:00Z" });
    expect(closed).toMatchObject({ operatorState: "terminal", terminalState: "closed", terminalProvenance: { source: "github", url: "https://github.com/repo/app/issues/44" }, completedAt: "2026-07-12T10:00:00Z", lastActivityAt: "2026-07-12T10:00:00Z" });
  });

  it("keeps declared terminal state ahead of conflicting GitHub fallback", () => {
    const [item] = deriveWorkItems({
      now: new Date("2026-07-12T12:00:00Z"),
      workItems: [{
        ...BASE_ITEM,
        claim: { schemaVersion: 1, agentId: "worker", repo: BASE_ITEM.repo, target: BASE_ITEM.target, status: "active", updatedAt: "2026-07-12T11:30:00Z", path: "claim.json" },
        batchSignals: [{ batchId: "declared", status: "closed", blockedOn: [], updatedAt: "2026-07-12T11:30:00Z" }],
        type: "pull_request",
        github: { repo: BASE_ITEM.repo, target: BASE_ITEM.target, type: "pull_request", title: "Merged", url: "https://github.com/repo/app/pull/43", state: "MERGED", mergedAt: "2026-07-12T11:00:00Z", labels: [], loadState: "loaded" }
      }]
    });

    expect(item).toMatchObject({ terminalState: "closed", terminalProvenance: { source: "declared" }, lastActivityAt: "2026-07-12T11:30:00Z" });
  });

  it("does not let older terminal telemetry override newer active work", () => {
    const [item] = deriveWorkItems({
      now: new Date("2026-07-12T11:35:00Z"),
      workItems: [{
        ...BASE_ITEM,
        heartbeat: {
          schemaVersion: 1,
          agentId: "worker",
          repo: BASE_ITEM.repo,
          target: BASE_ITEM.target,
          status: "in_progress",
          updatedAt: "2026-07-12T11:30:00Z",
          expiresAt: "2026-07-12T12:30:00Z",
          path: "heartbeat.json",
          liveness: "live"
        },
        batchSignals: [{
          batchId: "older-batch",
          laneName: "implementation",
          status: "done",
          blockedOn: [],
          updatedAt: "2026-07-12T10:00:00Z"
        }]
      }]
    });

    expect(item).toMatchObject({
      operatorState: "running",
      terminalState: undefined,
      terminalProvenance: undefined
    });
  });

  it("does not let older GitHub completion evidence override newer active telemetry", () => {
    const [item] = deriveWorkItems({
      now: new Date("2026-07-12T11:35:00Z"),
      workItems: [{
        ...BASE_ITEM,
        type: "pull_request",
        heartbeat: {
          schemaVersion: 1,
          agentId: "worker",
          repo: BASE_ITEM.repo,
          target: BASE_ITEM.target,
          status: "in_progress",
          updatedAt: "2026-07-12T11:30:00Z",
          expiresAt: "2026-07-12T12:30:00Z",
          path: "heartbeat.json",
          liveness: "live"
        },
        github: {
          repo: BASE_ITEM.repo,
          target: BASE_ITEM.target,
          type: "pull_request",
          title: "Merged",
          url: "https://github.com/shakacode/dashboard/pull/43",
          state: "MERGED",
          mergedAt: "2026-07-12T11:00:00Z",
          labels: [],
          loadState: "loaded"
        }
      }]
    });

    expect(item).toMatchObject({
      operatorState: "running",
      terminalState: undefined,
      completedAt: undefined
    });
  });

  it("does not let undated GitHub completion evidence override timestamped active telemetry", () => {
    const [item] = deriveWorkItems({
      now: new Date("2026-07-12T12:00:00Z"),
      workItems: [{
        ...BASE_ITEM,
        type: "pull_request",
        heartbeat: {
          schemaVersion: 1,
          agentId: "worker",
          repo: BASE_ITEM.repo,
          target: BASE_ITEM.target,
          status: "in_progress",
          updatedAt: "2026-07-12T11:55:00Z",
          expiresAt: "2026-07-12T12:30:00Z",
          path: "heartbeat.json",
          liveness: "live"
        },
        github: {
          repo: BASE_ITEM.repo,
          target: BASE_ITEM.target,
          type: "pull_request",
          title: "Merged without timestamp",
          url: "https://github.com/shakacode/dashboard/pull/43",
          state: "MERGED",
          labels: [],
          loadState: "loaded"
        }
      }]
    });

    expect(item).toMatchObject({
      operatorState: "running",
      terminalState: undefined,
      terminalProvenance: undefined,
      completedAt: undefined
    });
  });

  it.each([
    {
      name: "root issue closed after the latest coordination signal",
      now: "2026-07-14T12:00:00Z",
      closedAt: "2026-07-12T11:30:00Z",
      heartbeat: {
        schemaVersion: 1,
        agentId: "worker",
        repo: BASE_ITEM.repo,
        target: BASE_ITEM.target,
        status: "dead",
        updatedAt: "2026-07-12T11:00:00Z",
        expiresAt: "2026-07-12T11:05:00Z",
        path: "heartbeat.json",
        liveness: "dead" as const
      },
      operatorState: "needs_attention"
    },
    {
      name: "root issue closed before the latest coordination signal",
      now: "2026-07-12T12:00:00Z",
      closedAt: "2026-07-12T11:00:00Z",
      heartbeat: {
        schemaVersion: 1,
        agentId: "worker",
        repo: BASE_ITEM.repo,
        target: BASE_ITEM.target,
        status: "in_progress",
        updatedAt: "2026-07-12T11:55:00Z",
        expiresAt: "2026-07-12T12:30:00Z",
        path: "heartbeat.json",
        liveness: "live" as const
      },
      operatorState: "running"
    }
  ])("keeps an open implementation PR nonterminal when $name", ({ now, closedAt, heartbeat, operatorState }) => {
    const [item] = deriveWorkItems({
      now: new Date(now),
      workItems: [{
        ...BASE_ITEM,
        heartbeat,
        github: {
          repo: BASE_ITEM.repo,
          target: BASE_ITEM.target,
          type: "issue",
          title: "Closed root issue",
          url: "https://github.com/shakacode/dashboard/issues/43",
          state: "CLOSED",
          closedAt,
          labels: [],
          loadState: "loaded",
          implementationPr: {
            repo: BASE_ITEM.repo,
            target: "54",
            title: "Open implementation",
            url: "https://github.com/shakacode/dashboard/pull/54",
            state: "OPEN",
            labels: [],
            loadState: "loaded"
          }
        }
      }]
    });

    expect(item).toMatchObject({
      operatorState,
      terminalState: undefined,
      terminalProvenance: undefined,
      completedAt: undefined
    });
  });

  it("keeps an unknown implementation PR nonterminal and archive-ineligible", () => {
    const [item] = deriveWorkItems({
      now: new Date("2026-07-14T12:00:00Z"),
      workItems: [{
        ...BASE_ITEM,
        heartbeat: {
          schemaVersion: 1,
          agentId: "worker",
          repo: BASE_ITEM.repo,
          target: BASE_ITEM.target,
          status: "dead",
          updatedAt: "2026-07-12T11:00:00Z",
          expiresAt: "2026-07-12T11:05:00Z",
          path: "heartbeat.json",
          liveness: "dead"
        },
        github: {
          repo: BASE_ITEM.repo,
          target: BASE_ITEM.target,
          type: "issue",
          title: "Closed root issue",
          url: "https://github.com/shakacode/dashboard/issues/43",
          state: "CLOSED",
          closedAt: "2026-07-12T11:30:00Z",
          labels: [],
          loadState: "loaded",
          implementationPr: {
            repo: BASE_ITEM.repo,
            target: "54",
            title: "Unknown implementation",
            url: "https://github.com/shakacode/dashboard/pull/54",
            state: "UNKNOWN",
            labels: [],
            loadState: "unknown"
          }
        }
      }]
    });

    expect(item).toMatchObject({
      operatorState: "needs_attention",
      terminalState: undefined,
      terminalProvenance: undefined,
      completedAt: undefined
    });
  });

  it("does not guess terminal state when GitHub reconciliation is unknown", () => {
    const [item] = deriveWorkItems({
      now: new Date("2026-07-12T12:00:00Z"),
      workItems: [{ ...BASE_ITEM, github: { repo: BASE_ITEM.repo, target: BASE_ITEM.target, type: "unknown", title: "UNKNOWN", url: "", state: "UNKNOWN", labels: [], loadState: "unknown" } }]
    });
    expect(item.terminalState).toBeUndefined();
    expect(item.terminalProvenance).toBeUndefined();
  });

  it("uses a loaded merged implementation PR when the coordinated target is unavailable", () => {
    const [item] = deriveWorkItems({
      now: new Date("2026-07-12T12:00:00Z"),
      workItems: [{
        ...BASE_ITEM,
        github: {
          repo: BASE_ITEM.repo,
          target: BASE_ITEM.target,
          type: "unknown",
          title: "UNKNOWN",
          url: "",
          state: "UNKNOWN",
          labels: [],
          loadState: "unknown",
          implementationPr: {
            repo: BASE_ITEM.repo,
            target: "54",
            title: "Implement issue 43",
            url: "https://github.com/shakacode/dashboard/pull/54",
            state: "MERGED",
            mergedAt: "2026-07-12T11:00:00Z",
            labels: [],
            loadState: "loaded"
          }
        }
      }]
    });

    expect(item).toMatchObject({
      terminalState: "done",
      completedAt: "2026-07-12T11:00:00Z",
      terminalProvenance: { source: "github", url: "https://github.com/shakacode/dashboard/pull/54" }
    });
  });

  it("never infers terminal state from a deleted branch alone", () => {
    const [item] = deriveWorkItems({
      now: new Date("2026-07-12T12:00:00Z"),
      workItems: [{ ...BASE_ITEM, github: { repo: BASE_ITEM.repo, target: BASE_ITEM.target, type: "issue", title: "Open", url: "https://github.com/repo/app/issues/43", state: "OPEN", branchState: "deleted", labels: [], loadState: "loaded" } }]
    });
    expect(item).toMatchObject({ operatorState: "ready", github: { branchState: "deleted" } });
    expect(item.terminalState).toBeUndefined();
  });
  it("makes a wedged live lane an actionable attention item", () => {
    const [item] = deriveWorkItems({
      workItems: [
        {
          ...BASE_ITEM,
          heartbeat: {
            schemaVersion: 1,
            agentId: "acd-b-i43",
            repo: BASE_ITEM.repo,
            target: BASE_ITEM.target,
            status: "wedged",
            updatedAt: "2026-07-12T11:00:00.000Z",
            expiresAt: "2026-07-12T11:30:00.000Z",
            path: "heartbeats/acd-b-i43.json",
            liveness: "live"
          }
        }
      ],
      now: new Date("2026-07-12T11:20:00.000Z")
    });

    expect(item).toMatchObject({
      operatorState: "needs_attention",
      attention: { kind: "wedged", action: "Copy resume prompt" }
    });
  });

  it("keeps terminal work out of attention and retains the terminal subtype", () => {
    const [item] = deriveWorkItems({
      workItems: [
        {
          ...BASE_ITEM,
          heartbeat: {
            schemaVersion: 1,
            agentId: "acd-b-i43",
            repo: BASE_ITEM.repo,
            target: BASE_ITEM.target,
            status: "completed",
            updatedAt: "2026-07-12T11:00:00.000Z",
            expiresAt: "2026-07-12T11:30:00.000Z",
            path: "heartbeats/acd-b-i43.json",
            liveness: "dead"
          }
        }
      ],
      now: new Date("2026-07-12T11:20:00.000Z")
    });

    expect(item).toMatchObject({ operatorState: "terminal", terminalState: "done", attention: undefined });
  });

  it("does not treat claim release as successful completion", () => {
    const [item] = deriveWorkItems({
      workItems: [
        {
          ...BASE_ITEM,
          claim: {
            schemaVersion: 1,
            agentId: "acd-b-i43",
            repo: BASE_ITEM.repo,
            target: BASE_ITEM.target,
            status: "released",
            updatedAt: "2026-07-12T11:00:00.000Z",
            path: "claims/acd-b-i43.json"
          }
        }
      ],
      events: [{
        eventId: "release-1",
        type: "claim_released",
        repo: BASE_ITEM.repo,
        target: BASE_ITEM.target,
        status: "released",
        timestamp: "2026-07-12T11:00:00.000Z",
        path: "events/release-1.json"
      }],
      now: new Date("2026-07-12T11:20:00.000Z")
    });

    expect(item).toMatchObject({ operatorState: "ready", terminalState: undefined });
  });

  it("ages an old dead unfinished holder with no possible open PR into History without declaring it done", () => {
    const updatedAt = new Date(Date.parse("2026-07-12T11:20:00.000Z") - ARCHIVE_AFTER_MS - 1).toISOString();
    const [agedOut, possibleOpenPr] = deriveWorkItems({
      workItems: [
        {
          ...BASE_ITEM,
          heartbeat: {
            schemaVersion: 1,
            agentId: "acd-b-i43",
            repo: BASE_ITEM.repo,
            target: BASE_ITEM.target,
            status: "implementation",
            updatedAt,
            expiresAt: updatedAt,
            path: "heartbeats/acd-b-i43.json",
            liveness: "dead"
          }
        },
        {
          ...BASE_ITEM,
          id: "shakacode/dashboard#44",
          target: "44",
          heartbeat: {
            schemaVersion: 1,
            agentId: "acd-b-i44",
            repo: BASE_ITEM.repo,
            target: "44",
            status: "implementation",
            prUrl: "https://github.com/shakacode/dashboard/pull/44",
            updatedAt,
            expiresAt: updatedAt,
            path: "heartbeats/acd-b-i44.json",
            liveness: "dead"
          }
        }
      ],
      now: new Date("2026-07-12T11:20:00.000Z")
    });

    expect(agedOut).toMatchObject({ operatorState: "archived_view", terminalState: undefined, attention: undefined });
    expect(possibleOpenPr).toMatchObject({ operatorState: "needs_attention", attention: { kind: "dead_holder" } });
  });

  it("does not keep a dead holder active when its loaded implementation PR is closed", () => {
    const updatedAt = new Date(Date.parse("2026-07-12T11:20:00.000Z") - ARCHIVE_AFTER_MS - 1).toISOString();
    const [item] = deriveWorkItems({
      workItems: [{
        ...BASE_ITEM,
        heartbeat: {
          schemaVersion: 1,
          agentId: "acd-b-i43",
          repo: BASE_ITEM.repo,
          target: BASE_ITEM.target,
          status: "implementation",
          prUrl: "https://github.com/shakacode/dashboard/pull/54",
          updatedAt,
          expiresAt: updatedAt,
          path: "heartbeats/acd-b-i43.json",
          liveness: "dead"
        },
        github: {
          repo: BASE_ITEM.repo,
          target: BASE_ITEM.target,
          type: "unknown",
          title: "UNKNOWN",
          url: "",
          state: "UNKNOWN",
          labels: [],
          loadState: "unknown",
          implementationPr: {
            repo: BASE_ITEM.repo,
            target: "54",
            title: "Closed implementation",
            url: "https://github.com/shakacode/dashboard/pull/54",
            state: "CLOSED",
            closedAt: "2026-07-11T11:20:00.000Z",
            labels: [],
            loadState: "loaded"
          }
        }
      }],
      now: new Date("2026-07-12T11:20:00.000Z")
    });

    expect(item).toMatchObject({
      operatorState: "archived_view",
      terminalState: undefined,
      terminalProvenance: undefined,
      completedAt: undefined,
      attention: undefined
    });
  });

  it("turns stopped batches and missing PR QA into explicit attention reasons", () => {
    const items = deriveWorkItems({
      workItems: [
        { ...BASE_ITEM, batchSignals: [{ batchId: "batch-a", laneName: "build", status: "running", blockedOn: [] }] },
        {
          ...BASE_ITEM,
          id: "shakacode/dashboard#44",
          target: "44",
          type: "pull_request",
          github: { repo: BASE_ITEM.repo, target: "44", type: "pull_request", title: "PR", url: "https://github.com/shakacode/dashboard/pull/44", state: "OPEN", labels: [], loadState: "loaded" }
        }
      ],
      batchOperations: [
        {
          batchId: "batch-a",
          repo: BASE_ITEM.repo,
          controlStatus: "stopped",
          eventCount: 0,
          qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 }
        }
      ],
      qaValidations: [
        {
          id: "qa-44",
          repo: BASE_ITEM.repo,
          target: "44",
          type: "pull_request",
          status: "missing",
          detail: "No QA evidence"
        }
      ],
      now: new Date("2026-07-12T11:20:00.000Z")
    });

    expect(items.map((item) => item.attention)).toMatchObject([
      { kind: "batch_stopped", action: "Copy resume prompt" },
      { kind: "qa_missing", action: "Open PR" }
    ]);
  });

  it("scopes same-id batch operations by repository and distinguishes a pending stop request", () => {
    const [repoA, repoB] = deriveWorkItems({
      workItems: [
        { ...BASE_ITEM, repo: "repo/a", id: "repo/a#43", batchSignals: [{ batchId: "shared", laneName: "a", status: "running", blockedOn: [] }] },
        { ...BASE_ITEM, repo: "repo/b", id: "repo/b#43", batchSignals: [{ batchId: "shared", laneName: "b", status: "running", blockedOn: [] }] }
      ],
      batchOperations: [
        { batchId: "shared", repo: "repo/b", controlStatus: "stopped", eventCount: 1, qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 } },
        { batchId: "shared", repo: "repo/a", controlStatus: "stop_requested", eventCount: 1, qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 } }
      ],
      now: new Date("2026-07-12T11:20:00.000Z")
    });

    expect(repoA.attention).toMatchObject({ kind: "batch_stop_requested", label: "Batch stop is pending", action: "Open batch operations" });
    expect(repoB.attention).toMatchObject({ kind: "batch_stopped", label: "Batch is stopped", action: "Copy resume prompt" });
  });

  it("falls back to a resume action when missing QA has no resolvable pull request URL", () => {
    const [withoutUrl, withUrl] = deriveWorkItems({
      workItems: [
        { ...BASE_ITEM, type: "pull_request", id: "shakacode/dashboard#44", target: "44" },
        { ...BASE_ITEM, type: "pull_request", id: "shakacode/dashboard#45", target: "45", claim: { schemaVersion: 1, agentId: "worker", repo: BASE_ITEM.repo, target: "45", status: "active", prUrl: "https://github.com/shakacode/dashboard/pull/45", path: "claims/45.json" } }
      ],
      qaValidations: [
        { id: "qa-44", repo: BASE_ITEM.repo, target: "44", type: "pull_request", status: "missing", detail: "missing" },
        { id: "qa-45", repo: BASE_ITEM.repo, target: "45", type: "pull_request", status: "missing", detail: "missing" }
      ],
      now: new Date("2026-07-12T11:20:00.000Z")
    });

    expect(withoutUrl.attention?.action).toBe("Copy resume prompt");
    expect(withUrl.attention?.action).toBe("Open PR");
  });

  it("scopes repo-less operations through exact batch membership and avoids same-id cross-repo collisions", () => {
    const [repoA, repoB] = deriveWorkItems({
      workItems: [
        { ...BASE_ITEM, repo: "repo/a", id: "repo/a#43", batchSignals: [{ batchId: "shared", laneName: "a", status: "running", blockedOn: [] }] },
        { ...BASE_ITEM, repo: "repo/b", id: "repo/b#43", batchSignals: [{ batchId: "shared", laneName: "b", status: "running", blockedOn: [] }] }
      ],
      batches: [
        { schemaVersion: 1, batchId: "shared", targets: [{ type: "issue", target: "43", repo: "repo/a" }], lanes: [], path: "batches/a.json" },
        { schemaVersion: 1, batchId: "shared", targets: [{ type: "issue", target: "43", repo: "repo/b" }], lanes: [], path: "batches/b.json" }
      ],
      batchOperations: [
        { batchId: "shared", batchPath: "batches/a.json", controlStatus: "stopped", eventCount: 1, qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 } }
      ],
      now: new Date("2026-07-12T11:20:00.000Z")
    });
    expect(repoA.attention?.kind).toBe("batch_stopped");
    expect(repoB.attention).toBeUndefined();
  });

  it("applies an unscoped repo-less operation only when batch membership is unique", () => {
    const [onlyItem] = deriveWorkItems({
      workItems: [{ ...BASE_ITEM, batchSignals: [{ batchId: "unique", laneName: "lane", status: "running", blockedOn: [] }] }],
      batchOperations: [{ batchId: "unique", controlStatus: "stop_requested", eventCount: 1, qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 } }],
      now: new Date("2026-07-12T11:20:00.000Z")
    });
    expect(onlyItem.attention?.kind).toBe("batch_stop_requested");
  });

  it("uses corroborated lane membership for repo-less lane-only batch stops without leaking across repos", () => {
    const laneOnlyBatch = { schemaVersion: 1, batchId: "lane-only", lanes: [{ name: "lane", owner: "worker", targets: ["43"], dependsOn: [], status: "running", liveness: "dead" as const, blockedOn: [] }], path: "batches/lane-only.json" };
    const [only] = deriveWorkItems({
      workItems: [{ ...BASE_ITEM, repo: "repo/a", id: "repo/a#43", batchSignals: [{ batchId: "lane-only", laneName: "lane", status: "running", blockedOn: [] }] }],
      batches: [laneOnlyBatch],
      batchOperations: [{ batchId: "lane-only", batchPath: laneOnlyBatch.path, controlStatus: "stopped", eventCount: 1, qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 } }],
      now: new Date("2026-07-12T11:20:00.000Z")
    });
    expect(only.attention?.kind).toBe("batch_stopped");

    const collided = deriveWorkItems({
      workItems: [
        { ...BASE_ITEM, repo: "repo/a", id: "repo/a#43", batchSignals: [{ batchId: "lane-only", laneName: "lane", status: "running", blockedOn: [] }] },
        { ...BASE_ITEM, repo: "repo/b", id: "repo/b#43", batchSignals: [{ batchId: "lane-only", laneName: "lane", status: "running", blockedOn: [] }] }
      ],
      batches: [laneOnlyBatch],
      batchOperations: [{ batchId: "lane-only", batchPath: laneOnlyBatch.path, controlStatus: "stopped", eventCount: 1, qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 } }],
      now: new Date("2026-07-12T11:20:00.000Z")
    });
    expect(collided.every((item) => item.attention === undefined)).toBe(true);
  });
});
