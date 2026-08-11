import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

describe("readConfig", () => {
  it("defaults to loopback host protections", () => {
    const config = readConfig({});

    expect(config.port).toBe(4319);
    expect(config.host).toBe("127.0.0.1");
    expect(config.allowedHosts).toEqual(expect.arrayContaining(["localhost", "127.0.0.1", "::1"]));
    expect(config.stateRoot).toContain(".local/state/agent-coordination");
    expect(config.coordApiUrl).toBe("");
    expect(config.coordApiToken).toBe("");
    expect(config.refreshIntervalMs).toBe(0);
    expect(config.githubRefreshIntervalMs).toBe(15 * 60 * 1000);
    expect(config.githubRequestBudgetPerHour).toBe(1_000);
    expect(config.githubRequestsPerRefresh).toBe(50);
    expect(config.githubQuotaSafetyThreshold).toBe(500);
    expect(config.targetRepos).toEqual([]);
  });

  it("requires explicit allowed hosts for wildcard binds", () => {
    expect(() => readConfig({ HOST: "0.0.0.0" })).toThrow(/ALLOWED_HOSTS/);

    expect(readConfig({ HOST: "0.0.0.0", ALLOWED_HOSTS: "dashboard.local,192.168.1.10" }).allowedHosts).toEqual([
      "dashboard.local",
      "192.168.1.10"
    ]);
  });

  it("reads optional coordination API settings", () => {
    const config = readConfig({ AGENT_COORD_API_URL: " https://coord.example.test\n", AGENT_COORD_API_TOKEN: " secret\n" });

    expect(config.coordApiUrl).toBe("https://coord.example.test");
    expect(config.coordApiToken).toBe("secret");
    expect(config.refreshIntervalMs).toBe(0);
  });

  it("falls back to the legacy coordination token and prefers the API token", () => {
    expect(readConfig({ AGENT_COORD_TOKEN: " legacy-secret\n" })).toMatchObject({
      coordApiToken: "legacy-secret",
      coordApiTokenEnvVar: "AGENT_COORD_TOKEN"
    });
    expect(readConfig({ AGENT_COORD_API_TOKEN: " current-secret ", AGENT_COORD_TOKEN: "legacy-secret" })).toMatchObject({
      coordApiToken: "current-secret",
      coordApiTokenEnvVar: "AGENT_COORD_API_TOKEN"
    });
  });

  it("treats blank coordination API settings as unset", () => {
    const config = readConfig({ AGENT_COORD_API_URL: "   ", AGENT_COORD_API_TOKEN: "\n" });

    expect(config.coordApiUrl).toBe("");
    expect(config.coordApiToken).toBe("");
    expect(config.refreshIntervalMs).toBe(0);
  });

  it("allows dashboard refresh interval overrides", () => {
    expect(readConfig({ AGENT_COORD_API_URL: "https://coord.example.test", DASHBOARD_REFRESH_MS: "2500" }).refreshIntervalMs).toBe(2500);
    expect(readConfig({ AGENT_COORD_API_URL: "https://coord.example.test", DASHBOARD_REFRESH_MS: "0" }).refreshIntervalMs).toBe(0);
    expect(() => readConfig({ DASHBOARD_REFRESH_MS: "-1" })).toThrow(/DASHBOARD_REFRESH_MS/);
  });

  it("reads conservative GitHub refresh and quota guardrails", () => {
    expect(readConfig({
      GITHUB_REFRESH_MS: "600000",
      GITHUB_REQUEST_BUDGET_PER_HOUR: "800",
      GITHUB_REQUESTS_PER_REFRESH: "40",
      GITHUB_QUOTA_SAFETY_THRESHOLD: "250"
    })).toMatchObject({
      githubRefreshIntervalMs: 600_000,
      githubRequestBudgetPerHour: 800,
      githubRequestsPerRefresh: 40,
      githubQuotaSafetyThreshold: 250
    });
    expect(readConfig({ GITHUB_REFRESH_MS: "0" }).githubRefreshIntervalMs).toBe(0);
    expect(() => readConfig({ GITHUB_REQUEST_BUDGET_PER_HOUR: "0" })).toThrow(/GITHUB_REQUEST_BUDGET_PER_HOUR/);
    expect(() => readConfig({ GITHUB_REQUESTS_PER_REFRESH: "-1" })).toThrow(/GITHUB_REQUESTS_PER_REFRESH/);
    expect(() => readConfig({ GITHUB_QUOTA_SAFETY_THRESHOLD: "-1" })).toThrow(/GITHUB_QUOTA_SAFETY_THRESHOLD/);
  });
});
