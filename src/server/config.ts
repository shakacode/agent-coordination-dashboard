import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 4319;
export const DEFAULT_GITHUB_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_GITHUB_REQUEST_BUDGET_PER_HOUR = 1_000;
export const DEFAULT_GITHUB_REQUESTS_PER_REFRESH = 50;
export const DEFAULT_GITHUB_QUOTA_SAFETY_THRESHOLD = 500;

export interface ServerConfig {
  port: number;
  host: string;
  allowedHosts: string[];
  stateRoot: string;
  coordApiUrl?: string;
  coordApiToken?: string;
  coordApiTokenEnvVar?: "AGENT_COORD_API_TOKEN" | "AGENT_COORD_TOKEN";
  refreshIntervalMs: number;
  /** Optional for compatibility with programmatic callers built before quota guardrails. */
  githubRefreshIntervalMs?: number;
  githubRequestBudgetPerHour?: number;
  githubRequestsPerRefresh?: number;
  githubQuotaSafetyThreshold?: number;
  targetRepos: string[];
  settingsPath: string;
  nodeEnv: string;
}

function listFromEnv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultAllowedHosts(host: string): string[] {
  const hosts = ["localhost", "127.0.0.1", "::1"];
  if (host !== "0.0.0.0" && host !== "::") {
    hosts.push(host);
  }
  return Array.from(new Set(hosts));
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function refreshIntervalFromEnv(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("DASHBOARD_REFRESH_MS must be a non-negative number.");
  }
  return parsed;
}

function integerFromEnv(name: string, value: string | undefined, fallback: number, allowZero = false): number {
  if (!value?.trim()) return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

export function readConfig(env = process.env): ServerConfig {
  const host = env.HOST || "127.0.0.1";
  const coordApiUrl = env.AGENT_COORD_API_URL?.trim() || "";
  const coordApiTokenEnvVar = env.AGENT_COORD_API_TOKEN?.trim()
    ? "AGENT_COORD_API_TOKEN"
    : env.AGENT_COORD_TOKEN?.trim()
      ? "AGENT_COORD_TOKEN"
      : undefined;
  if (isWildcardHost(host) && !env.ALLOWED_HOSTS?.trim()) {
    throw new Error("ALLOWED_HOSTS is required when HOST binds all interfaces.");
  }

  return {
    port: Number(env.PORT || DEFAULT_PORT),
    host,
    allowedHosts: env.ALLOWED_HOSTS ? listFromEnv(env.ALLOWED_HOSTS) : defaultAllowedHosts(host),
    stateRoot: env.AGENT_COORD_STATE_ROOT || join(homedir(), ".local", "state", "agent-coordination"),
    coordApiUrl,
    coordApiToken: env.AGENT_COORD_API_TOKEN?.trim() || env.AGENT_COORD_TOKEN?.trim() || "",
    coordApiTokenEnvVar,
    refreshIntervalMs: refreshIntervalFromEnv(env.DASHBOARD_REFRESH_MS, 0),
    githubRefreshIntervalMs: integerFromEnv("GITHUB_REFRESH_MS", env.GITHUB_REFRESH_MS, DEFAULT_GITHUB_REFRESH_INTERVAL_MS, true),
    githubRequestBudgetPerHour: integerFromEnv("GITHUB_REQUEST_BUDGET_PER_HOUR", env.GITHUB_REQUEST_BUDGET_PER_HOUR, DEFAULT_GITHUB_REQUEST_BUDGET_PER_HOUR),
    githubRequestsPerRefresh: integerFromEnv("GITHUB_REQUESTS_PER_REFRESH", env.GITHUB_REQUESTS_PER_REFRESH, DEFAULT_GITHUB_REQUESTS_PER_REFRESH),
    githubQuotaSafetyThreshold: integerFromEnv("GITHUB_QUOTA_SAFETY_THRESHOLD", env.GITHUB_QUOTA_SAFETY_THRESHOLD, DEFAULT_GITHUB_QUOTA_SAFETY_THRESHOLD, true),
    targetRepos: env.TARGET_REPOS ? listFromEnv(env.TARGET_REPOS) : [],
    settingsPath: env.DASHBOARD_SETTINGS_PATH || "",
    nodeEnv: env.NODE_ENV || "development"
  };
}
