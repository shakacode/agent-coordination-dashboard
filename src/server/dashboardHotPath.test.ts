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
    const input = model([event("stale", "2026-07-13T11:00:00Z")]);
    const windowed = applyDashboardHistoryWindow(input, now, 1);
    expect(windowed.events).toEqual([]);
    expect(windowed.warnings.at(-1)?.message).toContain("omitted 1 batch history event older than 1 day");
  });
});
