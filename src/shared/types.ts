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

export type AttentionSourceIntervalSeconds = number | {
  default: number;
  repositories?: Record<string, number>;
};

export interface DashboardSettings {
  targetRepos: string[];
  attentionWorkspace?: string;
  attentionSourceIntervalSeconds?: AttentionSourceIntervalSeconds;
  attentionOpenAgeDays?: number;
  /** Preserve file-only settings when older clients save their known fields. */
  [key: string]: unknown;
}
