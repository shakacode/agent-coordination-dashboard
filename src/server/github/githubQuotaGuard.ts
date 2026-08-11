import type { GhRunner } from "./types";
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
}

interface RateLimitObservation {
  used?: number;
  remaining?: number;
  resetAtMs?: number;
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

export function parseGitHubRateLimitHeaders(text: string): RateLimitObservation {
  const resetEpochSeconds = headerNumber(text, "x-ratelimit-reset");
  return {
    used: headerNumber(text, "x-ratelimit-used"),
    remaining: headerNumber(text, "x-ratelimit-remaining"),
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
  let probeFreshUntil = 0;
  let probeInFlight: Promise<void> | undefined;
  let observation: RateLimitObservation = {};
  let pausedUntil = 0;
  let pausedReason: GitHubQuotaReason = "none";
  let pausedMessage = "";

  if (!options.enabled) {
    pausedUntil = Number.POSITIVE_INFINITY;
    pausedReason = "disabled";
    pausedMessage = "GitHub enrichment is disabled because GITHUB_REFRESH_MS is 0.";
  }

  function refreshWindow(now: number) {
    while (hourlyRequestTimes.length > 0 && hourlyRequestTimes[0] <= now - HOUR_MS) hourlyRequestTimes.shift();
    if (options.enabled && pausedUntil > 0 && now >= pausedUntil) {
      pausedUntil = 0;
      pausedReason = "none";
      pausedMessage = "";
      probeFreshUntil = 0;
    }
  }

  function pause(reason: GitHubQuotaReason, message: string, until: number) {
    pausedReason = reason;
    pausedMessage = message;
    pausedUntil = until;
  }

  function pauseForObservation(now: number): boolean {
    if (observation.remaining === undefined || observation.remaining > options.safetyThreshold) return false;
    const reason = observation.remaining === 0 ? "rate_limit_exhausted" : "rate_limit_low";
    const resetAt = observation.resetAtMs && observation.resetAtMs > now
      ? observation.resetAtMs
      : now + options.fallbackCooldownMs;
    pause(
      reason,
      observation.remaining === 0
        ? "GitHub reported no authenticated REST requests remaining."
        : `GitHub reported ${observation.remaining} authenticated REST requests remaining, at or below the ${options.safetyThreshold} safety threshold.`,
      resetAt
    );
    return true;
  }

  function blockedByGlobalState(now: number): string | undefined {
    refreshWindow(now);
    if (pausedUntil > now) return pausedMessage;
    if (hourlyRequestTimes.length >= options.hourlyRequestBudget) {
      const until = hourlyRequestTimes[0] + HOUR_MS;
      pause("hourly_budget", `The dashboard's ${options.hourlyRequestBudget}-request hourly GitHub budget is exhausted.`, until);
      return pausedMessage;
    }
    return undefined;
  }

  function consume(context: RefreshContext, countAttempt = true, reserveObservedQuota = false): string | undefined {
    if (countAttempt) context.requestsAttempted += 1;
    const now = options.now();
    const globalBlock = blockedByGlobalState(now);
    if (globalBlock) {
      context.requestsBlocked += 1;
      return globalBlock;
    }
    if (context.requestsExecuted >= options.perRefreshRequestLimit) {
      context.requestsBlocked += 1;
      context.reason = "per_refresh_limit";
      return `This refresh reached its ${options.perRefreshRequestLimit}-request GitHub ceiling.`;
    }
    if (reserveObservedQuota && observation.remaining !== undefined) {
      observation = { ...observation, remaining: Math.max(0, observation.remaining - 1) };
      pauseForObservation(now);
    }
    context.requestsExecuted += 1;
    hourlyRequestTimes.push(now);
    return undefined;
  }

  async function executeProbe(context: RefreshContext): Promise<void> {
    const blocked = consume(context);
    if (blocked) return;
    const result = await baseRunner.run(["api", "--include", "user"]);
    const now = options.now();
    observation = parseGitHubRateLimitHeaders(`${result.stdout}\n${result.stderr}`);
    if (pauseForObservation(now)) return;
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || `exit ${result.exitCode}`;
      pause("probe_failed", `Representative GitHub quota probe failed: ${message}`, now + options.fallbackCooldownMs);
      return;
    }
    if (observation.remaining === undefined || observation.resetAtMs === undefined) {
      pause("probe_failed", "Representative GitHub quota probe returned no usable remaining/reset headers.", now + options.fallbackCooldownMs);
      return;
    }
    probeFreshUntil = now + options.probeIntervalMs;
  }

  async function ensureProbe(context: RefreshContext): Promise<void> {
    const now = options.now();
    refreshWindow(now);
    if (pausedUntil > now || probeFreshUntil > now) return;
    if (!probeInFlight) {
      probeInFlight = executeProbe(context).finally(() => {
        probeInFlight = undefined;
      });
    }
    await probeInFlight;
  }

  function beginRefresh(caller: string) {
    const context: RefreshContext = {
      caller,
      requestsAttempted: 0,
      requestsExecuted: 0,
      requestsBlocked: 0,
      reason: "none"
    };
    const runner: GhRunner = {
      async run(args) {
        context.requestsAttempted += 1;
        await ensureProbe(context);
        const blocked = consume(context, false, true);
        if (blocked) return blockedResult(blocked);
        const result = await baseRunner.run(args);
        const observed = parseGitHubRateLimitHeaders(`${result.stdout}\n${result.stderr}`);
        if (observed.used !== undefined || observed.remaining !== undefined || observed.resetAtMs !== undefined) {
          observation = observed;
          pauseForObservation(options.now());
        } else if (result.exitCode !== 0 && /(?:api\s+)?rate.?limit/i.test(result.stderr)) {
          pause("rate_limit_exhausted", "GitHub reported authenticated REST rate limiting.", options.now() + options.fallbackCooldownMs);
        }
        return result;
      }
    };

    return {
      runner,
      status(details: { targetCount?: number } = {}): GitHubQuotaStatus {
        const now = options.now();
        refreshWindow(now);
        const globallyPaused = pausedUntil > now;
        const reason = globallyPaused ? pausedReason : context.reason;
        const state: GitHubQuotaState = globallyPaused ? "paused" : reason === "none" ? "available" : "degraded";
        const message = globallyPaused
          ? pausedMessage
          : reason === "per_refresh_limit"
            ? `GitHub enrichment was capped at ${options.perRefreshRequestLimit} requests for this dashboard refresh; unreconciled values remain UNKNOWN.`
            : "GitHub enrichment is available.";
        return {
          state,
          reason,
          caller: context.caller,
          checkedAt: new Date(now).toISOString(),
          requestsAttempted: context.requestsAttempted,
          requestsExecuted: context.requestsExecuted,
          requestsBlocked: context.requestsBlocked,
          hourlyRequestBudget: options.hourlyRequestBudget,
          hourlyRequestsRemaining: Math.max(0, options.hourlyRequestBudget - hourlyRequestTimes.length),
          perRefreshRequestLimit: options.perRefreshRequestLimit,
          ...details,
          ...(observation.used === undefined ? {} : { rateLimitUsed: observation.used }),
          ...(observation.remaining === undefined ? {} : { rateLimitRemaining: observation.remaining }),
          ...(observation.resetAtMs === undefined ? {} : { rateLimitResetAt: new Date(observation.resetAtMs).toISOString() }),
          ...(globallyPaused && Number.isFinite(pausedUntil) ? { pausedUntil: new Date(pausedUntil).toISOString() } : {}),
          message
        };
      }
    };
  }

  return { beginRefresh };
}
