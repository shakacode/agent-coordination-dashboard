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
    const config = readConfig({ AGENT_COORD_API_URL: "https://coord.example.test", AGENT_COORD_TOKEN: "secret" });

    expect(config.coordApiUrl).toBe("https://coord.example.test");
    expect(config.coordApiToken).toBe("secret");
  });
});
