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
        { severity: "warning", message: "Could not read coordination directory heartbeats: ENOENT" }
      ],
      now: new Date("2026-06-17T20:00:00Z")
    });

    expect(model.workItems.some((item) => item.repo === "other/repo")).toBe(false);
    expect(model.agents.some((agent) => agent.agentId === "other-worker")).toBe(false);
    expect(model.agents.some((agent) => agent.agentId === "idle-worker")).toBe(false);
    expect(model.warnings.some((warning) => warning.message.includes("claims/other/repo"))).toBe(false);
    expect(model.warnings.some((warning) => warning.message.includes("heartbeats/idle-worker"))).toBe(false);
    expect(model.warnings.some((warning) => warning.message.includes("Could not read coordination directory heartbeats"))).toBe(true);
    expect(model.warnings.some((warning) => warning.message === "Malformed JSON in an unscoped heartbeats record.")).toBe(true);
    expect(model.warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        "Skipped 1 claim records outside TARGET_REPOS.",
        "Skipped 2 heartbeat records outside TARGET_REPOS.",
        "Skipped 1 GitHub preview records outside TARGET_REPOS.",
        "Skipped 1 warning records outside TARGET_REPOS."
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
});
