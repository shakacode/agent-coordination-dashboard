import { afterEach, describe, expect, it, vi } from "vitest";
import type { BatchEvent, DashboardModel } from "../shared/types";
import { applyDashboardHistoryWindow, createOpenGitHubItemsCache, DEFAULT_HISTORY_WINDOW_DAYS } from "./dashboardHotPath";
import type { GitHubLoadResult } from "./github/githubClient";

function loadResult(title: string, failed = false): GitHubLoadResult {
  return {
    items: [{ repo: "repo/app", target: "45", type: "issue", title, url: "https://github.com/repo/app/issues/45", state: "OPEN", labels: [], loadState: "loaded" }],
    warnings: failed ? [{ severity: "warning", repo: "repo/app", message: "GitHub issue list failed for repo/app: auth required" }] : [],
    ...(failed ? { failed: true } : {})
  };
}

describe("createOpenGitHubItemsCache", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces concurrent loads and reuses fresh results per repository", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cache = createOpenGitHubItemsCache(async (repo) => {
      calls += 1;
      if (calls === 1) await gate;
      return loadResult(repo);
    });

    const first = cache.load("repo/app");
    const second = cache.load("repo/app");
    const other = cache.load("repo/other");
    release();
    await Promise.all([first, second, other]);
    expect(calls).toBe(2);

    await expect(cache.load("repo/app")).resolves.toMatchObject({ items: [expect.objectContaining({ title: "repo/app" })] });
    expect(calls).toBe(2);
  });

  it("expires cached results after the TTL and loads live again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
    let calls = 0;
    const cache = createOpenGitHubItemsCache(async () => {
      calls += 1;
      return loadResult(`load-${calls}`);
    }, 1_000);

    await expect(cache.load("repo/app")).resolves.toMatchObject({ items: [expect.objectContaining({ title: "load-1" })] });
    await cache.load("repo/app");
    expect(calls).toBe(1);

    vi.advanceTimersByTime(1_001);
    await expect(cache.load("repo/app")).resolves.toMatchObject({ items: [expect.objectContaining({ title: "load-2" })] });
    expect(calls).toBe(2);
  });

  it("passes failed loads through with their warnings and never reuses them", async () => {
    let calls = 0;
    const cache = createOpenGitHubItemsCache(async () => {
      calls += 1;
      return calls === 1 ? loadResult("degraded", true) : loadResult("recovered");
    });

    const degraded = await cache.load("repo/app");
    expect(degraded.failed).toBe(true);
    expect(degraded.warnings[0].message).toContain("auth required");
    expect(cache.cacheSize()).toBe(0);

    const recovered = await cache.load("repo/app");
    expect(recovered.items[0].title).toBe("recovered");
    expect(calls).toBe(2);
    await cache.load("repo/app");
    expect(calls).toBe(2);
  });

  it("does not cache rejected loads and retries live on the next request", async () => {
    let calls = 0;
    const cache = createOpenGitHubItemsCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error("spawn failed");
      return loadResult("after-retry");
    });

    await expect(cache.load("repo/app")).rejects.toThrow("spawn failed");
    expect(cache.cacheSize()).toBe(0);
    await expect(cache.load("repo/app")).resolves.toMatchObject({ items: [expect.objectContaining({ title: "after-retry" })] });
    expect(calls).toBe(2);
  });

  it("bypasses fresh cache entries on demand and re-caches the live result", async () => {
    let calls = 0;
    const cache = createOpenGitHubItemsCache(async () => {
      calls += 1;
      return loadResult(`load-${calls}`);
    });

    await cache.load("repo/app");
    const bypassed = await cache.load("repo/app", { bypassCache: true });
    expect(bypassed.items[0].title).toBe("load-2");
    expect(calls).toBe(2);

    await expect(cache.load("repo/app")).resolves.toMatchObject({ items: [expect.objectContaining({ title: "load-2" })] });
    expect(calls).toBe(2);
  });

  it("caps settled cache entries deterministically", async () => {
    const cache = createOpenGitHubItemsCache(async (repo) => loadResult(repo), 60_000, 2);
    await cache.load("repo/one");
    await cache.load("repo/two");
    await cache.load("repo/three");
    expect(cache.cacheSize()).toBe(2);
  });
});

