import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

describe("readConfig", () => {
  it("defaults to loopback host protections", () => {
    const config = readConfig({});

    expect(config.host).toBe("127.0.0.1");
    expect(config.allowedHosts).toEqual(expect.arrayContaining(["localhost", "127.0.0.1", "::1"]));
    expect(config.stateRoot).toContain(".local/state/agent-coordination");
    expect(config.coordApiUrl).toBe("");
    expect(config.coordApiToken).toBe("");
    expect(config.refreshIntervalMs).toBe(0);
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
    const config = readConfig({ AGENT_COORD_API_URL: " https://coord.example.test\n", AGENT_COORD_TOKEN: " secret\n" });

    expect(config.coordApiUrl).toBe("https://coord.example.test");
    expect(config.coordApiToken).toBe("secret");
    expect(config.refreshIntervalMs).toBe(5000);
  });

  it("treats blank coordination API settings as unset", () => {
    const config = readConfig({ AGENT_COORD_API_URL: "   ", AGENT_COORD_TOKEN: "\n" });

    expect(config.coordApiUrl).toBe("");
    expect(config.coordApiToken).toBe("");
    expect(config.refreshIntervalMs).toBe(0);
  });

  it("allows dashboard refresh interval overrides", () => {
    expect(readConfig({ AGENT_COORD_API_URL: "https://coord.example.test", DASHBOARD_REFRESH_MS: "2500" }).refreshIntervalMs).toBe(2500);
    expect(readConfig({ AGENT_COORD_API_URL: "https://coord.example.test", DASHBOARD_REFRESH_MS: "0" }).refreshIntervalMs).toBe(0);
    expect(() => readConfig({ DASHBOARD_REFRESH_MS: "-1" })).toThrow(/DASHBOARD_REFRESH_MS/);
  });
});
