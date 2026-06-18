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
});

