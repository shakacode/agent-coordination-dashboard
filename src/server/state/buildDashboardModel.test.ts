import { describe, expect, it } from "vitest";
import type { ClaimRecord, GitHubPreview, HeartbeatRecord } from "../../shared/types";
import { buildDashboardModel } from "./buildDashboardModel";

const claim: ClaimRecord = {
  schemaVersion: 1,
  repo: "shakacode/react_on_rails",
  target: "4005",
  agentId: "worker-a",
  status: "active",
  updatedAt: "2026-06-17T19:00:00Z",
  expiresAt: "2026-06-17T23:00:00Z",
  path: "claims/shakacode/react_on_rails/4005.json"
};

const heartbeat: HeartbeatRecord = {
  schemaVersion: 1,
  agentId: "worker-a",
  repo: "shakacode/react_on_rails",
  target: "4005",
  status: "in_progress",
  updatedAt: "2026-06-17T19:55:00Z",
  expiresAt: "2026-06-17T20:10:00Z",
  path: "heartbeats/worker-a.json",
  liveness: "live"
};

const preview: GitHubPreview = {
  repo: "shakacode/react_on_rails",
  target: "4010",
  type: "issue",
  title: "Unscheduled issue",
  url: "https://github.com/shakacode/react_on_rails/issues/4010",
  state: "OPEN",
  labels: [],
  loadState: "loaded"
};

