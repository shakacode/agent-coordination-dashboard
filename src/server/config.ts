export interface ServerConfig {
  port: number;
  host: string;
  allowedHosts: string[];
  stateRoot: string;
  targetRepos: string[];
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

export function readConfig(env = process.env): ServerConfig {
  const host = env.HOST || "127.0.0.1";
  return {
    port: Number(env.PORT || 4317),
    host,
    allowedHosts: env.ALLOWED_HOSTS ? listFromEnv(env.ALLOWED_HOSTS) : defaultAllowedHosts(host),
    stateRoot: env.AGENT_COORD_STATE_ROOT || "/Users/justin/Documents/agent-coordination/agent-coordination-pr2",
    targetRepos: listFromEnv(env.TARGET_REPOS || "shakacode/react_on_rails"),
    nodeEnv: env.NODE_ENV || "development"
  };
}
