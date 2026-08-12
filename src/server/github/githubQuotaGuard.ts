import type { GhRunner, GhRunOptions } from "./types";
import type { GitHubQuotaReason, GitHubQuotaState, GitHubQuotaStatus } from "../../shared/types";

interface GitHubRequestGovernorOptions {
  enabled?: boolean;
  hourlyRequestBudget: number;
  perRefreshRequestLimit: number;
  safetyThreshold: number;
  probeIntervalMs: number;
  fallbackCooldownMs: number;
  now?: () => number;
}

interface RefreshContext {
  caller: string;
  requestsAttempted: number;
  requestsExecuted: number;
  requestsBlocked: number;
  reason: GitHubQuotaReason;
  poolsUsed: Set<PrimaryRateLimitPool>;
  estimatedGraphQlCostReserved: number;
  observedHeaders?: RateLimitObservation;
}

interface RateLimitObservation {
  used?: number;
  remaining?: number;
  resetAtMs?: number;
  requestId?: string;
}

type PrimaryRateLimitPool = "rest" | "graphql";

interface PrimaryPoolState {
  probeFreshUntil: number;
  probeInFlight?: Promise<void>;
  observation: RateLimitObservation;
  pausedUntil: number;
  pausedReason: GitHubQuotaReason;
  pausedMessage: string;
}

