import { describe, expect, it } from "vitest";
import { effectiveCustody } from "./effectiveCustody";
import type { WorkItem } from "./types";

const item = {
  claim: { schemaVersion: 1, repo: "repo/app", target: "47", agentId: "holder-a", status: "active", path: "claims/47.json" },
  heartbeat: { schemaVersion: 1, agentId: "holder-b", status: "reviewing", updatedAt: "2026-07-12T10:00:00Z", expiresAt: "2026-07-12T10:05:00Z", liveness: "live", path: "heartbeats/b.json" }
} satisfies Pick<WorkItem, "claim" | "heartbeat">;

describe("effectiveCustody", () => {
  it("fences a heartbeat from a different active claim holder", () => {
    expect(effectiveCustody(item)).toEqual({ claim: item.claim, heartbeat: undefined });
  });

  it("uses heartbeat evidence when there is no active claim", () => {
    expect(effectiveCustody({ ...item, claim: { ...item.claim, status: "released" } })).toEqual({ claim: undefined, heartbeat: item.heartbeat });
  });

  it("keeps a same-holder heartbeat alongside the active claim", () => {
    const sameHolder = { ...item.heartbeat, agentId: "holder-a" };
    expect(effectiveCustody({ ...item, heartbeat: sameHolder })).toEqual({ claim: item.claim, heartbeat: sameHolder });
  });
});
