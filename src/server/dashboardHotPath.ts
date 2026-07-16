import type { BatchEvent, CoordinationWarning, DashboardModel } from "../shared/types";
import type { GitHubLoadResult } from "./github/githubClient";

/**
 * Hot-path helpers for /api/dashboard (issue #68): a short-TTL cache for
 * per-repository open GitHub previews and a default hot window over batch
 * history events.
 *
 * Honesty invariants:
 * - A load whose result reports `failed` is never reused; the next request
 *   retries live, so failures keep their degraded warnings instead of being
 *   replaced by stale fresh-looking data.
 * - Cached previews are reused for at most the TTL; expiry restores live loads.
 * - The history window never hides its own effect: omissions are announced in
 *   the payload's warnings, and events whose age cannot be proven (missing or
 *   unparseable timestamps) are always kept.
 */

export const OPEN_GITHUB_ITEMS_CACHE_TTL_MS = 60_000;
export const DEFAULT_HISTORY_WINDOW_DAYS = 7;

interface OpenGitHubItemsCacheEntry {
  expiresAt: number;
  promise: Promise<GitHubLoadResult>;
  settled: boolean;
  reusable: boolean;
}

export function createOpenGitHubItemsCache(
  loader: (repo: string) => Promise<GitHubLoadResult>,
  ttlMs = OPEN_GITHUB_ITEMS_CACHE_TTL_MS,
  maxCacheEntries = 100
) {
  const cache = new Map<string, OpenGitHubItemsCacheEntry>();

  function prune(now: number) {
    for (const [key, entry] of cache) {
      if (entry.settled && (!entry.reusable || entry.expiresAt <= now)) cache.delete(key);
    }
    while (cache.size > Math.max(1, maxCacheEntries)) {
      const oldestSettled = Array.from(cache).find(([, entry]) => entry.settled)?.[0];
      if (!oldestSettled) break;
      cache.delete(oldestSettled);
    }
  }

  return {
    load(repo: string, options: { bypassCache?: boolean } = {}): Promise<GitHubLoadResult> {
      const now = Date.now();
      prune(now);
      const existing = cache.get(repo);
      if (!options.bypassCache && existing && (!existing.settled || (existing.reusable && existing.expiresAt > now))) {
        return existing.promise;
      }
      const promise = loader(repo);
      const entry: OpenGitHubItemsCacheEntry = { expiresAt: now + ttlMs, promise, settled: false, reusable: false };
      cache.set(repo, entry);
      const settle = (result?: GitHubLoadResult) => {
        entry.settled = true;
        entry.reusable = Boolean(result) && !result?.failed;
        prune(Date.now());
      };
      promise.then(settle, () => settle(undefined));
      return promise;
    },
    cacheSize: () => cache.size
  };
}

function historyWindowNotice(omittedCount: number, windowDays: number): CoordinationWarning {
  return {
    severity: "info",
    message: `Dashboard history window: omitted ${omittedCount} batch history ${
      omittedCount === 1 ? "event" : "events"
    } older than ${windowDays} ${windowDays === 1 ? "day" : "days"} from this payload; request /api/dashboard?history=full for complete history.`
  };
}

/**
 * Defaults the dashboard payload to a hot window of recent batch history.
 * Model derivations (terminal states, QA statuses, batch operation counters)
 * are computed from full history before this runs, so windowing only trims the
 * serialized `events` list. The input model is never mutated.
 */
export function applyDashboardHistoryWindow(
  model: DashboardModel,
  now: Date,
  windowDays = DEFAULT_HISTORY_WINDOW_DAYS
): DashboardModel {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const kept: BatchEvent[] = [];
  let omittedCount = 0;
  for (const event of model.events) {
    const timestamp = Date.parse(event.timestamp || "");
    if (Number.isNaN(timestamp) || timestamp >= cutoff) {
      kept.push(event);
    } else {
      omittedCount += 1;
    }
  }
  if (omittedCount === 0) {
    return model;
  }
  return {
    ...model,
    events: kept,
    warnings: [...model.warnings, historyWindowNotice(omittedCount, windowDays)]
  };
}