describe("buildDashboardModel", () => {
  it("classifies live claimed work as in process and open unclaimed work as ready", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [claim],
      heartbeats: [heartbeat],
      batches: [],
      githubItems: [preview],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.workItems.find((item) => item.target === "4005")?.schedulingState).toBe("in_process");
    expect(model.workItems.find((item) => item.target === "4010")?.schedulingState).toBe("ready_for_batch");
    expect(model.agents[0].agentId).toBe("worker-a");
  });

  it("classifies dead heartbeat claims as started but not processing", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [claim],
      heartbeats: [{ ...heartbeat, liveness: "dead" }],
      batches: [],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.workItems[0].schedulingState).toBe("started_not_processing");
    expect(model.workItems[0].warnings[0].message).toContain("not currently live or stale");
  });

  it("does not attach a claim holder heartbeat from a different target", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [claim],
      heartbeats: [{ ...heartbeat, target: "4010" }],
      batches: [],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    const claimedItem = model.workItems.find((item) => item.target === "4005");
    const movedHeartbeatItem = model.workItems.find((item) => item.target === "4010");

    expect(claimedItem?.schedulingState).toBe("started_not_processing");
    expect(claimedItem?.heartbeat).toBeUndefined();
    expect(claimedItem?.warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("heartbeat currently points at")])
    );
    expect(movedHeartbeatItem?.schedulingState).toBe("in_process");
  });

  it("treats any live heartbeat for the same work as in process", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [claim],
      heartbeats: [
        { ...heartbeat, liveness: "dead" },
        { ...heartbeat, agentId: "worker-b", liveness: "live" }
      ],
      batches: [],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.workItems[0].schedulingState).toBe("in_process");
    expect(model.workItems[0].heartbeat?.agentId).toBe("worker-b");
    expect(model.workItems[0].warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("heartbeat from worker-b")])
    );
  });

  it("classifies live heartbeat-only work as in process", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [heartbeat],
      batches: [],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.workItems[0].schedulingState).toBe("in_process");
    expect(model.agents[0].currentWork[0].target).toBe("4005");
  });

  it("does not let released claims block ready GitHub work", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [{ ...claim, status: "released" }],
      heartbeats: [],
      batches: [],
      githubItems: [{ ...preview, target: "4005" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.workItems[0].schedulingState).toBe("ready_for_batch");
    expect(model.workItems[0].claim).toBeUndefined();
    expect(model.agents).toEqual([]);
  });

  it("scopes coordination records to target repositories", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [claim, { ...claim, repo: "other/repo", target: "12", agentId: "other-worker" }],
      heartbeats: [
        heartbeat,
        { ...heartbeat, repo: "other/repo", target: "12", agentId: "other-worker" },
        { ...heartbeat, repo: undefined, target: undefined, agentId: "idle-worker" }
      ],
      batches: [],
      githubItems: [preview, { ...preview, repo: "other/repo", target: "12" }],
      warnings: [
        { severity: "warning", repo: "other/repo", message: "Malformed JSON in claims/other/repo/12.json" },
        { severity: "warning", message: "Malformed JSON in heartbeats/idle-worker.json" },
        { severity: "warning", message: "Malformed JSON in events/batch-1.jsonl:2: Unexpected end of JSON input" },
        { severity: "warning", message: "Could not read coordination directory heartbeats: ENOENT" },
        { severity: "warning", message: "Could not read coordination directory events: EACCES" },
        { severity: "warning", message: "Could not read coordination directory batches/private-batch-dir: EACCES" }
      ],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.workItems.some((item) => item.repo === "other/repo")).toBe(false);
    expect(model.agents.some((agent) => agent.agentId === "other-worker")).toBe(false);
    expect(model.agents.some((agent) => agent.agentId === "idle-worker")).toBe(false);
    expect(model.warnings.some((warning) => warning.message.includes("claims/other/repo"))).toBe(false);
    expect(model.warnings.some((warning) => warning.message.includes("heartbeats/idle-worker"))).toBe(false);
    expect(model.warnings.some((warning) => warning.message.includes("private-batch-dir"))).toBe(false);
    expect(model.warnings.some((warning) => warning.message.includes("Could not read coordination directory heartbeats"))).toBe(true);
    expect(model.warnings.some((warning) => warning.message.includes("Could not read coordination directory events"))).toBe(true);
    expect(model.warnings.some((warning) => warning.message === "Malformed JSON in an unscoped heartbeats record.")).toBe(true);
    expect(model.warnings.some((warning) => warning.message === "Malformed JSON in an unscoped events record.")).toBe(true);
    expect(model.warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        "Skipped 1 claim records outside TARGET_REPOS.",
        "Skipped 2 heartbeat records outside TARGET_REPOS.",
        "Skipped 1 GitHub preview records outside TARGET_REPOS.",
        "Skipped 2 warning records outside TARGET_REPOS."
      ])
    );
  });

  it("does not mark open work as ready when it is already in a retained batch lane", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: ["outside TARGET_REPOS"],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            },
            {
              name: "lane-b",
              owner: "worker-b",
              targets: ["99"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [preview],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.workItems[0].schedulingState).toBe("started_not_processing");
    expect(model.workItems[0].batchSignals).toEqual([
      { batchId: "batch-1", laneName: "lane-a", status: "queued", blockedOn: ["outside TARGET_REPOS"] }
    ]);
    expect(model.workItems[0].warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("already scheduled in batch")])
    );
  });

  it("keys mixed-repo retained batch lanes by unique manifest target repo", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["repo-a/app", "repo-b/api"],
      claims: [],
      heartbeats: [
        {
          ...heartbeat,
          agentId: "worker-b",
          repo: "repo-b/api",
          target: "34",
          batchId: "batch-mixed",
          status: "in_progress",
          liveness: "live"
        }
      ],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-mixed",
          repo: "repo-a/app",
          path: "batches/batch-mixed.json",
          targets: [
            { type: "pull_request", target: "12", repo: "repo-a/app" },
            { type: "pull_request", target: "34", repo: "repo-b/api" }
          ],
          lanes: [
            {
              name: "api-pr",
              owner: "worker-b",
              targets: ["34"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "api-event",
          type: "lane.done",
          batchId: "batch-mixed",
          repo: "repo-b/api",
          target: "34",
          timestamp: "2026-06-17T20:00:00Z",
          path: "events/batch-mixed.jsonl:1"
        },
        {
          eventId: "api-stop",
          type: "batch.stop_requested",
          batchId: "batch-mixed",
          repo: "repo-b/api",
          status: "stop_requested",
          timestamp: "2026-06-17T20:01:00Z",
          path: "events/batch-mixed.jsonl:2"
        }
      ],
      githubItems: [
        {
          ...preview,
          repo: "repo-a/app",
          target: "34",
          type: "pull_request",
          title: "Same number in app",
          url: "https://github.com/repo-a/app/pull/34"
        },
        {
          ...preview,
          repo: "repo-b/api",
          target: "34",
          type: "pull_request",
          title: "API PR",
          url: "https://github.com/repo-b/api/pull/34"
        }
      ],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.workItems.find((item) => item.repo === "repo-b/api" && item.target === "34")?.batchSignals).toEqual([
      { batchId: "batch-mixed", laneName: "api-pr", status: "in_progress", blockedOn: [] }
    ]);
    expect(model.workItems.find((item) => item.repo === "repo-a/app" && item.target === "34")?.batchSignals).toEqual([]);
    expect(model.batches[0].lanes[0]).toEqual(expect.objectContaining({ status: "in_progress", liveness: "live" }));
    expect(model.events).toEqual([
      expect.objectContaining({ eventId: "api-stop", batchPath: "batches/batch-mixed.json" }),
      expect.objectContaining({ eventId: "api-event", batchPath: "batches/batch-mixed.json" })
    ]);
    expect(model.batchOperations.find((operation) => operation.batchId === "batch-mixed")?.controlStatus).toBe("stop_requested");
  });

  it("keeps mixed-repo batches when only a per-target repo is in scope", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["repo-b/api"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-mixed",
          repo: "repo-a/app",
          objective: "Process app and API repos.",
          targets: [
            { type: "pull_request", target: "12", repo: "repo-a/app" },
            { type: "pull_request", target: "34", repo: "repo-b/api" }
          ],
          launchPrompt:
            "Use $pr-batch.\nRepository: repo-a/app, repo-b/api\nBatch id: batch-mixed\nItems:\n- PR #12\n- PR #34",
          path: "batches/batch-mixed.json",
          lanes: [
            {
              name: "api-pr",
              owner: "worker-b",
              targets: ["34"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "api-stop",
          type: "batch.stop_requested",
          batchId: "batch-mixed",
          repo: "repo-b/api",
          status: "stop_requested",
          timestamp: "2026-06-17T20:01:00Z",
          path: "events/batch-mixed.jsonl:1"
        }
      ],
      githubItems: [
        {
          ...preview,
          repo: "repo-b/api",
          target: "34",
          type: "pull_request",
          title: "API PR",
          url: "https://github.com/repo-b/api/pull/34"
        }
      ],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches).toHaveLength(1);
    expect(model.batches[0]).toEqual(
      expect.objectContaining({
        batchId: "batch-mixed",
        repo: undefined,
        objective: undefined,
        launchPrompt: undefined
      })
    );
    expect(model.batches[0].targets).toEqual([{ type: "pull_request", target: "34", repo: "repo-b/api" }]);
    expect(model.batches[0].lanes[0].targets).toEqual(["34"]);
    expect(model.batchOperations[0]).toEqual(expect.objectContaining({ controlStatus: "stop_requested", eventCount: 1 }));
  });

  it("drops retained batches whose identity path references out-of-scope repos", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["repo-b/api"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "repo-a/app-hidden",
          repo: "repo-a/app",
          targets: [{ type: "pull_request", target: "34", repo: "repo-b/api" }],
          path: "batches/repo-a/app-hidden.json",
          lanes: [
            {
              name: "api-pr",
              owner: "worker-b",
              targets: ["34"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches).toEqual([]);
    expect(model.events).toEqual([]);
  });

  it("infers batch cards from scoped claims and heartbeats when batch manifests are missing", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [{ ...claim, target: "4005", batchId: "batch-1" }],
      heartbeats: [{ ...heartbeat, agentId: "worker-b", target: "4010", batchId: "batch-1" }],
      batches: [],
      githubItems: [preview, { ...preview, target: "4005" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches).toHaveLength(1);
    expect(model.batches[0]).toMatchObject({
      batchId: "batch-1",
      repo: "shakacode/react_on_rails",
      source: "inferred"
    });
    expect(model.batches[0].lanes.map((lane) => [lane.owner, lane.targets])).toEqual([
      ["worker-a", ["4005"]],
      ["worker-b", ["4010"]]
    ]);
    expect(model.workItems.find((item) => item.target === "4010")?.batchSignals).toEqual([
      { batchId: "batch-1", laneName: "worker-b", status: "in_progress", blockedOn: [] }
    ]);
    expect(model.healthItems.map((item) => item.title)).toContain("Batch manifest missing");
  });

  it("does not infer duplicate batches when a same-repo manifest exists", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [{ ...claim, target: "4010", batchId: "batch-1" }],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [preview],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches).toHaveLength(1);
    expect(model.batches[0].source).toBe("manifest");
    expect(model.batches[0].lanes.map((lane) => lane.targets)).toEqual([["4005"]]);
  });

  it("keeps repo-less batches and batch-id heartbeats when lane targets are scoped", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [{ ...claim, target: "4010", batchId: "batch-1" }],
      heartbeats: [
        {
          ...heartbeat,
          repo: undefined,
          target: undefined,
          batchId: "batch-1",
          status: "in_progress"
        },
        {
          ...heartbeat,
          agentId: "other-worker",
          repo: undefined,
          target: undefined,
          batchId: "batch-1",
          status: "in_progress"
        }
      ],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          updatedAt: "2026-06-17T20:00:00Z",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: ["batch-1:lane-b"],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            },
            {
              name: "lane-b",
              owner: "other-worker",
              targets: ["9999"],
              dependsOn: ["batch-1:lane-a"],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [preview],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches).toHaveLength(1);
    expect(model.batches[0].lanes).toHaveLength(1);
    expect(model.batches[0].lanes[0].status).toBe("in_progress");
    expect(model.batches[0].lanes[0].liveness).toBe("live");
    expect(model.batches[0].lanes[0].blockedOn).toEqual(["outside TARGET_REPOS"]);
    expect(model.agents[0].agentId).toBe("worker-a");
    expect(model.agents.some((agent) => agent.agentId === "other-worker")).toBe(false);
  });

  it("matches repo-scoped targeted heartbeats to retained repo-less batch lanes", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [{ ...heartbeat, batchId: "batch-1", target: "4010", status: "in_progress" }],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [preview],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].lanes[0].status).toBe("in_progress");
    expect(model.batches[0].lanes[0].liveness).toBe("live");
  });

  it("keeps corroborated repo-less batch lanes in multi-repo dashboards", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails", "other/repo"],
      claims: [{ ...claim, target: "4010", batchId: "batch-1" }],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [preview],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches).toHaveLength(1);
    expect(model.workItems.find((item) => item.repo === "shakacode/react_on_rails" && item.target === "4010")?.batchSignals).toEqual([
      { batchId: "batch-1", laneName: "lane-a", status: "queued", blockedOn: [] }
    ]);
  });

  it("redacts repo-less retained prompt metadata outside target repository scope", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          objective: "Process shakacode/react_on_rails and secret/repo.",
          targets: [
            { type: "pull_request", target: "4010", repo: "shakacode/react_on_rails" },
            { type: "issue", target: "99", repo: "secret/repo", title: "Private issue" }
          ],
          reservations: [{ type: "issue", target: "100", repo: "secret/repo", reason: "Private reservation" }],
          launchPrompt: [
            "Use $pr-batch to complete this batch with subagents.",
            "Repository: shakacode/react_on_rails, secret/repo",
            "Batch id: batch-1",
            "Items:",
            "- PR #4010: https://github.com/shakacode/react_on_rails/pull/4010",
            "- Issue #99: https://github.com/secret/repo/issues/99"
          ].join("\n"),
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            },
            {
              name: "lane-b",
              owner: "worker-b",
              targets: ["99"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [preview],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches).toHaveLength(1);
    expect(model.batches[0].lanes.map((lane) => lane.targets)).toEqual([["4010"]]);
    expect(model.batches[0].targets).toEqual([{ type: "pull_request", target: "4010", repo: "shakacode/react_on_rails" }]);
    expect(model.batches[0].reservations).toEqual([]);
    expect(model.batches[0].objective).toBeUndefined();
    expect(model.batches[0].launchPrompt).toBeUndefined();
  });

  it("keeps repo-less retained prompt metadata when every referenced repo is in scope", () => {
    const launchPrompt = [
      "Use $pr-batch to complete this batch with subagents.",
      "Repository: repo-a/app, repo-b/api",
      "Batch id: multi-repo-batch",
      "Batch objective: Process visible repos.",
      "Items:",
      "- PR #12: https://github.com/repo-a/app/pull/12",
      "- Issue #34: https://github.com/repo-b/api/issues/34"
    ].join("\n");
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["repo-a/app", "repo-b/api"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "multi-repo-batch",
          objective: "Process visible repos.",
          targets: [
            { type: "pull_request", target: "12", repo: "repo-a/app" },
            { type: "issue", target: "34", repo: "repo-b/api" }
          ],
          reservations: [],
          launchPrompt,
          path: "batches/multi-repo-batch.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["12"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            },
            {
              name: "lane-b",
              owner: "worker-b",
              targets: ["34"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches).toHaveLength(1);
    expect(model.batches[0].objective).toBe("Process visible repos.");
    expect(model.batches[0].launchPrompt).toBe(launchPrompt);
  });

  it("summarizes batch control events and separate QA validation state", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-1.json",
          targets: [{ type: "pull_request", target: "4010" }],
          lanes: [
            {
              name: "qa",
              owner: "worker-qa",
              targets: ["4010"],
              dependsOn: [],
              status: "ready_for_qa",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "stop-1",
          type: "batch.stop_requested",
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          status: "stop_requested",
          timestamp: "2026-06-17T20:00:00Z",
          path: "events/batches/batch-1.jsonl:1"
        },
        {
          eventId: "qa-1",
          type: "qa.validation_passed",
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          target: "4010",
          status: "passed",
          timestamp: "2026-06-17T20:05:00Z",
          path: "events/batches/batch-1.jsonl:2"
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:10:00Z")
    });

    expect(model.batchOperations).toEqual([
      expect.objectContaining({
        batchId: "batch-1",
        controlStatus: "stop_requested",
        eventCount: 2,
        latestEventType: "qa.validation_passed",
        qa: expect.objectContaining({ passed: 1, missing: 0 })
      })
    ]);
    expect(model.qaValidations).toEqual([
      expect.objectContaining({
        repo: "shakacode/react_on_rails",
        target: "4010",
        batchId: "batch-1",
        laneName: "qa",
        status: "passed"
      })
    ]);
  });

  it("does not count a QA event from an older batch as validation for the current batch", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-current",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-current.json",
          targets: [{ type: "pull_request", target: "4010" }],
          lanes: [
            {
              name: "qa",
              owner: "worker-qa",
              targets: ["4010"],
              dependsOn: [],
              status: "ready_for_qa",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "qa-old",
          type: "qa.validation_passed",
          batchId: "batch-old",
          repo: "shakacode/react_on_rails",
          target: "4010",
          status: "passed",
          timestamp: "2026-06-17T20:05:00Z",
          path: "events/batch-old.jsonl:1"
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:10:00Z")
    });

    expect(model.qaValidations).toEqual([
      expect.objectContaining({
        target: "4010",
        batchId: "batch-current",
        status: "missing",
        latestEvent: undefined
      })
    ]);
    expect(model.batchOperations[0].qa).toEqual(
      expect.objectContaining({
        total: 1,
        missing: 1,
        passed: 0
      })
    );
  });

  it("tracks QA validation separately for each retained batch signal on the same PR", () => {
    const batch = (batchId: string, laneName: string) => ({
      schemaVersion: 1,
      batchId,
      repo: "shakacode/react_on_rails",
      path: `batches/${batchId}.json`,
      targets: [{ type: "pull_request" as const, target: "4010" }],
      lanes: [
        {
          name: laneName,
          owner: "worker-qa",
          targets: ["4010"],
          dependsOn: [],
          status: "queued",
          liveness: "no-heartbeat" as const,
          blockedOn: []
        }
      ]
    });
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [batch("batch-old", "qa-old"), batch("batch-new", "qa-new")],
      events: [
        {
          eventId: "qa-old",
          type: "qa.validation_passed",
          batchId: "batch-old",
          repo: "shakacode/react_on_rails",
          target: "4010",
          status: "passed",
          timestamp: "2026-06-17T20:05:00Z",
          path: "events/batch-old.jsonl:1"
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:10:00Z")
    });

    expect(model.qaValidations.map((item) => [item.batchId, item.status])).toEqual([
      ["batch-old", "passed"],
      ["batch-new", "missing"]
    ]);
    expect(model.batchOperations.find((operation) => operation.batchId === "batch-old")?.qa).toEqual(
      expect.objectContaining({ passed: 1, missing: 0 })
    );
    expect(model.batchOperations.find((operation) => operation.batchId === "batch-new")?.qa).toEqual(
      expect.objectContaining({ passed: 0, missing: 1 })
    );
  });

  it("keeps batch-level stop requests for scoped repo-less batches", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "multi-repo-batch",
          path: "batches/multi-repo-batch.json",
          targets: [{ type: "pull_request", target: "4010", repo: "shakacode/react_on_rails" }],
          lanes: [
            {
              name: "qa",
              owner: "worker-qa",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "stop-1",
          type: "batch.stop_requested",
          batchId: "multi-repo-batch",
          laneName: "secret/repo-lane",
          agentId: "secret/repo-agent",
          machineId: "secret/repo-machine",
          status: "stop_requested",
          timestamp: "2026-06-17T20:05:00Z",
          path: "events/batches/multi-repo-batch.jsonl:1"
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:10:00Z")
    });

    expect(model.events).toEqual([
      expect.objectContaining({
        eventId: expect.stringContaining("multi-repo-batch:redacted:batch.stop_requested"),
        batchPath: "batches/multi-repo-batch.json",
        message: "Unscoped batch-level event details hidden by dashboard scoping."
      })
    ]);
    expect(model.events[0]).not.toHaveProperty("laneName");
    expect(model.events[0]).not.toHaveProperty("agentId");
    expect(model.events[0]).not.toHaveProperty("machineId");
    expect(model.batchOperations[0]).toEqual(
      expect.objectContaining({
        batchId: "multi-repo-batch",
        controlStatus: "stop_requested",
        eventCount: 1
      })
    );
  });

  it("attaches repo-only stop requests to matching repo-less multi-repo batches", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "multi-repo-batch",
          path: "batches/multi-repo-batch.json",
          targets: [
            { type: "pull_request", target: "4010", repo: "shakacode/react_on_rails" },
            { type: "pull_request", target: "99", repo: "secret/repo" }
          ],
          lanes: [
            {
              name: "qa",
              owner: "worker-qa",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "stop-1",
          type: "batch.stop_requested",
          batchId: "multi-repo-batch",
          repo: "shakacode/react_on_rails",
          status: "stop_requested",
          timestamp: "2026-06-17T20:05:00Z",
          path: "events/batches/multi-repo-batch.jsonl:1"
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:10:00Z")
    });

    expect(model.events).toEqual([
      expect.objectContaining({
        eventId: "stop-1",
        batchPath: "batches/multi-repo-batch.json"
      })
    ]);
    expect(model.batchOperations[0]).toEqual(
      expect.objectContaining({
        batchId: "multi-repo-batch",
        controlStatus: "stop_requested",
        eventCount: 1
      })
    );
  });

  it("drops unscoped non-control batch events for repo-less batches", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "multi-repo-batch",
          path: "batches/multi-repo-batch.json",
          targets: [
            { type: "pull_request", target: "4010", repo: "shakacode/react_on_rails" },
            { type: "pull_request", target: "99", repo: "secret/repo" }
          ],
          lanes: [
            {
              name: "visible",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "note-1",
          type: "batch.note",
          batchId: "multi-repo-batch",
          message: "secret/repo deployment details",
          timestamp: "2026-06-17T20:05:00Z",
          path: "events/batches/multi-repo-batch.jsonl:1"
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:10:00Z")
    });

    expect(model.events).toEqual([]);
    expect(model.batchOperations[0].eventCount).toBe(0);
  });

  it("treats explicit failed QA events as failed even when the message mentions pass", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-qa",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-qa.json",
          targets: [{ type: "pull_request", target: "4010" }],
          lanes: [
            {
              name: "qa",
              owner: "worker-qa",
              targets: ["4010"],
              dependsOn: [],
              status: "ready_for_qa",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "qa-failed",
          type: "qa.validation_failed",
          batchId: "batch-qa",
          repo: "shakacode/react_on_rails",
          target: "4010",
          status: "failed",
          message: "did not pass smoke tests",
          timestamp: "2026-06-17T20:05:00Z",
          path: "events/batch-qa.jsonl:1"
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:10:00Z")
    });

    expect(model.qaValidations[0]).toEqual(expect.objectContaining({ status: "failed" }));
    expect(model.batchOperations[0].qa).toEqual(expect.objectContaining({ failed: 1, passed: 0 }));
  });

  it("classifies documented QA validation event types without redundant status fields", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-qa",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-qa.json",
          targets: [{ type: "pull_request", target: "4010" }],
          lanes: [
            {
              name: "qa",
              owner: "worker-qa",
              targets: ["4010"],
              dependsOn: [],
              status: "ready_for_qa",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "qa-passed",
          type: "qa.validation_passed",
          batchId: "batch-qa",
          repo: "shakacode/react_on_rails",
          target: "4010",
          timestamp: "2026-06-17T20:05:00Z",
          path: "events/batch-qa.jsonl:1"
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:10:00Z")
    });

    expect(model.qaValidations[0]).toEqual(expect.objectContaining({ status: "passed" }));
    expect(model.batchOperations[0].qa).toEqual(expect.objectContaining({ passed: 1, unknown: 0 }));
  });

  it("does not treat ordinary lane events that mention QA as separate QA validation", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-qa",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-qa.json",
          targets: [{ type: "pull_request", target: "4010" }],
          lanes: [
            {
              name: "implementation",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "ready_for_qa",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "lane-done",
          type: "lane.done",
          batchId: "batch-qa",
          repo: "shakacode/react_on_rails",
          target: "4010",
          status: "ready_for_qa",
          message: "implementation is ready for QA",
          timestamp: "2026-06-17T20:05:00Z",
          path: "events/batch-qa.jsonl:1"
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:10:00Z")
    });

    expect(model.qaValidations[0]).toEqual(expect.objectContaining({ status: "missing", latestEvent: undefined }));
    expect(model.batchOperations[0].qa).toEqual(expect.objectContaining({ missing: 1, passed: 0 }));
  });

  it("treats explicit stopped events as stopped even when the message mentions stop requested", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-stop",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-stop.json",
          targets: [{ type: "pull_request", target: "4010" }],
          lanes: [
            {
              name: "qa",
              owner: "worker-qa",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "stop-request",
          type: "batch.stop_requested",
          batchId: "batch-stop",
          repo: "shakacode/react_on_rails",
          status: "stop_requested",
          timestamp: "2026-06-17T20:05:00Z",
          path: "events/batch-stop.jsonl:1"
        },
        {
          eventId: "stopped",
          type: "batch.stopped",
          batchId: "batch-stop",
          repo: "shakacode/react_on_rails",
          status: "stopped",
          message: "stopped after stop requested",
          timestamp: "2026-06-17T20:06:00Z",
          path: "events/batch-stop.jsonl:2"
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:10:00Z")
    });

    expect(model.batchOperations[0]).toEqual(expect.objectContaining({ controlStatus: "stopped" }));
  });

  it("does not infer batch stop status from free-form event messages", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-running",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-running.json",
          targets: [{ type: "pull_request", target: "4010" }],
          lanes: [
            {
              name: "implementation",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "lane-done",
          type: "lane.done",
          batchId: "batch-running",
          repo: "shakacode/react_on_rails",
          target: "4010",
          status: "done",
          message: "No stop requested; worker completed normally.",
          timestamp: "2026-06-17T20:06:00Z",
          path: "events/batch-running.jsonl:1"
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:10:00Z")
    });

    expect(model.batchOperations[0]).toEqual(expect.objectContaining({ controlStatus: "running" }));
  });

  it("redacts repo-scoped retained prompt metadata outside target repository scope", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          objective: "Process shakacode/react_on_rails and secret/repo.",
          targets: [
            { type: "pull_request", target: "4010", repo: "shakacode/react_on_rails" },
            { type: "issue", target: "99", repo: "secret/repo", title: "Private issue" }
          ],
          reservations: [{ type: "issue", target: "100", repo: "secret/repo", reason: "Private reservation" }],
          launchPrompt: [
            "Use $pr-batch to complete this batch with subagents.",
            "Repository: shakacode/react_on_rails, secret/repo",
            "Batch id: batch-1",
            "Items:",
            "- PR #4010: https://github.com/shakacode/react_on_rails/pull/4010",
            "- Issue #99: https://github.com/secret/repo/issues/99"
          ].join("\n"),
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [preview],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches).toHaveLength(1);
    expect(model.batches[0].lanes.map((lane) => lane.targets)).toEqual([["4010"]]);
    expect(model.batches[0].targets).toEqual([{ type: "pull_request", target: "4010", repo: "shakacode/react_on_rails" }]);
    expect(model.batches[0].reservations).toEqual([]);
    expect(model.batches[0].objective).toBeUndefined();
    expect(model.batches[0].launchPrompt).toBeUndefined();
  });

  it("does not redact retained prompt metadata for local source paths", () => {
    const launchPrompt = [
      "Use $pr-batch to complete this batch with subagents.",
      "Repository: shakacode/react_on_rails",
      "Batch id: batch-source-paths",
      "Batch objective: Fix src/server/app.ts and docs/coordination-telemetry-contract.md.",
      "Items:",
      "- PR #4010: https://github.com/shakacode/react_on_rails/pull/4010",
      "  Context: fix src/server/app.ts and client/components/BatchesTab.tsx"
    ].join("\n");
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-source-paths",
          repo: "shakacode/react_on_rails",
          objective: "Fix src/server/app.ts and docs/coordination-telemetry-contract.md.",
          targets: [
            {
              type: "pull_request",
              target: "4010",
              url: "https://github.com/shakacode/react_on_rails/pull/4010",
              title: "fix src/server/app.ts and client/components/BatchesTab.tsx"
            }
          ],
          reservations: [],
          launchPrompt,
          path: "batches/batch-source-paths.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].objective).toContain("src/server/app.ts");
    expect(model.batches[0].launchPrompt).toBe(launchPrompt);
    expect(model.batches[0].targets).toEqual([
      expect.objectContaining({ target: "4010", title: "fix src/server/app.ts and client/components/BatchesTab.tsx" })
    ]);
  });

  it("drops repo-less reservations when their free-form metadata references out-of-scope repos", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          targets: [{ type: "pull_request", target: "4010", repo: "shakacode/react_on_rails" }],
          reservations: [
            {
              type: "pull_request",
              target: "99",
              reason: "Deferred because secret/repo owns the rollout."
            }
          ],
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [preview],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].reservations).toEqual([]);
  });

  it("drops lanes whose target number collides with out-of-scope target metadata", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["repo-a/app"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "repo-a/app",
          targets: [
            { type: "pull_request", target: "10", repo: "repo-a/app" },
            { type: "pull_request", target: "12", repo: "repo-a/app" },
            { type: "issue", target: "12", repo: "secret/repo" }
          ],
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "safe",
              owner: "worker-a",
              targets: ["10"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            },
            {
              name: "ambiguous",
              owner: "worker-b",
              targets: ["12"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].lanes.map((lane) => lane.name)).toEqual(["safe"]);
    expect(model.batches[0].targets).toEqual([{ type: "pull_request", target: "10", repo: "repo-a/app" }]);
  });

  it("does not override batch lanes with unrelated owner heartbeats", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [{ ...heartbeat, batchId: "other-batch", target: "9999", status: "complete" }],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          updatedAt: "2026-06-17T20:00:00Z",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005"],
              dependsOn: [],
              status: "blocked",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].lanes[0].status).toBe("blocked");
    expect(model.batches[0].lanes[0].liveness).toBe("no-heartbeat");
    expect(model.warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("owner heartbeat points at")])
    );
  });

  it("redacts repo-scoped batch dependencies outside retained lanes", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005"],
              dependsOn: ["other-batch:lane-x"],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [{ ...preview, target: "4005" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].lanes[0].dependsOn).toEqual(["outside TARGET_REPOS"]);
    expect(model.batches[0].lanes[0].blockedOn).toEqual(["outside TARGET_REPOS"]);
  });

  it("does not apply batch-only heartbeats across repo-scoped batch collisions", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails", "other/repo"],
      claims: [],
      heartbeats: [{ ...heartbeat, batchId: "batch-1", target: undefined, status: "in_progress" }],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        },
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "other/repo",
          path: "batches/other-batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["12"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [{ ...preview, target: "4005" }, { ...preview, repo: "other/repo", target: "12" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches.find((batch) => batch.repo === "shakacode/react_on_rails")?.lanes[0].status).toBe("in_progress");
    expect(model.batches.find((batch) => batch.repo === "other/repo")?.lanes[0].status).toBe("queued");
  });

  it("does not apply repo-less batch-only heartbeats to repo-scoped batches", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [{ ...heartbeat, repo: undefined, target: undefined, batchId: "batch-1", status: "in_progress" }],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [{ ...preview, target: "4005" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].lanes[0].status).toBe("queued");
    expect(model.batches[0].lanes[0].liveness).toBe("no-heartbeat");
  });

  it("matches batch heartbeats with targets to the correct lane", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [{ ...heartbeat, batchId: "batch-1", target: "4010", status: "in_progress" }],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            },
            {
              name: "lane-b",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [preview, { ...preview, target: "4005" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].lanes[0].status).toBe("queued");
    expect(model.batches[0].lanes[0].liveness).toBe("no-heartbeat");
    expect(model.batches[0].lanes[1].status).toBe("in_progress");
    expect(model.batches[0].lanes[1].liveness).toBe("live");
  });

  it("surfaces machine ids and scoped batch history events", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [{ ...claim, machineId: "m5", batchId: "batch-1" }],
      heartbeats: [{ ...heartbeat, machineId: "m5", batchId: "batch-1" }],
      batches: [],
      events: [
        {
          eventId: "event-1",
          type: "lane.started",
          batchId: "batch-1",
          machineId: "m5",
          agentId: "worker-a",
          repo: "shakacode/react_on_rails",
          target: "4005",
          timestamp: "2026-06-17T20:00:00Z",
          path: "events/batch-1.jsonl"
        },
        {
          eventId: "event-2",
          type: "lane.started",
          batchId: "batch-2",
          repo: "other/repo",
          timestamp: "2026-06-17T20:00:00Z",
          path: "events/batch-2.jsonl"
        }
      ],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.agents[0].machineId).toBe("m5");
    expect(model.events).toHaveLength(1);
    expect(model.events[0].eventId).toBe("event-1");
    expect(model.healthItems.some((item) => item.title.includes("missing machine id"))).toBe(false);
  });

  it("attaches history to the matching retained batch path", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails", "other/repo"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          path: "batches/react-batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        },
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "other/repo",
          path: "batches/other-batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-b",
              targets: ["12"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "react-event",
          type: "lane.started",
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          target: "4005",
          timestamp: "2026-06-17T20:00:00Z",
          path: "events/batch-1.jsonl#1"
        },
        {
          eventId: "other-event",
          type: "lane.started",
          batchId: "batch-1",
          repo: "other/repo",
          target: "12",
          timestamp: "2026-06-17T20:00:01Z",
          path: "events/batch-1.jsonl#2"
        },
        {
          eventId: "ambiguous-event",
          type: "lane.started",
          batchId: "batch-1",
          target: "4005",
          timestamp: "2026-06-17T20:00:02Z",
          path: "events/batch-1.jsonl#3"
        }
      ],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.events.map((event) => [event.eventId, event.batchPath])).toEqual([
      ["other-event", "batches/other-batch-1.json"],
      ["react-event", "batches/react-batch-1.json"]
    ]);
  });

  it("does not attach repo-scoped events to repo-less batches by target number alone", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails", "other/repo"],
      claims: [{ ...claim, target: "4010", batchId: "batch-1" }],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "other-event",
          type: "lane.started",
          batchId: "batch-1",
          repo: "other/repo",
          target: "4010",
          timestamp: "2026-06-17T20:00:00Z",
          path: "events/batch-1.jsonl"
        },
        {
          eventId: "react-event",
          type: "lane.started",
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          target: "4010",
          timestamp: "2026-06-17T20:00:01Z",
          path: "events/batch-1.jsonl"
        }
      ],
      githubItems: [preview],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.events.find((event) => event.eventId === "react-event")?.batchPath).toBe("batches/batch-1.json");
    expect(model.events.find((event) => event.eventId === "other-event")?.batchPath).toBeUndefined();
  });

  it("drops target metadata that points at repositories outside the dashboard scope", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          objective: "Process scoped and hidden targets.",
          targets: [
            {
              type: "pull_request",
              target: "4010",
              url: "https://github.com/shakacode/react_on_rails/pull/4010",
              title: "Scoped PR"
            },
            {
              type: "pull_request",
              target: "12",
              url: "https://github.com/other/private-repo/pull/12",
              title: "other/private-repo implementation detail"
            }
          ],
          launchPrompt:
            "Use $pr-batch.\nRepository: shakacode/react_on_rails\nBatch id: batch-1\nItems:\n- PR #4010\n- PR #12",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4010", "12"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      events: [
        {
          eventId: "visible-event",
          type: "lane.done",
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          target: "4010",
          timestamp: "2026-06-17T20:00:01Z",
          path: "events/batch-1.jsonl:1"
        },
        {
          eventId: "hidden-event",
          type: "lane.done",
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          target: "12",
          message: "Hidden target detail from other/private-repo.",
          timestamp: "2026-06-17T20:00:02Z",
          path: "events/batch-1.jsonl:2"
        }
      ],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].targets).toEqual([
      expect.objectContaining({
        target: "4010",
        url: "https://github.com/shakacode/react_on_rails/pull/4010",
        title: "Scoped PR"
      })
    ]);
    expect(model.batches[0].lanes[0].targets).toEqual(["4010"]);
    expect(model.batches[0].objective).toBeUndefined();
    expect(model.batches[0].launchPrompt).toBeUndefined();
    expect(model.events).toEqual([expect.objectContaining({ eventId: "visible-event", batchPath: "batches/batch-1.json" })]);
  });

  it("drops retained lanes whose metadata references repositories outside the dashboard scope", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          targets: [{ type: "pull_request", target: "4010" }],
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "visible-lane",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            },
            {
              name: "blocked-by-secret/repo",
              owner: "worker-b",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [{ ...preview, target: "4010", type: "pull_request" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].lanes.map((lane) => lane.name)).toEqual(["visible-lane"]);
    expect(model.workItems.find((item) => item.target === "4010")?.batchSignals).toEqual([
      { batchId: "batch-1", laneName: "visible-lane", status: "queued", blockedOn: [] }
    ]);
  });

  it("reports batch lanes without heartbeats or history", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4010"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [preview],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.healthItems.map((item) => item.title)).toEqual(
      expect.arrayContaining(["Batch lane has no heartbeat", "Batch has no history events"])
    );
  });

  it("warns when retained batch manifests are missing launch prompts", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          objective: "Process a retained manifest without prompt metadata.",
          targets: [{ type: "pull_request", target: "4005" }],
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [{ ...preview, target: "4005" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.healthItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "batch",
          severity: "warning",
          title: "Prompt missing",
          detail: expect.stringContaining("batch-1")
        })
      ])
    );
  });

  it("warns when launch prompt targets and manifest targets do not match", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          objective: "Process mismatched prompt targets.",
          targets: [
            { type: "pull_request", target: "4005" },
            { type: "issue", target: "4011" }
          ],
          launchPrompt: [
            "Use $pr-batch to complete this batch with subagents.",
            "Repository: shakacode/react_on_rails",
            "Batch id: batch-1",
            "Batch objective: Process mismatched prompt targets.",
            "Items:",
            "- PR #4005: https://github.com/shakacode/react_on_rails/pull/4005",
            "- Issue #4010: https://github.com/shakacode/react_on_rails/issues/4010"
          ].join("\n"),
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005", "4011"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [{ ...preview, target: "4005" }, { ...preview, target: "4010" }, { ...preview, target: "4011" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.healthItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "batch",
          severity: "warning",
          title: "Prompt target mismatch",
          detail: expect.stringContaining("prompt has shakacode/react_on_rails:issue#4010")
        })
      ])
    );
    expect(model.healthItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Prompt target mismatch",
          detail: expect.stringContaining("manifest has shakacode/react_on_rails:issue#4011")
        })
      ])
    );
  });

  it("warns when launch prompt and manifest targets share a number but differ by repo", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["repo-a/app", "repo-b/api"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          targets: [{ type: "pull_request", target: "12", repo: "repo-a/app" }],
          launchPrompt: [
            "Use $pr-batch to complete this batch with subagents.",
            "Repository: repo-b/api",
            "Batch id: batch-1",
            "Items:",
            "- PR #12: https://github.com/repo-b/api/pull/12"
          ].join("\n"),
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["12"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.healthItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Prompt target mismatch",
          detail: expect.stringContaining("repo-b/api:pull_request#12")
        })
      ])
    );
    expect(model.healthItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Prompt target mismatch",
          detail: expect.stringContaining("repo-a/app:pull_request#12")
        })
      ])
    );
  });

  it("keeps generated launch prompts that mention the retained batches path", () => {
    const launchPrompt = [
      "Use $pr-batch to complete this batch with subagents.",
      "Repository: shakacode/react_on_rails",
      "Batch id: batch-1",
      "Batch objective: Process generated prompt.",
      "Items:",
      "- PR #4005: https://github.com/shakacode/react_on_rails/pull/4005",
      "Execution rules:",
      "- Before spawning workers, create the private retained batch manifest at batches/batch-1.json with batch_id, repo, objective, targets, lanes, reservations, created_at, created_by_machine, and launch_prompt."
    ].join("\n");
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          objective: "Process generated prompt.",
          targets: [{ type: "pull_request", target: "4005" }],
          launchPrompt,
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [{ ...preview, target: "4005" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].launchPrompt).toBe(launchPrompt);
    expect(model.healthItems.map((item) => item.title)).not.toContain("Prompt missing");
  });

  it("redacts launch prompts with free-form out-of-scope repo references", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          objective: "Process visible repo.",
          targets: [{ type: "pull_request", target: "4005" }],
          launchPrompt: [
            "Use $pr-batch to complete this batch with subagents.",
            "Repository: shakacode/react_on_rails",
            "Batch id: batch-1",
            "Items:",
            "- PR #4005: https://github.com/shakacode/react_on_rails/pull/4005",
            "  Context: blocked by secret/repo."
          ].join("\n"),
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [{ ...preview, target: "4005" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].launchPrompt).toBeUndefined();
  });

  it("redacts launch prompts with out-of-scope repos whose owner looks like a local path segment", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["shakacode/react_on_rails"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-1",
          repo: "shakacode/react_on_rails",
          objective: "Process visible repo.",
          targets: [{ type: "pull_request", target: "4005" }],
          launchPrompt: [
            "Use $pr-batch to complete this batch with subagents.",
            "Repository: shakacode/react_on_rails",
            "Batch id: batch-1",
            "Items:",
            "- PR #4005: https://github.com/shakacode/react_on_rails/pull/4005",
            "  Context: blocked by src/platform."
          ].join("\n"),
          path: "batches/batch-1.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["4005"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [{ ...preview, target: "4005" }],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.batches[0].launchPrompt).toBeUndefined();
  });

  it("reports unparseable retained launch prompts as health warnings", () => {
    const model = buildDashboardModel({
      stateRoot: "/state",
      targetRepos: ["repo-a/app", "repo-b/api"],
      claims: [],
      heartbeats: [],
      batches: [
        {
          schemaVersion: 1,
          batchId: "multi-repo-same-number",
          repo: "repo-a/app",
          targets: [
            { type: "pull_request", target: "12", repo: "repo-a/app" },
            { type: "pull_request", target: "12", repo: "repo-b/api" }
          ],
          launchPrompt: [
            "Use $pr-batch to complete this batch with subagents.",
            "Repository: repo-a/app, repo-b/api",
            "Batch id: multi-repo-same-number",
            "Items:",
            "- PR #12: https://github.com/repo-a/app/pull/12",
            "- PR #12: https://github.com/repo-b/api/pull/12"
          ].join("\n"),
          path: "batches/multi-repo-same-number.json",
          lanes: [
            {
              name: "lane-a",
              owner: "worker-a",
              targets: ["12"],
              dependsOn: [],
              status: "queued",
              liveness: "no-heartbeat",
              blockedOn: []
            }
          ]
        }
      ],
      githubItems: [],
      warnings: [],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.healthItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "batch",
          severity: "warning",
          title: "Prompt parse failed",
          detail: expect.stringContaining("duplicate PR/issue number")
        })
      ])
    );
  });
});
