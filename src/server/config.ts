import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 4319;

export interface ServerConfig {
  port: number;
  host: string;
  allowedHosts: string[];
  stateRoot: string;
  coordApiUrl?: string;
  coordApiToken?: string;
  refreshIntervalMs: number;
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

export function readConfig(env = process.env): ServerConfig {
  const host = env.HOST || "127.0.0.1";
  const coordApiUrl = env.AGENT_COORD_API_URL?.trim() || "";
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
    refreshIntervalMs: refreshIntervalFromEnv(env.DASHBOARD_REFRESH_MS, coordApiUrl ? 5000 : 0),
    targetRepos: env.TARGET_REPOS ? listFromEnv(env.TARGET_REPOS) : [],
    settingsPath: env.DASHBOARD_SETTINGS_PATH || "",
    nodeEnv: env.NODE_ENV || "development"
  };
}
