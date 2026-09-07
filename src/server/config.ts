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
  coordApiTokenEnvVar?: "AGENT_COORD_API_TOKEN" | "AGENT_COORD_TOKEN";
  targetRepos: string[];
  settingsPath: string;
  nodeEnv: string;
  /**
   * `AGENT_COORD_MACHINE_ID`: which machine this dashboard runs on, as the
   * attention model's `dashboard_host`. Undefined when it is not set, which the
   * model reports as `UNKNOWN` rather than guessing.
   */
  machineId?: string;
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
    targetRepos: env.TARGET_REPOS ? listFromEnv(env.TARGET_REPOS) : [],
    settingsPath: env.DASHBOARD_SETTINGS_PATH || "",
    nodeEnv: env.NODE_ENV || "development",
    machineId: env.AGENT_COORD_MACHINE_ID?.trim() || undefined
  };
}
