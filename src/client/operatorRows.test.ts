import { describe, expect, it } from "vitest";
import type { BatchRecord, ClaimRecord, DashboardModel, HeartbeatRecord, WorkItem } from "../shared/types";
import {
  buildOperatorRows,
  filterOperatorRows,
  filterOperatorRowsByProvenance,
  filterOperatorRowsForOverview,
  operatorDeepLinkFromSearchParams,
  safeGithubUrl
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
  it("classifies observed, inferred, synthetic, and unknown rows with source evidence", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({ provenance: { classification: "observed", evidence: ["github"] } } as Partial<WorkItem>),
          workItem({
            id: "repo/app#124",
            target: "124",
            github: undefined,
            provenance: { classification: "inferred", evidence: ["manifest"] }
          } as Partial<WorkItem>),
          workItem({
            id: "repo/app#125",
            target: "125",
            github: undefined,
            provenance: { classification: "unknown", evidence: [] }
          } as Partial<WorkItem>)
        ],
        batches: [
          {
            schemaVersion: 1,
            batchId: "synthetic-batch",
            repo: "repo/app",
            source: "inferred",
            path: "inferred-batches/repo__app/synthetic-batch.json",
            lanes: [
              {
                name: "standalone",
                owner: "agent-synthetic",
                targets: [],
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

    expect(Object.fromEntries(rows.map((row) => [row.target || "standalone", row.provenance]))).toEqual({
      "123": { classification: "observed", evidence: ["github"] },
      "124": { classification: "inferred", evidence: ["manifest"] },
      "125": { classification: "unknown", evidence: [] },
      standalone: { classification: "inferred", evidence: ["inferred_batch"] }
    });
  });

  it("filters inferred and synthetic rows by default while preserving unknown rows", () => {
    const rows = [
      { provenance: { classification: "observed", evidence: ["claim"] } },
      { provenance: { classification: "inferred", evidence: ["manifest"] } },
      { provenance: { classification: "synthetic", evidence: ["inferred_batch"] } },
      { provenance: { classification: "unknown", evidence: [] } }
    ] as any;

    expect(filterOperatorRowsByProvenance(rows, false).map((row) => row.provenance.classification)).toEqual([
      "observed",
      "unknown"
    ]);
    expect(filterOperatorRowsByProvenance(rows, true)).toEqual(rows);
  });

  it("deduplicates a matching fallback by repo and target without hiding a same-number target in another repo", () => {
    const observed = workItem({ provenance: { classification: "observed", evidence: ["github"] } } as Partial<WorkItem>);
    const rows = buildOperatorRows(
      dashboard({
        workItems: [observed],
        batches: [
          {
            schemaVersion: 1,
            batchId: "app-collision",
            repo: "repo/app",
            source: "manifest",
            path: "batches/app-collision.json",
            targets: [{ type: "pull_request", target: "123", repo: "repo/app" }],
            lanes: [
              {
                name: "app",
                owner: "agent-app",
                targets: ["123"],
                dependsOn: [],
                status: "queued",
                liveness: "no-heartbeat",
                blockedOn: []
              }
            ]
          },
          {
            schemaVersion: 1,
            batchId: "api-collision",
            repo: "repo/api",
            source: "manifest",
            path: "batches/api-collision.json",
            targets: [{ type: "issue", target: "123", repo: "repo/api" }],
            lanes: [
              {
                name: "api",
                owner: "agent-api",
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

    expect(rows.filter((row) => row.repo === "repo/app" && row.target === "123")).toHaveLength(1);
    expect(rows.filter((row) => row.repo === "repo/api" && row.target === "123")).toMatchObject([
      { source: "lane", provenance: { classification: "synthetic", evidence: ["manifest"] } }
    ]);
  });

  it("classifies a lane-only row with event evidence as observed", () => {
    const batch: BatchRecord = {
      schemaVersion: 1,
      batchId: "event-backed",
      repo: "repo/app",
      source: "manifest",
      path: "batches/event-backed.json",
      lanes: [
        {
          name: "diagnostic",
          owner: "agent-diagnostic",
          targets: [],
          dependsOn: [],
          status: "queued",
          liveness: "no-heartbeat",
          blockedOn: []
        }
      ]
    };
    const rows = buildOperatorRows(
      dashboard({
        batches: [batch],
        events: [
          {
            eventId: "phase-1",
            type: "phase",
            batchId: "event-backed",
            laneName: "diagnostic",
            repo: "repo/app",
            status: "working",
            timestamp: "2026-07-09T19:59:00Z",
            path: "events/event-backed.jsonl:1"
          }
        ]
      })
    );

    expect(rows).toMatchObject([
      { provenance: { classification: "observed", evidence: ["manifest", "event"] } }
    ]);
  });

  it("does not reuse a target-scoped lane event across sibling target rows", () => {
    const batch: BatchRecord = {
      schemaVersion: 1,
      batchId: "multi-target-events",
      repo: "repo/app",
      source: "manifest",
      path: "batches/multi-target-events.json",
      targets: [
        { type: "issue", target: "123", repo: "repo/app" },
        { type: "issue", target: "456", repo: "repo/app" }
      ],
      lanes: [
        {
          name: "implementation",
          owner: "agent-a",
          targets: ["123", "456"],
          dependsOn: [],
          status: "queued",
          liveness: "no-heartbeat",
          blockedOn: []
        }
      ]
    };
    const rows = buildOperatorRows(
      dashboard({
        batches: [batch],
        events: [
          {
            eventId: "target-123",
            type: "phase",
            batchId: "multi-target-events",
            laneName: "implementation",
            repo: "repo/app",
            target: "123",
            status: "working-123",
            timestamp: "2026-07-09T19:59:00Z",
            path: "events/multi-target-events.jsonl:1"
          }
        ]
      })
    );

    expect(rows.find((row) => row.target === "123")).toMatchObject({
      activityStatus: "working-123",
      provenance: { classification: "observed", evidence: ["manifest", "event"] }
    });
    expect(rows.find((row) => row.target === "456")).toMatchObject({
      activityStatus: "queued",
      provenance: { classification: "synthetic", evidence: ["manifest"] }
    });

    const laneWideRows = buildOperatorRows(
      dashboard({
        batches: [batch],
        events: [
          {
            eventId: "lane-wide",
            type: "phase",
            batchId: "multi-target-events",
            laneName: "implementation",
            repo: "repo/app",
            status: "lane-started",
            timestamp: "2026-07-09T19:58:00Z",
            path: "events/multi-target-events.jsonl:2"
          }
        ]
      })
    );
    expect(laneWideRows.map((row) => ({ target: row.target, activityStatus: row.activityStatus }))).toEqual([
      { target: "123", activityStatus: "lane-started" },
      { target: "456", activityStatus: "lane-started" }
    ]);
  });

  it("suppresses an ambiguous multi-repo lane fallback when every candidate target is represented", () => {
    const apiTarget = workItem({
      id: "repo/api#123",
      repo: "repo/api",
      github: {
        repo: "repo/api",
        target: "123",
        type: "pull_request",
        title: "API target",
        url: "https://github.com/repo/api/pull/123",
        state: "OPEN",
        labels: [],
        loadState: "loaded"
      }
    });
    const ambiguousBatch: BatchRecord = {
      schemaVersion: 1,
      batchId: "multi-repo",
      source: "manifest",
      path: "batches/multi-repo.json",
      targets: [
        { type: "pull_request", target: "123", repo: "repo/app" },
        { type: "pull_request", target: "123", repo: "repo/api" }
      ],
      lanes: [
        {
          name: "ambiguous",
          owner: "agent-ambiguous",
          targets: ["123"],
          dependsOn: [],
          status: "queued",
          liveness: "no-heartbeat",
          blockedOn: []
        }
      ]
    };

    const representedRows = buildOperatorRows(
      dashboard({ workItems: [workItem(), apiTarget], batches: [ambiguousBatch] })
    );
    expect(representedRows).toHaveLength(2);
    expect(representedRows.every((row) => row.source === "target")).toBe(true);

    const partiallyRepresentedRows = buildOperatorRows(
      dashboard({ workItems: [workItem()], batches: [ambiguousBatch] })
    );
    expect(partiallyRepresentedRows.filter((row) => row.source === "lane")).toMatchObject([
      {
        repo: "UNKNOWN",
        target: "123",
        type: "unknown",
        title: "Target #123 (repository UNKNOWN)",
        url: undefined,
        provenance: { classification: "unknown", evidence: ["manifest"] },
        warnings: ["Target repository UNKNOWN: manifest target #123 matches multiple saved repositories."]
      }
    ]);

    const secondAmbiguousBatch: BatchRecord = {
      ...ambiguousBatch,
      batchId: "multi-repo-two",
      path: "batches/multi-repo-two.json"
    };
    const twoAmbiguousRows = buildOperatorRows(
      dashboard({ workItems: [workItem()], batches: [ambiguousBatch, secondAmbiguousBatch] })
    ).filter((row) => row.source === "lane");
    expect(twoAmbiguousRows).toHaveLength(2);
    expect(new Set(twoAmbiguousRows.map((row) => row.id)).size).toBe(2);
  });

  it("keeps repo-less no-target lane rows distinct across batches", () => {
    const repoLessBatch = (batchId: string): BatchRecord => ({
      schemaVersion: 1,
      batchId,
      source: "manifest",
      path: `batches/${batchId}.json`,
      lanes: [
        {
          name: "implementation",
          owner: `agent-${batchId}`,
          targets: ["123"],
          dependsOn: [],
          status: "queued",
          liveness: "no-heartbeat",
          blockedOn: []
        }
      ]
    });

    const rows = buildOperatorRows(
      dashboard({ batches: [repoLessBatch("repo-less-a"), repoLessBatch("repo-less-b")] })
    );

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows).toMatchObject([
      {
        repo: "UNKNOWN",
        target: "123",
        provenance: { classification: "unknown", evidence: ["manifest"] },
        warnings: ["Target repository UNKNOWN: lane target #123 has no explicit repository evidence."]
      },
      {
        repo: "UNKNOWN",
        target: "123",
        provenance: { classification: "unknown", evidence: ["manifest"] },
        warnings: ["Target repository UNKNOWN: lane target #123 has no explicit repository evidence."]
      }
    ]);
  });

  it("does not upgrade an ambiguous target event to observed without a direct lane or batch-path match", () => {
    const batch: BatchRecord = {
      schemaVersion: 1,
      batchId: "ambiguous-event",
      source: "manifest",
      path: "batches/ambiguous-event.json",
      targets: [
        { type: "issue", target: "123", repo: "repo/app" },
        { type: "issue", target: "123", repo: "repo/api" }
      ],
      lanes: [
        {
          name: "implementation",
          owner: "agent-a",
          targets: ["123"],
          dependsOn: [],
          status: "queued",
          liveness: "no-heartbeat",
          blockedOn: []
        }
      ]
    };
    const rows = buildOperatorRows(
      dashboard({
        batches: [batch],
        events: [
          {
            eventId: "unscoped-target-event",
            type: "phase",
            batchId: "ambiguous-event",
            repo: "repo/api",
            target: "123",
            status: "working",
            timestamp: "2026-07-09T19:59:00Z",
            path: "events/ambiguous-event.jsonl:1"
          }
        ]
      })
    );

    expect(rows).toMatchObject([
      {
        repo: "UNKNOWN",
        provenance: { classification: "unknown", evidence: ["manifest"] },
        activityStatus: "queued"
      }
    ]);
  });

  it("does not let a concrete repo event contaminate an ambiguous repository-UNKNOWN lane row", () => {
    const batch: BatchRecord = {
      schemaVersion: 1,
      batchId: "ambiguous-direct-event",
      source: "manifest",
      path: "batches/ambiguous-direct-event.json",
      targets: [
        { type: "issue", target: "123", repo: "repo/app" },
        { type: "issue", target: "123", repo: "repo/api" }
      ],
      lanes: [
        {
          name: "implementation",
          owner: "agent-a",
          targets: ["123"],
          dependsOn: [],
          status: "queued",
          liveness: "no-heartbeat",
          blockedOn: []
        }
      ]
    };
    const rows = buildOperatorRows(
      dashboard({
        workItems: [workItem({ provenance: { classification: "observed", evidence: ["github"] } })],
        batches: [batch],
        events: [
          {
            eventId: "api-target-event",
            type: "phase",
            batchId: "ambiguous-direct-event",
            laneName: "implementation",
            repo: "repo/api",
            target: "123",
            status: "working-api",
            message: "API-only activity",
            timestamp: "2026-07-09T19:59:00Z",
            path: "events/ambiguous-direct-event.jsonl:1"
          }
        ]
      })
    );
    const unknownRow = rows.find((row) => row.repo === "UNKNOWN");

    expect(unknownRow).toMatchObject({
      target: "123",
      activityStatus: "queued",
      activityMessage: undefined,
      provenance: { classification: "unknown", evidence: ["manifest"] },
      warnings: ["Target repository UNKNOWN: manifest target #123 matches multiple saved repositories."]
    });
  });

  it("allows only exact HTTPS GitHub issue and pull-request URLs", () => {
    expect(safeGithubUrl("https://github.com/repo/app/pull/123")).toBe("https://github.com/repo/app/pull/123");
    expect(safeGithubUrl("https://github.com/repo/app/issues/456?tab=activity#comment")).toBe(
      "https://github.com/repo/app/issues/456?tab=activity#comment"
    );
    for (const value of [
      undefined,
      "http://github.com/repo/app/pull/123",
      "https://example.com/repo/app/pull/123",
      "https://github.com/repo/app/actions/123",
      "https://github.com/repo/app/pull/not-a-number",
      "javascript:alert(1)",
      "not a url"
    ]) {
      expect(safeGithubUrl(value)).toBeUndefined();
    }
  });

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

  it("describes claim-only metadata provenance without manufacturing a missing machine", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [workItem({ claim: { ...claim, machineId: undefined }, heartbeat: undefined })]
      })
    );

    expect((rows[0] as any).metadata).toMatchObject({
      owner: { value: "justin", state: "observed", source: "claim" },
      thread: { value: "thread-a", state: "observed", source: "claim" },
      host: { value: "codex", state: "observed", source: "claim" },
      machine: { state: "not_applicable" },
      branch: { value: "feature/operator-view", state: "observed", source: "claim" },
      prUrl: { value: "https://github.com/repo/app/pull/123", state: "observed", source: "claim" },
      batch: { value: "batch-1", state: "observed", source: "claim" },
      activity: { value: "active", state: "observed", source: "claim" }
    });
  });

  it("keeps optional metadata not applicable without warnings for started-not-processing claims", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            type: "issue",
            schedulingState: "started_not_processing",
            github: { ...workItem().github!, type: "issue", url: "https://github.com/repo/app/issues/123" },
            claim: {
              ...claim,
              machineId: undefined,
              threadHandle: undefined,
              host: undefined,
              operator: undefined,
              batchId: undefined,
              branch: undefined,
              prUrl: undefined
            },
            heartbeat: undefined
          })
        ]
      })
    );

    expect(rows[0].metadata).toMatchObject({
      owner: { state: "not_applicable" },
      thread: { state: "not_applicable" },
      host: { state: "not_applicable" },
      machine: { state: "not_applicable" },
      branch: { state: "not_applicable" },
      prUrl: { state: "not_applicable" },
      batch: { state: "not_applicable" },
      activity: { value: "active", state: "observed", source: "claim" }
    });
    expect(rows[0].warnings).toEqual([]);
  });

  it("describes heartbeat-only metadata as observed from the heartbeat", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [workItem({ claim: undefined, heartbeat })]
      })
    );

    expect(rows[0].metadata).toMatchObject({
      owner: { value: "justin", state: "observed", source: "heartbeat" },
      thread: { value: "thread-a", state: "observed", source: "heartbeat" },
      host: { value: "codex", state: "observed", source: "heartbeat" },
      machine: { value: "m5", state: "observed", source: "heartbeat" },
      branch: { value: "feature/operator-view", state: "observed", source: "heartbeat" },
      prUrl: { value: "https://github.com/repo/app/pull/123", state: "observed", source: "heartbeat" },
      batch: { value: "batch-1", state: "observed", source: "heartbeat" },
      activity: { value: "coding", state: "observed", source: "heartbeat" }
    });
  });

  it("attributes Owner provenance to the source of the displayed operator", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: { ...claim, operator: undefined },
            heartbeat: { ...heartbeat, agentId: "agent-b", operator: "maintainer" }
          })
        ]
      })
    );

    expect(rows[0]).toMatchObject({
      agentId: "agent-a",
      operator: "maintainer",
      metadata: { owner: { value: "maintainer", state: "observed", source: "heartbeat" } }
    });
  });

  it("uses the same chosen source for visible values and provenance", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: { ...claim, machineId: "claim-machine" },
            heartbeat: { ...heartbeat, machineId: "heartbeat-machine", prUrl: undefined }
          })
        ]
      })
    );

    expect(rows[0]).toMatchObject({
      machineId: "heartbeat-machine",
      prUrl: "https://github.com/repo/app/pull/123",
      activityStatus: "coding"
    });
    expect(rows[0].metadata).toMatchObject({
      machine: { value: "heartbeat-machine", state: "observed", source: "heartbeat" },
      prUrl: { value: "https://github.com/repo/app/pull/123", state: "observed", source: "claim" },
      activity: { value: "coding", state: "observed", source: "heartbeat" }
    });
  });

  it("normalizes padded displayed values and their provenance at selection", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: {
              ...claim,
              agentId: "  agent-a  ",
              machineId: "  claim-machine  ",
              operator: "  claim-owner  "
            },
            heartbeat: {
              ...heartbeat,
              agentId: "  agent-a  ",
              machineId: "  heartbeat-machine  ",
              operator: "  heartbeat-owner  "
            }
          })
        ]
      })
    );

    expect(rows[0]).toMatchObject({
      agentId: "agent-a",
      machineId: "heartbeat-machine",
      operator: "claim-owner"
    });
    expect(rows[0].metadata).toMatchObject({
      machine: { value: "heartbeat-machine", state: "observed", source: "heartbeat" },
      owner: { value: "claim-owner", state: "observed", source: "claim" }
    });
  });

  it("uses claim activity as both the visible and disclosed claim-only value", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [workItem({ claim, heartbeat: undefined })]
      })
    );

    expect(rows[0].activityStatus).toBe("active");
    expect(rows[0].metadata.activity).toEqual({ value: "active", state: "observed", source: "claim" });
  });

  it("uses the GitHub preview URL when coordination records omit the PR URL", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: undefined,
            heartbeat: { ...heartbeat, prUrl: undefined }
          })
        ]
      })
    );

    expect(rows[0].prUrl).toBe("https://github.com/repo/app/pull/123");
    expect(rows[0].metadata.prUrl).toEqual({
      value: "https://github.com/repo/app/pull/123",
      state: "observed",
      source: "github"
    });
  });

  it("keeps operator fields informational for ready event-only work", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            type: "issue",
            schedulingState: "ready_for_batch",
            claim: undefined,
            heartbeat: undefined
          })
        ],
        events: [
          {
            eventId: "event-only",
            type: "phase",
            agentId: "event-agent",
            repo: "repo/app",
            target: "123",
            status: "coding",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/event-only.json"
          }
        ]
      })
    );

    expect(rows[0].metadata).toMatchObject({
      owner: { state: "not_applicable" },
      thread: { state: "not_applicable" },
      host: { state: "not_applicable" },
      machine: { state: "not_applicable" },
      branch: { state: "not_applicable" },
      prUrl: { state: "not_applicable" },
      batch: { state: "not_applicable" },
      activity: { value: "coding", state: "observed", source: "event" }
    });
    expect(rows[0].warnings).toEqual([]);
  });

  it("warns when in-process work lacks operational operator fields", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            type: "issue",
            claim: undefined,
            heartbeat: undefined
          })
        ]
      })
    );

    expect(rows[0].warnings).toEqual(["Operator UNKNOWN", "Thread UNKNOWN", "Host UNKNOWN"]);
  });

  it("keeps the newest observed value for each metadata field across event history", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [workItem({ claim: undefined, heartbeat: undefined, github: undefined })],
        events: [
          {
            eventId: "event-metadata",
            type: "phase",
            agentId: "event-agent",
            machineId: "event-machine",
            threadHandle: "event-thread",
            host: "codex",
            operator: "maintainer",
            branch: "feature/from-event",
            prUrl: "https://github.com/repo/app/pull/123",
            repo: "repo/app",
            target: "123",
            status: "coding",
            timestamp: "2026-07-09T19:58:00Z",
            path: "events/event-metadata.json"
          },
          {
            eventId: "event-qa",
            type: "qa.validation_passed",
            repo: "repo/app",
            target: "123",
            status: "passed",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/event-qa.json"
          }
        ]
      })
    );

    expect(rows[0]).toMatchObject({
      operator: "maintainer",
      machineId: "event-machine",
      threadHandle: "event-thread",
      host: "codex",
      branch: "feature/from-event",
      prUrl: "https://github.com/repo/app/pull/123",
      activityStatus: "passed",
      metadata: {
        owner: { value: "maintainer", state: "observed", source: "event" },
        machine: { value: "event-machine", state: "observed", source: "event" },
        branch: { value: "feature/from-event", state: "observed", source: "event" },
        prUrl: { value: "https://github.com/repo/app/pull/123", state: "observed", source: "event" },
        activity: { value: "passed", state: "observed", source: "event" }
      }
    });
  });

  it("keeps batch-backed event metadata on event-recovery rows without batch signals", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: undefined,
            heartbeat: undefined,
            github: undefined,
            schedulingState: "started_not_processing"
          })
        ],
        events: [
          {
            eventId: "event-recovery",
            type: "phase",
            batchId: "history-batch",
            laneName: "implementation",
            agentId: "event-agent",
            machineId: "event-machine",
            threadHandle: "event-thread",
            host: "codex",
            operator: "maintainer",
            repo: "repo/app",
            target: "123",
            branch: "feature/recovery",
            prUrl: "https://github.com/repo/app/pull/123",
            status: "coding",
            timestamp: "2026-07-09T19:59:30Z",
            path: "events/history-batch.jsonl:1"
          }
        ]
      })
    );

    expect(rows[0]).toMatchObject({
      activityStatus: "coding",
      batchId: "history-batch",
      agentId: "event-agent",
      machineId: "event-machine",
      threadHandle: "event-thread",
      host: "codex",
      operator: "maintainer",
      branch: "feature/recovery",
      prUrl: "https://github.com/repo/app/pull/123"
    });
    expect(rows[0].metadata.batch).toEqual({
      value: "history-batch",
      state: "observed",
      source: "event"
    });
    expect(rows[0].metadata.activity).toEqual({ value: "coding", state: "observed", source: "event" });
  });

  it("marks optional manifest-only metadata not applicable", () => {
    const batch: BatchRecord = {
      schemaVersion: 1,
      batchId: "manifest-batch",
      repo: "repo/app",
      source: "manifest",
      path: "batches/manifest-batch.json",
      lanes: [
        {
          name: "docs",
          owner: "manifest-owner",
          targets: [],
          dependsOn: [],
          status: "queued",
          liveness: "no-heartbeat",
          blockedOn: []
        }
      ]
    };

    const rows = buildOperatorRows(dashboard({ batches: [batch] }));

    expect(rows[0].metadata).toMatchObject({
      owner: { state: "not_applicable" },
      thread: { state: "not_applicable" },
      host: { state: "not_applicable" },
      machine: { state: "not_applicable" },
      branch: { state: "not_applicable" },
      prUrl: { state: "not_applicable" },
      batch: { value: "manifest-batch", state: "observed", source: "manifest" },
      activity: { value: "queued", state: "observed", source: "manifest" }
    });
    expect(rows[0].warnings).toEqual([]);
  });

  it("labels batch metadata inferred from coordination signals", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: { ...claim, batchId: "inferred-batch" },
            heartbeat: undefined,
            batchSignals: [{ batchId: "inferred-batch", laneName: "agent-a", status: "active", blockedOn: [] }]
          })
        ],
        batches: [
          {
            schemaVersion: 1,
            batchId: "inferred-batch",
            repo: "repo/app",
            source: "inferred",
            path: "inferred/repo/app/inferred-batch.json",
            lanes: [
              {
                name: "agent-a",
                owner: "agent-a",
                targets: ["123"],
                dependsOn: [],
                status: "active",
                liveness: "no-heartbeat",
                blockedOn: []
              }
            ]
          }
        ]
      })
    );

    expect(rows[0].metadata.batch).toEqual({
      value: "inferred-batch",
      state: "inferred",
      source: "inferred_batch"
    });
    expect(rows[0].warnings).toEqual([]);
  });

  it("warns only for genuinely required heartbeat machine and PR URL metadata", () => {
    const rows = buildOperatorRows(
      dashboard({
        workItems: [
          workItem({
            claim: undefined,
            heartbeat: { ...heartbeat, machineId: undefined, prUrl: undefined },
            github: undefined
          })
        ]
      })
    );

    expect(rows[0].metadata.machine).toEqual({ state: "missing", source: "heartbeat" });
    expect(rows[0].metadata.prUrl).toEqual({ state: "missing", source: "github" });
    expect(rows[0].warnings).toEqual(["Machine UNKNOWN", "PR URL UNKNOWN"]);
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

  it("derives fallback lane display values from the selected provenance values", () => {
    const batch: BatchRecord = {
      schemaVersion: 1,
      batchId: "batch-provenance",
      repo: "repo/app",
      targets: [{ type: "pull_request", target: "123", repo: "repo/app" }],
      path: "batches/batch-provenance.json",
      lanes: [
        {
          name: "implementation",
          owner: "agent-manifest",
          targets: ["123"],
          dependsOn: [],
          status: "queued",
          liveness: "no-heartbeat",
          blockedOn: [],
          threadHandle: "manifest-thread",
          branch: "manifest-branch"
        }
      ]
    };
    const rows = buildOperatorRows(
      dashboard({
        batches: [batch],
        events: [
          {
            eventId: "lane-event",
            type: "phase",
            batchId: "batch-provenance",
            laneName: "implementation",
            agentId: "agent-event",
            machineId: "event-machine",
            threadHandle: "event-thread",
            host: "codex",
            operator: "maintainer",
            repo: "repo/app",
            target: "123",
            branch: "event-branch",
            prUrl: "https://github.com/repo/app/pull/123",
            status: "coding",
            timestamp: "2026-07-09T19:59:00Z",
            path: "events/lane-event.json"
          }
        ]
      })
    );

    expect(rows[0]).toMatchObject({
      agentId: "agent-manifest",
      machineId: "event-machine",
      threadHandle: "manifest-thread",
      host: "codex",
      operator: "maintainer",
      branch: "manifest-branch",
      prUrl: "https://github.com/repo/app/pull/123",
      activityStatus: "coding"
    });
    expect(rows[0].metadata).toMatchObject({
      machine: { value: rows[0].machineId },
      thread: { value: rows[0].threadHandle },
      host: { value: rows[0].host },
      owner: { value: rows[0].operator },
      branch: { value: rows[0].branch },
      prUrl: { value: rows[0].prUrl },
      activity: { value: rows[0].activityStatus }
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

    const rows = buildOperatorRows(model);
    const repairRows = filterOperatorRowsForOverview(rows, model, "batch_repair");
    expect(repairRows).toHaveLength(1);
    expect(repairRows[0]).toMatchObject({
      repo: "repo/app",
      batchId: "batch-1",
      batchPath: "batches/repo-app/batch-1.json",
      activityStatus: "stopped"
    });
    expect(rows[0].activityStatus).toBe("coding");
  });

  it("keeps both explicit repo identities in a same-number multi-repo batch repair", () => {
    const model = dashboard({
      workItems: [
        workItem({
          id: "repo/app#123",
          repo: "repo/app",
          target: "123",
          type: "issue",
          schedulingState: "ready_for_batch",
          provenance: { classification: "observed", evidence: ["github"] }
        }),
        workItem({
          id: "repo/api#123",
          repo: "repo/api",
          target: "123",
          type: "issue",
          schedulingState: "ready_for_batch",
          provenance: { classification: "observed", evidence: ["github"] },
          github: {
            repo: "repo/api",
            target: "123",
            type: "issue",
            title: "API repair target",
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
          batchId: "multi-repo-repair",
          repo: "repo/app",
          source: "manifest",
          path: "batches/multi-repo-repair.json",
          targets: [
            { type: "issue", target: "123", repo: "repo/app" },
            { type: "issue", target: "123", repo: "repo/api" }
          ],
          lanes: [
            {
              name: "implementation",
              owner: "agent-a",
              targets: ["123"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      batchOperations: [
        {
          batchId: "multi-repo-repair",
          repo: "repo/app",
          batchPath: "batches/multi-repo-repair.json",
          controlStatus: "stopped",
          eventCount: 1,
          qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 }
        }
      ]
    });

    expect(
      filterOperatorRowsForOverview(buildOperatorRows(model), model, "batch_repair").map((row) => ({
        repo: row.repo,
        target: row.target,
        activityStatus: row.activityStatus
      }))
    ).toEqual([
      { repo: "repo/app", target: "123", activityStatus: "stopped" },
      { repo: "repo/api", target: "123", activityStatus: "stopped" }
    ]);
  });

  it("keeps the batch repo fallback for lane targets absent from a partial structured target list", () => {
    const model = dashboard({
      workItems: [
        workItem({
          id: "repo/app#456",
          repo: "repo/app",
          target: "456",
          type: "issue",
          schedulingState: "ready_for_batch",
          provenance: { classification: "observed", evidence: ["github"] },
          github: {
            repo: "repo/app",
            target: "456",
            type: "issue",
            title: "Unlisted lane target",
            url: "https://github.com/repo/app/issues/456",
            state: "OPEN",
            labels: [],
            loadState: "loaded"
          }
        })
      ],
      batches: [
        {
          schemaVersion: 1,
          batchId: "partial-targets",
          repo: "repo/app",
          source: "manifest",
          path: "batches/partial-targets.json",
          targets: [{ type: "issue", target: "123", repo: "repo/app" }],
          lanes: [
            {
              name: "implementation",
              owner: "agent-a",
              targets: ["456"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ]
    });

    expect(
      filterOperatorRowsForOverview(buildOperatorRows(model), model, "batch_repair").map((row) => ({
        repo: row.repo,
        target: row.target,
        activityStatus: row.activityStatus
      }))
    ).toEqual([{ repo: "repo/app", target: "456", activityStatus: "prompt_missing" }]);
  });

  it("presents every repair cause on matched batch targets before coordination signals attach batch identity", () => {
    const model = dashboard({
      workItems: [
        workItem({ claim: undefined, heartbeat: undefined, schedulingState: "ready_for_batch" }),
        workItem({ id: "repo/app#124", target: "124", claim: undefined, heartbeat: undefined, schedulingState: "ready_for_batch" }),
        workItem({ id: "repo/app#125", target: "125", claim: undefined, heartbeat: undefined, schedulingState: "ready_for_batch" }),
        workItem({ id: "repo/app#126", target: "126", claim: undefined, heartbeat: undefined, schedulingState: "ready_for_batch" })
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
        },
        {
          schemaVersion: 1,
          batchId: "inferred-batch",
          repo: "repo/app",
          source: "inferred",
          path: "batches/inferred.json",
          lanes: [
            {
              name: "qa",
              owner: "agent-qa",
              targets: ["125"],
              dependsOn: [],
              blockedOn: [],
              status: "queued",
              liveness: "no-heartbeat"
            }
          ]
        },
        {
          schemaVersion: 1,
          batchId: "stop-requested-batch",
          repo: "repo/app",
          path: "batches/stop-requested.json",
          launchPrompt: "Use $pr-batch",
          lanes: [
            {
              name: "release",
              owner: "agent-release",
              targets: ["126"],
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
        },
        {
          batchId: "stop-requested-batch",
          repo: "repo/app",
          batchPath: "batches/stop-requested.json",
          controlStatus: "stop_requested",
          eventCount: 1,
          qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 }
        }
      ]
    });

    expect(
      filterOperatorRowsForOverview(buildOperatorRows(model), model, "batch_repair").map((row) => ({
        target: row.target,
        batchId: row.batchId,
        laneName: row.laneName,
        activityStatus: row.activityStatus,
        activityMetadata: row.metadata.activity
      }))
    ).toEqual([
      {
        target: "123",
        batchId: "prompt-missing",
        laneName: "docs",
        activityStatus: "prompt_missing",
        activityMetadata: { value: "prompt_missing", state: "inferred", source: "dashboard" }
      },
      {
        target: "124",
        batchId: "stopped-batch",
        laneName: "code",
        activityStatus: "stopped",
        activityMetadata: { value: "stopped", state: "inferred", source: "event" }
      },
      {
        target: "125",
        batchId: "inferred-batch",
        laneName: "qa",
        activityStatus: "batch_plan_missing",
        activityMetadata: { value: "batch_plan_missing", state: "inferred", source: "inferred_batch" }
      },
      {
        target: "126",
        batchId: "stop-requested-batch",
        laneName: "release",
        activityStatus: "stop_requested",
        activityMetadata: { value: "stop_requested", state: "inferred", source: "event" }
      }
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

  it("does not retag active work from a healthy batch when an old repair manifest names the same target", () => {
    const model = dashboard({
      workItems: [
        workItem({
          claim: { ...claim, batchId: "healthy-new" },
          heartbeat: { ...heartbeat, batchId: "healthy-new" }
        })
      ],
      batches: [
        {
          schemaVersion: 1,
          batchId: "broken-old",
          repo: "repo/app",
          objective: "Repair stale batch",
          path: "batches/broken-old.json",
          lanes: [
            {
              name: "old-lane",
              owner: "old-agent",
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
          batchId: "healthy-new",
          repo: "repo/app",
          path: "batches/healthy-new.json",
          launchPrompt: "Use $pr-batch",
          lanes: [
            {
              name: "active-lane",
              owner: "agent-a",
              targets: ["123"],
              dependsOn: [],
              blockedOn: [],
              status: "coding",
              liveness: "live"
            }
          ]
        }
      ]
    });
    const rows = buildOperatorRows(model);
    expect(rows[0]).toMatchObject({ target: "123", batchId: "healthy-new" });

    const repairRows = filterOperatorRowsForOverview(rows, model, "batch_repair");
    expect(repairRows).toEqual([
      expect.objectContaining({ source: "batch", batchId: "broken-old", title: "Repair stale batch" })
    ]);
    expect(repairRows[0].target).toBeUndefined();
    expect(repairRows.some((row) => row.id.includes("target:repo/app#123"))).toBe(false);
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
