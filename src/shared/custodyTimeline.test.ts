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
        claim({ agentId: "worker-a", status: "released", path: "claims/shakacode/dashboard/history/46-first.json", generation: 4, threadHandle: "first-chat", branch: "codex/first" }),
        claim({ agentId: "worker-b", generation: 5, threadHandle: "takeover-chat", claimedAt: "2026-07-12T10:03:00Z", branch: "codex/takeover", prUrl: "https://github.com/shakacode/dashboard/pull/47" })
      ],
      heartbeats: [heartbeat({ threadHandle: "takeover-chat" })],
      events: [
        event({ eventId: "start", type: "lane.started", agentId: "worker-a", machineId: "m1", threadHandle: "first-chat", branch: "codex/first", timestamp: "2026-07-12T10:00:00Z" }),
        event({ eventId: "renew", type: "heartbeat", agentId: "worker-a", machineId: "m1", threadHandle: "first-chat", timestamp: "2026-07-12T10:01:00Z" }),
        event({ eventId: "takeover", type: "continued", agentId: "worker-b", machineId: "m2", threadHandle: "takeover-chat", branch: "codex/takeover", prUrl: "https://github.com/shakacode/dashboard/pull/47", timestamp: "2026-07-12T10:03:00Z" }),
        event({ eventId: "plan", status: "planning", agentId: "worker-b", timestamp: "2026-07-12T10:04:00Z" }),
        event({ eventId: "implement", status: "implementing", timestamp: "2026-07-12T10:05:00Z" })
      ]
    });

    expect(timeline.claims).toEqual([
      expect.objectContaining({ action: "acquired", agentId: "worker-a", machineId: "m1" }),
      expect.objectContaining({ action: "renewed", agentId: "worker-a" }),
      expect.objectContaining({ action: "taken_over", agentId: "worker-b", previousAgentId: "worker-a", machineId: "m2" })
    ]);
    expect(timeline.phases).toEqual([
      expect.objectContaining({ phase: "planning", durationMs: 60_000 }),
      expect.objectContaining({ phase: "implementing", durationMs: 300_000 })
    ]);
    expect(timeline.branches).toEqual(["codex/first", "codex/takeover"]);
    expect(timeline.prUrls).toEqual(["https://github.com/shakacode/dashboard/pull/47"]);
  });

  it("treats an acquisition after an append-only release event as a new custody chain", () => {
    const event = (overrides: Partial<BatchEvent>): BatchEvent => ({
      eventId: "event",
      type: "lane.started",
      repo: "shakacode/dashboard",
      target: "46",
      path: "history/batch.jsonl:1",
      timestamp: "2026-07-12T10:00:00Z",
      ...overrides
    });
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      claims: [],
      heartbeats: [],
      events: [
        event({ eventId: "a", agentId: "worker-a" }),
        event({ eventId: "release", type: "lane.handoff", agentId: "worker-a", timestamp: "2026-07-12T10:05:00Z" }),
        event({ eventId: "b", agentId: "worker-b", timestamp: "2026-07-12T10:06:00Z" })
      ]
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

  it("clips old-holder liveness at telemetry transfer and release boundaries", () => {
    const heartbeat = (overrides: Partial<HeartbeatRecord>): HeartbeatRecord => ({
      schemaVersion: 1,
      repo: "shakacode/dashboard",
      target: "46",
      agentId: "worker-a",
      status: "implementing",
      updatedAt: "2026-07-12T10:00:00Z",
      expiresAt: "2026-07-12T10:05:00Z",
      path: "heartbeats/worker-a.json",
      liveness: "live",
      ...overrides
    });
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:30:00Z"),
      claims: [],
      heartbeats: [
        heartbeat({ agentId: "worker-a" }),
        heartbeat({ agentId: "worker-b", updatedAt: "2026-07-12T10:10:00Z", expiresAt: "2026-07-12T10:15:00Z" })
      ],
      events: [
        { eventId: "a", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", path: "events/custody.jsonl:1" },
        { eventId: "b", type: "continued", repo: "shakacode/dashboard", target: "46", agentId: "worker-b", timestamp: "2026-07-12T10:10:00Z", path: "events/custody.jsonl:2" },
        { eventId: "released", type: "lane.handoff", repo: "shakacode/dashboard", target: "46", agentId: "worker-b", timestamp: "2026-07-12T10:20:00Z", path: "events/custody.jsonl:3" }
      ]
    });

    expect(timeline.liveness.filter((span) => span.agentId === "worker-a").every((span) => span.endedAt <= "2026-07-12T10:10:00.000Z")).toBe(true);
    expect(timeline.liveness.filter((span) => span.agentId === "worker-b").every((span) => span.endedAt <= "2026-07-12T10:20:00.000Z")).toBe(true);
  });
});
