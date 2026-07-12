import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { canBypassDashboardCache, createDashboardApp } from "./app";
import type { ServerConfig } from "./config";

const servers: Server[] = [];

function testConfig(stateRoot: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    stateRoot,
    refreshIntervalMs: 0,
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

async function listen(stateRoot: string, overrides: Partial<ServerConfig> = {}): Promise<string> {
  const app = await createDashboardApp(testConfig(stateRoot, overrides), {
    serveFrontend: false,
    loadOpenGitHubItems: async () => ({ items: [], warnings: [] })
  });
  const server = app.listen(0, "127.0.0.1");
  return listenServer(server);
}

async function listenEmptyCoordinationApi(): Promise<string> {
  return listenServer(
    createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ entries: [] }));
    }).listen(0, "127.0.0.1")
  );
}

async function listenUnauthorizedCoordinationApi(): Promise<string> {
  return listenServer(
    createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "unauthorized" }));
    }).listen(0, "127.0.0.1")
  );
}

describe("dashboard app import endpoint", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("returns runtime refresh settings with target repositories", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-settings-"));
    const baseUrl = await listen(stateRoot, { refreshIntervalMs: 2500 });

    const initial = await fetch(`${baseUrl}/api/settings`);
    await expect(initial.json()).resolves.toEqual({
      targetRepos: ["shakacode/react_on_rails"],
      refreshIntervalMs: 2500
    });

    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: ["repo-a/app"] })
    });

    await expect(saved.json()).resolves.toEqual({
      targetRepos: ["repo-a/app"],
      refreshIntervalMs: 2500
    });
  });

  it("coalesces dashboard reads while API refresh caching is active", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-cache-"));
    let githubLoads = 0;
    const app = await createDashboardApp(testConfig(stateRoot, { refreshIntervalMs: 5000 }), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => {
        githubLoads += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { items: [], warnings: [] };
      }
    });
    const baseUrl = await listenServer(app.listen(0, "127.0.0.1"));

    const [first, second] = await Promise.all([fetch(`${baseUrl}/api/dashboard`), fetch(`${baseUrl}/api/dashboard`)]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(githubLoads).toBe(1);

    const cached = await fetch(`${baseUrl}/api/dashboard`);
    expect(cached.ok).toBe(true);
    expect(githubLoads).toBe(1);

    const fresh = await fetch(`${baseUrl}/api/dashboard`, { headers: { "X-Dashboard-Refresh": "foreground" } });
    expect(fresh.ok).toBe(true);
    expect(githubLoads).toBe(2);

    const cachedAfterFresh = await fetch(`${baseUrl}/api/dashboard`);
    expect(cachedAfterFresh.ok).toBe(true);
    expect(githubLoads).toBe(2);

    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: ["repo-a/app"] })
    });
    expect(saved.ok).toBe(true);
    const refreshed = await fetch(`${baseUrl}/api/dashboard`);
    expect(refreshed.ok).toBe(true);
    expect(githubLoads).toBe(3);
  });

  it("uses a claim PR URL as the canonical GitHub target and maps its terminal result onto the issue WorkItem", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-reconcile-"));
    const claimDirectory = join(stateRoot, "claims", "shakacode", "react_on_rails");
    await mkdir(claimDirectory, { recursive: true });
    await writeFile(join(claimDirectory, "45.json"), JSON.stringify({
      schema_version: 1, repo: "shakacode/react_on_rails", target: "45", agent_id: "worker", status: "active", pr_url: "https://github.com/shakacode/react_on_rails/pull/54"
    }));
    let reconciledTarget = "";
    const app = await createDashboardApp(testConfig(stateRoot), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => ({ items: [{ repo: "shakacode/react_on_rails", target: "45", type: "issue", title: "Open issue", url: "https://github.com/shakacode/react_on_rails/issues/45", state: "OPEN", labels: [], loadState: "loaded" }], warnings: [] }),
      loadGitHubTargets: async (references) => ({
        items: references.map((reference) => {
          reconciledTarget = reference.target;
          return { ...reference, type: "pull_request" as const, title: "Merged work", url: "https://github.com/shakacode/react_on_rails/pull/54", state: "MERGED", mergedAt: "2026-07-12T10:00:00Z", labels: [], loadState: "loaded" as const };
        }),
        warnings: []
      })
    });
    const baseUrl = await listenServer(app.listen(0, "127.0.0.1"));
    const body = await (await fetch(`${baseUrl}/api/dashboard`)).json() as { workItems: Array<Record<string, unknown>>; trulyOpenCount: number; trulyOpenCountStatus: string };
    expect(reconciledTarget).toBe("54");
    expect(body.workItems).toHaveLength(1);
    expect(body.workItems[0]).toMatchObject({ id: "shakacode/react_on_rails#45", target: "45", type: "issue", operatorState: "terminal", terminalState: "done", terminalProvenance: { source: "github", url: "https://github.com/shakacode/react_on_rails/pull/54" }, github: { target: "45", type: "pull_request", url: "https://github.com/shakacode/react_on_rails/pull/54" } });
    expect(body.trulyOpenCount).toBe(0);
    expect(body.trulyOpenCountStatus).toBe("available");
  });

  it("enriches a declared terminal issue from its PR URL without overriding declared precedence", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-declared-pr-"));
    await mkdir(join(stateRoot, "batches"), { recursive: true });
    await writeFile(join(stateRoot, "batches", "declared.json"), JSON.stringify({ schema_version: 1, batch_id: "declared", repo: "shakacode/react_on_rails", targets: [{ type: "issue", target: "45" }], lanes: [{ name: "done", owner: "worker", targets: ["45"], depends_on: [], status: "completed", pr_url: "https://github.com/shakacode/react_on_rails/pull/54" }] }));
    const app = await createDashboardApp(testConfig(stateRoot), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => ({ items: [], warnings: [] }),
      loadGitHubTargets: async (references) => ({ items: references.map((reference) => ({ repo: reference.repo, target: reference.target, type: "pull_request" as const, title: "Merged implementation", url: "https://github.com/shakacode/react_on_rails/pull/54", state: "MERGED", mergedAt: "2026-07-12T10:00:00Z", labels: [], loadState: "loaded" as const })), warnings: [] })
    });
    const body = await (await fetch(`${await listenServer(app.listen(0, "127.0.0.1"))}/api/dashboard`)).json() as { workItems: Array<Record<string, unknown>> };
    expect(body.workItems[0]).toMatchObject({ type: "issue", terminalState: "done", terminalProvenance: { source: "declared" }, github: { type: "pull_request", url: "https://github.com/shakacode/react_on_rails/pull/54", state: "MERGED", mergedAt: "2026-07-12T10:00:00Z" } });
  });

  it("enriches a declared terminal pull request from its own target without requiring prUrl", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-declared-own-pr-"));
    await mkdir(join(stateRoot, "batches"), { recursive: true });
    await writeFile(join(stateRoot, "batches", "declared-pr.json"), JSON.stringify({ schema_version: 1, batch_id: "declared-pr", repo: "shakacode/react_on_rails", targets: [{ type: "pull_request", target: "54" }], lanes: [{ name: "done", owner: "worker", targets: ["54"], depends_on: [], status: "completed" }] }));
    const app = await createDashboardApp(testConfig(stateRoot), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => ({ items: [], warnings: [] }),
      loadGitHubTargets: async (references) => ({ items: references.map((reference) => ({ repo: reference.repo, target: reference.target, type: "pull_request" as const, title: "Merged PR", url: "https://github.com/shakacode/react_on_rails/pull/54", state: "MERGED", mergedAt: "2026-07-12T10:00:00Z", labels: [], loadState: "loaded" as const })), warnings: [] })
    });
    const body = await (await fetch(`${await listenServer(app.listen(0, "127.0.0.1"))}/api/dashboard`)).json() as { workItems: Array<Record<string, unknown>>; githubMergeTimeStatus: string };
    expect(body.workItems[0]).toMatchObject({ type: "pull_request", terminalState: "done", terminalProvenance: { source: "declared" }, github: { state: "MERGED", mergedAt: "2026-07-12T10:00:00Z", url: "https://github.com/shakacode/react_on_rails/pull/54" } });
    expect(body.githubMergeTimeStatus).toBe("available");
  });

  it("consumes a canonical open PR row when it becomes evidence for a coordinated issue", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-consumed-pr-"));
    await mkdir(join(stateRoot, "batches"), { recursive: true });
    await writeFile(join(stateRoot, "batches", "issue-pr.json"), JSON.stringify({ schema_version: 1, batch_id: "issue-pr", repo: "shakacode/react_on_rails", targets: [{ type: "issue", target: "45" }], lanes: [{ name: "implementation", owner: "worker", targets: ["45"], depends_on: [], status: "running", pr_url: "https://github.com/shakacode/react_on_rails/pull/54" }] }));
    const openPr = { repo: "shakacode/react_on_rails", target: "54", type: "pull_request" as const, title: "Open PR", url: "https://github.com/shakacode/react_on_rails/pull/54", state: "OPEN", labels: [], loadState: "loaded" as const };
    const app = await createDashboardApp(testConfig(stateRoot), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => ({ items: [openPr], warnings: [] }),
      loadGitHubTargets: async () => ({ items: [openPr], warnings: [] })
    });
    const body = await (await fetch(`${await listenServer(app.listen(0, "127.0.0.1"))}/api/dashboard`)).json() as { workItems: Array<{ id: string; type: string; github?: { url: string } }>; trulyOpenCount: number };
    expect(body.workItems).toEqual([expect.objectContaining({ id: "shakacode/react_on_rails#45", type: "issue", github: expect.objectContaining({ url: "https://github.com/shakacode/react_on_rails/pull/54" }) })]);
    expect(body.trulyOpenCount).toBe(1);
  });

  it("preserves a consumed canonical PR row when it has independent coordination evidence", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-independent-pr-"));
    await mkdir(join(stateRoot, "batches"), { recursive: true });
    await writeFile(join(stateRoot, "batches", "issue-pr.json"), JSON.stringify({ schema_version: 1, batch_id: "issue-pr", repo: "shakacode/react_on_rails", targets: [{ type: "issue", target: "45" }], lanes: [{ name: "implementation", owner: "worker", targets: ["45"], depends_on: [], status: "running", pr_url: "https://github.com/shakacode/react_on_rails/pull/54" }] }));
    const claimDirectory = join(stateRoot, "claims", "shakacode", "react_on_rails");
    await mkdir(claimDirectory, { recursive: true });
    await writeFile(join(claimDirectory, "54.json"), JSON.stringify({ schema_version: 1, repo: "shakacode/react_on_rails", target: "54", agent_id: "pr-worker", status: "active" }));
    const openPr = { repo: "shakacode/react_on_rails", target: "54", type: "pull_request" as const, title: "Open PR", url: "https://github.com/shakacode/react_on_rails/pull/54", state: "OPEN", labels: [], loadState: "loaded" as const };
    const app = await createDashboardApp(testConfig(stateRoot), { serveFrontend: false, loadOpenGitHubItems: async () => ({ items: [openPr], warnings: [] }), loadGitHubTargets: async () => ({ items: [openPr], warnings: [] }) });
    const body = await (await fetch(`${await listenServer(app.listen(0, "127.0.0.1"))}/api/dashboard`)).json() as { workItems: Array<{ id: string }>; trulyOpenCount: number };
    expect(body.workItems.map((item) => item.id)).toEqual(["shakacode/react_on_rails#45", "shakacode/react_on_rails#54"]);
    expect(body.trulyOpenCount).toBe(2);
  });

  it("propagates foreground GitHub bypass when dashboard caching is disabled", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-zero-cache-bypass-"));
    const directory = join(stateRoot, "claims", "shakacode", "react_on_rails");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "45.json"), JSON.stringify({ schema_version: 1, repo: "shakacode/react_on_rails", target: "45", agent_id: "worker", status: "active" }));
    const bypasses: Array<boolean | undefined> = [];
    const app = await createDashboardApp(testConfig(stateRoot, { refreshIntervalMs: 0 }), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => ({ items: [], warnings: [] }),
      loadGitHubTargets: async (_references, options) => { bypasses.push(options?.bypassCache); return { items: [], warnings: [] }; }
    });
    const baseUrl = await listenServer(app.listen(0, "127.0.0.1"));
    await fetch(`${baseUrl}/api/dashboard`);
    await fetch(`${baseUrl}/api/dashboard`, { headers: { "X-Dashboard-Refresh": "foreground" } });
    expect(bypasses).toEqual([false, true]);
  });

  it("keeps distinct branch evidence when two issue WorkItems share one PR", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-shared-pr-"));
    const directory = join(stateRoot, "claims", "shakacode", "react_on_rails");
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "45.json"), JSON.stringify({ schema_version: 1, repo: "shakacode/react_on_rails", target: "45", agent_id: "worker-a", status: "active", branch: "feature/a", pr_url: "https://github.com/shakacode/react_on_rails/pull/54" })),
      writeFile(join(directory, "46.json"), JSON.stringify({ schema_version: 1, repo: "shakacode/react_on_rails", target: "46", agent_id: "worker-b", status: "active", branch: "feature/b", pr_url: "https://github.com/shakacode/react_on_rails/pull/54" }))
    ]);
    const app = await createDashboardApp(testConfig(stateRoot), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => ({ items: ["45", "46"].map((target) => ({ repo: "shakacode/react_on_rails", target, type: "issue" as const, title: `Open issue ${target}`, url: `https://github.com/shakacode/react_on_rails/issues/${target}`, state: "OPEN", labels: [], loadState: "loaded" as const })), warnings: [] }),
      loadGitHubTargets: async (references) => ({ items: references.map((reference) => ({ repo: reference.repo, target: reference.target, type: "pull_request" as const, title: "Merged shared PR", url: "https://github.com/shakacode/react_on_rails/pull/54", state: "MERGED", mergedAt: "2026-07-12T10:00:00Z", branchState: reference.branch === "feature/a" ? "deleted" as const : "present" as const, labels: [], loadState: "loaded" as const })), warnings: [] })
    });
    const body = await (await fetch(`${await listenServer(app.listen(0, "127.0.0.1"))}/api/dashboard`)).json() as { workItems: Array<{ target: string; type: string; terminalState?: string; github?: { branchState?: string } }> };
    expect(body.workItems.map((item) => ({ target: item.target, type: item.type, terminal: item.terminalState, branch: item.github?.branchState }))).toEqual([
      { target: "45", type: "issue", terminal: "done", branch: "deleted" },
      { target: "46", type: "issue", terminal: "done", branch: "present" }
    ]);
  });

  it.each([
    ["heartbeat", async (root: string) => {
      await mkdir(join(root, "heartbeats"), { recursive: true });
      await writeFile(join(root, "heartbeats", "worker.json"), JSON.stringify({ schema_version: 1, agent_id: "worker", repo: "shakacode/react_on_rails", target: "45", status: "running", updated_at: "2026-07-12T10:00:00Z", expires_at: "2026-07-12T20:00:00Z", pr_url: "https://github.com/shakacode/react_on_rails/pull/54" }));
    }],
    ["batch lane", async (root: string) => {
      await mkdir(join(root, "batches"), { recursive: true });
      await writeFile(join(root, "batches", "batch.json"), JSON.stringify({ schema_version: 1, batch_id: "batch", repo: "shakacode/react_on_rails", targets: [{ type: "issue", target: "45" }], lanes: [{ name: "implementation", owner: "worker", targets: ["45"], depends_on: [], status: "running", pr_url: "https://github.com/shakacode/react_on_rails/pull/54" }] }));
    }]
  ])("uses %s PR URL metadata as the canonical GitHub target", async (_source, setup) => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-pr-url-"));
    await setup(stateRoot);
    let reconciledTarget = "";
    const app = await createDashboardApp(testConfig(stateRoot), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => ({ items: [{ repo: "shakacode/react_on_rails", target: "45", type: "issue", title: "Open issue", url: "https://github.com/shakacode/react_on_rails/issues/45", state: "OPEN", labels: [], loadState: "loaded" }], warnings: [] }),
      loadGitHubTargets: async (references) => ({ items: references.map((reference) => { reconciledTarget = reference.target; return { ...reference, type: "pull_request" as const, title: "Merged", url: "https://github.com/shakacode/react_on_rails/pull/54", state: "MERGED", mergedAt: "2026-07-12T10:00:00Z", labels: [], loadState: "loaded" as const }; }), warnings: [] })
    });
    const body = await (await fetch(`${await listenServer(app.listen(0, "127.0.0.1"))}/api/dashboard`)).json() as { workItems: Array<{ id: string; terminalState?: string; github?: { url: string } }> };
    expect(reconciledTarget).toBe("54");
    expect(body.workItems).toEqual([expect.objectContaining({ id: "shakacode/react_on_rails#45", terminalState: "done", github: expect.objectContaining({ url: "https://github.com/shakacode/react_on_rails/pull/54" }) })]);
  });

  it.each([
    ["claim", async (root: string) => {
      const directory = join(root, "claims", "shakacode", "react_on_rails");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "45.json"), JSON.stringify({ schema_version: 1, repo: "shakacode/react_on_rails", target: "45", agent_id: "worker", status: "active", branch: "feature/work" }));
    }],
    ["batch lane", async (root: string) => {
      await mkdir(join(root, "batches"), { recursive: true });
      await writeFile(join(root, "batches", "batch.json"), JSON.stringify({ schema_version: 1, batch_id: "batch", repo: "shakacode/react_on_rails", targets: [{ type: "issue", target: "45" }], lanes: [{ name: "implementation", owner: "worker", targets: ["45"], depends_on: [], status: "running", branch: "feature/work" }] }));
    }]
  ])("enriches an already-loaded open target from %s branch metadata without replacing target truth", async (_source, setup) => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-branch-only-"));
    await setup(stateRoot);
    let receivedReference: { target: string; branch?: string; existingTarget?: { state: string; title: string; url: string } } | undefined;
    const app = await createDashboardApp(testConfig(stateRoot), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => ({ items: [{ repo: "shakacode/react_on_rails", target: "45", type: "issue", title: "Open issue", url: "https://github.com/shakacode/react_on_rails/issues/45", state: "OPEN", labels: [], loadState: "loaded" }], warnings: [] }),
      loadGitHubTargets: async (references) => {
        receivedReference = references[0];
        return { items: references.map((reference) => ({ ...reference.existingTarget!, branchState: "deleted" as const })), warnings: [] };
      }
    });
    const body = await (await fetch(`${await listenServer(app.listen(0, "127.0.0.1"))}/api/dashboard`)).json() as { workItems: Array<{ operatorState?: string; terminalState?: string; github?: { state: string; title: string; url: string; branchState?: string } }>; trulyOpenCount: number; trulyOpenCountStatus: string };
    expect(receivedReference).toMatchObject({ target: "45", branch: "feature/work", existingTarget: { state: "OPEN", title: "Open issue", url: "https://github.com/shakacode/react_on_rails/issues/45" } });
    expect(body.workItems[0]).toMatchObject({ operatorState: "ready", github: { state: "OPEN", title: "Open issue", url: "https://github.com/shakacode/react_on_rails/issues/45", branchState: "deleted" } });
    expect(body.workItems[0].terminalState).toBeUndefined();
    expect(body.trulyOpenCount).toBe(1);
    expect(body.trulyOpenCountStatus).toBe("available");
  });

  it("reports the truly-open headline as UNKNOWN when target reconciliation is unavailable", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-reconcile-unknown-"));
    const claimDirectory = join(stateRoot, "claims", "shakacode", "react_on_rails");
    await mkdir(claimDirectory, { recursive: true });
    await writeFile(join(claimDirectory, "4005.json"), JSON.stringify({ schema_version: 1, repo: "shakacode/react_on_rails", target: "4005", agent_id: "worker", status: "active" }));
    const app = await createDashboardApp(testConfig(stateRoot), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => ({ items: [], warnings: [] }),
      loadGitHubTargets: async (references) => ({
        items: references.map((reference) => ({ ...reference, title: "GitHub state unavailable", url: "", state: "UNKNOWN", labels: [], loadState: "unknown" as const })),
        warnings: [{ severity: "warning", repo: "shakacode/react_on_rails", target: "4005", message: "GitHub auth required" }]
      })
    });
    const baseUrl = await listenServer(app.listen(0, "127.0.0.1"));
    const body = await (await fetch(`${baseUrl}/api/dashboard`)).json() as { trulyOpenCount?: number; trulyOpenCountStatus: string; warnings: Array<{ message: string }> };
    expect(body.trulyOpenCount).toBeUndefined();
    expect(body.trulyOpenCountStatus).toBe("unknown");
    expect(body.warnings.some((warning) => warning.message.toLowerCase().includes("auth required"))).toBe(true);
  });

  it("keeps the truly-open headline UNKNOWN when GitHub list coverage is partial", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-github-partial-"));
    const app = await createDashboardApp(testConfig(stateRoot), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => ({ items: [], warnings: [{ severity: "warning", repo: "shakacode/react_on_rails", message: "GitHub issue list failed" }] }),
      loadGitHubTargets: async () => ({ items: [], warnings: [] })
    });
    const baseUrl = await listenServer(app.listen(0, "127.0.0.1"));
    const body = await (await fetch(`${baseUrl}/api/dashboard`)).json() as { trulyOpenCount?: number; trulyOpenCountStatus: string };
    expect(body.trulyOpenCount).toBeUndefined();
    expect(body.trulyOpenCountStatus).toBe("unknown");
  });

  it("does not cache in-flight dashboard reads after a local write invalidates them", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-dashboard-cache-inflight-"));
    let githubLoads = 0;
    let resolveFirstLoadStarted: () => void = () => undefined;
    let releaseFirstLoad: () => void = () => undefined;
    const firstLoadStarted = new Promise<void>((resolve) => {
      resolveFirstLoadStarted = resolve;
    });
    const firstLoadReleased = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });

    const app = await createDashboardApp(testConfig(stateRoot, { refreshIntervalMs: 5000 }), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => {
        githubLoads += 1;
        if (githubLoads === 1) {
          resolveFirstLoadStarted();
          await firstLoadReleased;
        }
        return { items: [], warnings: [] };
      }
    });
    const baseUrl = await listenServer(app.listen(0, "127.0.0.1"));

    const firstDashboard = fetch(`${baseUrl}/api/dashboard`);
    await firstLoadStarted;
    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: ["shakacode/react_on_rails"] })
    });
    expect(saved.ok).toBe(true);
    releaseFirstLoad();
    await firstDashboard;

    const afterInvalidation = await fetch(`${baseUrl}/api/dashboard`);
    expect(afterInvalidation.ok).toBe(true);
    expect(githubLoads).toBe(2);
  });

  it("allows dashboard cache bypass only from loopback foreground refreshes", () => {
    expect(canBypassDashboardCache("foreground", "127.0.0.1")).toBe(true);
    expect(canBypassDashboardCache("foreground", "::1")).toBe(true);
    expect(canBypassDashboardCache("foreground", "203.0.113.8")).toBe(false);
    expect(canBypassDashboardCache(undefined, "127.0.0.1")).toBe(false);
  });

  it("writes imported batch manifests into the coordination root batches directory", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-react-on-rails-4005",
        repo: "shakacode/react_on_rails",
        objective: "Stabilize PR 4005.",
        targets: [{ type: "pull_request", target: "4005" }],
        lanes: [
          {
            name: "tests",
            owner: "worker-a",
            targets: ["4005"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: []
          }
        ],
        reservations: [],
        createdAt: "2026-06-20T10:00:00.000Z",
        createdByMachine: "macbook-a",
        launchPrompt:
          "Use $pr-batch to complete batch-react-on-rails-4005.\nRepository: shakacode/react_on_rails\nBatch id: batch-react-on-rails-4005\nItems:\n- PR #4005"
      })
    });

    expect(response.status).toBe(201);
    await expect(readFile(join(stateRoot, "batches", "batch-react-on-rails-4005.json"), "utf8")).resolves.toContain(
      "Batch id: batch-react-on-rails-4005"
    );
    await expect(readFile(join(stateRoot, "claims", "batch-react-on-rails-4005.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(stateRoot, "heartbeats", "batch-react-on-rails-4005.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("stamps imported manifests with missing server-side creation metadata", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-audit-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-react-on-rails-4010",
        repo: "shakacode/react_on_rails",
        objective: "Validate PR 4010.",
        targets: [{ type: "pull_request", target: "4010" }],
        lanes: [
          {
            name: "qa",
            owner: "worker-a",
            targets: ["4010"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: []
          }
        ],
        reservations: [],
        launchPrompt:
          "Use $pr-batch to complete batch-react-on-rails-4010.\nRepository: shakacode/react_on_rails\nBatch id: batch-react-on-rails-4010\nItems:\n- PR #4010"
      })
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { manifest: { created_at?: string; created_by_machine?: string } };
    expect(body.manifest.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.manifest.created_by_machine).toMatch(/^dashboard:/);
    await expect(readFile(join(stateRoot, "batches", "batch-react-on-rails-4010.json"), "utf8")).resolves.toEqual(
      expect.stringContaining('"created_by_machine": "dashboard:')
    );
  });

  it("does not expose the configured coordination API URL in dashboard responses", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-api-display-"));
    const apiUrl = await listenEmptyCoordinationApi();
    const baseUrl = await listen(stateRoot, {
      coordApiUrl: apiUrl,
      coordApiToken: "test-token"
    });

    const response = await fetch(`${baseUrl}/api/dashboard`);
    const body = (await response.json()) as { stateRoot: string };

    expect(response.status).toBe(200);
    expect(body.stateRoot).toBe("coordination-api");
    expect(JSON.stringify(body)).not.toContain(apiUrl);
  });

  it("reports fresh per-resource coordination diagnostics without exposing the token", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-doctor-"));
    const apiUrl = await listenUnauthorizedCoordinationApi();
    const baseUrl = await listen(stateRoot, {
      coordApiUrl: apiUrl,
      coordApiToken: "secret-token-value",
      coordApiTokenEnvVar: "AGENT_COORD_API_TOKEN"
    });

    const response = await fetch(`${baseUrl}/api/doctor`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      apiUrl,
      tokenEnvVar: "AGENT_COORD_API_TOKEN",
      stateRoot,
      perResource: [
        expect.objectContaining({ resource: "claims", status: "auth_error", httpStatus: 401 }),
        expect.objectContaining({ resource: "heartbeats", status: "auth_error", httpStatus: 401 }),
        expect.objectContaining({ resource: "batches", status: "auth_error", httpStatus: 401 }),
        expect.objectContaining({ resource: "events", status: "auth_error", httpStatus: 401 })
      ]
    });
    expect(JSON.stringify(body)).not.toContain("secret-token-value");
  });

  it("rejects coordination diagnostics requested from a non-loopback client", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-doctor-remote-"));
    const app = await createDashboardApp(testConfig(stateRoot), {
      serveFrontend: false,
      loadOpenGitHubItems: async () => ({ items: [], warnings: [] })
    });
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

  it("clears degraded source status on a fresh read without restarting the dashboard", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-recovery-"));
    let authorized = false;
    const apiUrl = await listenServer(
      createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        if (!authorized) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res.end(JSON.stringify({ entries: [] }));
      }).listen(0, "127.0.0.1")
    );
    const baseUrl = await listen(stateRoot, {
      coordApiUrl: apiUrl,
      coordApiToken: "rotated-token",
      coordApiTokenEnvVar: "AGENT_COORD_API_TOKEN",
      refreshIntervalMs: 5000
    });

    const degraded = (await (await fetch(`${baseUrl}/api/dashboard`)).json()) as {
      sourceStatus: Array<{ status: string }>;
      trulyOpenCount?: number;
      trulyOpenCountStatus: string;
    };
    expect(degraded.sourceStatus.every((source) => source.status === "auth_error")).toBe(true);
    expect(degraded.trulyOpenCount).toBeUndefined();
    expect(degraded.trulyOpenCountStatus).toBe("unknown");

    authorized = true;
    const recovered = (await (
      await fetch(`${baseUrl}/api/dashboard`, { headers: { "X-Dashboard-Refresh": "foreground" } })
    ).json()) as { sourceStatus: Array<{ status: string }>; trulyOpenCount?: number; trulyOpenCountStatus: string };
    expect(recovered.sourceStatus.every((source) => source.status === "empty")).toBe(true);
    expect(recovered.trulyOpenCount).toBe(0);
    expect(recovered.trulyOpenCountStatus).toBe("available");
  });

  it("treats a blank coordination API URL as filesystem mode", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-api-blank-url-"));
    const baseUrl = await listen(stateRoot, {
      coordApiUrl: "   ",
      coordApiToken: "test-token"
    });

    const response = await fetch(`${baseUrl}/api/dashboard`);
    const body = (await response.json()) as { stateRoot: string };

    expect(response.status).toBe(200);
    expect(body.stateRoot).toBe(stateRoot);
  });

  it("rejects batch imports in coordination API mode", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-api-import-disabled-"));
    const apiUrl = await listenEmptyCoordinationApi();
    const baseUrl = await listen(stateRoot, {
      coordApiUrl: apiUrl,
      coordApiToken: "test-token"
    });

    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-api-disabled",
        repo: "shakacode/react_on_rails",
        targets: [{ type: "pull_request", target: "4005" }],
        lanes: [{ name: "qa", owner: "worker-a", targets: ["4005"] }],
        launchPrompt: "Use $pr-batch to complete batch-api-disabled."
      })
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toContain("filesystem mode");
    await expect(readFile(join(stateRoot, "batches", "batch-api-disabled.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects batch stop requests in coordination API mode", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-api-stop-disabled-"));
    const apiUrl = await listenEmptyCoordinationApi();
    const baseUrl = await listen(stateRoot, {
      coordApiUrl: apiUrl,
      coordApiToken: "test-token"
    });

    const response = await fetch(`${baseUrl}/api/batches/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-api-disabled",
        repo: "shakacode/react_on_rails",
        reason: "Stop from API mode."
      })
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toContain("filesystem mode");
    await expect(readFile(join(stateRoot, "events", "batches", "batch-api-disabled.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("allows imported prompt metadata that mentions local source paths", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-source-paths-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-source-paths",
        repo: "shakacode/react_on_rails",
        objective: "Fix src/server/app.ts.",
        targets: [{ type: "pull_request", target: "4010", title: "fix src/server/app.ts" }],
        lanes: [
          {
            name: "implementation",
            owner: "worker-a",
            targets: ["4010"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: []
          }
        ],
        reservations: [],
        launchPrompt:
          "Use $pr-batch to complete this batch.\nRepository: shakacode/react_on_rails\nBatch id: batch-source-paths\nBatch objective: Fix src/server/app.ts.\nItems:\n- PR #4010\n  Context: fix src/server/app.ts"
      })
    });

    expect(response.status).toBe(201);
    await expect(readFile(join(stateRoot, "batches", "batch-source-paths.json"), "utf8")).resolves.toEqual(
      expect.stringContaining("src/server/app.ts")
    );
  });

  it("rejects imported prompt metadata that mentions out-of-scope repos with local-looking owners", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-local-owner-repo-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-local-owner-repo",
        repo: "shakacode/react_on_rails",
        objective: "Fix visible PR while docs/private is pending.",
        targets: [{ type: "pull_request", target: "4010", title: "visible PR" }],
        lanes: [
          {
            name: "implementation",
            owner: "worker-a",
            targets: ["4010"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: []
          }
        ],
        reservations: [],
        launchPrompt:
          "Use $pr-batch to complete this batch.\nRepository: shakacode/react_on_rails\nBatch id: batch-local-owner-repo\nItems:\n- PR #4010\n  Context: blocked by docs/private"
      })
    });

    expect(response.status).toBe(400);
    await expect(readFile(join(stateRoot, "batches", "batch-local-owner-repo.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects unsafe batch ids instead of writing outside the batches directory", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-unsafe-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "../escape",
        repo: "shakacode/react_on_rails",
        objective: "Unsafe path attempt.",
        launchPrompt: "Use $pr-batch..."
      })
    });

    expect(response.status).toBe(400);
    await expect(readFile(join(stateRoot, "escape.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects imported manifests without targets, lanes, and launch prompt metadata", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-invalid-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-empty",
        repo: "shakacode/react_on_rails",
        targets: [],
        lanes: []
      })
    });

    expect(response.status).toBe(400);
    await expect(readFile(join(stateRoot, "batches", "batch-empty.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite an existing imported batch manifest", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-existing-"));
    const baseUrl = await listen(stateRoot);
    const body = {
      batchId: "batch-react-on-rails-4005",
      repo: "shakacode/react_on_rails",
      objective: "Stabilize PR 4005.",
      targets: [{ type: "pull_request", target: "4005" }],
      lanes: [
        {
          name: "tests",
          owner: "worker-a",
          targets: ["4005"],
          dependsOn: [],
          status: "queued",
          liveness: "no-heartbeat",
          blockedOn: []
        }
      ],
      reservations: [],
      createdAt: "2026-06-20T10:00:00.000Z",
      createdByMachine: "macbook-a",
      launchPrompt:
        "Use $pr-batch to complete batch-react-on-rails-4005.\nRepository: shakacode/react_on_rails\nBatch id: batch-react-on-rails-4005\nItems:\n- PR #4005"
    };

    const first = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const second = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, objective: "Clobber attempt." })
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    await expect(readFile(join(stateRoot, "batches", "batch-react-on-rails-4005.json"), "utf8")).resolves.toContain(
      '"objective": "Stabilize PR 4005."'
    );
  });

  it("rejects imports outside the saved dashboard target repositories", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-out-of-scope-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-other-repo",
        repo: "other/repo",
        objective: "Out of scope.",
        targets: [{ type: "pull_request", target: "12" }],
        lanes: [
          {
            name: "lane-a",
            owner: "worker-a",
            targets: ["12"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: []
          }
        ],
        launchPrompt: "Use $pr-batch to complete this batch.\nRepository: other/repo\nBatch id: batch-other-repo\nItems:\n- PR #12"
      })
    });

    expect(response.status).toBe(400);
    await expect(readFile(join(stateRoot, "batches", "batch-other-repo.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects imports whose target metadata references repositories outside the dashboard scope", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-out-of-scope-target-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-hidden-target",
        repo: "shakacode/react_on_rails",
        objective: "Do not leak hidden target details.",
        targets: [
          {
            type: "pull_request",
            target: "4005",
            title: "Blocked by other/private-repo."
          }
        ],
        lanes: [
          {
            name: "tests",
            owner: "worker-a",
            targets: ["4005"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: []
          }
        ],
        launchPrompt:
          "Use $pr-batch to complete this batch.\nRepository: shakacode/react_on_rails\nBatch id: batch-hidden-target\nItems:\n- PR #4005"
      })
    });

    expect(response.status).toBe(400);
    await expect(readFile(join(stateRoot, "batches", "batch-hidden-target.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects imports whose lane metadata references repositories outside the dashboard scope", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-out-of-scope-lane-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-hidden-lane",
        repo: "shakacode/react_on_rails",
        objective: "Do not persist hidden lane details.",
        targets: [{ type: "pull_request", target: "4005" }],
        lanes: [
          {
            name: "blocked-by-other/private-repo",
            owner: "worker-a",
            targets: ["4005"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: []
          }
        ],
        launchPrompt:
          "Use $pr-batch to complete this batch.\nRepository: shakacode/react_on_rails\nBatch id: batch-hidden-lane\nItems:\n- PR #4005"
      })
    });

    expect(response.status).toBe(400);
    await expect(readFile(join(stateRoot, "batches", "batch-hidden-lane.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects imports whose lane operator fields reference repositories outside the dashboard scope", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-out-of-scope-lane-operator-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-hidden-lane-operator",
        repo: "shakacode/react_on_rails",
        objective: "Do not persist hidden lane operator details.",
        targets: [{ type: "pull_request", target: "4005" }],
        lanes: [
          {
            name: "tests",
            owner: "worker-a",
            targets: ["4005"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: [],
            prUrl: "https://github.com/other/private-repo/pull/44"
          }
        ],
        launchPrompt:
          "Use $pr-batch to complete this batch.\nRepository: shakacode/react_on_rails\nBatch id: batch-hidden-lane-operator\nItems:\n- PR #4005"
      })
    });

    expect(response.status).toBe(400);
    await expect(readFile(join(stateRoot, "batches", "batch-hidden-lane-operator.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects imports whose lane branch prose references repositories outside the dashboard scope", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-out-of-scope-lane-branch-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-hidden-lane-branch",
        repo: "shakacode/react_on_rails",
        objective: "Do not persist hidden lane branch details.",
        targets: [{ type: "pull_request", target: "4005" }],
        lanes: [
          {
            name: "tests",
            owner: "worker-a",
            targets: ["4005"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: [],
            branch: "fix for other/private-repo"
          }
        ],
        launchPrompt:
          "Use $pr-batch to complete this batch.\nRepository: shakacode/react_on_rails\nBatch id: batch-hidden-lane-branch\nItems:\n- PR #4005"
      })
    });

    expect(response.status).toBe(400);
    await expect(readFile(join(stateRoot, "batches", "batch-hidden-lane-branch.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects imports whose launch prompt repository header references out-of-scope repos", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-header-scope-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-hidden-header",
        repo: "shakacode/react_on_rails",
        objective: "Do not persist hidden repository headers.",
        targets: [{ type: "pull_request", target: "4005" }],
        lanes: [
          {
            name: "tests",
            owner: "worker-a",
            targets: ["4005"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: []
          }
        ],
        launchPrompt:
          "Use $pr-batch to complete this batch.\nRepository: shakacode/react_on_rails, docs/private\nBatch id: batch-hidden-header\nItems:\n- PR #4005"
      })
    });

    expect(response.status).toBe(400);
    await expect(readFile(join(stateRoot, "batches", "batch-hidden-header.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects imports with duplicate target numbers across repos", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-duplicate-targets-"));
    const baseUrl = await listen(stateRoot);
    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: ["repo-a/app", "repo-b/api"] })
    });
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-duplicate-targets",
        objective: "Ambiguous duplicate target numbers.",
        targets: [
          { type: "pull_request", target: "12", repo: "repo-a/app" },
          { type: "issue", target: "12", repo: "repo-b/api" }
        ],
        lanes: [
          {
            name: "shared-number",
            owner: "worker-a",
            targets: ["12"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: []
          }
        ],
        launchPrompt:
          "Use $pr-batch to complete this batch.\nRepository: repo-a/app, repo-b/api\nBatch id: batch-duplicate-targets\nItems:\n- PR #12\n- Issue #12"
      })
    });

    expect(response.status).toBe(400);
    await expect(readFile(join(stateRoot, "batches", "batch-duplicate-targets.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects imports whose launch prompt batch id differs from the manifest id", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-import-id-drift-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-new-id",
        repo: "shakacode/react_on_rails",
        objective: "Stabilize PR 4005.",
        targets: [{ type: "pull_request", target: "4005" }],
        lanes: [
          {
            name: "tests",
            owner: "worker-a",
            targets: ["4005"],
            dependsOn: [],
            status: "queued",
            liveness: "no-heartbeat",
            blockedOn: []
          }
        ],
        launchPrompt:
          "Use $pr-batch to complete this batch.\nRepository: shakacode/react_on_rails\nBatch id: batch-old-id\nItems:\n- PR #4005"
      })
    });

    expect(response.status).toBe(400);
    await expect(readFile(join(stateRoot, "batches", "batch-new-id.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes explicit batch stop requests as events without touching claims or heartbeats", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-stop-"));
    await mkdir(join(stateRoot, "batches"), { recursive: true });
    await writeFile(
      join(stateRoot, "batches", "batch-react-on-rails-4005.json"),
      JSON.stringify({
        schema_version: 1,
        batch_id: "batch-react-on-rails-4005",
        repo: "shakacode/react_on_rails",
        objective: "Stabilize PR 4005.",
        targets: [{ type: "pull_request", target: "4005" }],
        lanes: [{ name: "qa", owner: "worker-a", targets: ["4005"], depends_on: [], status: "queued" }]
      })
    );
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "batch-react-on-rails-4005",
        repo: "shakacode/react_on_rails",
        reason: "Restart with a smaller lane split."
      })
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe("events/batches/batch-react-on-rails-4005.jsonl");
    await expect(readFile(join(stateRoot, "events", "batches", "batch-react-on-rails-4005.jsonl"), "utf8")).resolves.toEqual(
      expect.stringContaining('"type":"batch.stop_requested"')
    );
    await expect(readFile(join(stateRoot, "claims", "batch-react-on-rails-4005.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(stateRoot, "heartbeats", "batch-react-on-rails-4005.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("writes repo-scoped stop requests for scoped repo-less batches", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-stop-repoless-"));
    await mkdir(join(stateRoot, "batches"), { recursive: true });
    await writeFile(
      join(stateRoot, "batches", "multi-repo-batch.json"),
      JSON.stringify({
        schema_version: 1,
        batch_id: "multi-repo-batch",
        objective: "Multi-repo batch.",
        targets: [
          { type: "pull_request", target: "4005", repo: "shakacode/react_on_rails" },
          { type: "pull_request", target: "99", repo: "secret/repo" }
        ],
        lanes: [{ name: "visible", owner: "worker-a", targets: ["4005"], depends_on: [], status: "queued" }]
      })
    );
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "multi-repo-batch",
        reason: "Restart visible scoped lane."
      })
    });

    expect(response.status).toBe(201);
    const event = await readFile(join(stateRoot, "events", "batches", "multi-repo-batch.jsonl"), "utf8");
    expect(event).toContain('"repo":"shakacode/react_on_rails"');
    expect(event).toContain("Restart visible scoped lane.");
  });

  it("rejects ambiguous repo-less batch stop requests without a scoped repo", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-stop-repoless-ambiguous-"));
    await mkdir(join(stateRoot, "batches"), { recursive: true });
    await writeFile(
      join(stateRoot, "batches", "multi-repo-batch.json"),
      JSON.stringify({
        schema_version: 1,
        batch_id: "multi-repo-batch",
        objective: "Visible multi-repo batch.",
        targets: [
          { type: "pull_request", target: "12", repo: "repo-a/app" },
          { type: "pull_request", target: "34", repo: "repo-b/api" }
        ],
        lanes: [
          { name: "app", owner: "worker-a", targets: ["12"], depends_on: [], status: "queued" },
          { name: "api", owner: "worker-b", targets: ["34"], depends_on: [], status: "queued" }
        ]
      })
    );
    const baseUrl = await listen(stateRoot);
    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRepos: ["repo-a/app", "repo-b/api"] })
    });
    const response = await fetch(`${baseUrl}/api/batches/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: "multi-repo-batch" })
    });

    expect(response.status).toBe(409);
    await expect(readFile(join(stateRoot, "events", "batches", "multi-repo-batch.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects batch stop requests that do not resolve to a scoped visible batch", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-stop-hidden-"));
    const baseUrl = await listen(stateRoot);
    const response = await fetch(`${baseUrl}/api/batches/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: "hidden-batch",
        reason: "Should not write outside the scoped dashboard model."
      })
    });

    expect(response.status).toBe(404);
    await expect(readFile(join(stateRoot, "events", "batches", "hidden-batch.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
