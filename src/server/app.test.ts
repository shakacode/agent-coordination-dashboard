/// <reference types="vite/client" />
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeDashboardSettings } from "./settings";
import { ATTENTION_CACHE_TTL_MS, createDashboardApp } from "./app";
import appModuleSource from "./app.ts?raw";
import {
  ATTENTION_READ_OUTCOME_KINDS,
  ATTENTION_WORKSPACE,
  type AttentionReadCounts,
  type AttentionReadResult,
  type AttentionRepositoryRead,
  type ReadAttentionRecordsOptions
} from "./attention/readAttentionRecords";
import { ATTENTION_SAMPLE_INTERVAL_MS, ATTENTION_SAMPLES_FILENAME } from "./attention/sampler";
import type { ServerConfig } from "./config";
import type { AttentionPayload } from "../shared/attention";
import { attentionRepository, makeAttentionRecord, openAttentionRecord } from "../shared/attention.fixtures";

const servers: Server[] = [];
const roots: string[] = [];

/** The model's clock for every attention test; the shared fixtures are fresh against it. */
const NOW = new Date("2026-09-03T09:30:00.000Z");
const CHECKED_AT = NOW.toISOString();
const ATTENTION_PREFIX = `attention/${ATTENTION_WORKSPACE}/${attentionRepository}`;

/** The `Accept` header a browser sends when it navigates to a page. */
const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

function emptyCounts(): AttentionReadCounts {
  const outcomes = {} as AttentionReadCounts["outcomes"];
  for (const kind of ATTENTION_READ_OUTCOME_KINDS) {
    outcomes[kind] = 0;
  }
  return { seen: 0, read: 0, skipped: 0, outcomes };
}

function repositoryRead(overrides: Partial<AttentionRepositoryRead> = {}): AttentionRepositoryRead {
  return {
    repository: attentionRepository,
    workspace: ATTENTION_WORKSPACE,
    mode: "fs",
    prefix: ATTENTION_PREFIX,
    sourceStatus: { status: "ok", checkedAt: CHECKED_AT },
    records: [openAttentionRecord],
    diagnostics: [],
    partial: false,
    counts: emptyCounts(),
    ...overrides
  };
}

function attentionRead(...repositories: AttentionRepositoryRead[]): AttentionReadResult {
  const reads = repositories.length > 0 ? repositories : [repositoryRead()];
  return { workspace: ATTENTION_WORKSPACE, mode: reads[0].mode, checkedAt: CHECKED_AT, repositories: reads };
}

/** A reader seam that records every call, so a test can count reads rather than infer them. */
function countingReader(result: AttentionReadResult = attentionRead()) {
  const calls: ReadAttentionRecordsOptions[] = [];
  return {
    calls,
    read: async (options: ReadAttentionRecordsOptions): Promise<AttentionReadResult> => {
      calls.push(options);
      return result;
    }
  };
}

async function attentionPayloadOf(response: Response): Promise<AttentionPayload> {
  return (await response.json()) as AttentionPayload;
}

function attentionConfig(stateRoot: string, overrides: Partial<ServerConfig> = {}): Partial<ServerConfig> {
  return { targetRepos: [attentionRepository], settingsPath: join(stateRoot, "settings.json"), ...overrides };
}

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
  const app = await createDashboardApp(testConfig(stateRoot, overrides), {
    serveFrontend: false,
    attentionSampler: false,
    ...appOptions
  });
  return listenServer(app.listen(0, "127.0.0.1"));
}

/** The same app behind a server that reports a fixed peer address. */
async function listenForPeer(
  stateRoot: string,
  remoteAddress: string,
  overrides: Partial<ServerConfig> = {},
  appOptions: NonNullable<Parameters<typeof createDashboardApp>[1]> = {}
): Promise<string> {
  const app = await createDashboardApp(testConfig(stateRoot, overrides), {
    serveFrontend: false,
    attentionSampler: false,
    ...appOptions
  });
  return listenServer(
    createServer((req, res) => {
      Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddress });
      app(req, res);
    }).listen(0, "127.0.0.1")
  );
}

interface DirectResponse {
  status: number;
  body: string;
}

/**
 * Dispatch one request straight into the app, with no socket server and no HTTP
 * client.
 *
 * The timer test needs it: client and server share this process, so an HTTP
 * client's own connection timers would land in a `setTimeout` spy and make the
 * assertion about the app unreadable. Every other test uses a real server.
 */
