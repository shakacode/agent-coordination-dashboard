import { describe, expect, it } from "vitest";
import type { BatchRecord, ClaimRecord, DashboardModel, HeartbeatRecord, WorkItem } from "../shared/types";
import {
  buildOperatorRows,
  filterOperatorRows,
  filterOperatorRowsForOverview,
  operatorDeepLinkFromSearchParams
} from "./operatorRows";

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
      batchSignals: [{ batchId: "batch-1", laneName: "blocked-lane", status: "coding", blockedOn: ["repo/app#done"] }],
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
    expect(rows.find((row) => row.target === "124")?.blockedOn).toEqual(["repo/app#done"]);
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
        events: [
          {
            eventId: "old-lane-done",
            type: "done",
            batchId: "batch-old",
            laneName: "docs",
            repo: "repo/app",
            status: "done",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/batch-old.jsonl:1"
          }
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

  it("treats released claims as done instead of dead", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: { ...claim, status: "released" },
            heartbeat: undefined,
            schedulingState: "ready_for_batch"
          })
        ]
      })
    );

    expect(rows[0].operatorState).toBe("done");
  });

  it("ignores retained batch events when live work has no active batch id", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: { ...claim, batchId: undefined },
            heartbeat: { ...heartbeat, batchId: undefined },
            batchSignals: [{ batchId: "batch-old", laneName: "docs", status: "done", blockedOn: [] }]
          })
        ],
        events: [
          {
            eventId: "old-done",
            type: "done",
            batchId: "batch-old",
            laneName: "docs",
            repo: "repo/app",
            target: "123",
            status: "done",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/batch-old.jsonl:1"
          }
        ]
      })
    );

    expect(rows[0].operatorState).toBe("running");
    expect(rows[0].lastEventAt).toBeUndefined();
  });

  it("does not treat dead heartbeat batch ids as current event scope", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: { ...claim, batchId: undefined },
            heartbeat: { ...heartbeat, batchId: "batch-old", liveness: "dead" },
            batchSignals: [{ batchId: "batch-old", laneName: "docs", status: "done", blockedOn: [] }]
          })
        ],
        events: [
          {
            eventId: "old-done",
            type: "done",
            batchId: "batch-old",
            laneName: "docs",
            repo: "repo/app",
            target: "123",
            status: "done",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/batch-old.jsonl:1"
          }
        ]
      })
    );

    expect(rows[0].operatorState).toBe("dead");
    expect(rows[0].lastEventAt).toBeUndefined();
  });

  it("prefers the active claim batch over a mismatched live heartbeat batch", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: { ...claim, batchId: "batch-current" },
            heartbeat: { ...heartbeat, batchId: "batch-old" },
            batchSignals: [
              { batchId: "batch-old", laneName: "docs", status: "done", blockedOn: [] },
              { batchId: "batch-current", laneName: "docs", status: "coding", blockedOn: [] }
            ]
          })
        ],
        events: [
          {
            eventId: "old-done",
            type: "done",
            batchId: "batch-old",
            laneName: "docs",
            repo: "repo/app",
            target: "123",
            status: "done",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/batch-old.jsonl:1"
          }
        ]
      })
    );

    expect(rows[0].operatorState).toBe("running");
    expect(rows[0].batchId).toBe("batch-current");
    expect(rows[0].lastEventAt).toBeUndefined();
  });

  it("prefers queued retained signals over older terminal signals before workers start", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: undefined,
            heartbeat: undefined,
            schedulingState: "started_not_processing",
            batchSignals: [
              { batchId: "batch-old", laneName: "docs", status: "done", blockedOn: [] },
              { batchId: "batch-current", laneName: "docs", status: "queued", blockedOn: [] }
            ]
          })
        ],
        batches: [
          {
            schemaVersion: 1,
            batchId: "batch-old",
            repo: "repo/app",
            path: "batches/batch-old.json",
            lanes: [
              {
                name: "docs",
                owner: "agent-old",
                targets: ["123"],
                dependsOn: [],
                status: "done",
                liveness: "no-heartbeat",
                blockedOn: []
              }
            ]
          },
          {
            schemaVersion: 1,
            batchId: "batch-current",
            repo: "repo/app",
            path: "batches/batch-current.json",
            lanes: [
              {
                name: "docs",
                owner: "agent-current",
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
    expect(rows[0].batchId).toBe("batch-current");
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

  it("ignores target events from older batches when a target is reused", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: { ...claim, batchId: "batch-2" },
            heartbeat: { ...heartbeat, batchId: "batch-2" },
            batchSignals: [{ batchId: "batch-2", laneName: "current-lane", status: "coding", blockedOn: [] }]
          })
        ],
        events: [
          {
            eventId: "old-batch-done",
            type: "done",
            batchId: "batch-1",
            laneName: "old-lane",
            agentId: "agent-a",
            repo: "repo/app",
            target: "123",
            status: "done",
            timestamp: "2026-07-09T19:58:00Z",
            path: "events/batch-1.jsonl:1"
          }
        ]
      })
    );

    expect(rows[0]).toMatchObject({
      operatorState: "running",
      activityStatus: "coding"
    });
    expect(rows[0].lastEventAt).toBeUndefined();
  });

  it("ignores batch-scoped target events when work has no current batch context", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: undefined,
            heartbeat: undefined,
            batchSignals: undefined,
            schedulingState: "ready_for_batch"
          })
        ],
        events: [
          {
            eventId: "prior-batch-done",
            type: "done",
            batchId: "batch-old",
            laneName: "old-lane",
            repo: "repo/app",
            target: "123",
            status: "done",
            timestamp: "2026-07-09T19:58:00Z",
            path: "events/batch-old.jsonl:1"
          }
        ]
      })
    );

    expect(rows[0]).toMatchObject({
      operatorState: "ready",
      activityStatus: "ready_for_batch"
    });
    expect(rows[0].lastEventAt).toBeUndefined();
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

  it("does not pause rows for statuses that only prefix-match pause tokens", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [workItem({ claim, heartbeat: { ...heartbeat, status: "context_limitation_review" } })]
      })
    );

    expect(rows[0].operatorState).toBe("running");
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
      id: "lane:repo/app:batch-standalone:docs",
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

  it("uses lane liveness for fallback lane rows", () => {
    const rows = buildOperatorRows(
      dashboard({
        batches: [
          {
            schemaVersion: 1,
            batchId: "batch-live-lane",
            repo: "repo/app",
            path: "batches/batch-live-lane.json",
            lanes: [
              {
                name: "ops",
                owner: "agent-ops",
                targets: [],
                dependsOn: [],
                status: "coding",
                liveness: "live",
                blockedOn: [],
                threadHandle: "thread-ops",
                host: "codex",
                operator: "justin"
              }
            ]
          }
        ]
      })
    );

    expect(rows[0]).toMatchObject({
      id: "lane:repo/app:batch-live-lane:ops",
      operatorState: "running",
      liveness: "live"
    });
  });

  it("keeps fallback lane ids distinct across repos with reused batch ids", () => {
    const rows = buildOperatorRows(
      dashboard({
        batches: ["repo/app", "repo/api"].map((repo) => ({
          schemaVersion: 1,
          batchId: "batch-reused",
          repo,
          path: `batches/${repo.replace("/", "__")}/batch-reused.json`,
          lanes: [
            {
              name: "docs",
              owner: "agent-docs",
              targets: [],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }))
      })
    );

    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it("scopes fallback lane events by repo when batch ids and lane names are reused", () => {
    const rows = buildOperatorRows(
      dashboard({
        batches: ["repo/app", "repo/api"].map((repo) => ({
          schemaVersion: 1,
          batchId: "batch-reused",
          repo,
          path: `batches/${repo.replace("/", "__")}/batch-reused.json`,
          lanes: [
            {
              name: "docs",
              owner: `agent-${repo.endsWith("app") ? "app" : "api"}`,
              targets: [],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        })),
        events: [
          {
            eventId: "app-done",
            type: "done",
            batchId: "batch-reused",
            batchPath: "batches/repo__app/batch-reused.json",
            laneName: "docs",
            repo: "repo/app",
            status: "done",
            timestamp: "2026-07-09T19:58:00Z",
            path: "events/batch-reused.jsonl:1"
          }
        ]
      })
    );

    expect(rows.find((row) => row.repo === "repo/app")?.operatorState).toBe("done");
    expect(rows.find((row) => row.repo === "repo/api")?.operatorState).toBe("ready");
  });

  it("prefers the active claim and heartbeat batch signal over older retained signals", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: { ...claim, batchId: "batch-current", threadHandle: undefined },
            heartbeat: { ...heartbeat, batchId: "batch-current", threadHandle: undefined },
            batchSignals: [
              { batchId: "batch-old", laneName: "docs", status: "done", blockedOn: [] },
              { batchId: "batch-current", laneName: "docs", status: "coding", blockedOn: [] }
            ]
          })
        ],
        events: [
          {
            eventId: "old-lane-done",
            type: "done",
            batchId: "batch-old",
            laneName: "docs",
            repo: "repo/app",
            status: "done",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/batch-old.jsonl:1"
          }
        ],
        batches: [
          {
            schemaVersion: 1,
            batchId: "batch-old",
            repo: "repo/app",
            path: "batches/batch-old.json",
            lanes: [
              {
                name: "docs",
                owner: "agent-old",
                targets: ["123"],
                dependsOn: [],
                status: "done",
                liveness: "no-heartbeat",
                blockedOn: [],
                threadHandle: "thread-old"
              }
            ]
          },
          {
            schemaVersion: 1,
            batchId: "batch-current",
            repo: "repo/app",
            path: "batches/batch-current.json",
            lanes: [
              {
                name: "docs",
                owner: "agent-current",
                targets: ["123"],
                dependsOn: [],
                status: "coding",
                liveness: "live",
                blockedOn: [],
                threadHandle: "thread-current"
              }
            ]
          }
        ]
      })
    );

    expect(rows[0]).toMatchObject({
      operatorState: "running",
      batchId: "batch-current",
      laneName: "docs",
      threadHandle: "thread-current"
    });
  });

  it("keeps wedged state when only QA telemetry is fresh", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [workItem({ claim, heartbeat })],
        events: [
          {
            eventId: "phase-old",
            type: "phase",
            batchId: "batch-1",
            laneName: "lane-a",
            agentId: "agent-a",
            repo: "repo/app",
            target: "123",
            status: "coding",
            timestamp: "2026-07-09T19:40:00Z",
            path: "events/batch-1.jsonl:1"
          },
          {
            eventId: "qa-fresh",
            type: "qa.validation_requested",
            batchId: "batch-1",
            laneName: "qa",
            repo: "repo/app",
            target: "123",
            status: "requested",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/batch-1.jsonl:2"
          }
        ]
      })
    );

    expect(rows[0].operatorState).toBe("wedged");
    expect(rows[0].activityStatus).toBe("requested");
    expect(rows[0].lastEventAt).toBe("2026-07-09T19:59:30Z");
  });

  it("does not let QA validation events complete live operator work", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [workItem({ claim, heartbeat })],
        events: [
          {
            eventId: "qa-passed",
            type: "qa.validation_passed",
            batchId: "batch-1",
            laneName: "qa",
            repo: "repo/app",
            target: "123",
            status: "passed",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/batch-1.jsonl:1"
          }
        ]
      })
    );

    expect(rows[0].operatorState).toBe("running");
  });

  it("restricts targetless lane events to the work item repo", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim,
            heartbeat,
            batchSignals: [{ batchId: "batch-shared", laneName: "shared", status: "coding", blockedOn: [] }]
          })
        ],
        events: [
          {
            eventId: "other-repo-done",
            type: "done",
            batchId: "batch-shared",
            laneName: "shared",
            repo: "repo/api",
            status: "done",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/batch-shared.jsonl:1"
          }
        ]
      })
    );

    expect(rows[0].operatorState).toBe("running");
  });

  it("chooses signal lanes from the work item's repo when batch ids are reused", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            id: "repo/api#123",
            repo: "repo/api",
            target: "123",
            schedulingState: "started_not_processing",
            batchSignals: [{ batchId: "batch-reused", laneName: "shared", status: "queued", blockedOn: [] }],
            github: {
              repo: "repo/api",
              target: "123",
              type: "issue",
              title: "API issue",
              url: "https://github.com/repo/api/issues/123",
              state: "OPEN",
              labels: [],
              loadState: "loaded"
            }
          })
        ],
        batches: [
          {
            schemaVersion: 1,
            batchId: "batch-reused",
            repo: "repo/app",
            targets: [{ type: "issue", target: "123", repo: "repo/app" }],
            path: "batches/repo-app.json",
            lanes: [
              {
                name: "shared",
                owner: "agent-app",
                targets: ["123"],
                dependsOn: [],
                status: "blocked",
                liveness: "no-heartbeat",
                blockedOn: ["repo/app#122"],
                threadHandle: "thread-app"
              }
            ]
          },
          {
            schemaVersion: 1,
            batchId: "batch-reused",
            repo: "repo/api",
            targets: [{ type: "issue", target: "123", repo: "repo/api" }],
            path: "batches/repo-api.json",
            lanes: [
              {
                name: "shared",
                owner: "agent-api",
                targets: ["123"],
                dependsOn: [],
                status: "queued",
                liveness: "no-heartbeat",
                blockedOn: [],
                threadHandle: "thread-api"
              }
            ]
          }
        ]
      })
    );

    const apiRow = rows.find((row) => row.repo === "repo/api" && row.target === "123");
    expect(apiRow).toMatchObject({
      operatorState: "ready",
      threadHandle: "thread-api",
      blockedOn: []
    });
  });

  it("does not require PR URLs for active issue rows", () => {
    const issueHeartbeat = {
      ...heartbeat,
      prUrl: undefined
    };
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            type: "issue",
            claim: { ...claim, prUrl: undefined },
            heartbeat: issueHeartbeat,
            github: {
              repo: "repo/app",
              target: "123",
              type: "issue",
              title: "Active issue",
              url: "https://github.com/repo/app/issues/123",
              state: "OPEN",
              labels: [],
              loadState: "loaded"
            }
          })
        ]
      })
    );

    expect(rows[0].operatorState).toBe("running");
    expect(rows[0].warnings).not.toContain("PR URL UNKNOWN");
  });

  it("falls back to manifest target metadata when GitHub previews are unavailable", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            type: "unknown",
            github: undefined,
            schedulingState: "started_not_processing",
            batchSignals: [{ batchId: "batch-1", laneName: "docs", status: "queued", blockedOn: [] }]
          })
        ],
        batches: [
          {
            schemaVersion: 1,
            batchId: "batch-1",
            repo: "repo/app",
            targets: [
              {
                type: "pull_request",
                target: "123",
                title: "Manifest title",
                url: "https://github.com/repo/app/pull/123"
              }
            ],
            path: "batches/batch-1.json",
            lanes: [
              {
                name: "docs",
                owner: "agent-docs",
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

    expect(rows[0]).toMatchObject({
      type: "pull_request",
      title: "Manifest title",
      url: "https://github.com/repo/app/pull/123"
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

  it("maps every overview filter to rows from explicit dashboard state", () => {
    const model = dashboard({
      workItems: [
        workItem({ claim, heartbeat }),
        workItem({ id: "repo/app#124", target: "124", schedulingState: "ready_for_batch", claim: undefined, heartbeat: undefined }),
        workItem({ id: "repo/app#125", target: "125", schedulingState: "started_not_processing", claim: undefined, heartbeat: undefined })
      ],
      qaValidations: [
        {
          id: "repo/app#125",
          repo: "repo/app",
          target: "125",
          type: "pull_request",
          status: "missing",
          detail: "Separate QA evidence is missing."
        }
      ],
      batchOperations: [
        {
          batchId: "batch-1",
          repo: "repo/app",
          controlStatus: "stopped",
          eventCount: 1,
          stopRequestedAt: "2026-07-09T19:50:00Z",
          stoppedAt: "2026-07-09T19:51:00Z",
          qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 }
        }
      ]
    });
    const rows = buildOperatorRows(model);

    expect(filterOperatorRowsForOverview(rows, model, "processing_now").map((row) => row.target)).toEqual(["123"]);
    expect(filterOperatorRowsForOverview(rows, model, "ready_for_batch").map((row) => row.target)).toEqual(["124"]);
    expect(filterOperatorRowsForOverview(rows, model, "needs_recovery").map((row) => row.target)).toEqual(["125"]);
    expect(filterOperatorRowsForOverview(rows, model, "qa_attention").map((row) => row.target)).toEqual(["125"]);
    expect(filterOperatorRowsForOverview(rows, model, "batch_repair").map((row) => row.target)).toEqual(["123"]);
  });

  it("scopes batch-repair filters when different repos reuse a batch id", () => {
    const appClaim = { ...claim, batchId: "shared-batch" };
    const appHeartbeat = { ...heartbeat, batchId: "shared-batch" };
    const apiClaim = { ...claim, repo: "repo/api", agentId: "agent-api", batchId: "shared-batch" };
    const apiHeartbeat = { ...heartbeat, repo: "repo/api", agentId: "agent-api", batchId: "shared-batch" };
    const model = dashboard({
      workItems: [
        workItem({ claim: appClaim, heartbeat: appHeartbeat }),
        workItem({ id: "repo/api#123", repo: "repo/api", claim: apiClaim, heartbeat: apiHeartbeat })
      ],
      batchOperations: [
        {
          batchId: "shared-batch",
          repo: "repo/app",
          controlStatus: "stopped",
          eventCount: 1,
          qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 }
        }
      ]
    });

    expect(filterOperatorRowsForOverview(buildOperatorRows(model), model, "batch_repair").map((row) => row.repo)).toEqual([
      "repo/app"
    ]);
  });

  it("returns one repair row when inferred and stopped signals overlap", () => {
    const model = dashboard({
      workItems: [
        workItem({
          claim,
          heartbeat,
          batchSignals: [{ batchId: "batch-1", laneName: "implementation", status: "coding", blockedOn: [] }]
        })
      ],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "repo/app",
          source: "inferred",
          path: "batches/repo-app/batch-1.json",
          lanes: [
            {
              name: "implementation",
              owner: "agent-a",
              targets: ["123"],
              dependsOn: [],
              blockedOn: [],
              status: "coding",
              liveness: "live"
            }
          ]
        }
      ],
      batchOperations: [
        {
          batchId: "batch-1",
          repo: "repo/app",
          batchPath: "batches/repo-app/batch-1.json",
          controlStatus: "stopped",
          eventCount: 1,
          qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 }
        }
      ]
    });

    const repairRows = filterOperatorRowsForOverview(buildOperatorRows(model), model, "batch_repair");
    expect(repairRows).toHaveLength(1);
    expect(repairRows[0]).toMatchObject({ repo: "repo/app", batchId: "batch-1", batchPath: "batches/repo-app/batch-1.json" });
  });

  it("maps prompt-missing and stopped batch lane targets before coordination signals attach batch identity", () => {
    const model = dashboard({
      workItems: [
        workItem({ claim: undefined, heartbeat: undefined, schedulingState: "ready_for_batch" }),
        workItem({ id: "repo/app#124", target: "124", claim: undefined, heartbeat: undefined, schedulingState: "ready_for_batch" })
      ],
      batches: [
        {
          schemaVersion: 1,
          batchId: "prompt-missing",
          repo: "repo/app",
          path: "batches/prompt-missing.json",
          lanes: [
            {
              name: "docs",
              owner: "agent-docs",
              targets: ["123"],
              dependsOn: [],
              blockedOn: [],
              status: "queued",
              liveness: "no-heartbeat"
            }
          ]
        },
        {
          schemaVersion: 1,
          batchId: "stopped-batch",
          repo: "repo/app",
          path: "batches/stopped.json",
          launchPrompt: "Use $pr-batch",
          lanes: [
            {
              name: "code",
              owner: "agent-code",
              targets: ["124"],
              dependsOn: [],
              blockedOn: [],
              status: "queued",
              liveness: "no-heartbeat"
            }
          ]
        }
      ],
      batchOperations: [
        {
          batchId: "stopped-batch",
          repo: "repo/app",
          batchPath: "batches/stopped.json",
          controlStatus: "stopped",
          eventCount: 1,
          qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 }
        }
      ]
    });

    expect(
      filterOperatorRowsForOverview(buildOperatorRows(model), model, "batch_repair").map((row) => ({
        target: row.target,
        batchId: row.batchId,
        laneName: row.laneName
      }))
    ).toEqual([
      { target: "123", batchId: "prompt-missing", laneName: "docs" },
      { target: "124", batchId: "stopped-batch", laneName: "code" }
    ]);
  });

  it("creates one read-only presentation row for a rowless repair batch with overlapping evidence", () => {
    const model = dashboard({
      batches: [
        {
          schemaVersion: 1,
          batchId: "rowless-batch",
          repo: "repo/app",
          objective: "Repair retained batch metadata",
          path: "batches/rowless.json",
          lanes: []
        }
      ],
      batchOperations: [
        {
          batchId: "rowless-batch",
          repo: "repo/app",
          batchPath: "batches/rowless.json",
          controlStatus: "stopped",
          eventCount: 1,
          qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 }
        }
      ]
    });

    expect(filterOperatorRowsForOverview(buildOperatorRows(model), model, "batch_repair")).toEqual([
      expect.objectContaining({
        source: "batch",
        batchId: "rowless-batch",
        repo: "repo/app",
        title: "Repair retained batch metadata",
        activityStatus: "stopped"
      })
    ]);
  });

  it("parses only supported overview filters from shareable search params", () => {
    const supported = ["ready_for_batch", "needs_recovery", "processing_now", "qa_attention", "batch_repair"];
    for (const value of supported) {
      expect(operatorDeepLinkFromSearchParams(new URLSearchParams(`operatorFilter=${value}`)).overviewFilter).toBe(value);
    }

    expect(operatorDeepLinkFromSearchParams(new URLSearchParams("operatorFilter=needs_recovery&q=owner"))).toMatchObject({
      overviewFilter: "needs_recovery",
      query: "owner"
    });

    for (const hostile of ["__proto__", "constructor", "toString", "hasOwnProperty", "made_up"]) {
      expect(operatorDeepLinkFromSearchParams(new URLSearchParams(`operatorFilter=${hostile}`)).overviewFilter).toBeUndefined();
    }
  });
});
