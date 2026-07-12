import express from "express";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBatchManifestDraft, type BatchManifestDraft } from "../shared/batchManifest";
import type { BatchRecord, DashboardModel, DashboardSettings } from "../shared/types";
import type { ServerConfig } from "./config";
import { loadOpenGitHubItems as defaultLoadOpenGitHubItems } from "./github/githubClient";
import { createHostGuard } from "./security/hostGuard";
import { isLoopbackAddress } from "./security/loopback";
import { normalizeTargetRepos, readDashboardSettings, settingsPath, writeDashboardSettings } from "./settings";
import { BatchManifestImportError, writeImportedBatchManifest } from "./state/batchManifestImport";
import { writeBatchStopRequest } from "./state/batchControl";
import { buildDashboardModel } from "./state/buildDashboardModel";
import { readCoordinationState } from "./state/readCoordinationState";
import { repoRefsFromBranch, repoRefsFromPromptHeaders, repoRefsFromText } from "./repoRefs";

type LoadOpenGitHubItems = typeof defaultLoadOpenGitHubItems;
const MAX_DASHBOARD_CACHE_TTL_MS = 5000;

export function canBypassDashboardCache(refreshHeader: string | undefined, remoteAddress: string | undefined): boolean {
  // Same-host reverse proxies make remote callers appear loopback; keep exposed deployments direct and host-guarded.
  return refreshHeader === "foreground" && isLoopbackAddress(remoteAddress);
}

interface CreateDashboardAppOptions {
  serveFrontend?: boolean;
  loadOpenGitHubItems?: LoadOpenGitHubItems;
}