function requestDirectly(app: Awaited<ReturnType<typeof createDashboardApp>>, path: string): Promise<DirectResponse> {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  const req = new IncomingMessage(socket);
  req.method = "GET";
  req.url = path;
  req.headers = { host: "127.0.0.1" };
  const res = new ServerResponse(req);
  const chunks: string[] = [];
  const capture = (chunk: unknown) => {
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      chunks.push(chunk.toString());
    }
  };
  res.write = ((chunk: unknown) => {
    capture(chunk);
    return true;
  }) as typeof res.write;
  return new Promise((resolve) => {
    res.end = ((chunk?: unknown) => {
      capture(chunk);
      resolve({ status: res.statusCode, body: chunks.join("") });
      return res;
    }) as typeof res.end;
    app(req, res);
    req.push(null);
  });
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
      })),
      attention: {
        mode: "fs",
        workspace: ATTENTION_WORKSPACE,
        // No settings file exists yet, so the configured targets stand in and
        // the report says so.
        settings: "first_run_default",
        repositories: [
          {
            // The scope comes from the saved settings, which fall back to the
            // configured targets on first run.
            repository: "shakacode/react_on_rails",
            status: "empty",
            checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            partial: false
          }
        ]
      }
    });
  });

  it("still answers a report when the saved settings cannot be read", async () => {
    const stateRoot = await coordinationRoot("coord-doctor-corrupt-settings-");
    const corruptSettingsPath = join(stateRoot, "settings.json");
    await writeFile(corruptSettingsPath, "{ this is not json", "utf8");
    const baseUrl = await listen(stateRoot);

    const response = await fetch(`${baseUrl}/api/doctor`);
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    // The endpoint an operator reaches when the configuration is broken keeps
    // answering a report, and the report leaks neither the settings path, the
    // parser message, nor a stack.
    expect(response.status).toBe(200);
    expect(text).not.toContain(corruptSettingsPath);
    expect(text).not.toContain("Could not read dashboard settings");
    expect(text).not.toContain("src/server/settings.ts");
    expect(text).not.toContain("<!DOCTYPE html>");
    // The configured targets are a first-run fallback only. A settings file
    // that exists but cannot be read is not a first run, so the scope is
    // reported as unreadable rather than silently replaced by repositories the
    // operator never saved.
    expect(body.attention).toEqual({
      mode: "fs",
      workspace: "UNKNOWN",
      settings: "unreadable",
      repositories: []
    });
    expect(JSON.stringify(body)).not.toContain("shakacode/react_on_rails");
  });

  it("scopes the reported attention read to the saved settings", async () => {
    const stateRoot = await coordinationRoot("coord-doctor-saved-settings-");
    await writeFile(join(stateRoot, "settings.json"), JSON.stringify({ targetRepos: ["repo-a/app"] }), "utf8");
    const baseUrl = await listen(stateRoot);

    const body = (await (await fetch(`${baseUrl}/api/doctor`)).json()) as Record<string, unknown>;

    // Saved settings win over the configured targets, and the report says the
    // scope came from them.
    expect(body.attention).toEqual({
      mode: "fs",
      workspace: ATTENTION_WORKSPACE,
      settings: "saved",
      repositories: [{ repository: "repo-a/app", status: "empty", checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), partial: false }]
    });
    expect(JSON.stringify(body)).not.toContain("shakacode/react_on_rails");
  });

  it("rejects coordination diagnostics requested from a non-loopback client", async () => {
    const stateRoot = await coordinationRoot("coord-doctor-remote-");
    const app = await createDashboardApp(testConfig(stateRoot), { serveFrontend: false, attentionSampler: false });
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
    await expect(initial.json()).resolves.toEqual(normalizeDashboardSettings({ targetRepos: ["shakacode/react_on_rails"] }));

    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: ["repo-a/app"] })
    });

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual(normalizeDashboardSettings({ targetRepos: ["repo-a/app"] }));
    await expect(readFile(join(stateRoot, "settings.json"), "utf8")).resolves.toContain("repo-a/app");
    await expect((await fetch(`${baseUrl}/api/settings`)).json()).resolves.toEqual(normalizeDashboardSettings({ targetRepos: ["repo-a/app"] }));
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
    await expect(response.json()).resolves.toEqual({ error: "targetRepos: At least one owner/repo target is required." });
  });

  it("rejects settings writes from remote viewers", async () => {
    const stateRoot = await coordinationRoot("coord-settings-remote-");
    const app = await createDashboardApp(testConfig(stateRoot), { serveFrontend: false, attentionSampler: false });
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
      attentionSampler: false as const,
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

describe("GET /api/attention", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("builds the payload once and serves the cached copy inside the TTL", async () => {
    const stateRoot = await coordinationRoot("coord-attention-hit-");
    const reader = countingReader();
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot, { machineId: "m5" }), {
      readAttentionRecords: reader.read,
      now: () => NOW
    });

    const first = await fetch(`${baseUrl}/api/attention`);
    const firstBody = await attentionPayloadOf(first);
    const second = await fetch(`${baseUrl}/api/attention`);

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(firstBody.cards).toHaveLength(1);
    // The configured machine id reaches the model, so the payload names this
    // dashboard's host instead of falling back to UNKNOWN.
    expect(firstBody.dashboard_host).toBe("M5");
    expect(firstBody.sources).toEqual([expect.objectContaining({ repository: attentionRepository, status: "ok" })]);
    await expect(second.json()).resolves.toEqual(firstBody);
    expect(reader.calls).toHaveLength(1);
    // The scope comes from the saved settings, which fall back to the configured
    // targets on first run.
    expect(reader.calls[0]).toMatchObject({ stateRoot, targetRepos: [attentionRepository] });
  });

  it("rebuilds on the first request after the TTL expires", async () => {
    const stateRoot = await coordinationRoot("coord-attention-expiry-");
    const reader = countingReader();
    const clock = { value: NOW };
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: reader.read,
      now: () => clock.value
    });

    await fetch(`${baseUrl}/api/attention`);
    clock.value = new Date(NOW.getTime() + ATTENTION_CACHE_TTL_MS - 1);
    await fetch(`${baseUrl}/api/attention`);
    expect(reader.calls).toHaveLength(1);

    clock.value = new Date(NOW.getTime() + ATTENTION_CACHE_TTL_MS);
    await fetch(`${baseUrl}/api/attention`);

    expect(reader.calls).toHaveLength(2);
  });

  it("coalesces concurrent misses into one read", async () => {
    const stateRoot = await coordinationRoot("coord-attention-inflight-");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reads: string[] = [];
    const read = async (): Promise<AttentionReadResult> => {
      reads.push("start");
      await gate;
      return attentionRead();
    };
    const app = await createDashboardApp(testConfig(stateRoot, attentionConfig(stateRoot)), {
      serveFrontend: false,
      attentionSampler: false,
      readAttentionRecords: read,
      now: () => NOW
    });
    let arrived = 0;
    const baseUrl = await listenServer(
      createServer((req, res) => {
        arrived += 1;
        app(req, res);
      }).listen(0, "127.0.0.1")
    );

    const pending = Promise.all([
      fetch(`${baseUrl}/api/attention`),
      fetch(`${baseUrl}/api/attention`),
      fetch(`${baseUrl}/api/attention`)
    ]);
    // The build stays open until all three requests are inside the app, so none
    // of them can be answered from a cache that does not exist yet.
    while (arrived < 3) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release();
    const bodies = await Promise.all((await pending).map(attentionPayloadOf));

    expect(reads).toHaveLength(1);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it("rebuilds inside the TTL for a loopback foreground refresh", async () => {
    const stateRoot = await coordinationRoot("coord-attention-bypass-");
    const reader = countingReader();
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: reader.read,
      now: () => NOW
    });

    await fetch(`${baseUrl}/api/attention`);
    const refreshed = await fetch(`${baseUrl}/api/attention`, { headers: { "X-Dashboard-Refresh": "foreground" } });
    expect(refreshed.status).toBe(200);
    expect(reader.calls).toHaveLength(2);

    // The refresh repopulated the cache rather than disabling it.
    await fetch(`${baseUrl}/api/attention`);
    expect(reader.calls).toHaveLength(2);
  });

  it.each([
    ["an unrelated header value", "background"],
    ["no header at all", undefined]
  ])("ignores %s from a loopback client", async (_label, headerValue) => {
    const stateRoot = await coordinationRoot("coord-attention-header-");
    const reader = countingReader();
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: reader.read,
      now: () => NOW
    });

    await fetch(`${baseUrl}/api/attention`);
    await fetch(`${baseUrl}/api/attention`, {
      headers: headerValue === undefined ? {} : { "X-Dashboard-Refresh": headerValue }
    });

    expect(reader.calls).toHaveLength(1);
  });

  it("ignores the foreground refresh header from a non-loopback address", async () => {
    const stateRoot = await coordinationRoot("coord-attention-remote-refresh-");
    const reader = countingReader();
    const baseUrl = await listenForPeer(stateRoot, "203.0.113.8", attentionConfig(stateRoot), {
      readAttentionRecords: reader.read,
      now: () => NOW
    });

    const first = await fetch(`${baseUrl}/api/attention`);
    const firstBody = await attentionPayloadOf(first);
    const second = await fetch(`${baseUrl}/api/attention`, { headers: { "X-Dashboard-Refresh": "foreground" } });

    // A remote viewer still reads the payload; it just cannot force a rebuild.
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual(firstBody);
    expect(reader.calls).toHaveLength(1);
  });

  it("rebuilds against the new scope after a settings write, inside the TTL", async () => {
    const stateRoot = await coordinationRoot("coord-attention-settings-write-");
    const reader = countingReader();
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: reader.read,
      now: () => NOW
    });

    await fetch(`${baseUrl}/api/attention`);
    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: ["repo-a/app"] })
    });
    expect(saved.status).toBe(200);

    // The clock never moves, so the entry is still inside its TTL: the write is
    // the only thing that can have dropped it. A remote viewer cannot force a
    // refresh, so a stale scope would keep serving records from a repository
    // that is no longer saved.
    await fetch(`${baseUrl}/api/attention`);

    expect(reader.calls).toHaveLength(2);
    expect(reader.calls[0].targetRepos).toEqual([attentionRepository]);
    expect(reader.calls[1].targetRepos).toEqual(["repo-a/app"]);
  });

  it("does not cache a payload whose scope a settings write replaced mid-build", async () => {
    const stateRoot = await coordinationRoot("coord-attention-write-in-flight-");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reads: ReadAttentionRecordsOptions[] = [];
    const read = async (options: ReadAttentionRecordsOptions): Promise<AttentionReadResult> => {
      reads.push(options);
      if (reads.length === 1) {
        await gate;
      }
      return attentionRead();
    };
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: read,
      now: () => NOW
    });

    const pending = fetch(`${baseUrl}/api/attention`);
    while (reads.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: ["repo-a/app"] })
    });
    expect(saved.status).toBe(200);
    release();

    // The request that was already waiting still gets the build it joined; what
    // must not happen is that build becoming the cached answer for the new
    // scope.
    expect((await pending).status).toBe(200);
    await fetch(`${baseUrl}/api/attention`);

    expect(reads).toHaveLength(2);
    expect(reads[1].targetRepos).toEqual(["repo-a/app"]);
  });

  it("does not join a request arriving after a settings write to the build reading the replaced scope", async () => {
    const stateRoot = await coordinationRoot("coord-attention-write-join-");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let secondReadStarted!: () => void;
    const secondRead = new Promise<void>((resolve) => {
      secondReadStarted = resolve;
    });
    const reads: ReadAttentionRecordsOptions[] = [];
    // Each read reports the scope it was asked for, so a payload can be traced
    // back to the settings it was built from.
    const read = async (options: ReadAttentionRecordsOptions): Promise<AttentionReadResult> => {
      reads.push(options);
      if (reads.length === 1) {
        await gate;
      } else {
        secondReadStarted();
      }
      return attentionRead(repositoryRead({ repository: options.targetRepos[0] }));
    };
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: read,
      now: () => NOW
    });

    const joinedBeforeWrite = fetch(`${baseUrl}/api/attention`);
    while (reads.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: ["repo-a/app"] })
    });
    expect(saved.status).toBe(200);

    // This request arrives after the write, so it must read the saved scope
    // rather than join the build that is still reading the replaced one. The
    // race is bounded rather than spun on, so a regression fails here instead
    // of hanging.
    const afterWrite = fetch(`${baseUrl}/api/attention`);
    await Promise.race([secondRead, new Promise((resolve) => setTimeout(resolve, 250))]);
    release();

    const afterWriteBody = await attentionPayloadOf(await afterWrite);
    expect(afterWriteBody.sources).toEqual([expect.objectContaining({ repository: "repo-a/app" })]);
    expect(reads).toHaveLength(2);
    expect(reads[1].targetRepos).toEqual(["repo-a/app"]);

    // The request that had already joined the old build still gets the old
    // payload: cancelling a read in progress is the only alternative, and it is
    // out of scope here.
    const joinedBody = await attentionPayloadOf(await joinedBeforeWrite);
    expect(joinedBody.sources).toEqual([expect.objectContaining({ repository: attentionRepository })]);
  });

  it("answers 500 without detail when the saved settings cannot be read, and recovers once they are repaired", async () => {
    const stateRoot = await coordinationRoot("coord-attention-corrupt-settings-");
    const settingsFile = join(stateRoot, "settings.json");
    await writeFile(settingsFile, "{ this is not json", "utf8");
    const reader = countingReader();
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: reader.read,
      now: () => NOW
    });

    const failure = await fetch(`${baseUrl}/api/attention`);
    const failureText = await failure.text();

    // Falling back to the configured targets here would serve cards for
    // repositories the operator never saved, so the route reports the failure
    // and reads nothing.
    expect(failure.status).toBe(500);
    expect(JSON.parse(failureText)).toEqual({ error: "Attention payload could not be built." });
    expect(failureText).not.toContain(settingsFile);
    expect(failureText).not.toContain("Could not read dashboard settings");
    expect(failureText).not.toContain("src/server/settings.ts");
    expect(failureText).not.toContain("<!DOCTYPE html>");
    expect(failureText).not.toContain(attentionRepository);
    expect(reader.calls).toHaveLength(0);

    await writeFile(settingsFile, JSON.stringify({ targetRepos: [attentionRepository] }), "utf8");
    const repaired = await fetch(`${baseUrl}/api/attention`);

    // The failure poisoned nothing: the next request builds normally.
    expect(repaired.status).toBe(200);
    expect((await attentionPayloadOf(repaired)).cards).toHaveLength(1);
    expect(reader.calls).toHaveLength(1);
  });

  it("answers 200 with source statuses and diagnostics when every repository is unreachable", async () => {
    const stateRoot = await coordinationRoot("coord-attention-unreachable-");
    const reader = countingReader(
      attentionRead(
        repositoryRead({
          mode: "api",
          sourceStatus: { status: "unreachable", checkedAt: CHECKED_AT, httpStatus: 503 },
          records: [],
          diagnostics: [
            {
              repository: attentionRepository,
              workspace: ATTENTION_WORKSPACE,
              mode: "api",
              kind: "unreadable",
              path: ATTENTION_PREFIX,
              reason: `Could not read coordination API ${ATTENTION_PREFIX}: 503 unavailable`
            }
          ]
        })
      )
    );
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: reader.read,
      now: () => NOW
    });

    const response = await fetch(`${baseUrl}/api/attention`);
    const body = await attentionPayloadOf(response);

    expect(response.status).toBe(200);
    expect(body.cards).toEqual([]);
    expect(body.sources).toEqual([
      expect.objectContaining({ repository: attentionRepository, mode: "api", status: "unreachable" })
    ]);
    expect(body.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ repository: attentionRepository, kind: "unreadable" })])
    );
  });

  it("answers 500 without detail only when the read throws, and retries on the next request", async () => {
    const stateRoot = await coordinationRoot("coord-attention-throw-");
    let attempts = 0;
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("reader exploded at /Users/someone/secret/path");
        }
        return attentionRead();
      },
      now: () => NOW
    });

    const failure = await fetch(`${baseUrl}/api/attention`);
    const failureText = await failure.text();

    expect(failure.status).toBe(500);
    expect(JSON.parse(failureText)).toEqual({ error: "Attention payload could not be built." });
    expect(failureText).not.toContain("reader exploded");
    expect(failureText).not.toContain("/Users/someone/secret/path");

    // Nothing was cached and the in-flight guard was cleared, so the next
    // request builds again instead of inheriting the failure.
    const recovered = await fetch(`${baseUrl}/api/attention`);
    expect(recovered.status).toBe(200);
    expect((await attentionPayloadOf(recovered)).cards).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it("reaches only the configured coordination API while building in API mode", async () => {
    const stateRoot = await coordinationRoot("coord-attention-no-github-");
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requested.push(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
      return new Response(JSON.stringify({ entries: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const baseUrl = await listen(
      stateRoot,
      attentionConfig(stateRoot, { coordApiUrl: "https://coord.example.test", coordApiToken: "api-token" }),
      { fetchImpl, now: () => NOW }
    );

    const response = await fetch(`${baseUrl}/api/attention`);
    const body = await attentionPayloadOf(response);

    expect(response.status).toBe(200);
    expect(requested).toHaveLength(1);
    expect(requested.map((url) => new URL(url).host)).toEqual(["coord.example.test"]);
    expect(requested.some((url) => new URL(url).host === "api.github.com")).toBe(false);
    expect(new URL(requested[0]).searchParams.get("prefix")).toBe(ATTENTION_PREFIX);
    expect(body.sources).toEqual([
      expect.objectContaining({ repository: attentionRepository, mode: "api", status: "empty" })
    ]);
  });

  it("imports nothing from the GitHub client into the app module", () => {
    const staticImports = [...appModuleSource.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";$/gm)].map((match) => match[1]);
    const dynamicImports = [...appModuleSource.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);

    // The regex is load-bearing, so prove it actually found the module's imports.
    expect(staticImports).toContain("./attention/readAttentionRecords");
    expect([...staticImports, ...dynamicImports].filter((specifier) => /github/i.test(specifier))).toEqual([]);
  });

  it("schedules no timer while creating the app or serving the route", async () => {
    const stateRoot = await coordinationRoot("coord-attention-timers-");
    const reader = countingReader();
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");

    try {
      const app = await createDashboardApp(testConfig(stateRoot, attentionConfig(stateRoot)), {
        serveFrontend: false,
        attentionSampler: false,
        readAttentionRecords: reader.read,
        now: () => NOW
      });
      const response = await requestDirectly(app, "/api/attention");

      expect(response.status).toBe(200);
      // The cache is a TTL and an in-flight guard: no timer ever rebuilds it,
      // and the sampling job is the only timer the dashboard runs at all.
      expect(interval).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      interval.mockRestore();
      timeout.mockRestore();
    }
  });

  it("starts the hourly sampler by default, and nothing else on the render path", async () => {
    const stateRoot = await coordinationRoot("coord-attention-sampler-default-");
    const reader = countingReader();
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");

    try {
      const app = await createDashboardApp(testConfig(stateRoot, attentionConfig(stateRoot)), {
        serveFrontend: false,
        readAttentionRecords: reader.read,
        now: () => NOW
      });
      const response = await requestDirectly(app, "/api/attention");

      expect(response.status).toBe(200);
      // Production gets the sampling job without index.ts asking for it, and
      // gets exactly one interval: the hourly sample, and no cache refresh.
      expect(interval).toHaveBeenCalledTimes(1);
      expect(interval.mock.calls[0][1]).toBe(ATTENTION_SAMPLE_INTERVAL_MS);
      expect(timeout).not.toHaveBeenCalled();
      // Unref'd, so the sampling job never holds a process open by itself.
      const handle = interval.mock.results[0].value as ReturnType<typeof setInterval>;
      expect(handle.hasRef()).toBe(false);
      clearInterval(handle);
    } finally {
      interval.mockRestore();
      timeout.mockRestore();
    }
  });

  it("counts a document load and a foreground refresh, and never a poll, in the hourly sample", async () => {
    const stateRoot = await coordinationRoot("coord-attention-document-loads-");
    const reader = countingReader();
    const ticks: { tick: () => Promise<void>; delayMs: number }[] = [];
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: reader.read,
      now: () => NOW,
      attentionSampler: {
        schedule: (tick, delayMs) => {
          ticks.push({ tick, delayMs });
          return () => {};
        }
      }
    });

    // A navigation: the browser names the document media type outright.
    await fetch(baseUrl, { headers: { accept: DOCUMENT_ACCEPT } });
    // The client's own poll, exactly as src/client/api.ts sends it.
    await fetch(`${baseUrl}/api/attention`, { headers: { accept: "application/json" } });
    await fetch(`${baseUrl}/api/attention`, { headers: { accept: "application/json" } });
    // The operator pressing Refresh: a loopback foreground request.
    await fetch(`${baseUrl}/api/attention`, {
      headers: { accept: "application/json", "X-Dashboard-Refresh": "foreground" }
    });
    // A script and a stylesheet the page pulls in behind the document.
    await fetch(`${baseUrl}/assets/index.js`, { headers: { accept: "*/*" } });
    await fetch(`${baseUrl}/assets/index.css`, { headers: { accept: "text/css,*/*;q=0.1" } });
    // Reading an endpoint by hand in an address bar is not a page load.
    await fetch(`${baseUrl}/api/health`, { headers: { accept: DOCUMENT_ACCEPT } });
    // Express routes are case-insensitive, so these still serve API JSON.
    await fetch(`${baseUrl}/API/attention`, { headers: { accept: DOCUMENT_ACCEPT } });

    expect(ticks).toHaveLength(1);
    expect(ticks[0].delayMs).toBe(ATTENTION_SAMPLE_INTERVAL_MS);
    // One build for the first poll and one for the foreground refresh.
    expect(reader.calls).toHaveLength(2);
    await ticks[0].tick();
    // The sample reads through the same cache the route does, so an hourly job
    // never doubles the read load.
    expect(reader.calls).toHaveLength(2);

    const rows = (await readFile(join(stateRoot, ATTENTION_SAMPLES_FILENAME), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ts: NOW.toISOString(), open: 1, document_loads_since_last: 2 });
  });

  it("does not sample an old pending scope or consume new-scope visits after settings change", async () => {
    const root = await coordinationRoot("coord-sampler-pending-scope-");
    const ticks: (() => Promise<void>)[] = [];
    let releaseOld!: () => void;
    let startedOld!: () => void;
    const oldStarted = new Promise<void>((resolve) => { startedOld = resolve; });
    const oldReleased = new Promise<void>((resolve) => { releaseOld = resolve; });
    const baseUrl = await listen(root, attentionConfig(root), {
      now: () => NOW,
      readAttentionRecords: async ({ targetRepos }) => {
        if (targetRepos[0] === attentionRepository) {
          startedOld();
          await oldReleased;
        }
        return attentionRead(...targetRepos.map((repository) => repositoryRead({
          repository,
          records: [makeAttentionRecord({
            repository, target: `https://github.com/${repository}/pull/1`,
            priority_class: "urgent-risk", created_at: "2026-09-01T09:00:00Z"
          })]
        })));
      },
      attentionSampler: { schedule: (tick) => { ticks.push(tick); return () => {}; }, logger: { warn: () => {} } }
    });
    await fetch(baseUrl, { headers: { accept: DOCUMENT_ACCEPT } });
    const pending = ticks[0]();
    await oldStarted;
    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetRepos: ["example/new-repo"] })
    });
    expect(saved.status).toBe(200);
    await fetch(baseUrl, { headers: { accept: DOCUMENT_ACCEPT } });
    releaseOld();
    await pending;
    await expect(readFile(join(root, ATTENTION_SAMPLES_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
    await ticks[0]();
    const rows = (await readFile(join(root, ATTENTION_SAMPLES_FILENAME), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ urgent: 1, new_urgent_since_last: 1, document_loads_since_last: 1 });
  });

  it("does not count a foreground HEAD request as an operator arrival", async () => {
    const stateRoot = await coordinationRoot("coord-attention-head-refresh-");
    const ticks: (() => Promise<void>)[] = [];
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: countingReader().read,
      now: () => NOW,
      attentionSampler: { schedule: (tick) => { ticks.push(tick); return () => {}; } }
    });
    const response = await fetch(`${baseUrl}/api/attention`, {
      method: "HEAD",
      headers: { "X-Dashboard-Refresh": "foreground" }
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    await ticks[0]();
    const row = JSON.parse((await readFile(join(stateRoot, ATTENTION_SAMPLES_FILENAME), "utf8")).trim());
    expect(row.document_loads_since_last).toBe(0);
  });

  it("serves every card through the record projection, so an unsafe target arrives as null", async () => {
    const stateRoot = await coordinationRoot("coord-attention-projection-");
    const record = {
      ...makeAttentionRecord({ id: "unsafe-target-record", target: "javascript:alert(document.domain)" }),
      prompt: "Full agent prompt that must never reach a card"
    } as ReturnType<typeof makeAttentionRecord>;
    const reader = countingReader(attentionRead(repositoryRead({ records: [record] })));
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: reader.read,
      now: () => NOW
    });

    const body = await attentionPayloadOf(await fetch(`${baseUrl}/api/attention`));

    expect(body.cards).toHaveLength(1);
    // The route forwards the projection the model produced and nothing else:
    // the client relies on this being the one validation point.
    expect(body.cards[0].record.target).toBeNull();
    expect(JSON.stringify(body)).not.toContain("javascript:");
    expect(JSON.stringify(body)).not.toContain("Full agent prompt");
    expect(Object.hasOwn(body.cards[0].record, "prompt")).toBe(false);
  });
});

