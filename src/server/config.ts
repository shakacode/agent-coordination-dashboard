import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerConfig {
  port: number;
  host: string;
  allowedHosts: string[];
  stateRoot: string;
  coordApiUrl?: string;
  coordApiToken?: string;
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

export function readConfig(env = process.env): ServerConfig {
  const host = env.HOST || "127.0.0.1";
  if (isWildcardHost(host) && !env.ALLOWED_HOSTS?.trim()) {
    throw new Error("ALLOWED_HOSTS is required when HOST binds all interfaces.");
  }

  return {
    port: Number(env.PORT || 4317),
    host,
    allowedHosts: env.ALLOWED_HOSTS ? listFromEnv(env.ALLOWED_HOSTS) : defaultAllowedHosts(host),
    stateRoot: env.AGENT_COORD_STATE_ROOT || join(homedir(), ".local", "state", "agent-coordination"),
    coordApiUrl: env.AGENT_COORD_API_URL || "",
    coordApiToken: env.AGENT_COORD_TOKEN || "",
    targetRepos: env.TARGET_REPOS ? listFromEnv(env.TARGET_REPOS) : [],
    settingsPath: env.DASHBOARD_SETTINGS_PATH || "",
    nodeEnv: env.NODE_ENV || "development"
  };
}
