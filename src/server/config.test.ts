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
  });

  it("reads the dashboard machine id and treats a blank one as unset", () => {
    expect(readConfig({ AGENT_COORD_MACHINE_ID: " M5\n" }).machineId).toBe("M5");
    expect(readConfig({ AGENT_COORD_MACHINE_ID: "   " }).machineId).toBeUndefined();
    expect(readConfig({}).machineId).toBeUndefined();
  });

  it("reads the remaining coordination and target settings", () => {
    expect(readConfig({
      PORT: "5000",
      AGENT_COORD_STATE_ROOT: "/tmp/coordination",
      TARGET_REPOS: "owner/one, owner/two",
      DASHBOARD_SETTINGS_PATH: "/tmp/settings.json",
      NODE_ENV: "production"
    })).toMatchObject({
      port: 5000,
      stateRoot: "/tmp/coordination",
      targetRepos: ["owner/one", "owner/two"],
      settingsPath: "/tmp/settings.json",
      nodeEnv: "production"
    });
  });
});