describe("attention settings HTTP integration", () => {
  it("preserves every saved property through full and legacy target-only PUTs", async () => {
    const root = await coordinationRoot("settings-roundtrip-");
    const baseUrl = await listen(root);
    const settings = { targetRepos: ["example/app"], attentionWorkspace: "Desk.east", attentionOpenAgeDays: 2,
      attentionSourceIntervalSeconds: { default: 600, repositories: { "example/app": 120 } }, future: { nested: [true, null] } };
    const put = (body: unknown) => fetch(`${baseUrl}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(await (await put(settings)).json()).toEqual(settings);
    const expected = { ...settings, targetRepos: ["other/app"] };
    expect(await (await put({ targetRepos: expected.targetRepos })).json()).toEqual(expected);
    expect(await (await fetch(`${baseUrl}/api/settings`)).json()).toEqual(expected);
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual(expected);
    const report = await (await fetch(`${baseUrl}/api/doctor`)).json();
    expect(report).toMatchObject({ attention: { workspace: "Desk.east" } });
  });

  it("rejects named invalid settings without changing disk or the attention cache", async () => {
    const root = await coordinationRoot("settings-invalid-attention-");
    const reader = vi.fn(async () => attentionRead());
    const baseUrl = await listen(root, attentionConfig(root), { readAttentionRecords: reader, now: () => NOW });
    await writeFile(join(root, "settings.json"), JSON.stringify({ targetRepos: [attentionRepository] }));
    await fetch(`${baseUrl}/api/attention`);
    const before = await readFile(join(root, "settings.json"), "utf8");
    for (const [key, value] of [["attentionWorkspace", "../escape"], ["attentionOpenAgeDays", 0], ["attentionOpenAgeDays", 2.5], ["attentionSourceIntervalSeconds", { default: 600, repositories: { "example/app": 0 } }]] as const) {
      const response = await fetch(`${baseUrl}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: value }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining(key) });
      expect(await readFile(join(root, "settings.json"), "utf8")).toBe(before);
      await fetch(`${baseUrl}/api/attention`);
      expect(reader).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["{broken", '{"targetRepos":["example/app"],"attentionWorkspace":"../escape"}'])("repairs malformed saved contents only with a complete valid PUT: %s", async (contents) => {
    const root = await coordinationRoot("settings-repair-");
    const baseUrl = await listen(root);
    await writeFile(join(root, "settings.json"), contents);
    const put = (body: unknown) => fetch(`${baseUrl}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await put({ attentionWorkspace: "Desk" })).status).toBe(400);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(contents);
    expect((await put({ targetRepos: ["example/app"], attentionWorkspace: "Desk" })).status).toBe(200);
    expect(await (await fetch(`${baseUrl}/api/settings`)).json()).toEqual(normalizeDashboardSettings({ targetRepos: ["example/app"], attentionWorkspace: "Desk" }));
  });
});

it("applies saved workspace, interval overrides and open age to the HTTP model", async () => {
  const root = await coordinationRoot("settings-model-http-");
  const reader = vi.fn(async (options: ReadAttentionRecordsOptions) => {
    const result = attentionRead(repositoryRead({ records: [makeAttentionRecord({
      workspace: options.workspace, refresh_interval_seconds: undefined,
      created_at: "2026-08-31T09:30:00Z", refreshed_at: "2026-09-03T09:25:00Z",
      source: { ...openAttentionRecord.source, last_seen_at: "2026-09-03T09:29:00Z" }
    })] }));
    return { ...result, workspace: options.workspace ?? "default" };
  });
  const baseUrl = await listen(root, attentionConfig(root), { readAttentionRecords: reader, now: () => NOW });
  const put = (body: unknown) => fetch(`${baseUrl}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await put({ attentionWorkspace: "Desk", attentionOpenAgeDays: 2,
    attentionSourceIntervalSeconds: { default: 60, repositories: { [attentionRepository]: 600 } } })).status).toBe(200);
  const fresh = await (await fetch(`${baseUrl}/api/attention`)).json() as AttentionPayload;
  expect(fresh.workspace).toBe("Desk");
  expect(fresh.cards).toHaveLength(1);
  expect(fresh.cards[0].verify_open_age).toBe(true);
  expect(reader.mock.calls[0][0].workspace).toBe("Desk");
  expect((await put({ attentionSourceIntervalSeconds: 120 })).status).toBe(200);
  const stale = await (await fetch(`${baseUrl}/api/attention`)).json() as AttentionPayload;
  expect(stale.cards).toHaveLength(0);
  expect(stale.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "stale_source" })]));
});

