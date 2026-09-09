import express from "express";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAttentionModel as buildAttentionModelImpl } from "./attention/buildAttentionModel";
import { readAttentionRecords as readAttentionRecordsImpl } from "./attention/readAttentionRecords";
import { createAttentionSampler, type AttentionSamplerOptions } from "./attention/sampler";
import type { ServerConfig } from "./config";
import { readDoctorReport, type DoctorSettingsStatus } from "./doctor";
import { createHostGuard } from "./security/hostGuard";
import { isLoopbackAddress } from "./security/loopback";
import { isMachineLocalAddress, type MachineInterfaceMap } from "./security/machineLocal";
import { normalizeTargetRepos, readDashboardSettings, settingsPath, writeDashboardSettings } from "./settings";
import type { AttentionPayload } from "../shared/attention";

/**
 * How long one built attention payload is served before the next request
 * rebuilds it.
 *
 * The cache is a TTL plus an in-flight guard and nothing else: no timer ever
 * schedules a rebuild, so an idle dashboard reads only when the hourly sampler
 * asks for a payload, and that read is served from this cache like any other. A
 * reader that wants to skip the TTL asks for it explicitly with
 * `X-Dashboard-Refresh: foreground` from the machine running the dashboard.
 */
export const ATTENTION_CACHE_TTL_MS = 60000;

interface CreateDashboardAppOptions {
  serveFrontend?: boolean;
  machineInterfaces?: MachineInterfaceMap;
  /** Injectable for tests; defaults to the real attention reader. */
  readAttentionRecords?: typeof readAttentionRecordsImpl;
  /** Injectable for tests; defaults to the real attention model. */
  buildAttentionModel?: typeof buildAttentionModelImpl;
  /** Injectable for tests; defaults to the current time. Drives the cache clock. */
  now?: () => Date;
  /** Injectable for tests; defaults to {@link ATTENTION_CACHE_TTL_MS}. */
  ttlMs?: number;
  /**
   * Injectable for tests; defaults to the global fetch and is handed to the
   * attention reader, which is the only thing on this route that makes a
   * request at all.
   */
  fetchImpl?: typeof fetch;
  /**
   * Injectable for tests; defaults to the real hourly attention sampler.
   *
   * `false` wires the document-load counter without scheduling anything, which
   * is what every test that is not about the sampler wants: creating the app
   * must not start a real timer in a test process. An object replaces
   * individual sampler seams — the interval, the clock, the scheduler, the
   * payload source — and still starts the job.
   */
  attentionSampler?: Partial<AttentionSamplerOptions> | false;
}

/**
 * The loopback-only foreground refresh rule.
 *
 * Same-host reverse proxies make remote callers appear loopback, so an exposed
 * deployment must stay direct and host-guarded; a remote viewer's header is
 * ignored and the request is served from the cache.
 */
function canBypassAttentionCache(refreshHeader: string | undefined, remoteAddress: string | undefined): boolean {
  return refreshHeader === "foreground" && isLoopbackAddress(remoteAddress);
}

/** The media types a browser names when it is navigating to a page. */
const DOCUMENT_MEDIA_TYPES = ["text/html", "application/xhtml+xml"];

/**
 * Whether an `Accept` header asks for the HTML document itself.
 *
 * The media type has to be named outright. A wildcard range accepts a document
 * the way it accepts everything else, so a script or an image — which browsers
 * request under a wildcard, or under their own type ahead of one — never reads
 * as a navigation.
 */
function acceptsDocument(accept: string | undefined): boolean {
  if (!accept) {
    return false;
  }
  return accept.split(",").some((entry) => {
    const parts = entry.split(";").map((part) => part.trim().toLowerCase());
    if (!DOCUMENT_MEDIA_TYPES.includes(parts[0])) {
      return false;
    }
    // `q=0` says the client will not take a document at all.
    const quality = parts.slice(1).find((part) => part.startsWith("q="));
    return quality === undefined || Number(quality.slice(2)) !== 0;
  });
}

/**
 * The smallest surface that separates an operator arriving at the page from the
 * client already on it.
 *
 * The sampler's `document_loads_since_last` measures returns to the page, so it
 * counts the request that fetches the HTML document and nothing else. The view's
 * own 60-second poll asks `/api/attention` for `application/json`, so it fails
 * both halves of this test and can never be mistaken for a return. `/api` is
 * excluded outright: opening an endpoint in an address bar sends a document
 * `Accept`, and reading JSON by hand is not a page load.
 *
 * A navigation is the only other way the document is fetched, in either serving
 * mode: the production static handler and the dev Vite middleware both answer
 * the same request, so the count is taken before either of them rather than
 * inside one.
 */
