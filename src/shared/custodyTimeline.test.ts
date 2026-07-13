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

  it("keeps heartbeat branch and PR anchors on liveness spans", () => {
    const spans = buildLivenessSpans(
      [heartbeat({ branch: "codex/live-span", prUrl: "https://github.com/shakacode/dashboard/pull/46" })],
      new Date("2026-07-12T10:01:00Z")
    );

    expect(spans[0]).toMatchObject({ branch: "codex/live-span", prUrl: "https://github.com/shakacode/dashboard/pull/46" });
  });

  it.each([
    ["equal expiry", "2026-07-12T10:00:00Z"],
    ["earlier expiry", "2026-07-12T09:59:00Z"]
  ])("renders a finite heartbeat with %s as dead until its custody boundary", (_description, expiresAt) => {
    const spans = buildLivenessSpans(
      [heartbeat({ updatedAt: "2026-07-12T10:00:00Z", expiresAt })],
      new Date("2026-07-12T10:10:00Z"),
      [{ agentId: "worker-a", endedAt: "2026-07-12T10:03:00Z" }]
    );

    expect(spans).toEqual([
      expect.objectContaining({
        liveness: "dead",
        startedAt: "2026-07-12T10:00:00.000Z",
        endedAt: "2026-07-12T10:03:00.000Z"
      })
    ]);
  });

  it.each([
    ["invalid update", "not-a-time", "2026-07-12T10:05:00Z"],
    ["invalid expiry", "2026-07-12T10:00:00Z", "not-a-time"],
    ["future update", "2026-07-12T10:11:00Z", "2026-07-12T10:12:00Z"]
  ])("keeps %s heartbeat timestamps out of observed liveness spans", (_description, updatedAt, expiresAt) => {
    expect(buildLivenessSpans(
      [heartbeat({ updatedAt, expiresAt })],
      new Date("2026-07-12T10:10:00Z")
    )).toEqual([]);
  });
});