export async function createDashboardApp(config: ServerConfig, options: CreateDashboardAppOptions = {}) {
  const app = express();
  const persistedSettingsPath = settingsPath(config.settingsPath);
  const loadOpenGitHubItems = options.loadOpenGitHubItems || defaultLoadOpenGitHubItems;
  const coordApiUrl = config.coordApiUrl?.trim() || "";
  const coordApiToken = config.coordApiToken || "";
  const displayedStateRoot = coordApiUrl ? "coordination-api" : config.stateRoot;
  const dashboardCacheTtlMs = config.refreshIntervalMs > 0 ? Math.min(config.refreshIntervalMs, MAX_DASHBOARD_CACHE_TTL_MS) : 0;
  let dashboardCacheGeneration = 0;
  let dashboardBuildSequence = 0;
  let latestCacheableDashboardBuild = 0;
  let cachedDashboard: { expiresAt: number; key: string; model: DashboardModel } | undefined;
  let dashboardBuildInFlight: { key: string; promise: Promise<DashboardModel> } | undefined;

  app.use(createHostGuard(config.allowedHosts));
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/doctor", async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({
        error: "Coordination diagnostics can only be read from the machine running the dashboard."
      });
      return;
    }

    const state = await readCoordinationState(config.stateRoot, new Date(), {
      apiUrl: coordApiUrl,
      token: coordApiToken
    });
    res.json({
      apiUrl: coordApiUrl || null,
      tokenEnvVar: config.coordApiTokenEnvVar || null,
      stateRoot: config.stateRoot,
      perResource: state.sourceStatus
    });
  });

  async function currentSettings() {
    const settings = await readDashboardSettings(persistedSettingsPath, { targetRepos: config.targetRepos });
    return { ...settings, refreshIntervalMs: config.refreshIntervalMs };
  }

  function dashboardCacheKey(settings: DashboardSettings): string {
    return settings.targetRepos.join("\n");
  }

  function invalidateDashboardCache() {
    dashboardCacheGeneration += 1;
    cachedDashboard = undefined;
    dashboardBuildInFlight = undefined;
  }

  function nextCacheableDashboardBuild(): number {
    dashboardBuildSequence += 1;
    latestCacheableDashboardBuild = dashboardBuildSequence;
    return dashboardBuildSequence;
  }

  async function buildScopedDashboard(settings: DashboardSettings): Promise<DashboardModel> {
    const now = new Date();
    const state = await readCoordinationState(config.stateRoot, now, {
      apiUrl: coordApiUrl,
      token: coordApiToken
    });
    const githubResults = await Promise.all(settings.targetRepos.map((repo) => loadOpenGitHubItems(repo)));
    const githubItems = githubResults.flatMap((result) => result.items);
    const githubWarnings = githubResults.flatMap((result) => result.warnings);

    const model = buildDashboardModel({
      stateRoot: displayedStateRoot,
      targetRepos: settings.targetRepos,
      claims: state.claims,
      heartbeats: state.heartbeats,
      batches: state.batches,
      events: state.events,
      githubItems,
      warnings: [...state.warnings, ...githubWarnings],
      now
    });
    return {
      ...model,
      sourceStatus: state.sourceStatus,
      ...(config.coordApiTokenEnvVar ? { coordinationTokenEnvVar: config.coordApiTokenEnvVar } : {})
    };
  }

  function cacheDashboardModel(key: string, model: DashboardModel, generation: number, sequence: number, expiresAt: number) {
    if (generation !== dashboardCacheGeneration || sequence !== latestCacheableDashboardBuild) {
      return;
    }
    cachedDashboard = {
      expiresAt,
      key,
      model
    };
  }

  async function readScopedDashboard(settings: DashboardSettings, options: { bypassCache?: boolean } = {}): Promise<DashboardModel> {
    const key = dashboardCacheKey(settings);
    if (dashboardCacheTtlMs <= 0) {
      return buildScopedDashboard(settings);
    }

    if (options.bypassCache) {
      invalidateDashboardCache();
      const generation = dashboardCacheGeneration;
      const sequence = nextCacheableDashboardBuild();
      const model = await buildScopedDashboard(settings);
      cacheDashboardModel(key, model, generation, sequence, Date.now() + dashboardCacheTtlMs);
      return model;
    }

    const nowMs = Date.now();
    if (cachedDashboard?.key === key && cachedDashboard.expiresAt > nowMs) {
      return cachedDashboard.model;
    }
    if (dashboardBuildInFlight?.key === key) {
      return dashboardBuildInFlight.promise;
    }

    const generation = dashboardCacheGeneration;
    const sequence = nextCacheableDashboardBuild();
    const expiresAt = Date.now() + dashboardCacheTtlMs;
    const promise = buildScopedDashboard(settings)
      .then((model) => {
        cacheDashboardModel(key, model, generation, sequence, expiresAt);
        return model;
      })
      .finally(() => {
        if (dashboardBuildInFlight?.promise === promise) {
          dashboardBuildInFlight = undefined;
        }
      });
    dashboardBuildInFlight = { key, promise };
    return promise;
  }

  function batchContainsRepo(batch: BatchRecord, repo: string): boolean {
    return batch.repo === repo || Boolean(batch.targets?.some((target) => target.repo === repo));
  }

  function uniqueTargetRepo(batch: BatchRecord): string | undefined {
    const repos = new Set((batch.targets || []).map((target) => target.repo).filter((targetRepo): targetRepo is string => Boolean(targetRepo)));
    return repos.size === 1 ? Array.from(repos)[0] : undefined;
  }

  function repoForStop(batch: BatchRecord, requestedRepo: string): string {
    const repo = requestedRepo || batch.repo || uniqueTargetRepo(batch);
    if (!repo) {
      throw new BatchManifestImportError(`Batch ${batch.batchId} spans multiple saved target repositories; include repo.`, 409);
    }
    return repo;
  }

  async function resolveScopedBatchForStop(batchId: unknown, repo: string, settings: DashboardSettings): Promise<BatchRecord> {
    const normalizedBatchId = typeof batchId === "string" ? batchId.trim() : "";
    if (!normalizedBatchId) {
      throw new BatchManifestImportError("Batch id is required.");
    }

    const now = new Date();
    const state = await readCoordinationState(config.stateRoot, now, {
      apiUrl: coordApiUrl,
      token: coordApiToken
    });
    const model = buildDashboardModel({
      stateRoot: displayedStateRoot,
      targetRepos: settings.targetRepos,
      claims: state.claims,
      heartbeats: state.heartbeats,
      batches: state.batches,
      events: state.events,
      githubItems: [],
      warnings: state.warnings,
      now
    });
    const candidates = model.batches.filter(
      (batch) => batch.batchId === normalizedBatchId && (!repo || batchContainsRepo(batch, repo))
    );

    if (candidates.length === 0) {
      throw new BatchManifestImportError(`Batch ${normalizedBatchId} is not visible with the saved target repositories.`, 404);
    }
    if (!repo && candidates.length > 1) {
      throw new BatchManifestImportError(`Batch ${normalizedBatchId} matches multiple saved target repositories; include repo.`, 409);
    }
    return candidates[0];
  }

  function rejectApiModeWrite(res: express.Response, action: string): boolean {
    if (!coordApiUrl) {
      return false;
    }
    res.status(409).json({
      error: `${action} is only available in filesystem mode. API write support is planned for a later dashboard slice.`
    });
    return true;
  }

  app.get("/api/settings", async (_req, res) => {
    res.json(await currentSettings());
  });

  app.put("/api/settings", async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({
        error: "Settings can only be changed from the machine running the dashboard. Remote viewers have read-only access."
      });
      return;
    }

    const targetRepos = normalizeTargetRepos(req.body?.targetRepos);
    if (targetRepos.length === 0) {
      res.status(400).json({ error: "At least one owner/repo target is required." });
      return;
    }

    const saved = await writeDashboardSettings(persistedSettingsPath, { targetRepos });
    invalidateDashboardCache();
    res.json({ ...saved, refreshIntervalMs: config.refreshIntervalMs });
  });

  app.post("/api/batches/import", async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({
        error: "Batch plans can only be imported from the machine running the dashboard. Remote viewers have read-only access."
      });
      return;
    }
    if (rejectApiModeWrite(res, "Batch import")) {
      return;
    }

    try {
      const settings = await currentSettings();
      const draft = normalizeBatchManifestDraft(req.body);
      assertImportWithinTargetRepos(draft, settings.targetRepos);
      const result = await writeImportedBatchManifest(config.stateRoot, draft);
      invalidateDashboardCache();
      res.status(201).json(result);
    } catch (error) {
      const status = error instanceof BatchManifestImportError ? error.statusCode : 400;
      res.status(status).json({ error: error instanceof Error ? error.message : "Batch plan import failed." });
    }
  });

  app.post("/api/batches/stop", async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({
        error: "Batch stop requests can only be sent from the machine running the dashboard. Remote viewers have read-only access."
      });
      return;
    }
    if (rejectApiModeWrite(res, "Batch stop requests")) {
      return;
    }

    try {
      const settings = await currentSettings();
      const repo = typeof req.body?.repo === "string" ? req.body.repo.trim() : "";
      if (repo && !settings.targetRepos.includes(repo)) {
        throw new BatchManifestImportError(`Batch stop repo is outside saved target repositories: ${repo}.`);
      }
      const batch = await resolveScopedBatchForStop(req.body?.batchId, repo, settings);
      const stopRepo = repoForStop(batch, repo);
      const result = await writeBatchStopRequest(config.stateRoot, {
        batchId: batch.batchId,
        repo: stopRepo,
        reason: typeof req.body?.reason === "string" ? req.body.reason : undefined
      });
      invalidateDashboardCache();
      res.status(201).json(result);
    } catch (error) {
      const status = error instanceof BatchManifestImportError ? error.statusCode : 400;
      res.status(status).json({ error: error instanceof Error ? error.message : "Batch stop request failed." });
    }
  });

  app.get("/api/dashboard", async (req, res) => {
    const settings = await currentSettings();
    const bypassCache = canBypassDashboardCache(req.get("X-Dashboard-Refresh"), req.socket.remoteAddress);
    res.json(await readScopedDashboard(settings, { bypassCache }));
  });

  if (options.serveFrontend !== false) {
    if (config.nodeEnv === "production") {
      const dirname = fileURLToPath(new URL(".", import.meta.url));
      const dist = join(dirname, "../../dist");
      app.use(express.static(dist));
      app.get(/.*/, (_req, res) => {
        res.sendFile(join(dist, "index.html"));
      });
    } else {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        appType: "spa",
        server: { allowedHosts: config.allowedHosts, middlewareMode: true }
      });
      app.use(vite.middlewares);
    }
  }

  return app;
}