const BLOCKED_EXIT_CODE = 75;
const HOUR_MS = 60 * 60 * 1000;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer.`);
  return value;
}

function headerNumber(text: string, name: string): number | undefined {
  const match = text.match(new RegExp(`^${name}:\\s*(\\d+)\\s*$`, "im"));
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function headerValue(text: string, name: string): string | undefined {
  const match = text.match(new RegExp(`^${name}:\\s*([^\\r\\n]+?)\\s*$`, "im"));
  return match?.[1]?.trim() || undefined;
}

export function parseGitHubRateLimitHeaders(text: string): RateLimitObservation {
  const resetEpochSeconds = headerNumber(text, "x-ratelimit-reset");
  return {
    used: headerNumber(text, "x-ratelimit-used"),
    remaining: headerNumber(text, "x-ratelimit-remaining"),
    requestId: headerValue(text, "x-github-request-id"),
    ...(resetEpochSeconds === undefined ? {} : { resetAtMs: resetEpochSeconds * 1000 })
  };
}

function blockedResult(message: string) {
  return { stdout: "", stderr: `GitHub request blocked by dashboard quota guard: ${message}`, exitCode: BLOCKED_EXIT_CODE };
}

export function createGitHubRequestGovernor(baseRunner: GhRunner, rawOptions: GitHubRequestGovernorOptions) {
  const options = {
    enabled: rawOptions.enabled !== false,
    hourlyRequestBudget: positiveInteger(rawOptions.hourlyRequestBudget, "hourlyRequestBudget"),
    perRefreshRequestLimit: positiveInteger(rawOptions.perRefreshRequestLimit, "perRefreshRequestLimit"),
    safetyThreshold: nonNegativeInteger(rawOptions.safetyThreshold, "safetyThreshold"),
    probeIntervalMs: positiveInteger(rawOptions.probeIntervalMs, "probeIntervalMs"),
    fallbackCooldownMs: positiveInteger(rawOptions.fallbackCooldownMs, "fallbackCooldownMs"),
    now: rawOptions.now || Date.now
  };
  const hourlyRequestTimes: number[] = [];
  const pools: Record<PrimaryRateLimitPool, PrimaryPoolState> = {
    rest: { probeFreshUntil: 0, observation: {}, pausedUntil: 0, pausedReason: "none", pausedMessage: "" },
    graphql: { probeFreshUntil: 0, observation: {}, pausedUntil: 0, pausedReason: "none", pausedMessage: "" }
  };

  function refreshWindow(now: number) {
    while (hourlyRequestTimes.length > 0 && hourlyRequestTimes[0] <= now - HOUR_MS) hourlyRequestTimes.shift();
    for (const pool of Object.values(pools)) {
      if (pool.pausedUntil > 0 && now >= pool.pausedUntil) {
        pool.pausedUntil = 0;
        pool.pausedReason = "none";
        pool.pausedMessage = "";
        pool.probeFreshUntil = 0;
      }
    }
  }

  function pause(poolName: PrimaryRateLimitPool, reason: GitHubQuotaReason, message: string, until: number) {
    const pool = pools[poolName];
    pool.pausedReason = reason;
    pool.pausedMessage = message;
    pool.pausedUntil = until;
  }

  function pauseForObservation(poolName: PrimaryRateLimitPool, now: number): boolean {
    const pool = pools[poolName];
    if (pool.observation.remaining === undefined || pool.observation.remaining > options.safetyThreshold) return false;
    const reason = pool.observation.remaining === 0 ? "rate_limit_exhausted" : "rate_limit_low";
    const resetAt = pool.observation.resetAtMs && pool.observation.resetAtMs > now
      ? pool.observation.resetAtMs
      : now + options.fallbackCooldownMs;
    pause(
      poolName,
      reason,
      pool.observation.remaining === 0
        ? `GitHub reported no authenticated ${poolName.toUpperCase()} API points remaining.`
        : `GitHub reported ${pool.observation.remaining} authenticated ${poolName.toUpperCase()} API points remaining, at or below the ${options.safetyThreshold} safety threshold.`,
      resetAt
    );
    return true;
  }

  function blockedBySharedState(now: number): string | undefined {
    refreshWindow(now);
    if (!options.enabled) return "GitHub enrichment is disabled because GITHUB_REFRESH_MS is 0.";
    if (hourlyRequestTimes.length >= options.hourlyRequestBudget) {
      return `The dashboard's ${options.hourlyRequestBudget}-request hourly GitHub budget is exhausted.`;
    }
    return undefined;
  }

  function consume(context: RefreshContext, poolName: PrimaryRateLimitPool, countAttempt = true, estimatedCost = 0): string | undefined {
    if (countAttempt) context.requestsAttempted += 1;
    const now = options.now();
    const sharedBlock = blockedBySharedState(now);
    if (sharedBlock) {
      context.requestsBlocked += 1;
      context.reason = options.enabled ? "hourly_budget" : "disabled";
      return sharedBlock;
    }
    const pool = pools[poolName];
    if (pool.pausedUntil > now) {
      context.requestsBlocked += 1;
      context.reason = pool.pausedReason;
      context.poolsUsed.add(poolName);
      return pool.pausedMessage;
    }
    if (context.requestsExecuted >= options.perRefreshRequestLimit) {
      context.requestsBlocked += 1;
      context.reason = "per_refresh_limit";
      return `This refresh reached its ${options.perRefreshRequestLimit}-request GitHub ceiling.`;
    }
    if (estimatedCost > 0 && pool.observation.remaining !== undefined) {
      pool.observation = { ...pool.observation, remaining: Math.max(0, pool.observation.remaining - estimatedCost) };
      if (poolName === "graphql") context.estimatedGraphQlCostReserved += estimatedCost;
      if (pauseForObservation(poolName, now)) context.reason = pool.pausedReason;
    }
    context.poolsUsed.add(poolName);
    context.requestsExecuted += 1;
    hourlyRequestTimes.push(now);
    return undefined;
  }

  async function executeProbe(context: RefreshContext, poolName: PrimaryRateLimitPool): Promise<void> {
    const blocked = consume(context, poolName);
    if (blocked) return;
    const result = await baseRunner.run(poolName === "rest"
      ? ["api", "--include", "user"]
      : ["api", "graphql", "--include", "-f", "query=query{rateLimit{cost remaining resetAt used}}"]);
    const now = options.now();
    const pool = pools[poolName];
    pool.observation = parseGitHubRateLimitHeaders(`${result.stdout}\n${result.stderr}`);
    context.observedHeaders = pool.observation;
    if (pauseForObservation(poolName, now)) {
      context.reason = pool.pausedReason;
      return;
    }
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || `exit ${result.exitCode}`;
      pause(poolName, "probe_failed", `Representative GitHub ${poolName.toUpperCase()} quota probe failed: ${message}`, now + options.fallbackCooldownMs);
      return;
    }
    if (pool.observation.remaining === undefined || pool.observation.resetAtMs === undefined) {
      pause(poolName, "probe_failed", `Representative GitHub ${poolName.toUpperCase()} quota probe returned no usable remaining/reset headers.`, now + options.fallbackCooldownMs);
      return;
    }
    pool.probeFreshUntil = now + options.probeIntervalMs;
  }

  async function ensureProbe(context: RefreshContext, poolName: PrimaryRateLimitPool): Promise<void> {
    const now = options.now();
    refreshWindow(now);
    if (!options.enabled) return;
    const pool = pools[poolName];
    if (pool.pausedUntil > now || pool.probeFreshUntil > now) return;
    if (!pool.probeInFlight) {
      pool.probeInFlight = executeProbe(context, poolName).finally(() => {
        pool.probeInFlight = undefined;
      });
    }
    await pool.probeInFlight;
  }

  function requestPool(args: string[]): PrimaryRateLimitPool {
    return (args[0] === "api" && args[1] === "graphql")
      || (["pr", "issue"].includes(args[0]) && args[1] === "list")
      ? "graphql"
      : "rest";
  }

  function estimatedGraphQlCost(args: string[], runOptions: GhRunOptions | undefined): number | undefined {
    if (requestPool(args) !== "graphql") return 1;
    const hint = runOptions?.estimatedGraphQlCost;
    if (hint === undefined) return 1;
    return Number.isSafeInteger(hint) && hint > 0 ? hint : undefined;
  }

  function beginRefresh(caller: string) {
    const context: RefreshContext = {
      caller,
      requestsAttempted: 0,
      requestsExecuted: 0,
      requestsBlocked: 0,
      reason: options.enabled ? "none" : "disabled",
      poolsUsed: new Set(),
      estimatedGraphQlCostReserved: 0
    };
    const runner: GhRunner = {
      async run(args, runOptions) {
        const poolName = requestPool(args);
        context.requestsAttempted += 1;
        const estimatedCost = estimatedGraphQlCost(args, runOptions);
        if (estimatedCost === undefined) {
          const message = "GraphQL request omitted a valid positive safe-integer cost reservation.";
          pause(poolName, "probe_failed", message, options.now() + options.fallbackCooldownMs);
          context.poolsUsed.add(poolName);
          context.reason = "probe_failed";
          context.requestsBlocked += 1;
          return blockedResult(message);
        }
        await ensureProbe(context, poolName);
        const blocked = consume(context, poolName, false, estimatedCost);
        if (blocked) return blockedResult(blocked);
        const result = await baseRunner.run(args);
        const observed = parseGitHubRateLimitHeaders(`${result.stdout}\n${result.stderr}`);
        const pool = pools[poolName];
        if (observed.used !== undefined || observed.remaining !== undefined || observed.resetAtMs !== undefined) {
          pool.observation = { ...observed, requestId: observed.requestId || pool.observation.requestId };
          context.observedHeaders = { ...observed, requestId: observed.requestId || context.observedHeaders?.requestId };
          if (pauseForObservation(poolName, options.now())) context.reason = pool.pausedReason;
        } else if (observed.requestId) {
          pool.observation = { ...pool.observation, requestId: observed.requestId };
          context.observedHeaders = { ...context.observedHeaders, requestId: observed.requestId };
        } else if (result.exitCode !== 0 && /(?:api\s+)?rate.?limit/i.test(result.stderr)) {
          pause(poolName, "rate_limit_exhausted", `GitHub reported authenticated ${poolName.toUpperCase()} API rate limiting.`, options.now() + options.fallbackCooldownMs);
          context.reason = "rate_limit_exhausted";
        }
        return result;
      }
    };

    return {
      runner,
      status(details: { targetCount?: number; cacheHits?: number; cacheMisses?: number } = {}): GitHubQuotaStatus {
        const now = options.now();
        refreshWindow(now);
        const pausedPool = [...context.poolsUsed].map((name) => pools[name]).find((pool) => pool.pausedUntil > now);
        const sharedPaused = context.reason === "hourly_budget" || context.reason === "disabled";
        const reason = sharedPaused ? context.reason : pausedPool?.pausedReason || context.reason;
        const state: GitHubQuotaState = sharedPaused || pausedPool ? "paused" : reason === "none" ? "available" : "degraded";
        const message = sharedPaused
          ? context.reason === "disabled"
            ? "GitHub enrichment is disabled because GITHUB_REFRESH_MS is 0."
            : `The dashboard's ${options.hourlyRequestBudget}-request hourly GitHub budget is exhausted.`
          : pausedPool
            ? pausedPool.pausedMessage
            : reason === "per_refresh_limit"
            ? `GitHub enrichment was capped at ${options.perRefreshRequestLimit} requests for this dashboard refresh; unreconciled values remain UNKNOWN.`
            : "GitHub enrichment is available.";
        const observedHeaders = context.observedHeaders || {};
        return {
          state,
          reason,
          caller: context.caller,
          checkedAt: new Date(now).toISOString(),
          requestsAttempted: context.requestsAttempted,
          requestsExecuted: context.requestsExecuted,
          requestsBlocked: context.requestsBlocked,
          ...(context.estimatedGraphQlCostReserved > 0 ? { estimatedGraphQlCostReserved: context.estimatedGraphQlCostReserved } : {}),
          hourlyRequestBudget: options.hourlyRequestBudget,
          hourlyRequestsRemaining: Math.max(0, options.hourlyRequestBudget - hourlyRequestTimes.length),
          perRefreshRequestLimit: options.perRefreshRequestLimit,
          ...details,
          ...(observedHeaders.requestId ? { githubRequestId: observedHeaders.requestId } : {}),
          ...(observedHeaders.used === undefined ? {} : { rateLimitUsed: observedHeaders.used }),
          ...(observedHeaders.remaining === undefined ? {} : { rateLimitRemaining: observedHeaders.remaining }),
          ...(observedHeaders.resetAtMs === undefined ? {} : { rateLimitResetAt: new Date(observedHeaders.resetAtMs).toISOString() }),
          ...(pausedPool && Number.isFinite(pausedPool.pausedUntil) ? { pausedUntil: new Date(pausedPool.pausedUntil).toISOString() } : {}),
          message
        };
      }
    };
  }

  return { beginRefresh };
}