function isAttentionDocumentLoad(method: string | undefined, path: string, accept: string | undefined): boolean {
  if (method !== "GET") {
    return false;
  }
  const routePath = path.toLowerCase();
  if (routePath === "/api" || routePath.startsWith("/api/")) {
    return false;
  }
  return acceptsDocument(accept);
}

export async function createDashboardApp(config: ServerConfig, options: CreateDashboardAppOptions = {}) {
  const app = express();
  const persistedSettingsPath = settingsPath(config.settingsPath);
  const readAttentionRecords = options.readAttentionRecords || readAttentionRecordsImpl;
  const buildAttentionModel = options.buildAttentionModel || buildAttentionModelImpl;
  const now = options.now || (() => new Date());
  const attentionTtlMs = options.ttlMs ?? ATTENTION_CACHE_TTL_MS;

  let cachedAttention: { expiresAt: number; payload: AttentionPayload } | undefined;
  let attentionBuildInFlight: Promise<AttentionPayload> | undefined;
  /**
   * Bumped by every successful settings write. A build carries the generation
   * it started in, so a payload read for a scope that has since been replaced
   * is served to the requests already waiting on it but never cached.
   */
  let attentionScopeGeneration = 0;

  /**
   * Drop everything built for the previous target repositories.
   *
   * Displayed records are scoped to the saved settings, so a removed or
   * replaced repository must not keep appearing for up to a TTL — a remote
   * viewer cannot force a refresh, and the foreground header is loopback-only.
   *
   * The running build, if there is one, is reading the scope that was just
   * replaced, so it is orphaned rather than left joinable: a request that
   * arrives after the write starts its own build instead of being handed
   * records from a repository that is no longer saved. The orphan still
   * answers whoever was already waiting on it — cancelling a read in progress
   * is the only way to avoid that — but it caches nothing, because
   * `startAttentionBuild` compares the generation it captured, and its
   * `finally` compares promise identity, so it cannot clear the newer build's
   * entry either.
   */
  function invalidateAttentionScope(): void {
    cachedAttention = undefined;
    attentionBuildInFlight = undefined;
    attentionScopeGeneration += 1;
  }

  /**
   * Resolve the attention scope `/api/doctor` reports, and say which settings
   * state produced it.
   *
   * `readDashboardSettings` returns its fallback only when the file does not
   * exist and rejects every other failure, and a settings file that parses
   * always names at least one target, so an empty result means "no settings
   * file yet". That is the one state in which the configured `TARGET_REPOS`
   * may stand in. A file that exists but cannot be read is not a first run:
   * substituting the configured targets would hide the failure and report
   * repositories the operator never saved, so the scope is unreadable and
   * nothing is probed.
   */
  async function resolveDoctorSettingsScope(): Promise<{
    settings: DoctorSettingsStatus;
    targetRepos: readonly string[];
  }> {
    try {
      const saved = await readDashboardSettings(persistedSettingsPath, { targetRepos: [] });
      return saved.targetRepos.length > 0
        ? { settings: "saved", targetRepos: saved.targetRepos }
        : { settings: "first_run_default", targetRepos: config.targetRepos };
    } catch {
      return { settings: "unreadable", targetRepos: [] };
    }
  }

  /**
   * One attention read and one model build.
   *
   * The settings file is re-read every time: it is one small local file, and
   * re-reading it is what makes a `PUT /api/settings` change show up at the
   * next expiry or foreground refresh without restarting the server.
   */
  async function buildAttentionPayload(generation: number): Promise<AttentionPayload> {
    const settings = await readDashboardSettings(persistedSettingsPath, { targetRepos: config.targetRepos });
    // A replaced in-flight build must never restore its old visit bucket.
    if (generation === attentionScopeGeneration) attentionSampler.setScope(settings.targetRepos);
    const read = await readAttentionRecords({
      stateRoot: config.stateRoot,
      coordApiUrl: config.coordApiUrl,
      coordApiToken: config.coordApiToken,
      coordApiTokenEnvVar: config.coordApiTokenEnvVar,
      targetRepos: settings.targetRepos,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
    return buildAttentionModel(read, { now: now(), machineId: config.machineId });
  }

  /**
   * Start the one build, publishing it as the in-flight build before awaiting
   * anything so a concurrent request joins it instead of starting a second
   * read. The entry expires a TTL after the build started, so a slow read
   * cannot extend its own freshness. A rejected build caches nothing and clears
   * the guard, so the next request retries rather than inheriting the failure.
   */
  function startAttentionBuild(): Promise<AttentionPayload> {
    const expiresAt = now().getTime() + attentionTtlMs;
    const generation = attentionScopeGeneration;
    const build = buildAttentionPayload(generation)
      .then((payload) => {
        // A settings write landed while this build was reading, so the payload
        // describes a scope that is no longer saved: the requests waiting on
        // the build still get it, but it never becomes the cached answer.
        if (generation === attentionScopeGeneration) {
          cachedAttention = { expiresAt, payload };
        }
        return payload;
      })
      .finally(() => {
        if (attentionBuildInFlight === build) {
          attentionBuildInFlight = undefined;
        }
      });
    attentionBuildInFlight = build;
    return build;
  }

  function readAttentionPayload(bypassCache: boolean): Promise<AttentionPayload> {
    // The in-flight guard is checked before the TTL and before the bypass: at
    // most one read runs at a time, so a foreground refresh that arrives during
    // a build joins that build rather than starting a second one.
    if (attentionBuildInFlight) {
      return attentionBuildInFlight;
    }
    if (!bypassCache && cachedAttention && cachedAttention.expiresAt > now().getTime()) {
      return Promise.resolve(cachedAttention.payload);
    }
    return startAttentionBuild();
  }

  /**
   * The hourly sampler for the kill test, and the counter it reports.
   *
   * It reads through `readAttentionPayload` rather than reading for itself, so
   * an hourly sample joins whatever the route already built instead of doubling
   * the read load; it asks for no bypass, because a payload up to one TTL old
   * is still a fair snapshot of an hour.
   */
  const attentionSampler = createAttentionSampler({
    settingsFilePath: persistedSettingsPath,
    readPayload: async () => {
      const generation = attentionScopeGeneration;
      const payload = await readAttentionPayload(false);
      if (generation !== attentionScopeGeneration) {
        throw new Error("Attention scope changed while the sample was being read.");
      }
      return payload;
    },
    now,
    ...(options.attentionSampler || {})
  });

  // Attribute visits before the first payload read. An unreadable scope starts
  // empty, so repairing settings never assigns old unknown visits to it.
  attentionSampler.setScope((await resolveDoctorSettingsScope()).targetRepos);

  app.use(createHostGuard(config.allowedHosts));
  // After the host guard, so a request the dashboard refused to serve is not
  // counted as someone reading the page.
  app.use((req, _res, next) => {
    if (isAttentionDocumentLoad(req.method, req.path, req.get("Accept"))) {
      attentionSampler.countDocumentLoad();
    }
    next();
  });
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

    // An operator reaches this endpoint precisely when the configuration is
    // broken, so a corrupt or unreadable settings.json must not replace the
    // report with an error. The report says which settings state produced the
    // scope instead, and reports no scope at all when the saved settings
    // cannot be read.
    const scope = await resolveDoctorSettingsScope();
    res.json(await readDoctorReport({
      stateRoot: config.stateRoot,
      apiUrl: config.coordApiUrl,
      token: config.coordApiToken,
      tokenEnvVar: config.coordApiTokenEnvVar,
      targetRepos: scope.targetRepos,
      settings: scope.settings
    }));
  });

  /**
   * The read-only attention view's only route.
   *
   * It is served to every allowed host, exactly like `GET /api/settings`: it
   * reads and returns, and never launches an agent or mutates a coordination
   * record. Nothing here calls GitHub — the reader is the only component that
   * makes a request, and it talks to the coordination API alone.
   *
   * The reader and the model never throw for data or backend problems, so a
   * repository that cannot be read is a 200 carrying its source status and
   * diagnostics. A thrown error is a defect, not a partial read, so it is the
   * only 5xx and reports no message or stack.
   */
  app.get("/api/attention", async (req, res) => {
    // The payload is a snapshot of moving state and the server-side cache is
    // already its freshness bound; a browser or proxy copy would only add a
    // second, invisible one.
    res.set("Cache-Control", "no-store");
    try {
      const bypassCache = canBypassAttentionCache(req.get("X-Dashboard-Refresh"), req.socket.remoteAddress);
      if (bypassCache && req.method === "GET") {
        // The only foreground refresh the view sends is the operator asking for
        // one, so it is a return to the page exactly as a document load is. A
        // poll never reaches here: it sends no bypass header.
        attentionSampler.countDocumentLoad();
      }
      res.json(await readAttentionPayload(bypassCache));
    } catch {
      res.status(500).json({ error: "Attention payload could not be built." });
    }
  });

  app.get("/api/settings", async (_req, res) => {
    res.json(await readDashboardSettings(persistedSettingsPath, { targetRepos: config.targetRepos }));
  });

  app.put("/api/settings", async (req, res) => {
    if (!isMachineLocalAddress(req.socket.remoteAddress, options.machineInterfaces)) {
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
    // Only a write that actually landed changes the scope; a rejected
    // authorization or an invalid body returns above and leaves the cache
    // alone.
    invalidateAttentionScope();
    attentionSampler.setScope(saved.targetRepos);
    res.json(saved);
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

  // Last, so nothing can fire a sample against a half-built app. The render
  // path still schedules nothing: this is the one timer the dashboard runs, and
  // it is the sampling job, not a cache refresh.
  if (options.attentionSampler !== false) {
    attentionSampler.start();
  }

  return app;
}
