import { describe, expect, it } from "vitest";
import type { BatchRecord, ClaimRecord, DashboardModel, HeartbeatRecord, WorkItem } from "../shared/types";
import { buildOperatorRows, filterOperatorRows } from "./operatorRows";

const claim: ClaimRecord = {
  schemaVersion: 1,
  repo: "repo/app",
  target: "123",
  agentId: "agent-a",
  machineId: "m5",
  threadHandle: "thread-a",
  host: "codex",
  operator: "justin",
  batchId: "batch-1",
  branch: "feature/operator-view",
  prUrl: "https://github.com/repo/app/pull/123",
  status: "active",
  updatedAt: "2026-07-09T19:55:00Z",
  path: "claims/repo/app/123.json"
};

const heartbeat: HeartbeatRecord = {
  schemaVersion: 1,
  agentId: "agent-a",
  machineId: "m5",
  threadHandle: "thread-a",
  host: "codex",
  operator: "justin",
  repo: "repo/app",
  target: "123",
  batchId: "batch-1",
  branch: "feature/operator-view",
  prUrl: "https://github.com/repo/app/pull/123",
  status: "coding",
  updatedAt: "2026-07-09T19:59:00Z",
  expiresAt: "2026-07-09T20:10:00Z",
  path: "heartbeats/agent-a.json",
  liveness: "live"
};

function workItem(partial: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "repo/app#123",
    repo: "repo/app",
    target: "123",
    type: "pull_request",
    schedulingState: "in_process",
    warnings: [],
    selected: false,
    github: {
      repo: "repo/app",
      target: "123",
      type: "pull_request",
      title: "Improve operator view",
      url: "https://github.com/repo/app/pull/123",
      state: "OPEN",
      labels: [],
      loadState: "loaded"
    },
    ...partial
  };
}

function dashboard(partial: Partial<DashboardModel> = {}): DashboardModel {
  return {
    generatedAt: "2026-07-09T20:00:00Z",
    stateRoot: "/state",
    targetRepos: ["repo/app", "repo/api"],
    agents: [],
    workItems: [],
    batches: [],
    events: [],
    batchOperations: [],
    qaValidations: [],
    healthItems: [],
    warnings: [],
    ...partial
  };
}

