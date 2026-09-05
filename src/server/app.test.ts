import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardApp } from "./app";
import type { ServerConfig } from "./config";

const servers: Server[] = [];
const roots: string[] = [];

async function coordinationRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await Promise.all(
    ["claims", "heartbeats", "batches", "events"].map((resource) => mkdir(join(root, resource), { recursive: true }))
  );
  return root;
}

function testConfig(stateRoot: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    stateRoot,
    targetRepos: ["shakacode/react_on_rails"],
    settingsPath: join(stateRoot, "settings.json"),
    nodeEnv: "test",
    ...overrides
  };
}

async function listenServer(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function listen(
  stateRoot: string,
  overrides: Partial<ServerConfig> = {},
  appOptions: NonNullable<Parameters<typeof createDashboardApp>[1]> = {}
): Promise<string> {
  const app = await createDashboardApp(testConfig(stateRoot, overrides), { serveFrontend: false, ...appOptions });
  return listenServer(app.listen(0, "127.0.0.1"));
}

describe("dashboard app", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("reports service health", async () => {
    const stateRoot = await coordinationRoot("coord-health-");
    const baseUrl = await listen(stateRoot);

    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("reports filesystem coordination reachability for every resource", async () => {
    const stateRoot = await coordinationRoot("coord-doctor-");
    const baseUrl = await listen(stateRoot);

    const response = await fetch(`${baseUrl}/api/doctor`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      apiUrl: null,
      tokenEnvVar: null,
      stateRoot,
      perResource: ["claims", "heartbeats", "batches", "events"].map((resource) => ({
        resource,
        mode: "fs",
        status: "empty",
        checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      }))
    });
  });

  it("rejects coordination diagnostics requested from a non-loopback client", async () => {
    const stateRoot = await coordinationRoot("coord-doctor-remote-");
    const app = await createDashboardApp(testConfig(stateRoot), { serveFrontend: false });
    const baseUrl = await listenServer(
      createServer((req, res) => {
        Object.defineProperty(req.socket, "remoteAddress", { value: "203.0.113.8" });
        app(req, res);
      }).listen(0, "127.0.0.1")
    );

    const response = await fetch(`${baseUrl}/api/doctor`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Coordination diagnostics can only be read from the machine running the dashboard."
    });
  });

  it("returns and persists target repositories", async () => {
    const stateRoot = await coordinationRoot("coord-settings-");
    const baseUrl = await listen(stateRoot);

    const initial = await fetch(`${baseUrl}/api/settings`);
    await expect(initial.json()).resolves.toEqual({ targetRepos: ["shakacode/react_on_rails"] });

    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: ["repo-a/app"] })
    });

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({ targetRepos: ["repo-a/app"] });
    await expect(readFile(join(stateRoot, "settings.json"), "utf8")).resolves.toContain("repo-a/app");
    await expect((await fetch(`${baseUrl}/api/settings`)).json()).resolves.toEqual({ targetRepos: ["repo-a/app"] });
  });

  it.each(["./app", "repo/..", ".../repo"])("rejects a dot-only GitHub repository segment in settings: %s", async (targetRepo) => {
    const stateRoot = await coordinationRoot("coord-settings-invalid-repo-");
    const baseUrl = await listen(stateRoot);

    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: [targetRepo] })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "At least one owner/repo target is required." });
  });

  it("rejects settings writes from remote viewers", async () => {
    const stateRoot = await coordinationRoot("coord-settings-remote-");
    const app = await createDashboardApp(testConfig(stateRoot), { serveFrontend: false });
    const baseUrl = await listenServer(
      createServer((req, res) => {
        Object.defineProperty(req.socket, "remoteAddress", { value: "203.0.113.8" });
        app(req, res);
      }).listen(0, "127.0.0.1")
    );

    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: ["repo-a/app"] })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Settings can only be changed from the machine running the dashboard. Remote viewers have read-only access."
    });
  });

  it("allows writes from an exact assigned interface while keeping LAN and link-local peers read-only", async () => {
    const stateRoot = await coordinationRoot("coord-machine-local-writes-");
    const appOptions = {
      serveFrontend: false,
      machineInterfaces: {
        ethernet: [{ address: "192.168.7.26" }],
        bridge: [{ address: "fe80::1" }],
        link: [{ address: "169.254.42.7" }]
      }
    };
    const peers = [
      { label: "assigned interface", remoteAddress: "::ffff:192.168.7.26", forwardedFor: "", expectAllowed: true },
      { label: "LAN peer", remoteAddress: "192.168.7.27", forwardedFor: "192.168.7.26", expectAllowed: false },
      { label: "IPv6 link-local peer", remoteAddress: "fe80::1", forwardedFor: "", expectAllowed: false },
      { label: "IPv4 link-local peer", remoteAddress: "169.254.42.7", forwardedFor: "", expectAllowed: false }
    ];

    for (const peer of peers) {
      const app = await createDashboardApp(testConfig(stateRoot), appOptions);
      const baseUrl = await listenServer(
        createServer((req, res) => {
          Object.defineProperty(req.socket, "remoteAddress", { value: peer.remoteAddress });
          app(req, res);
        }).listen(0, "127.0.0.1")
      );

      const response = await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(peer.forwardedFor ? { "X-Forwarded-For": peer.forwardedFor } : {})
        },
        body: JSON.stringify({ targetRepos: ["repo-a/app"] })
      });

      if (peer.expectAllowed) {
        expect(response.status, `${peer.label} should pass machine-local authorization`).toBe(200);
      } else {
        expect(response.status, `${peer.label} should stay read-only`).toBe(403);
      }
    }
  });
});