function assertImportWithinTargetRepos(draft: BatchManifestDraft, targetRepos: string[]) {
  const targetRepoSet = new Set(targetRepos);
  const repos = new Set<string>();
  const addRepoRefs = (value: string | undefined) => {
    for (const repo of repoRefsFromText(value)) {
      repos.add(repo);
    }
  };
  const addBranchRepoRefs = (value: string | undefined) => {
    for (const repo of repoRefsFromBranch(value)) {
      repos.add(repo);
    }
  };
  if (draft.repo) {
    repos.add(draft.repo);
  }
  for (const target of draft.targets) {
    if (target.repo) {
      repos.add(target.repo);
    }
    addRepoRefs(target.url);
    addRepoRefs(target.title);
  }
  for (const reservation of draft.reservations) {
    if (reservation.repo) {
      repos.add(reservation.repo);
    }
    addRepoRefs(reservation.reason);
    addRepoRefs(reservation.owner);
    addRepoRefs(reservation.laneName);
  }
  for (const lane of draft.lanes) {
    addRepoRefs(lane.name);
    addRepoRefs(lane.owner);
    addRepoRefs(lane.status);
    addRepoRefs(lane.threadHandle);
    addRepoRefs(lane.host);
    addRepoRefs(lane.operator);
    addBranchRepoRefs(lane.branch);
    addRepoRefs(lane.prUrl);
    for (const dependency of lane.dependsOn) {
      addRepoRefs(dependency);
    }
    for (const blockedOn of lane.blockedOn) {
      addRepoRefs(blockedOn);
    }
  }
  addRepoRefs(draft.objective);
  addRepoRefs(draft.launchPrompt);
  for (const repo of repoRefsFromPromptHeaders(draft.launchPrompt)) {
    repos.add(repo);
  }
  const outOfScopeRepos = Array.from(repos).filter((repo) => !targetRepoSet.has(repo));
  if (outOfScopeRepos.length > 0) {
    throw new BatchManifestImportError(`Batch plan repos outside saved target repositories: ${outOfScopeRepos.join(", ")}.`);
  }
}
