export interface ServerConfig {
  port: number;
  host: string;
  stateRoot: string;
  targetRepos: string[];
  nodeEnv: string;
}

export function readConfig(env = process.env): ServerConfig {
  return {
    port: Number(env.PORT || 4317),
    host: env.HOST || "127.0.0.1",
    stateRoot: env.AGENT_COORD_STATE_ROOT || "/Users/justin/Documents/agent-coordination/agent-coordination-pr2",
    targetRepos: (env.TARGET_REPOS || "shakacode/react_on_rails")
      .split(",")
      .map((repo) => repo.trim())
      .filter(Boolean),
    nodeEnv: env.NODE_ENV || "development"
  };
}