it("does not treat a filesystem settings failure as permission to overwrite saved contents", async () => {
  const root = await coordinationRoot("settings-io-failure-");
  const baseUrl = await listen(root);
  await mkdir(join(root, "settings.json"));
  const response = await fetch(`${baseUrl}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetRepos: ["example/app"] }) });
  expect(response.status).toBe(500);
  // If the directory were removed or replaced, this succeeds unexpectedly.
  await expect(readFile(join(root, "settings.json"), "utf8")).rejects.toMatchObject({ code: "EISDIR" });
});

it("preserves disjoint concurrent partial settings updates and continues after a rejected update", async () => {
  const root = await coordinationRoot("settings-concurrent-");
  const baseUrl = await listen(root);
  await writeFile(join(root, "settings.json"), JSON.stringify({ targetRepos: ["example/app"] }));
  const put = (body: unknown) => fetch(`${baseUrl}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const responses = await Promise.all([
    put({ attentionWorkspace: "Desk" }),
    put({ attentionOpenAgeDays: 0 }),
    put({ attentionSourceIntervalSeconds: 120 }),
    put({ attentionOpenAgeDays: 3 })
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 400, 200, 200]);
  const expected = normalizeDashboardSettings({ targetRepos: ["example/app"], attentionWorkspace: "Desk", attentionSourceIntervalSeconds: 120, attentionOpenAgeDays: 3 });
  expect(await (await fetch(`${baseUrl}/api/settings`)).json()).toEqual(expected);
  expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual(expected);
});

it("allows a later settings update after a queued filesystem failure", async () => {
  const root = await coordinationRoot("settings-queue-recovery-");
  const baseUrl = await listen(root);
  const path = join(root, "settings.json");
  await mkdir(path);
  const put = (body: unknown) => fetch(`${baseUrl}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await put({ targetRepos: ["example/app"] })).status).toBe(500);
  await rm(path, { recursive: true });
  expect((await put({ targetRepos: ["example/app"], attentionWorkspace: "Desk" })).status).toBe(200);
  expect(await (await fetch(`${baseUrl}/api/settings`)).json()).toEqual(normalizeDashboardSettings({ targetRepos: ["example/app"], attentionWorkspace: "Desk" }));
});

it("reports UNKNOWN workspace for corrupted nondefault settings and recovers the saved scope after repair", async () => {
  const root = await coordinationRoot("doctor-workspace-recovery-");
  const path = join(root, "settings.json");
  const settings = { targetRepos: ["example/app"], attentionWorkspace: "Desk.east" };
  await writeFile(path, JSON.stringify(settings));
  const baseUrl = await listen(root);
  const doctor = async () => (await fetch(`${baseUrl}/api/doctor`)).json();
  expect(await doctor()).toMatchObject({ attention: { workspace: "Desk.east", settings: "saved" } });

  await writeFile(path, JSON.stringify(settings).slice(0, -1));
  const unreadable = await doctor();
  expect(unreadable).toMatchObject({ attention: { workspace: "UNKNOWN", settings: "unreadable", repositories: [] } });
  expect(JSON.stringify(unreadable)).not.toContain("example/app");
  expect(JSON.stringify(unreadable)).not.toContain("Desk.east");

  const response = await fetch(`${baseUrl}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
  expect(response.status).toBe(200);
  expect(await doctor()).toMatchObject({ attention: { workspace: "Desk.east", settings: "saved", repositories: [{ repository: "example/app" }] } });
});
