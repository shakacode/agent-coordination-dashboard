import express from "express";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBatchManifestDraft, type BatchManifestDraft } from "../shared/batchManifest";
import { repoLessBatchLaneMatchesWorkItem } from "../shared/batchSignal";
import { buildCustodyTimeline } from "../shared/custodyTimeline";
import type { BatchRecord, DashboardModel, DashboardSettings, WorkItem } from "../shared/types";
import type { ServerConfig } from "./config";
import { createGitHubTargetReconciler, githubTargetReferenceKey, loadOpenGitHubItems as defaultLoadOpenGitHubItems, type GitHubTargetReference } from "./github/githubClient";
import { createHostGuard } from "./security/hostGuard";
import { isLoopbackAddress } from "./security/loopback";
import { normalizeTargetRepos, readDashboardSettings, settingsPath, writeDashboardSettings } from "./settings";
import { BatchManifestImportError, writeImportedBatchManifest } from "./state/batchManifestImport";
import { writeBatchStopRequest } from "./state/batchControl";
import { buildDashboardModel, hasCoordinationEvidence } from "./state/buildDashboardModel";
import { readCoordinationState } from "./state/readCoordinationState";
import { repoRefsFromBranch, repoRefsFromPromptHeaders, repoRefsFromText } from "./repoRefs";

type LoadOpenGitHubItems = typeof defaultLoadOpenGitHubItems;
type LoadGitHubTargets = ReturnType<typeof createGitHubTargetReconciler>["load"];
type CoordinationSnapshot = { state: Awaited<ReturnType<typeof readCoordinationState>>; now: Date };
interface BuildScopedDashboardOptions {
  bypassGitHubCache?: boolean;
  captured?: CoordinationSnapshot;
}
const MAX_DASHBOARD_CACHE_TTL_MS = 5000;

export function batchLanesFor(item: WorkItem, model: DashboardModel) {
  return (item.batchSignals || [])
    .map((signal, index) => ({ signal, index }))
    .sort((left, right) => {
      const newestFirst = (Date.parse(right.signal.updatedAt || "") || 0) - (Date.parse(left.signal.updatedAt || "") || 0);
      return newestFirst || left.index - right.index;
    })
    .flatMap(({ signal }) => model.batches.flatMap((batch) => {
      if (batch.batchId !== signal.batchId) return [];
      const explicitlyScopedRepos = new Set((batch.targets || [])
        .filter((target) => target.target === item.target && target.repo)
        .map((target) => target.repo!));
      const repoMatches = explicitlyScopedRepos.size > 0
        ? explicitlyScopedRepos.has(item.repo)
        : batch.repo
          ? batch.repo === item.repo
          : repoLessBatchLaneMatchesWorkItem(batch, signal.batchId || "", item, model.workItems);
      if (!repoMatches) return [];
      return batch.lanes.filter((lane) => lane.name === signal.laneName && lane.targets.includes(item.target));
    }));
}

export function canBypassDashboardCache(refreshHeader: string | undefined, remoteAddress: string | undefined): boolean {
  // Same-host reverse proxies make remote callers appear loopback; keep exposed deployments direct and host-guarded.
  return refreshHeader === "foreground" && isLoopbackAddress(remoteAddress);
}

interface CreateDashboardAppOptions {
  serveFrontend?: boolean;
  loadOpenGitHubItems?: LoadOpenGitHubItems;
  loadGitHubTargets?: LoadGitHubTargets;
}