describe("buildCustodyTimeline", () => {
  it("preserves source paths for phase spans with caller-supplied duplicate IDs", () => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [],
      heartbeats: [],
      events: [
        { eventId: "caller-supplied-id", type: "phase", status: "planning", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:00:00Z", path: "events/one.jsonl:1" },
        { eventId: "caller-supplied-id", type: "phase", status: "implementing", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:01:00Z", path: "history/two.jsonl:1" }
      ]
    });

    expect(timeline.phases.map((span) => [span.eventId, span.eventPath])).toEqual([
      ["caller-supplied-id", "events/one.jsonl:1"],
      ["caller-supplied-id", "history/two.jsonl:1"]
    ]);
  });

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
        claim({ agentId: "worker-b", generation: 5, machineId: "m2", threadHandle: "takeover-chat", claimedAt: "2026-07-12T10:03:00Z", branch: "codex/takeover", prUrl: "https://github.com/shakacode/dashboard/pull/47" })
      ],
      heartbeats: [heartbeat({ threadHandle: "takeover-chat" })],
      events: [
        event({ eventId: "start", type: "lane.started", agentId: "worker-a", machineId: "m1", threadHandle: "first-chat", branch: "codex/first", timestamp: "2026-07-12T10:00:00Z" }),
        event({ eventId: "renew", type: "heartbeat", agentId: "worker-a", machineId: "m1", threadHandle: "first-chat", timestamp: "2026-07-12T10:01:00Z" }),
        event({ eventId: "takeover", type: "continued", agentId: "worker-b", generation: 5, machineId: "m2", threadHandle: "takeover-chat", branch: "codex/takeover", prUrl: "https://github.com/shakacode/dashboard/pull/47", timestamp: "2026-07-12T10:03:00Z" }),
        event({ eventId: "plan", status: "planning", agentId: "worker-b", timestamp: "2026-07-12T10:04:00Z" }),
        event({ eventId: "implement", status: "implementing", timestamp: "2026-07-12T10:05:00Z" })
      ]
    });

    expect(timeline.claims).toEqual([
      expect.objectContaining({ action: "acquired", agentId: "worker-a", machineId: "m1", sourceEventId: "start", sourceEventPath: "events/batch.jsonl:1" }),
      expect.objectContaining({ action: "renewed", agentId: "worker-a", sourceEventId: "renew", sourceEventPath: "events/batch.jsonl:1" }),
      expect.objectContaining({ action: "taken_over", agentId: "worker-b", previousAgentId: "worker-a", machineId: "m2", sourceEventId: "takeover", sourceEventPath: "events/batch.jsonl:1" })
    ]);
    expect(timeline.events.map((event) => event.eventId)).toEqual(["start", "renew", "takeover", "plan", "implement"]);
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
        event({ eventId: "a", agentId: "worker-a", generation: 3 }),
        event({ eventId: "release", type: "lane.handoff", agentId: "worker-a", generation: 4, timestamp: "2026-07-12T10:05:00Z" }),
        event({ eventId: "b", agentId: "worker-b", generation: 5, timestamp: "2026-07-12T10:06:00Z" })
      ]
    });

    expect(timeline.claims).toEqual([
      expect.objectContaining({ action: "acquired", generation: 3 }),
      expect.objectContaining({ action: "released", generation: 4 }),
      expect.objectContaining({ action: "acquired", generation: 5 })
    ]);
    expect(timeline.claims[2]).not.toHaveProperty("previousAgentId");
  });

  it("uses a current released snapshot as custody and liveness-boundary evidence", () => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [{
        schemaVersion: 1,
        repo: "shakacode/dashboard",
        target: "46",
        agentId: "worker-a",
        status: "released",
        updatedAt: "2026-07-12T10:04:00Z",
        path: "claims/shakacode/dashboard/46.json"
      }],
      heartbeats: [heartbeat({ expiresAt: "2026-07-12T10:20:00Z" })],
      events: [{
        eventId: "started",
        type: "lane.started",
        repo: "shakacode/dashboard",
        target: "46",
        agentId: "worker-a",
        timestamp: "2026-07-12T10:00:00Z",
        path: "events/custody.jsonl:1"
      }]
    });

    expect(timeline.claims).toEqual([
      expect.objectContaining({ action: "acquired", agentId: "worker-a" }),
      expect.objectContaining({ action: "released", agentId: "worker-a", timestamp: "2026-07-12T10:04:00Z" })
    ]);
    expect(timeline.liveness.every((span) => span.endedAt <= "2026-07-12T10:04:00.000Z")).toBe(true);
  });

  it("places an older released snapshot before newer durable custody telemetry", () => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:20:00Z"),
      claims: [{
        schemaVersion: 1,
        repo: "shakacode/dashboard",
        target: "46",
        agentId: "worker-a",
        status: "released",
        updatedAt: "2026-07-12T10:05:00Z",
        path: "claims/shakacode/dashboard/46.json"
      }],
      heartbeats: [heartbeat({ agentId: "worker-a", expiresAt: "2026-07-12T10:30:00Z" })],
      events: [
        { eventId: "started", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", path: "events/custody.jsonl:1" },
        { eventId: "takeover", type: "continued", repo: "shakacode/dashboard", target: "46", agentId: "worker-b", timestamp: "2026-07-12T10:10:00Z", path: "events/custody.jsonl:2" }
      ]
    });

    expect(timeline.claims.map((claim) => [claim.action, claim.agentId, claim.timestamp])).toEqual([
      ["acquired", "worker-a", "2026-07-12T10:00:00Z"],
      ["released", "worker-a", "2026-07-12T10:05:00Z"],
      ["taken_over", "worker-b", "2026-07-12T10:10:00Z"]
    ]);
    expect(timeline.liveness.filter((span) => span.agentId === "worker-a").every((span) => span.endedAt <= "2026-07-12T10:05:00.000Z")).toBe(true);
  });

  it("ends phases at a released current-claim snapshot without terminal telemetry", () => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [{
        schemaVersion: 1,
        repo: "shakacode/dashboard",
        target: "46",
        agentId: "worker-a",
        status: "released",
        updatedAt: "2026-07-12T10:04:00Z",
        path: "claims/shakacode/dashboard/46.json"
      }],
      heartbeats: [],
      events: [{
        eventId: "implement",
        type: "phase",
        status: "implementing",
        repo: "shakacode/dashboard",
        target: "46",
        timestamp: "2026-07-12T10:00:00Z",
        path: "events/batch.jsonl:1"
      }]
    });

    expect(timeline.phases).toEqual([
      expect.objectContaining({ phase: "implementing", endedAt: "2026-07-12T10:04:00.000Z", durationMs: 240_000 })
    ]);
  });

  it("keeps a newer current snapshot as a distinct renewal instead of rewriting history", () => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      claims: [{
        schemaVersion: 1,
        repo: "shakacode/dashboard",
        target: "46",
        agentId: "worker-a",
        status: "active",
        generation: 2,
        machineId: "m2",
        threadHandle: "current-thread",
        updatedAt: "2026-07-12T10:05:00Z",
        path: "claims/shakacode/dashboard/46.json"
      }],
      heartbeats: [],
      events: [{
        eventId: "started",
        type: "lane.started",
        repo: "shakacode/dashboard",
        target: "46",
        agentId: "worker-a",
        generation: 1,
        machineId: "m1",
        threadHandle: "old-thread",
        timestamp: "2026-07-12T10:00:00Z",
        path: "events/custody.jsonl:1"
      }]
    });

    expect(timeline.claims).toEqual([
      expect.objectContaining({ action: "acquired", generation: 1, machineId: "m1", threadHandle: "old-thread" }),
      expect.objectContaining({ action: "renewed", generation: 2, machineId: "m2", threadHandle: "current-thread", timestamp: "2026-07-12T10:05:00Z" })
    ]);
  });

  it("ignores non-ownership telemetry until explicit continuation transfers custody", () => {
    const event = (overrides: Partial<BatchEvent>): BatchEvent => ({
      eventId: "event",
      type: "phase",
      repo: "shakacode/dashboard",
      target: "46",
      path: "history/batch.jsonl:1",
      timestamp: "2026-07-12T10:00:00Z",
      ...overrides
    });
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [],
      heartbeats: [heartbeat({ agentId: "worker-a", expiresAt: "2026-07-12T10:20:00Z" })],
      events: [
        event({ eventId: "started", type: "lane.started", agentId: "worker-a" }),
        event({ eventId: "resumed", type: "resumed", agentId: "worker-a", timestamp: "2026-07-12T10:01:00Z" }),
        event({ eventId: "qa", type: "qa.validation_started", agentId: "qa-agent", timestamp: "2026-07-12T10:02:00Z" }),
        event({ eventId: "phase", type: "phase", agentId: "phase-agent", timestamp: "2026-07-12T10:03:00Z" }),
        event({ eventId: "blocked", type: "blocked", agentId: "coordinator", timestamp: "2026-07-12T10:04:00Z" }),
        event({ eventId: "review", type: "review", agentId: "reviewer", timestamp: "2026-07-12T10:05:00Z" }),
        event({ eventId: "continued", type: "continued", agentId: "worker-b", timestamp: "2026-07-12T10:07:00Z" })
      ]
    });

    expect(timeline.claims).toEqual([
      expect.objectContaining({ action: "acquired", agentId: "worker-a" }),
      expect.objectContaining({ action: "renewed", agentId: "worker-a" }),
      expect.objectContaining({ action: "taken_over", agentId: "worker-b", previousAgentId: "worker-a" })
    ]);
    expect(timeline.liveness.every((span) => span.endedAt <= "2026-07-12T10:07:00.000Z")).toBe(true);
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

  it.each([
    ["closed type", { type: "closed" }, true],
    ["stopped type", { type: "stopped" }, true],
    ["final type", { type: "final" }, true],
    ["merged type", { type: "merged" }, true],
    ["complete type", { type: "complete" }, true],
    ["completed type", { type: "completed" }, true],
    ["cancel type", { type: "cancel" }, true],
    ["cancelled type", { type: "cancelled" }, true],
    ["canceled type", { type: "canceled" }, true],
    ["lane final type", { type: "lane.final" }, true],
    ["normalized lane merged type", { type: "lane_merged" }, true],
    ["normalized lane complete type", { type: "lane-complete" }, true],
    ["lane completed type", { type: "lane.completed" }, true],
    ["lane cancel type", { type: "lane.cancel" }, true],
    ["normalized lane cancelled type", { type: "lane-cancelled" }, true],
    ["normalized lane canceled type", { type: "lane_canceled" }, true],
    ["lane release type", { type: "lane.release" }, true],
    ["normalized lane release type", { type: "lane_release" }, true],
    ["hyphenated lane release type", { type: "lane-release" }, true],
    ["claim release type", { type: "claim.release" }, true],
    ["normalized claim release type", { type: "claim_release" }, true],
    ["hyphenated claim release type", { type: "claim-release" }, true],
    ["custody release type", { type: "custody.release" }, true],
    ["normalized custody release type", { type: "custody_release" }, true],
    ["hyphenated custody release type", { type: "custody-release" }, true],
    ["lane handoff type", { type: "lane.handoff" }, true],
    ["normalized lane handoff type", { type: "lane_handoff" }, true],
    ["hyphenated lane handoff type", { type: "lane-handoff" }, true],
    ["claim handoff type", { type: "claim.handoff" }, true],
    ["normalized claim handoff type", { type: "claim_handoff" }, true],
    ["hyphenated claim handoff type", { type: "claim-handoff" }, true],
    ["custody handoff type", { type: "custody.handoff" }, true],
    ["normalized custody handoff type", { type: "custody_handoff" }, true],
    ["hyphenated custody handoff type", { type: "custody-handoff" }, true],
    ["closed lifecycle status", { type: "lifecycle", status: "closed" }, true],
    ["stopped lifecycle status", { type: "lifecycle", status: "stopped" }, true],
    ["final lifecycle status", { type: "lifecycle", status: "final" }, true],
    ["merged lifecycle status", { type: "lifecycle", status: "merged" }, true],
    ["complete lifecycle status", { type: "lifecycle", status: "complete" }, true],
    ["completed lifecycle status", { type: "lifecycle", status: "completed" }, true],
    ["cancel lifecycle status", { type: "lifecycle", status: "cancel" }, true],
    ["cancelled lifecycle status", { type: "lifecycle", status: "cancelled" }, true],
    ["canceled lifecycle status", { type: "lifecycle", status: "canceled" }, true],
    ["unclosed type", { type: "unclosed" }, false],
    ["stoppable lifecycle status", { type: "lifecycle", status: "stoppable" }, false]
  ] as const)("handles %s without transferring custody to an inactive reporter", (_description, terminalEvent, terminal) => {
    const event = (overrides: Partial<BatchEvent>): BatchEvent => ({
      eventId: "event",
      type: "lifecycle",
      repo: "shakacode/dashboard",
      target: "46",
      timestamp: "2026-07-12T10:00:00Z",
      path: "events/batch.jsonl:1",
      ...overrides
    });
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [],
      heartbeats: [heartbeat({ agentId: "worker-a", expiresAt: "2026-07-12T10:20:00Z" })],
      events: [
        event({ eventId: "started", type: "lane.started", agentId: "worker-a" }),
        event({ eventId: "phase", type: "phase", status: "implementing", agentId: "worker-a", timestamp: "2026-07-12T10:01:00Z" }),
        event({ eventId: "coordinator-terminal", ...terminalEvent, agentId: "coordinator", timestamp: "2026-07-12T10:04:00Z" }),
        event({ eventId: "holder-terminal", ...terminalEvent, agentId: "worker-a", timestamp: "2026-07-12T10:05:00Z" })
      ]
    });

    expect(timeline.phases).toEqual([
      expect.objectContaining({
        phase: "implementing",
        endedAt: terminal ? "2026-07-12T10:04:00.000Z" : "2026-07-12T10:10:00.000Z",
        durationMs: terminal ? 180_000 : 540_000
      })
    ]);
    expect(timeline.claims).toEqual(terminal
      ? [
        expect.objectContaining({ action: "acquired", agentId: "worker-a" }),
        expect.objectContaining({ action: "released", agentId: "worker-a", timestamp: "2026-07-12T10:04:00Z" })
      ]
      : [expect.objectContaining({ action: "acquired", agentId: "worker-a" })]);
    expect(timeline.claims.some((entry) => entry.agentId === "coordinator")).toBe(false);
    expect(timeline.liveness.every((span) => span.endedAt <= (terminal ? "2026-07-12T10:04:00.000Z" : "2026-07-12T10:10:00.000Z"))).toBe(true);
  });

  it.each(["done", "lane.done"])("treats canonical %s as terminal while releasing custody only for the active holder", (doneType) => {
    const event = (overrides: Partial<BatchEvent>): BatchEvent => ({
      eventId: "event",
      type: "lifecycle",
      repo: "shakacode/dashboard",
      target: "46",
      timestamp: "2026-07-12T10:00:00Z",
      path: "events/batch.jsonl:1",
      ...overrides
    });
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [],
      heartbeats: [heartbeat({ agentId: "worker-a", expiresAt: "2026-07-12T10:20:00Z" })],
      events: [
        event({ eventId: "started", type: "lane.started", agentId: "worker-a" }),
        event({ eventId: "phase", type: "phase", status: "implementing", agentId: "worker-a", timestamp: "2026-07-12T10:01:00Z" }),
        event({ eventId: "coordinator-done", type: doneType, agentId: "coordinator", timestamp: "2026-07-12T10:04:00Z" }),
        event({ eventId: "holder-done", type: doneType, agentId: "worker-a", timestamp: "2026-07-12T10:05:00Z" })
      ]
    });

    expect(timeline.phases).toEqual([
      expect.objectContaining({ phase: "implementing", endedAt: "2026-07-12T10:04:00.000Z", durationMs: 180_000 })
    ]);
    expect(timeline.claims).toEqual([
      expect.objectContaining({ action: "acquired", agentId: "worker-a" }),
      expect.objectContaining({ action: "released", agentId: "worker-a", timestamp: "2026-07-12T10:04:00Z" })
    ]);
    expect(timeline.claims.some((entry) => entry.agentId === "coordinator")).toBe(false);
    expect(timeline.liveness.every((span) => span.endedAt <= "2026-07-12T10:04:00.000Z")).toBe(true);
  });

  it.each(["lane_closed", "lane_stopped"])("releases active custody for an unattributed canonical %s terminal event", (terminalType) => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [],
      heartbeats: [heartbeat({ agentId: "worker-a", expiresAt: "2026-07-12T10:20:00Z" })],
      events: [
        { eventId: "started", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", path: "events/custody.jsonl:1" },
        { eventId: "phase", type: "phase", status: "implementing", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:01:00Z", path: "events/custody.jsonl:2" },
        { eventId: "terminal", type: terminalType, repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:05:00Z", path: "events/custody.jsonl:3" }
      ]
    });

    expect(timeline.claims).toEqual([
      expect.objectContaining({ action: "acquired", agentId: "worker-a" }),
      expect.objectContaining({ action: "released", agentId: "worker-a", timestamp: "2026-07-12T10:05:00Z" })
    ]);
    expect(timeline.liveness.every((span) => span.endedAt <= "2026-07-12T10:05:00.000Z")).toBe(true);
    expect(timeline.phases).toEqual([
      expect.objectContaining({ phase: "implementing", endedAt: "2026-07-12T10:05:00.000Z", durationMs: 240_000 })
    ]);
  });

  it("does not release custody for a similar unattributed but nonterminal event", () => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [],
      heartbeats: [heartbeat({ agentId: "worker-a", expiresAt: "2026-07-12T10:20:00Z" })],
      events: [
        { eventId: "started", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", path: "events/custody.jsonl:1" },
        { eventId: "phase", type: "phase", status: "implementing", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:01:00Z", path: "events/custody.jsonl:2" },
        { eventId: "not-terminal", type: "lane_closing", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:05:00Z", path: "events/custody.jsonl:3" }
      ]
    });

    expect(timeline.claims).toEqual([expect.objectContaining({ action: "acquired", agentId: "worker-a" })]);
    expect(timeline.liveness.every((span) => span.endedAt <= "2026-07-12T10:10:00.000Z")).toBe(true);
    expect(timeline.phases).toEqual([
      expect.objectContaining({ phase: "implementing", endedAt: "2026-07-12T10:10:00.000Z", durationMs: 540_000 })
    ]);
  });

  it("releases the active holder for a generic lifecycle handoff", () => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [],
      heartbeats: [heartbeat({ agentId: "worker-a", expiresAt: "2026-07-12T10:20:00Z" })],
      events: [
        { eventId: "started", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", path: "events/custody.jsonl:1" },
        { eventId: "handoff", type: "lifecycle", status: "handoff", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:05:00Z", path: "events/custody.jsonl:2" }
      ]
    });

    expect(timeline.claims).toEqual([
      expect.objectContaining({ action: "acquired", agentId: "worker-a" }),
      expect.objectContaining({ action: "released", agentId: "worker-a", timestamp: "2026-07-12T10:05:00Z" })
    ]);
    expect(timeline.liveness.every((span) => span.endedAt <= "2026-07-12T10:05:00.000Z")).toBe(true);
  });

  it("retains a generic custody renewal for the current holder", () => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      claims: [],
      heartbeats: [],
      events: [
        { eventId: "started", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", path: "events/custody.jsonl:1" },
        { eventId: "renewed", type: "custody", status: "renewed", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:05:00Z", path: "events/custody.jsonl:2" }
      ]
    });

    expect(timeline.claims).toEqual([
      expect.objectContaining({ action: "acquired", agentId: "worker-a" }),
      expect.objectContaining({ action: "renewed", agentId: "worker-a", timestamp: "2026-07-12T10:05:00Z" })
    ]);
  });

  it.each(["heartbeat", "renew", "renewed"])("ignores %s telemetry from a non-holder", (type) => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      claims: [],
      heartbeats: [],
      events: [
        { eventId: "started", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", path: "events/custody.jsonl:1" },
        { eventId: "late-renewal", type, repo: "shakacode/dashboard", target: "46", agentId: "worker-b", timestamp: "2026-07-12T10:05:00Z", path: "events/custody.jsonl:2" }
      ]
    });

    expect(timeline.claims).toEqual([expect.objectContaining({ action: "acquired", agentId: "worker-a" })]);
  });

  it.each([
    "claim.renewed",
    "claim_renewed",
    "claim-renewed",
    "custody.renewed",
    "custody_renewed",
    "custody-renewed"
  ])("ignores normalized %s telemetry from a non-holder", (type) => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      claims: [],
      heartbeats: [],
      events: [
        { eventId: "started", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", path: "events/custody.jsonl:1" },
        { eventId: "late-renewal", type, repo: "shakacode/dashboard", target: "46", agentId: "worker-b", timestamp: "2026-07-12T10:05:00Z", path: "events/custody.jsonl:2" }
      ]
    });

    expect(timeline.claims).toEqual([expect.objectContaining({ action: "acquired", agentId: "worker-a" })]);
  });

  it("keeps a current claim for a repository whose name is history", () => {
    const timeline = buildCustodyTimeline({
      repo: "acme/history",
      target: "46",
      claims: [{
        schemaVersion: 1,
        repo: "acme/history",
        target: "46",
        agentId: "worker-a",
        status: "active",
        updatedAt: "2026-07-12T10:00:00Z",
        path: "claims/acme/history/46.json"
      }],
      heartbeats: [],
      events: []
    });

    expect(timeline.claims).toEqual([expect.objectContaining({ action: "unknown", agentId: "worker-a" })]);
  });

  it("uses only explicit phase-bearing telemetry and collapses repeated phase names", () => {
    const event = (overrides: Partial<BatchEvent>): BatchEvent => ({
      eventId: "event",
      type: "heartbeat",
      repo: "shakacode/dashboard",
      target: "46",
      timestamp: "2026-07-12T10:00:00Z",
      path: "events/batch.jsonl:1",
      ...overrides
    });
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [],
      heartbeats: [],
      events: [
        event({ eventId: "heartbeat-a", status: "implementing" }),
        event({ eventId: "phase-implement", type: "phase", status: "implementing", timestamp: "2026-07-12T10:01:00Z" }),
        event({ eventId: "phase-implement-repeat", type: "phase.progress", status: "implementing", timestamp: "2026-07-12T10:02:00Z" }),
        event({ eventId: "heartbeat-b", status: "implementing", timestamp: "2026-07-12T10:03:00Z" }),
        event({ eventId: "verify", type: "verify", status: "verifying", timestamp: "2026-07-12T10:04:00Z" }),
        event({ eventId: "review", type: "review", status: "reviewing", timestamp: "2026-07-12T10:05:00Z" })
      ]
    });

    expect(timeline.phases).toEqual([
      expect.objectContaining({ eventId: "phase-implement", phase: "implementing", endedAt: "2026-07-12T10:04:00.000Z", durationMs: 180_000 }),
      expect.objectContaining({ eventId: "verify", phase: "verifying", endedAt: "2026-07-12T10:05:00.000Z", durationMs: 60_000 }),
      expect.objectContaining({ eventId: "review", phase: "reviewing", endedAt: "2026-07-12T10:10:00.000Z", durationMs: 300_000 })
    ]);
    expect(timeline.events.filter((item) => item.type === "heartbeat")).toHaveLength(2);
  });

  it("retains a repeated phase after a custody boundary", () => {
    const timeline = buildCustodyTimeline({
      repo: "shakacode/dashboard",
      target: "46",
      now: new Date("2026-07-12T10:10:00Z"),
      claims: [],
      heartbeats: [],
      events: [
        { eventId: "started-a", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", path: "events/custody.jsonl:1" },
        { eventId: "phase-a", type: "phase", status: "implementing", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:01:00Z", path: "events/custody.jsonl:2" },
        { eventId: "handoff", type: "lane.handoff", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:03:00Z", path: "events/custody.jsonl:3" },
        { eventId: "started-b", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-b", timestamp: "2026-07-12T10:04:00Z", path: "events/custody.jsonl:4" },
        { eventId: "phase-b", type: "phase", status: "implementing", repo: "shakacode/dashboard", target: "46", agentId: "worker-b", timestamp: "2026-07-12T10:05:00Z", path: "events/custody.jsonl:5" }
      ]
    });

    expect(timeline.phases.map((phase) => phase.eventId)).toEqual(["phase-a", "phase-b"]);
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
