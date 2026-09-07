/// <reference types="vite/client" />
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { ServerConfig } from "./config";
import type { AttentionPayload } from "../shared/attention";
import { attentionRepository, makeAttentionRecord, openAttentionRecord } from "../shared/attention.fixtures";

const servers: Server[] = [];
const roots: string[] = [];

/** The model's clock for every attention test; the shared fixtures are fresh against it. */
const NOW = new Date("2026-09-03T09:30:00.000Z");
const CHECKED_AT = NOW.toISOString();
const ATTENTION_PREFIX = `attention/${ATTENTION_WORKSPACE}/${attentionRepository}`;

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
  const app = await createDashboardApp(testConfig(stateRoot, overrides), { serveFrontend: false, ...appOptions });
  return listenServer(app.listen(0, "127.0.0.1"));
}

/** The same app behind a server that reports a fixed peer address. */
async function listenForPeer(
  stateRoot: string,
  remoteAddress: string,
  overrides: Partial<ServerConfig> = {},
  appOptions: NonNullable<Parameters<typeof createDashboardApp>[1]> = {}
): Promise<string> {
  const app = await createDashboardApp(testConfig(stateRoot, overrides), { serveFrontend: false, ...appOptions });
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
    // The attention scope falls back to the configured targets.
    expect(body.attention).toMatchObject({
      mode: "fs",
      repositories: [expect.objectContaining({ repository: "shakacode/react_on_rails", status: "empty" })]
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

describe("GET /api/attention", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("builds the payload once and serves the cached copy inside the TTL", async () => {
    const stateRoot = await coordinationRoot("coord-attention-hit-");
    const reader = countingReader();
    const baseUrl = await listen(stateRoot, attentionConfig(stateRoot), {
      readAttentionRecords: reader.read,
      now: () => NOW
    });

    const first = await fetch(`${baseUrl}/api/attention`);
    const firstBody = await attentionPayloadOf(first);
    const second = await fetch(`${baseUrl}/api/attention`);

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(firstBody.cards).toHaveLength(1);
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
        readAttentionRecords: reader.read,
        now: () => NOW
      });
      const response = await requestDirectly(app, "/api/attention");

      expect(response.status).toBe(200);
      expect(interval).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      interval.mockRestore();
      timeout.mockRestore();
    }
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