export async function createDashboardApp(config: ServerConfig, options: CreateDashboardAppOptions = {}) {
  const app = express();
  const persistedSettingsPath = settingsPath(config.settingsPath);
  const loadOpenGitHubItems = options.loadOpenGitHubItems || defaultLoadOpenGitHubItems;
  const defaultTargetReconciler = createGitHubTargetReconciler();
  const loadGitHubTargets = options.loadGitHubTargets || defaultTargetReconciler.load;
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

  async function captureCoordinationSnapshot(): Promise<CoordinationSnapshot> {
    const now = new Date();
    const state = await readCoordinationState(config.stateRoot, now, {
      apiUrl: coordApiUrl,
      token: coordApiToken
    });
    return { state, now };
  }

  function dashboardCacheKey(settings: DashboardSettings): string {
    return settings.targetRepos.join("\n");
  }

  function invalidateDashboardCache() {
    dashboardCacheGeneration += 1;
    cachedDashboard = undefined;
    dashboardBuildInFlight = undefined;
  }

  app.get("/api/item/:repo/:target", async (req, res) => {
    const repo = req.params.repo;
    const target = req.params.target;
    const settings = await currentSettings();
    if (!repo || !target || !settings.targetRepos.includes(repo)) {
      res.status(404).json({ error: "Work item is not in the saved target repositories." });
      return;
    }

    const captured = await captureCoordinationSnapshot();
    const model = await buildItemScopedDashboard(settings, captured);
    const item = model.workItems.find((candidate) => candidate.repo === repo && candidate.target === target);
    res.json({
      ...buildCustodyTimeline({ repo, target, claims: captured.state.claims, heartbeats: captured.state.heartbeats, events: captured.state.events, now: captured.now }),
      item,
      sourceStatus: captured.state.sourceStatus,
      // Reuse the dashboard model's target-repository sanitization, then keep
      // only this item's attributed warnings plus safe, unattributed notices.
      warnings: model.warnings.filter((warning) =>
        (!warning.repo || warning.repo === repo) && (!warning.target || warning.target === target)
      )
    });
  });

  function nextCacheableDashboardBuild(): number {
    dashboardBuildSequence += 1;
    latestCacheableDashboardBuild = dashboardBuildSequence;
    return dashboardBuildSequence;
  }

  function githubPullRequestReference(value: string | undefined, expectedRepo: string): Pick<GitHubTargetReference, "repo" | "target" | "type"> | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/i);
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || !match || match[1].toLowerCase() !== expectedRepo.toLowerCase()) return undefined;
      return { repo: expectedRepo, target: match[2], type: "pull_request" };
    } catch {
      return undefined;
    }
  }

  function reconciliationReference(item: WorkItem, model: DashboardModel): GitHubTargetReference | undefined {
    if (!hasCoordinationEvidence(item) || !/^\d+$/.test(item.target)) return undefined;
    const lanes = batchLanesFor(item, model);
    const branch = item.claim?.branch || item.heartbeat?.branch || lanes.find((lane) => lane.branch)?.branch;
    const events = model.events
      .filter((event) => event.repo === item.repo && event.target === item.target && event.prUrl)
      .sort((left, right) => (Date.parse(right.timestamp || "") || 0) - (Date.parse(left.timestamp || "") || 0));
    // Keep the selected PR URL and branch source-atomic. Active claim and live/stale
    // heartbeat sources are ordered by their live-record timestamp; claims fall back
    // from updatedAt to claimedAt. Equal or invalid timestamps retain
    // the stable claim-before-heartbeat order. Matching lanes and history remain
    // lower-priority fallbacks. Dead/unknown heartbeats and non-active claims
    // remain usable only after lanes and history, ordered by recency within that
    // fallback tier. A branch from another source is not sufficient evidence
    // that it belongs to the selected pull request.
    const liveSources = [
      { source: item.claim?.status === "active" ? item.claim : undefined, timestamp: item.claim?.updatedAt || item.claim?.claimedAt },
      { source: item.heartbeat && ["live", "stale"].includes(item.heartbeat.liveness) ? item.heartbeat : undefined, timestamp: item.heartbeat?.updatedAt }
    ]
      .map((candidate, index) => ({ ...candidate, index }))
      .filter((candidate): candidate is typeof candidate & { source: NonNullable<typeof candidate.source> } => Boolean(candidate.source))
      .sort((left, right) => {
        const newestFirst = (Date.parse(right.timestamp || "") || 0) - (Date.parse(left.timestamp || "") || 0);
        return newestFirst || left.index - right.index;
      })
      .map(({ source }) => source);
    const inactiveSources = [
      { source: item.claim?.status !== "active" ? item.claim : undefined, timestamp: item.claim?.updatedAt || item.claim?.claimedAt },
      { source: item.heartbeat && !["live", "stale"].includes(item.heartbeat.liveness) ? item.heartbeat : undefined, timestamp: item.heartbeat?.updatedAt }
    ]
      .map((candidate, index) => ({ ...candidate, index }))
      .filter((candidate): candidate is typeof candidate & { source: NonNullable<typeof candidate.source> } => Boolean(candidate.source))
      .sort((left, right) => {
        const newestFirst = (Date.parse(right.timestamp || "") || 0) - (Date.parse(left.timestamp || "") || 0);
        return newestFirst || left.index - right.index;
      })
      .map(({ source }) => source);
    // A validated same-repository prUrl is an authoritative coordination
    // association. Umbrella and manually linked PRs are valid; do not infer the
    // relationship from GitHub closing keywords.
    const pullRequest = [...liveSources, ...lanes, ...events, ...inactiveSources]
      .flatMap((source) => {
        const reference = githubPullRequestReference(source?.prUrl, item.repo);
        return reference ? [{ ...reference, ...(source?.branch ? { branch: source.branch } : {}) }] : [];
      })[0];
    if (pullRequest) {
      const existingTarget = model.workItems.find((candidate) =>
        candidate.repo === pullRequest.repo
        && candidate.target === pullRequest.target
        && candidate.github?.type === "pull_request"
        && candidate.github.loadState === "loaded"
      )?.github;
      return { ...pullRequest, ...(existingTarget ? { existingTarget } : {}) };
    }
    if (item.terminalState) {
      return item.type === "pull_request"
        ? { repo: item.repo, target: item.target, type: "pull_request", ...(branch ? { branch } : {}) }
        : undefined;
    }
    if (item.github?.loadState === "loaded") {
      return branch ? { repo: item.repo, target: item.target, type: item.type, branch, existingTarget: item.github } : undefined;
    }
    return { repo: item.repo, target: item.target, type: item.type, ...(branch ? { branch } : {}) };
  }

  function explicitlyDeclaredMergedWithoutGitHubTime(model: DashboardModel): boolean {
    const explicitlyMerged = (value: string | undefined) => /(^|[^a-z0-9])merged($|[^a-z0-9])/i.test(value || "");
    return model.workItems.some((item) => {
      if (item.terminalProvenance?.source !== "declared" || item.github?.mergedAt) return false;
      const eventDeclaresMerge = model.events.some((event) =>
        event.repo === item.repo
        && event.target === item.target
        && (explicitlyMerged(event.type) || explicitlyMerged(event.status))
      );
      return explicitlyMerged(item.heartbeat?.status)
        || eventDeclaresMerge
        || item.batchSignals?.some((signal) => explicitlyMerged(signal.status));
    });
  }

  async function buildScopedDashboard(settings: DashboardSettings, options: BuildScopedDashboardOptions = {}): Promise<DashboardModel> {
    const captured = options.captured || await captureCoordinationSnapshot();
    const now = captured.now;
    const state = captured.state;
    const githubResults = await Promise.all(settings.targetRepos.map((repo) => loadOpenGitHubItems(repo)));
    const openGithubItems = githubResults.flatMap((result) => result.items);
    const openGithubWarnings = githubResults.flatMap((result) => result.warnings);

    // Intentionally build twice: the preliminary pass derives canonical WorkItems
    // and reconciliation plans; the final pass applies fetched GitHub evidence.
    const preliminaryModel = buildDashboardModel({
      stateRoot: displayedStateRoot,
      targetRepos: settings.targetRepos,
      claims: state.claims,
      heartbeats: state.heartbeats,
      batches: state.batches,
      events: state.events,
      githubItems: openGithubItems,
      warnings: [...state.warnings, ...openGithubWarnings],
      now
    });
    const reconciliationPlans = preliminaryModel.workItems.flatMap((item) => {
      const reference = reconciliationReference(item, preliminaryModel);
      return reference ? [{ workItemId: item.id, item, reference }] : [];
    });
    const reconciled = await loadGitHubTargets(reconciliationPlans.map((plan) => plan.reference), { bypassCache: options.bypassGitHubCache });
    const returnedReferences = reconciled.references || reconciliationPlans.map((plan) => plan.reference);
    const resultByReference = new Map(reconciled.items.map((item, index) => [githubTargetReferenceKey(returnedReferences[index]), item]));
    const remappedGithubItems = reconciliationPlans.flatMap((plan) => {
      const result = resultByReference.get(githubTargetReferenceKey(plan.reference));
      const coordinatedType = plan.item.type === "issue" || plan.item.type === "pull_request"
        ? { coordinatedType: plan.item.type }
        : {};
      return result ? [{ ...result, repo: plan.item.repo, target: plan.item.target, ...coordinatedType }] : [];
    });
    const reconciledWorkItemIds = new Set(reconciliationPlans.map((plan) => plan.workItemId));
    const consumedCanonicalIds = new Set(reconciliationPlans.flatMap((plan) => {
      if (plan.reference.type !== "pull_request") return [];
      const canonicalId = `${plan.reference.repo}#${plan.reference.target}`;
      if (canonicalId === plan.workItemId) return [];
      const canonicalWorkItem = preliminaryModel.workItems.find((item) => item.id === canonicalId);
      return canonicalWorkItem && hasCoordinationEvidence(canonicalWorkItem) ? [] : [canonicalId];
    }));
    const githubItems = [...openGithubItems.filter((item) => {
      const id = `${item.repo}#${item.target}`;
      return !reconciledWorkItemIds.has(id) && !consumedCanonicalIds.has(id);
    }), ...remappedGithubItems];
    const model = reconciliationPlans.length === 0 ? preliminaryModel : buildDashboardModel({
      stateRoot: displayedStateRoot,
      targetRepos: settings.targetRepos,
      claims: state.claims,
      heartbeats: state.heartbeats,
      batches: state.batches,
      events: state.events,
      githubItems,
      warnings: [...state.warnings, ...openGithubWarnings, ...reconciled.warnings],
      now
    });
    // The headline is scope-wide: any missing GitHub evidence makes the whole count untrusted.
    const githubCoverageUnknown = openGithubWarnings.length > 0 || reconciled.items.some((item) => item.loadState === "unknown");
    const coordinationCoverageUnknown = state.sourceStatus.some((source) => ["auth_error", "unreachable"].includes(source.status));
    const mergeTimeCoverageUnknown = explicitlyDeclaredMergedWithoutGitHubTime(model);
    return {
      ...model,
      ...(githubCoverageUnknown || coordinationCoverageUnknown ? { trulyOpenCount: undefined, trulyOpenCountStatus: "unknown" as const } : {}),
      githubMergeTimeStatus: githubCoverageUnknown || coordinationCoverageUnknown || mergeTimeCoverageUnknown ? "unavailable" : "available",
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

  async function cachedDashboardForItem(settings: DashboardSettings): Promise<DashboardModel | undefined> {
    const key = dashboardCacheKey(settings);
    if (cachedDashboard?.key === key && cachedDashboard.expiresAt > Date.now()) return cachedDashboard.model;
    return dashboardBuildInFlight?.key === key ? dashboardBuildInFlight.promise : undefined;
  }

  async function buildItemScopedDashboard(settings: DashboardSettings, captured: CoordinationSnapshot): Promise<DashboardModel> {
    const cached = await cachedDashboardForItem(settings);
    if (!cached) return buildScopedDashboard(settings, { captured });
    // Item refreshes need fresh coordination state, but can safely reuse the
    // already-loaded GitHub previews from the current dashboard cache.
    const githubItems = cached.workItems.flatMap((item) => item.github ? [item.github] : []);
    return buildDashboardModel({
      stateRoot: displayedStateRoot,
      targetRepos: settings.targetRepos,
      claims: captured.state.claims,
      heartbeats: captured.state.heartbeats,
      batches: captured.state.batches,
      events: captured.state.events,
      githubItems,
      warnings: captured.state.warnings,
      now: captured.now
    });
  }

  async function readScopedDashboard(settings: DashboardSettings, options: { bypassCache?: boolean } = {}): Promise<DashboardModel> {
    const key = dashboardCacheKey(settings);
    if (dashboardCacheTtlMs <= 0) {
      return buildScopedDashboard(settings, { bypassGitHubCache: options.bypassCache });
    }

    if (options.bypassCache) {
      invalidateDashboardCache();
      const generation = dashboardCacheGeneration;
      const sequence = nextCacheableDashboardBuild();
      const model = await buildScopedDashboard(settings, { bypassGitHubCache: true });
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