describe("operatorRows", () => {
  it("builds target-first rows with owner, thread, batch, branch, and PR metadata", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [workItem({ claim, heartbeat })],
        events: [
          {
            eventId: "event-a",
            type: "phase",
            batchId: "batch-1",
            laneName: "lane-a",
            agentId: "agent-a",
            repo: "repo/app",
            target: "123",
            status: "coding",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/batch-1.jsonl:1"
          }
        ]
      })
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "target:repo/app#123",
      source: "target",
      repo: "repo/app",
      target: "123",
      title: "Improve operator view",
      operatorState: "running",
      liveness: "live",
      agentId: "agent-a",
      machineId: "m5",
      threadHandle: "thread-a",
      host: "codex",
      operator: "justin",
      batchId: "batch-1",
      branch: "feature/operator-view",
      prUrl: "https://github.com/repo/app/pull/123"
    });
    expect(rows[0].warnings).toEqual([]);
  });

  it("marks live work as wedged when phase telemetry has not changed for 15 minutes", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [workItem({ claim, heartbeat })],
        events: [
          {
            eventId: "event-old",
            type: "phase",
            batchId: "batch-1",
            laneName: "lane-a",
            agentId: "agent-a",
            repo: "repo/app",
            target: "123",
            status: "coding",
            timestamp: "2026-07-09T19:40:00Z",
            path: "events/batch-1.jsonl:1"
          }
        ]
      })
    );

    expect(rows[0].operatorState).toBe("wedged");
    expect(rows[0].lastEventAt).toBe("2026-07-09T19:40:00Z");
  });

  it("classifies paused and blocked work before generic running or dead states", () => {
    const paused = workItem({
      id: "repo/app#123",
      target: "123",
      claim,
      heartbeat: { ...heartbeat, status: "token_limit_pause" }
    });
    const blocked = workItem({
      id: "repo/app#124",
      target: "124",
      schedulingState: "started_not_processing",
      batchSignals: [{ batchId: "batch-1", laneName: "blocked-lane", status: "blocked", blockedOn: ["repo/app#123"] }],
      github: {
        repo: "repo/app",
        target: "124",
        type: "pull_request",
        title: "Blocked PR",
        url: "https://github.com/repo/app/pull/124",
        state: "OPEN",
        labels: [],
        loadState: "loaded"
      }
    });

    const rows = buildOperatorRows(dashboard({ workItems: [paused, blocked] }));

    expect(rows.find((row) => row.target === "123")?.operatorState).toBe("paused");
    expect(rows.find((row) => row.target === "124")?.operatorState).toBe("blocked");
    expect(rows.find((row) => row.target === "124")?.blockedOn).toEqual(["repo/app#123"]);
  });

  it("preserves queued target rows as ready before workers start", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: undefined,
            heartbeat: undefined,
            schedulingState: "started_not_processing",
            batchSignals: [{ batchId: "batch-1", laneName: "queued-lane", status: "queued", blockedOn: [] }]
          })
        ],
        batches: [
          {
            schemaVersion: 1,
            batchId: "batch-1",
            repo: "repo/app",
            path: "batches/batch-1.json",
            lanes: [
              {
                name: "queued-lane",
                owner: "agent-a",
                targets: ["123"],
                dependsOn: [],
                status: "queued",
                liveness: "no-heartbeat",
                blockedOn: []
              }
            ]
          }
        ]
      })
    );

    expect(rows[0].operatorState).toBe("ready");
  });

  it("does not classify rows from target-specific events for other targets in the same lane", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim,
            heartbeat,
            batchSignals: [{ batchId: "batch-1", laneName: "shared-lane", status: "coding", blockedOn: [] }]
          }),
          workItem({
            id: "repo/app#124",
            target: "124",
            schedulingState: "started_not_processing",
            batchSignals: [{ batchId: "batch-1", laneName: "shared-lane", status: "coding", blockedOn: [] }],
            github: {
              repo: "repo/app",
              target: "124",
              type: "pull_request",
              title: "Second PR",
              url: "https://github.com/repo/app/pull/124",
              state: "OPEN",
              labels: [],
              loadState: "loaded"
            }
          })
        ],
        events: [
          {
            eventId: "event-124-done",
            type: "done",
            batchId: "batch-1",
            laneName: "shared-lane",
            agentId: "agent-a",
            repo: "repo/app",
            target: "124",
            status: "done",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/batch-1.jsonl:1"
          }
        ]
      })
    );

    expect(rows.find((row) => row.target === "123")?.operatorState).toBe("running");
    expect(rows.find((row) => row.target === "124")?.operatorState).toBe("done");
  });

  it("keeps freeform event messages out of operator-state classification", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [workItem({ claim, heartbeat })],
        events: [
          {
            eventId: "event-message",
            type: "phase",
            batchId: "batch-1",
            laneName: "lane-a",
            agentId: "agent-a",
            repo: "repo/app",
            target: "123",
            status: "coding",
            message: "Passed lint and not blocked anymore; tests are still running.",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/batch-1.jsonl:1"
          }
        ]
      })
    );

    expect(rows[0].operatorState).toBe("running");
    expect(rows[0].activityMessage).toContain("Passed lint");
  });

  it("adds fallback rows for batch lanes without loaded target rows", () => {
    const batch: BatchRecord = {
      schemaVersion: 1,
      batchId: "batch-standalone",
      repo: "repo/app",
      objective: "Standalone lane",
      path: "batches/batch-standalone.json",
      lanes: [
        {
          name: "docs",
          owner: "agent-docs",
          targets: [],
          dependsOn: ["batch-standalone:tests"],
          status: "queued",
          liveness: "no-heartbeat",
          blockedOn: [],
          threadHandle: "thread-docs",
          host: "claude",
          operator: "maintainer",
          branch: "docs/batch"
        }
      ]
    };

    const rows = buildOperatorRows(dashboard({ batches: [batch] }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "lane:batch-standalone:docs",
      source: "lane",
      repo: "repo/app",
      operatorState: "ready",
      batchId: "batch-standalone",
      laneName: "docs",
      dependencies: ["batch-standalone:tests"],
      threadHandle: "thread-docs",
      host: "claude",
      operator: "maintainer",
      branch: "docs/batch"
    });
  });

  it("searches exact target collisions and partial branch, thread, operator, host, and URL metadata", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({ claim, heartbeat }),
          workItem({
            id: "repo/api#123",
            repo: "repo/api",
            target: "123",
            type: "issue",
            schedulingState: "ready_for_batch",
            github: {
              repo: "repo/api",
              target: "123",
              type: "issue",
              title: "API follow-up",
              url: "https://github.com/repo/api/issues/123",
              state: "OPEN",
              labels: [],
              loadState: "loaded"
            }
          })
        ]
      })
    );

    expect(filterOperatorRows(rows, "PR #123").map((row) => row.repo)).toEqual(["repo/app", "repo/api"]);
    expect(filterOperatorRows(rows, "feature/operator").map((row) => row.repo)).toEqual(["repo/app"]);
    expect(filterOperatorRows(rows, "thread-a").map((row) => row.repo)).toEqual(["repo/app"]);
    expect(filterOperatorRows(rows, "justin").map((row) => row.repo)).toEqual(["repo/app"]);
    expect(filterOperatorRows(rows, "codex").map((row) => row.repo)).toEqual(["repo/app"]);
    expect(filterOperatorRows(rows, "github.com/repo/app/pull/123").map((row) => row.repo)).toEqual(["repo/app"]);
  });
});
