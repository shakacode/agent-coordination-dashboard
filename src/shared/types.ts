export type GitHubQuotaState = "available" | "degraded" | "paused";
export type GitHubQuotaReason =
  | "none"
  | "disabled"
  | "per_refresh_limit"
  | "hourly_budget"
  | "rate_limit_low"
  | "rate_limit_exhausted"
  | "probe_failed"
  | "read_failed";

export interface GitHubQuotaStatus {
  state: GitHubQuotaState;
  reason: GitHubQuotaReason;
  caller: string;
  checkedAt: string;
  requestsAttempted: number;
  requestsExecuted: number;
  requestsBlocked: number;
  hourlyRequestBudget: number;
  hourlyRequestsRemaining: number;
  perRefreshRequestLimit: number;
  targetCount?: number;
  rateLimitUsed?: number;
  rateLimitRemaining?: number;
  rateLimitResetAt?: string;
  pausedUntil?: string;
  message: string;
}

export interface DashboardSettings {
  targetRepos: string[];
}
