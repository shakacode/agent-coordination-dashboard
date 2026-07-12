import { describe, expect, it } from "vitest";
import type { BatchEvent, ClaimRecord, HeartbeatRecord } from "./types";
import { buildCustodyTimeline, buildLivenessSpans } from "./custodyTimeline";

function heartbeat(overrides: Partial<HeartbeatRecord>): HeartbeatRecord {
  return {
    schemaVersion: 1,
    agentId: "worker-a",
    repo: "shakacode/dashboard",
    target: "46",
    status: "implementing",
    updatedAt: "2026-07-12T10:00:00Z",
    expiresAt: "2026-07-12T10:05:00Z",
    path: "heartbeats/worker-a.json",
    liveness: "live",
    ...overrides
  };
}

describe("buildLivenessSpans", () => {
  it("renders live, stale, and dead spans before a later renewal", () => {
    const spans = buildLivenessSpans(
      [
        heartbeat({ updatedAt: "2026-07-12T10:00:00Z", expiresAt: "2026-07-12T10:05:00Z" }),
        heartbeat({ updatedAt: "2026-07-12T10:30:00Z", expiresAt: "2026-07-12T10:35:00Z", status: "verifying" })
      ],
      new Date("2026-07-12T10:32:00Z")
    );

    expect(spans).toEqual([
      expect.objectContaining({ liveness: "live", startedAt: "2026-07-12T10:00:00.000Z", endedAt: "2026-07-12T10:05:00.000Z" }),
      expect.objectContaining({ liveness: "stale", startedAt: "2026-07-12T10:05:00.000Z", endedAt: "2026-07-12T10:20:00.000Z" }),
      expect.objectContaining({ liveness: "dead", startedAt: "2026-07-12T10:20:00.000Z", endedAt: "2026-07-12T10:30:00.000Z" }),
      expect.objectContaining({ liveness: "live", startedAt: "2026-07-12T10:30:00.000Z", endedAt: "2026-07-12T10:32:00.000Z", status: "verifying" })
    ]);
  });

  it("ends a prior thread span when the same holder renews from another chat", () => {
    const spans = buildLivenessSpans(
      [
        heartbeat({ threadHandle: "first-chat", updatedAt: "2026-07-12T10:00:00Z", expiresAt: "2026-07-12T10:05:00Z" }),
        heartbeat({ threadHandle: "resumed-chat", updatedAt: "2026-07-12T10:10:00Z", expiresAt: "2026-07-12T10:15:00Z" })
      ],
      new Date("2026-07-12T10:11:00Z")
    );

    expect(spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadHandle: "first-chat", liveness: "stale", endedAt: "2026-07-12T10:10:00.000Z" }),
      expect.objectContaining({ threadHandle: "resumed-chat", liveness: "live", startedAt: "2026-07-12T10:10:00.000Z" })
    ]));
  });
});

describe("buildCustodyTimeline", () => {
  it("keeps the claim custody chain, phase durations, and anchors for one target", () => {
    const claim = (overrides: Partial<ClaimRecord>): ClaimRecord => ({
      schemaVersion: 1,
      repo: "shakacode/dashboard",
      target: "46",
      agentId: "worker-a",
      status: "active",
      path: "claims/shakacode/dashboard/46.json",
      claimedAt: "2026-07-12T10:00:00Z",
      ...overrides
    });
    const event = (overrides: Partial<BatchEvent>): BatchEvent => ({
      eventId: "event",
      type: "phase",
      repo: "shakacode/dashboard",
      target: "46",
      path: "events/batch.jsonl:1",
      timestamp: "2026-07-12T10:00:00Z",
      ...overrides
    });

    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [
        claim({ agentId: "worker-a", generation: 4, threadHandle: "first-chat", branch: "codex/first" }),
        claim({ agentId: "worker-b", generation: 5, threadHandle: "takeover-chat", claimedAt: "2026-07-12T10:03:00Z", branch: "codex/takeover", prUrl: "https://github.com/shakacode/dashboard/pull/47" }),
        claim({ agentId: "worker-b", status: "released", updatedAt: "2026-07-12T10:08:00Z" })
      ],
      heartbeats: [heartbeat({ threadHandle: "takeover-chat" })],
      events: [
        event({ eventId: "plan", status: "planning", timestamp: "2026-07-12T10:00:00Z" }),
        event({ eventId: "implement", status: "implementing", timestamp: "2026-07-12T10:05:00Z" })
      ]
    });

    expect(timeline.claims).toEqual([
      expect.objectContaining({ action: "acquired", agentId: "worker-a", generation: 4 }),
      expect.objectContaining({ action: "taken_over", agentId: "worker-b", previousAgentId: "worker-a", generation: 5 }),
      expect.objectContaining({ action: "released", agentId: "worker-b" })
    ]);
    expect(timeline.phases).toEqual([
      expect.objectContaining({ phase: "planning", durationMs: 300_000 }),
      expect.objectContaining({ phase: "implementing", durationMs: 300_000 })
    ]);
    expect(timeline.branches).toEqual(["codex/first", "codex/takeover"]);
    expect(timeline.prUrls).toEqual(["https://github.com/shakacode/dashboard/pull/47"]);
  });

  it("treats an acquisition after release as a new custody chain", () => {
    const claim = (overrides: Partial<ClaimRecord>): ClaimRecord => ({
      schemaVersion: 1,
      repo: "shakacode/dashboard",
      target: "46",
      agentId: "worker-a",
      status: "active",
      path: "claims/shakacode/dashboard/46.json",
      claimedAt: "2026-07-12T10:00:00Z",
      ...overrides
    });
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      claims: [
        claim({ agentId: "worker-a", claimedAt: "2026-07-12T10:00:00Z" }),
        claim({ agentId: "worker-a", status: "released", updatedAt: "2026-07-12T10:05:00Z" }),
        claim({ agentId: "worker-b", claimedAt: "2026-07-12T10:06:00Z" })
      ],
      heartbeats: [],
      events: []
    });

    expect(timeline.claims.map((event) => event.action)).toEqual(["acquired", "released", "acquired"]);
    expect(timeline.claims[2]).not.toHaveProperty("previousAgentId");
  });

  it("ends the final phase at the first terminal lifecycle event", () => {
    const event = (overrides: Partial<BatchEvent>): BatchEvent => ({
      eventId: "event",
      type: "phase",
      repo: "shakacode/dashboard",
      target: "46",
      path: "events/batch.jsonl:1",
      timestamp: "2026-07-12T10:00:00Z",
      ...overrides
    });
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:30:00Z"),
      claims: [],
      heartbeats: [],
      events: [
        event({ eventId: "implement", status: "implementing", timestamp: "2026-07-12T10:00:00Z" }),
        event({ eventId: "merged", type: "lifecycle", status: "merged", timestamp: "2026-07-12T10:05:00Z" })
      ]
    });

    expect(timeline.phases).toEqual([
      expect.objectContaining({ phase: "implementing", endedAt: "2026-07-12T10:05:00.000Z", durationMs: 300_000 })
    ]);
  });
});