describe("applyDashboardHistoryWindow", () => {
  const now = new Date("2026-07-15T12:00:00Z");

  function event(eventId: string, timestamp: string | undefined): BatchEvent {
    return { eventId, type: "phase.implementing", repo: "repo/app", target: "45", timestamp, path: "events/batches/demo.jsonl:1" };
  }

  function model(events: BatchEvent[]): DashboardModel {
    return {
      generatedAt: now.toISOString(),
      stateRoot: "/state",
      targetRepos: ["repo/app"],
      agents: [],
      workItems: [],
      batches: [],
      events,
      batchOperations: [],
      qaValidations: [],
      healthItems: [],
      warnings: [{ severity: "warning", message: "existing warning" }],
      githubMergeTimeStatus: "unavailable",
      trulyOpenCountStatus: "unknown"
    };
  }

  it("keeps the default window aligned with the 7-day retention tier", () => {
    expect(DEFAULT_HISTORY_WINDOW_DAYS).toBe(7);
  });

  it("omits only events provably older than the window and announces the omission", () => {
    const boundary = new Date(now.getTime() - DEFAULT_HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const input = model([
      event("fresh", "2026-07-15T11:00:00Z"),
      event("boundary", boundary),
      event("stale", "2026-07-01T12:00:00Z"),
      event("ancient", "2026-05-01T12:00:00Z"),
      event("undated", undefined),
      event("unparseable", "not-a-timestamp")
    ]);

    const windowed = applyDashboardHistoryWindow(input, now);

    expect(windowed.events.map((item) => item.eventId)).toEqual(["fresh", "boundary", "undated", "unparseable"]);
    expect(windowed.warnings).toEqual([
      { severity: "warning", message: "existing warning" },
      {
        severity: "info",
        message: "Dashboard history window: omitted 2 batch history events older than 7 days from this payload; request /api/dashboard?history=full for complete history."
      }
    ]);
  });

  it("returns the model unchanged when every event is inside the window", () => {
    const input = model([event("fresh", "2026-07-15T11:00:00Z"), event("undated", undefined)]);
    expect(applyDashboardHistoryWindow(input, now)).toBe(input);
  });

  it("never mutates the input model", () => {
    const input = model([event("fresh", "2026-07-15T11:00:00Z"), event("stale", "2026-01-01T12:00:00Z")]);
    const windowed = applyDashboardHistoryWindow(input, now);

    expect(windowed).not.toBe(input);
    expect(input.events.map((item) => item.eventId)).toEqual(["fresh", "stale"]);
    expect(input.warnings).toEqual([{ severity: "warning", message: "existing warning" }]);
    expect(windowed.events.map((item) => item.eventId)).toEqual(["fresh"]);
  });

  it("honors a custom window and singular phrasing", () => {
    const input = model([event("stale-newest", "2026-07-13T11:00:00Z"), event("stale-older", "2026-07-13T09:00:00Z")]);
    const windowed = applyDashboardHistoryWindow(input, now, 1);
    expect(windowed.events.map((item) => item.eventId)).toEqual(["stale-newest"]);
    expect(windowed.warnings.at(-1)?.message).toContain("omitted 1 batch history event older than 1 day");
  });

  it("keeps a stalled lane's newest evidence regardless of age so known row state never turns UNKNOWN", () => {
    const laneEvent = (eventId: string, timestamp: string, overrides: Partial<BatchEvent> = {}): BatchEvent => ({
      eventId,
      type: "phase.implementing",
      batchId: "batch-old",
      laneName: "server",
      repo: "repo/app",
      timestamp,
      path: "events/batches/batch-old.jsonl:1",
      ...overrides
    });
    const input = model([
      event("fresh-work", "2026-07-15T11:00:00Z"),
      laneEvent("stalled-lane-newest", "2026-06-10T12:00:00Z", { status: "implementing", agentId: "worker-a" }),
      laneEvent("stalled-lane-older", "2026-06-01T12:00:00Z", { status: "started", agentId: "worker-a" }),
      { ...event("other-scope-newest", "2026-05-20T12:00:00Z"), target: "46" }
    ]);

    const windowed = applyDashboardHistoryWindow(input, now);

    // The stalled lane and the aged work scope keep their newest evidence even
    // though it is far outside the window; only the redundant older lane event
    // is omitted, and the notice counts exactly that omission.
    expect(windowed.events.map((item) => item.eventId)).toEqual(["fresh-work", "stalled-lane-newest", "other-scope-newest"]);
    expect(windowed.warnings.at(-1)?.message).toContain("omitted 1 batch history event older than 7 days");
  });

  it("returns the model unchanged when every old event is a scope's newest evidence", () => {
    const input = model([
      { ...event("lane-b", "2026-02-01T12:00:00Z"), laneName: "lane-b" },
      { ...event("lane-a", "2026-01-01T12:00:00Z"), laneName: "lane-a" }
    ]);
    expect(applyDashboardHistoryWindow(input, now)).toBe(input);
  });

  it("keeps old events that carry metadata a newer kept event lacks", () => {
    const input = model([
      event("fresh-no-machine", "2026-07-15T11:00:00Z"),
      { ...event("old-with-machine", "2026-06-01T12:00:00Z"), machineId: "mac-studio" },
      { ...event("older-with-machine", "2026-05-01T12:00:00Z"), machineId: "mac-studio" },
      { ...event("older-no-new-fields", "2026-04-01T12:00:00Z") }
    ]);

    const windowed = applyDashboardHistoryWindow(input, now);

    // old-with-machine is the newest machineId carrier for the scope, so the
    // client's newest-first metadata derivation stays identical; the two older
    // events add nothing a row derivation reads and are omitted.
    expect(windowed.events.map((item) => item.eventId)).toEqual(["fresh-no-machine", "old-with-machine"]);
    expect(windowed.warnings.at(-1)?.message).toContain("omitted 2 batch history events");
  });

  it("never lets whitespace-only metadata mask an older real carrier", () => {
    const input = model([
      { ...event("fresh-blank-operator", "2026-07-15T11:00:00Z"), operator: "  " },
      { ...event("old-real-operator", "2026-06-01T12:00:00Z"), operator: "justin808" },
      { ...event("old-blank-operator", "2026-05-01T12:00:00Z"), operator: " " }
    ]);

    const windowed = applyDashboardHistoryWindow(input, now);

    // The client trims before use, so "  " is not operator evidence: the real
    // carrier must survive, while the whitespace-only old event adds nothing.
    expect(windowed.events.map((item) => item.eventId)).toEqual(["fresh-blank-operator", "old-real-operator"]);
    expect(windowed.warnings.at(-1)?.message).toContain("omitted 1 batch history event");
  });

  it("never lets a whitespace-only status mask an older lifecycle-status carrier", () => {
    const input = model([
      { ...event("old-blank-status", "2026-06-10T12:00:00Z"), status: "  " },
      { ...event("older-real-status", "2026-06-01T12:00:00Z"), status: "implementing" },
      { ...event("oldest-redundant-status", "2026-05-01T12:00:00Z"), status: "started" }
    ]);

    const windowed = applyDashboardHistoryWindow(input, now);

    // The client's lifecycle candidate is `status || type`, rejected when
    // whitespace-only without falling back to the type, so the blank-status
    // newest event cannot supply the lifecycle status: the older real carrier
    // must survive while the redundant oldest one trims.
    expect(windowed.events.map((item) => item.eventId)).toEqual(["old-blank-status", "older-real-status"]);
    expect(windowed.warnings.at(-1)?.message).toContain("omitted 1 batch history event");
  });

  it("preserves each scope's newest evidence even when events arrive out of recency order", () => {
    const input = model([
      { ...event("lane-older", "2026-05-01T12:00:00Z"), laneName: "server" },
      event("work-older", "2026-06-01T12:00:00Z"),
      { ...event("lane-newest", "2026-06-15T12:00:00Z"), laneName: "server" },
      event("work-newest", "2026-06-10T12:00:00Z")
    ]);

    const windowed = applyDashboardHistoryWindow(input, now);

    // Decisions are made over a recency-sorted copy, so the shuffled input
    // cannot trick coverage tracking into keeping an older event instead of
    // the scope's newest; kept events stay in payload order.
    expect(windowed.events.map((item) => item.eventId)).toEqual(["lane-newest", "work-newest"]);
    expect(windowed.warnings.at(-1)?.message).toContain("omitted 2 batch history events");
  });

  it("keeps the newest non-QA event of a scope so operator-state transitions survive QA noise", () => {
    const input = model([
      { ...event("old-qa", "2026-06-10T12:00:00Z"), type: "qa.validation.passed" },
      { ...event("old-transition", "2026-06-01T12:00:00Z"), type: "phase.completed", status: "completed" },
      { ...event("old-earlier-transition", "2026-05-01T12:00:00Z"), type: "phase.started", status: "started" }
    ]);

    const windowed = applyDashboardHistoryWindow(input, now);

    expect(windowed.events.map((item) => item.eventId)).toEqual(["old-qa", "old-transition"]);
    expect(windowed.warnings.at(-1)?.message).toContain("omitted 1 batch history event");
  });
});
