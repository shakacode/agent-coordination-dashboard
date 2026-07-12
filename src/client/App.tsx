import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { generatePrBatchPrompt } from "../shared/prompt";
import { displayAttribution, firstDisplayAttribution } from "../shared/attribution";
import { repoLessBatchLaneMatchesWorkItem } from "../shared/batchSignal";
import type { BatchOperation, BatchRecord, CoordinationResource, CoordinationWarning, DashboardModel, DashboardSettings } from "../shared/types";
import { fetchDashboard, fetchSettings, requestBatchStop, saveImportedBatchManifest, saveSettings } from "./api";
import { BatchesTab } from "./components/BatchesTab";
import { AttentionShell, type DashboardSurface } from "./components/AttentionShell";
import { HealthTab } from "./components/HealthTab";
import { MachinesTab } from "./components/MachinesTab";
import { PromptDrawer } from "./components/PromptDrawer";
import { SignalGroupList } from "./components/SignalGroups";
import {
  hasStructuredOperatorDeepLink,
  operatorDeepLinkFromSearchParams,
  type OperatorDeepLink,
  type OverviewOperatorFilter
} from "./operatorRows";
import { groupWarnings } from "./signalGroups";

type WorkItem = DashboardModel["workItems"][number];
const MIN_BACKGROUND_REFRESH_TIMEOUT_MS = 4000;
const BACKGROUND_REFRESH_TIMEOUT_GRACE_MS = 1000;
const REQUIRED_COORDINATION_RESOURCES: readonly CoordinationResource[] = ["claims", "heartbeats", "batches"];
const BATCH_ACTION_COORDINATION_RESOURCES: readonly CoordinationResource[] = [
  ...REQUIRED_COORDINATION_RESOURCES,
  "events"
];

function operationMatchesBatch(operation: BatchOperation, batch: BatchRecord, batches: BatchRecord[]): boolean {
  if (operation.batchPath) return operation.batchPath === batch.path;
  if (operation.batchId !== batch.batchId) return false;
  if (operation.repo) return operation.repo === batch.repo;
  return batches.filter((candidate) => candidate.batchId === operation.batchId).length === 1;
}

export function backgroundRefreshTimeoutMs(refreshIntervalMs: number): number {
  const intervalMs = Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0 ? refreshIntervalMs : 0;
  return Math.max(MIN_BACKGROUND_REFRESH_TIMEOUT_MS, intervalMs + BACKGROUND_REFRESH_TIMEOUT_GRACE_MS);
}

function readOperatorDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const parsed = operatorDeepLinkFromSearchParams(params);
  const legacyItem = params.get("item");
  const canonicalItem = legacyItem?.match(/^([^/#]+\/[^/#]+)#(\d+)$/);
  const deepLink = canonicalItem
    ? { ...parsed, repo: parsed.repo || canonicalItem[1], target: parsed.target || canonicalItem[2] }
    : legacyItem && /^#?\d+$/.test(legacyItem)
      ? { ...parsed, target: parsed.target || legacyItem.replace(/^#/, "") }
    : parsed;
  const arbitraryLegacyQuery = legacyItem && !canonicalItem && !/^#?\d+$/.test(legacyItem) ? legacyItem : undefined;
  return {
    ...deepLink,
    query: deepLink.query || arbitraryLegacyQuery
  };
}

function hasLegacyFindLink(): boolean {
  const params = new URLSearchParams(window.location.search);
  return Boolean(params.get("item") || params.get("q") || params.get("batch") || params.get("lane") || params.get("repo") || params.get("target"));
}

export function operatorDeepLinkForOverviewFilter(filter: OverviewOperatorFilter, query: string): OperatorDeepLink {
  return { overviewFilter: filter, query: query || undefined };
}

function writeOperatorLocation(deepLink: OperatorDeepLink, query: string, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  for (const key of ["batch", "lane", "repo", "target", "operatorFilter", "q", "item"]) {
    url.searchParams.delete(key);
  }
  const values = {
    batch: deepLink.batchId,
    lane: deepLink.laneName,
    repo: deepLink.repo,
    target: deepLink.target,
    operatorFilter: deepLink.overviewFilter,
    q: query || undefined
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  window.history[`${mode}State`]({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function canSelectWorkItem(item: WorkItem): boolean {
  return item.schedulingState !== "in_process" && !item.batchSignals?.length;
}

function preserveWorkItemSelections(current: DashboardModel | null, next: DashboardModel): DashboardModel {
  if (!current) {
    return next;
  }

  const selectedIds = new Set(current.workItems.filter((item) => item.selected && canSelectWorkItem(item)).map((item) => item.id));
  if (selectedIds.size === 0) {
    return next;
  }

  return {
    ...next,
    workItems: next.workItems.map((item) => (selectedIds.has(item.id) && canSelectWorkItem(item) ? { ...item, selected: true } : item))
  };
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardModel | null>(null);
  const [settings, setSettings] = useState<DashboardSettings | null>(null);
  const [repoDraft, setRepoDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [operatorDeepLink, setOperatorDeepLink] = useState<OperatorDeepLink>(readOperatorDeepLink);
  const [operatorQuery, setOperatorQuery] = useState(operatorDeepLink.query || "");
  const [activeSurface, setActiveSurface] = useState<DashboardSurface>(() =>
    operatorDeepLink.query || hasStructuredOperatorDeepLink(operatorDeepLink) || hasLegacyFindLink() ? "find" : "attention"
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [historyMergedTodayOnly, setHistoryMergedTodayOnly] = useState(false);
  const [batchDetailScope, setBatchDetailScope] = useState<"events" | "repairs" | "all">("all");
  const [diagnosticScope, setDiagnosticScope] = useState<"agents" | "health" | "all">("all");
  const backgroundLoadInFlight = useRef(false);
  const userActionInFlightCount = useRef(0);
  const userActionQueue = useRef<Promise<void>>(Promise.resolve());
  const dashboardRequestVersion = useRef(0);
  const batchOperationsRef = useRef<HTMLDetailsElement>(null);
  const diagnosticsRef = useRef<HTMLDetailsElement>(null);
  const warningsRef = useRef<HTMLElement>(null);

  const requiredCoordinationUnavailable = Boolean(
    dashboard?.sourceStatus?.some(
      (source) =>
        BATCH_ACTION_COORDINATION_RESOURCES.includes(source.resource) && ["auth_error", "unreachable"].includes(source.status)
    )
  );
  const prompt = useMemo(
    () => (requiredCoordinationUnavailable ? "" : generatePrBatchPrompt(dashboard?.workItems || [])),
    [dashboard, requiredCoordinationUnavailable]
  );
  const repairBatches = useMemo(() => {
    if (!dashboard) return [];
    const stopped = dashboard.batchOperations.filter((operation) => operation.controlStatus !== "running");
    return dashboard.batches.filter((batch) =>
      batch.source === "inferred"
      || !batch.launchPrompt
      || stopped.some((operation) => operationMatchesBatch(operation, batch, dashboard.batches))
    );
  }, [dashboard]);
  const repairOperations = useMemo(() => (dashboard?.batchOperations || []).filter((operation) =>
    operation.controlStatus !== "running"
    && (repairBatches.some((batch) => operationMatchesBatch(operation, batch, dashboard?.batches || []))
      || !(dashboard?.batches || []).some((batch) => operationMatchesBatch(operation, batch, dashboard?.batches || [])))
  ), [dashboard, repairBatches]);
  const orphanRepairOperations = repairOperations.filter((operation) => !repairBatches.some((batch) => operationMatchesBatch(operation, batch, dashboard?.batches || [])));
  const repairWorkItemIds = useMemo(() => new Set((dashboard?.workItems || []).filter((item) => repairBatches.some((batch) => {
    if (batch.repo && batch.repo !== item.repo) return false;
    if (batch.targets?.some((target) => target.target === item.target && (target.repo || batch.repo) === item.repo)) return true;
    if (batch.repo) {
      return batch.lanes.some((lane) => lane.targets.includes(item.target))
        && item.batchSignals?.some((signal) => signal.batchId === batch.batchId);
    }
    return repoLessBatchLaneMatchesWorkItem(batch, batch.batchId, item, dashboard?.workItems || []);
  })).map((item) => item.id)), [dashboard, repairBatches]);
  const repairBatchCount = dashboard
    ? repairBatches.length
      + orphanRepairOperations.length
    : 0;
  function beginUserAction() {
    userActionInFlightCount.current += 1;
    setIsRefreshing(true);
  }

  function finishUserAction() {
    userActionInFlightCount.current = Math.max(0, userActionInFlightCount.current - 1);
    if (userActionInFlightCount.current === 0) {
      setIsRefreshing(false);
    }
  }

  function enqueueUserAction<T>(action: () => Promise<T>): Promise<T> {
    beginUserAction();
    const run = userActionQueue.current.then(action, action).finally(finishUserAction);
    userActionQueue.current = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  const loadDashboard = useCallback(async (options: { background?: boolean; backgroundTimeoutMs?: number } = {}) => {
    const isBackground = Boolean(options.background);
    if (isBackground && (backgroundLoadInFlight.current || userActionInFlightCount.current > 0)) {
      return;
    }
    if (isBackground) {
      backgroundLoadInFlight.current = true;
    } else {
      setError(null);
      beginUserAction();
    }
    const abortController = isBackground ? new AbortController() : undefined;
    const timeoutId = abortController
      ? window.setTimeout(() => abortController.abort(), options.backgroundTimeoutMs ?? MIN_BACKGROUND_REFRESH_TIMEOUT_MS)
      : undefined;
    const requestVersion = ++dashboardRequestVersion.current;
    try {
      const [loadedSettings, loadedDashboard] = await Promise.all([
        fetchSettings({ signal: abortController?.signal }),
        fetchDashboard({ fresh: !isBackground, signal: abortController?.signal })
      ]);
      if (requestVersion !== dashboardRequestVersion.current) {
        return;
      }
      setSettings(loadedSettings);
      setDashboard((current) => (isBackground ? preserveWorkItemSelections(current, loadedDashboard) : loadedDashboard));
    } catch (caught: unknown) {
      if (!isBackground) {
        setError(caught instanceof Error ? caught.message : "Dashboard failed to load");
      }
    } finally {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      if (isBackground) {
        backgroundLoadInFlight.current = false;
      } else {
        finishUserAction();
      }
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("item")) {
      writeOperatorLocation(operatorDeepLink, operatorQuery, "replace");
    }
  }, []);

  useEffect(() => {
    function restoreLocation() {
      const nextDeepLink = readOperatorDeepLink();
      setOperatorDeepLink(nextDeepLink);
      setOperatorQuery(nextDeepLink.query || "");
      setActiveSurface(nextDeepLink.query || hasStructuredOperatorDeepLink(nextDeepLink) || hasLegacyFindLink() ? "find" : "attention");
    }
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, []);

  useEffect(() => {
    function openFind(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setActiveSurface("find");
      }
    }
    window.addEventListener("keydown", openFind);
    return () => window.removeEventListener("keydown", openFind);
  }, []);

  useEffect(() => {
    const refreshIntervalMs = settings?.refreshIntervalMs || 0;
    if (refreshIntervalMs <= 0) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void loadDashboard({ background: true, backgroundTimeoutMs: backgroundRefreshTimeoutMs(refreshIntervalMs) });
    }, refreshIntervalMs);

    return () => window.clearInterval(intervalId);
  }, [loadDashboard, settings?.refreshIntervalMs]);

  async function persistRepos(nextRepos: string[]) {
    return enqueueUserAction(async () => {
      const requestVersion = ++dashboardRequestVersion.current;
      setError(null);
      try {
        const saved = await saveSettings({ targetRepos: nextRepos });
        if (requestVersion === dashboardRequestVersion.current) {
          setSettings(saved);
        }
        const loadedDashboard = await fetchDashboard({ fresh: true });
        if (requestVersion === dashboardRequestVersion.current) {
          setDashboard(loadedDashboard);
        }
      } catch (caught: unknown) {
        setError(caught instanceof Error ? caught.message : "Settings failed to save");
      }
    });
  }

  function addRepo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextRepo = repoDraft.trim();
    if (!nextRepo || settings?.targetRepos.includes(nextRepo)) {
      return;
    }
    setRepoDraft("");
    void persistRepos([...(settings?.targetRepos || []), nextRepo]);
  }

  function removeRepo(repo: string) {
    const remaining = (settings?.targetRepos || []).filter((item) => item !== repo);
    if (remaining.length > 0) {
      void persistRepos(remaining);
    }
  }

  function toggleWorkItem(id: string) {
    if (requiredCoordinationUnavailable) {
      return;
    }
    setDashboard((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        workItems: current.workItems.map((item) =>
          item.id === id && canSelectWorkItem(item)
            ? { ...item, selected: !item.selected }
            : item
        )
      };
    });
  }

  function updateOperatorQuery(query: string) {
    setOperatorQuery(query);
    const startingUniversalSearch = activeSurface === "find" && hasStructuredOperatorDeepLink(operatorDeepLink);
    const nextDeepLink = startingUniversalSearch
      ? { query: query || undefined }
      : { ...operatorDeepLink, query: query || undefined };
    setOperatorDeepLink(nextDeepLink);
    writeOperatorLocation(nextDeepLink, query, "replace");
  }

  function openSurface(surface: DashboardSurface) {
    setHistoryMergedTodayOnly(false);
    setActiveSurface(surface);
  }

  function clearOperatorConstraints() {
    const nextDeepLink = { query: operatorQuery || undefined };
    setOperatorDeepLink(nextDeepLink);
    writeOperatorLocation(nextDeepLink, operatorQuery, "replace");
  }

  function showMergedToday() {
    setOperatorQuery("");
    setHistoryMergedTodayOnly(true);
    setActiveSurface("history");
  }

  function openDetails(details: RefObject<HTMLDetailsElement | null>) {
    if (details.current) {
      details.current.open = true;
      details.current.scrollIntoView?.({ block: "start" });
    }
  }

  function openBatchDetails(scope: "events" | "repairs" | "all") {
    setBatchDetailScope(scope);
    openDetails(batchOperationsRef);
  }

  function openDiagnostics(scope: "agents" | "health" | "all") {
    setDiagnosticScope(scope);
    openDetails(diagnosticsRef);
  }

  function showAllWorkItems() {
    const nextDeepLink: OperatorDeepLink = {};
    setOperatorQuery("");
    setOperatorDeepLink(nextDeepLink);
    setActiveSurface("find");
    writeOperatorLocation(nextDeepLink, "", "replace");
  }

  function revealWarnings() {
    if (!warningsRef.current) {
      openDiagnostics("health");
      return;
    }
    warningsRef.current.querySelectorAll("details").forEach((details) => {
      details.open = true;
    });
    warningsRef.current.scrollIntoView?.({ block: "start" });
  }

  function copyResumePrompt(item: WorkItem) {
    const branch = item.claim?.branch || item.heartbeat?.branch;
    const prompt = `$pr-batch\nResume ${item.repo}#${item.target}${branch ? ` on ${branch}` : ""}. Verify current coordination state before edits.`;
    void navigator.clipboard?.writeText(prompt);
  }

  async function importBatchManifest(manifest: Partial<BatchRecord>) {
    return enqueueUserAction(async () => {
      const requestVersion = ++dashboardRequestVersion.current;
      try {
        await saveImportedBatchManifest(manifest);
        const loadedDashboard = await fetchDashboard({ fresh: true });
        if (requestVersion === dashboardRequestVersion.current) {
          setDashboard(loadedDashboard);
        }
      } catch (caught: unknown) {
        throw caught instanceof Error ? caught : new Error("Batch plan import failed");
      }
    });
  }

  async function stopBatch(input: { batchId: string; repo?: string; reason?: string }) {
    return enqueueUserAction(async () => {
      const requestVersion = ++dashboardRequestVersion.current;
      try {
        await requestBatchStop(input);
        const loadedDashboard = await fetchDashboard({ fresh: true });
        if (requestVersion === dashboardRequestVersion.current) {
          setDashboard(loadedDashboard);
        }
      } catch (caught: unknown) {
        throw caught instanceof Error ? caught : new Error("Batch stop request failed");
      }
    });
  }

  if (error) {
    return <main className="app-shell error-state">{error}</main>;
  }

  if (!dashboard || !settings) {
    return <main className="app-shell loading-state">Loading coordination dashboard...</main>;
  }

  const warningLabel = dashboard.warnings.some((warning) => warning.severity !== "info") ? "warnings" : "notices";
  const sourceFailures = (dashboard.sourceStatus || []).filter((source) =>
    ["auth_error", "unreachable"].includes(source.status)
  );
  const coordinationSourceError = sourceFailures.length > 0;
  const failedResources = new Set(sourceFailures.map((source) => source.resource));
  const hasAuthenticationFailure = sourceFailures.some((source) => source.status === "auth_error");
  const requiredResources = REQUIRED_COORDINATION_RESOURCES;
  const allRequiredSourcesFailed = requiredResources.every((resource) => failedResources.has(resource));
  const hasRequiredSourceFailure = requiredResources.some((resource) => failedResources.has(resource));
  const coordinationDegraded = hasAuthenticationFailure || hasRequiredSourceFailure;
  const filesystemOutage = coordinationDegraded && sourceFailures.every((source) => source.mode === "fs");
  const failedHttpStatuses = Array.from(
    new Set(sourceFailures.flatMap((source) => (source.httpStatus === undefined ? [] : [source.httpStatus])))
  );
  const degradedHttpStatus = failedHttpStatuses.length === 1 ? failedHttpStatuses[0] : undefined;
  const failedSourceDetails = (resources: readonly CoordinationResource[]) =>
    sourceFailures
      .filter((source) => resources.includes(source.resource))
      .map((source) => `${source.resource}: ${source.status}${source.httpStatus ? ` (${source.httpStatus})` : ""}`)
      .join("; ");
  const coordinationCount = (count: number, resources: readonly CoordinationResource[]) =>
    resources.some((resource) => failedResources.has(resource)) ? "—" : String(count);
  const agentSources = ["claims", "heartbeats", "events"] as const;
  const eventSources = ["events"] as const;
  const healthSources = ["claims", "heartbeats", "batches", "events"] as const;
  const unavailableSources = (resources: readonly CoordinationResource[]) =>
    resources.filter((resource) => failedResources.has(resource));
  const warningsHeading = warningLabel === "warnings" ? "Warnings" : "Notices";
  const warningGroups = groupWarnings(dashboard.warnings);
  const visibleWarningGroups = warningGroups.slice(0, 3);
  const overflowWarningGroups = warningGroups.slice(3);
  const renderWarning = (warning: CoordinationWarning) => {
    const repo = displayAttribution(warning.repo);
    const target = displayAttribution(warning.target);
    const context = repo !== "unattributed" ? `${repo}${target !== "unattributed" ? `#${target}` : ""}` : undefined;
    return (
      <>
        <strong>{warning.severity}</strong>
        <span>{context ? `${context}: ${warning.message}` : warning.message}</span>
      </>
    );
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Agent Coordination</h1>
          <p>
            {coordinationSourceError ? (
              <span className="source-chip source-chip-error">{dashboard.stateRoot}</span>
            ) : (
              dashboard.stateRoot
            )}{" "}
            · <button className="inline-count" onClick={showAllWorkItems} type="button">{dashboard.workItems.length} open or coordinated items</button>
          </p>
        </div>
        <div className="summary-strip">
          <button className="summary-count" disabled={dashboard.agents.length === 0 || agentSources.some((resource) => failedResources.has(resource))} onClick={() => openDiagnostics("agents")} title={failedSourceDetails(agentSources) || undefined} type="button">
            {coordinationCount(dashboard.agents.length, agentSources)} agents
          </button>
          <button className="summary-count" disabled={dashboard.events.length === 0 || eventSources.some((resource) => failedResources.has(resource))} onClick={() => openBatchDetails("events")} title={failedSourceDetails(eventSources) || undefined} type="button">
            {coordinationCount(dashboard.events.length, eventSources)} events
          </button>
          <button className="summary-count" disabled={dashboard.healthItems.length === 0 || healthSources.some((resource) => failedResources.has(resource))} onClick={() => openDiagnostics("health")} title={failedSourceDetails(healthSources) || undefined} type="button">
            {coordinationCount(dashboard.healthItems.length, healthSources)} health
          </button>
          <button className="summary-count" disabled={dashboard.warnings.length === 0} onClick={revealWarnings} type="button">
            {dashboard.warnings.length} {warningLabel}
          </button>
          <span>{new Date(dashboard.generatedAt).toLocaleTimeString()}</span>
          <button
            aria-label="Refresh dashboard"
            className="icon-button"
            disabled={isRefreshing}
            onClick={() => void loadDashboard()}
            title="Refresh"
            type="button"
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {coordinationDegraded && (
        <section aria-label="Coordination backend degraded" className="coordination-degraded-banner" role="alert">
          {filesystemOutage ? (
            <>
              <strong>Coordination state files unavailable — some dashboard data is unavailable</strong>
              <span>
                Check <code>AGENT_COORD_STATE_ROOT</code> permissions and state-file integrity, then refresh.
              </span>
            </>
          ) : hasAuthenticationFailure ? (
            <>
              <strong>
                {allRequiredSourcesFailed ? "Coordination backend unreachable" : "Coordination authentication failed"}
                {degradedHttpStatus ? ` (${degradedHttpStatus})` : ""} — {allRequiredSourcesFailed
                  ? "showing GitHub data only"
                  : "some coordination data is unavailable"}
              </strong>
              <span>
                Token source: {dashboard.coordinationTokenEnvVar || "no token environment variable found"}. Run{" "}
                <code>agent-coord doctor --deep</code> to diagnose and re-provision access.
              </span>
            </>
          ) : (
            <>
              <strong>
                Coordination backend unreachable{degradedHttpStatus ? ` (${degradedHttpStatus})` : ""} — some dashboard data is unavailable
              </strong>
              <span>
                Run <code>agent-coord doctor --deep</code> to inspect backend connectivity, then refresh.
              </span>
            </>
          )}
          <a href="/api/doctor" rel="noreferrer" target="_blank">
            Details
          </a>
        </section>
      )}

      <details className="repo-filter" aria-label="Target repositories">
        <summary>
          <span>Target repositories</span>
          <span>{settings.targetRepos.length} configured</span>
        </summary>
        <div className="repo-filter-body">
          <div className="repo-chips">
            {settings.targetRepos.map((repo) => (
              <span className="repo-chip" key={repo}>
                {repo}
                <button
                  aria-label={`Remove ${repo}`}
                  disabled={settings.targetRepos.length === 1 || isRefreshing}
                  onClick={() => removeRepo(repo)}
                  title={`Remove ${repo}`}
                  type="button"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
          <form className="repo-add-form" onSubmit={addRepo}>
            <input
              aria-label="Add target repository"
              onChange={(event) => setRepoDraft(event.target.value)}
              placeholder="owner/repo"
              value={repoDraft}
            />
            <button aria-label="Add repository" disabled={isRefreshing} title="Add repository" type="submit">
              <Plus size={16} aria-hidden="true" />
            </button>
          </form>
        </div>
      </details>

      {dashboard.warnings.length > 0 && (
        <section className="warnings-panel" aria-label={`Coordination ${warningLabel}`} ref={warningsRef}>
          <div className="warnings-panel-summary">
            <span className="warnings-heading">{warningsHeading}</span>
            <button className="inline-count" onClick={revealWarnings} type="button">
              {dashboard.warnings.length} {warningLabel}
            </button>
          </div>
          <SignalGroupList
            ariaLabel={`Coordination ${warningLabel} grouped by type`}
            groups={visibleWarningGroups}
            renderItem={renderWarning}
          />
          {overflowWarningGroups.length > 0 && (
            <details className="warnings-overflow">
              <summary>
                {overflowWarningGroups.length} more {overflowWarningGroups.length === 1 ? "type" : "types"}
              </summary>
              <SignalGroupList groups={overflowWarningGroups} renderItem={renderWarning} />
            </details>
          )}
        </section>
      )}

      <div className="dashboard-layout">
        <section className="content-region">
          <nav className="surface-nav" aria-label="Dashboard surfaces">
            {(["attention", "now", "find", "history"] as const).map((surface) => (
              <button className={activeSurface === surface ? "active" : ""} key={surface} onClick={() => openSurface(surface)} type="button">
                {surface[0].toUpperCase()}{surface.slice(1)}
              </button>
            ))}
          </nav>
          <AttentionShell
            items={dashboard.workItems}
            deepLink={operatorDeepLink}
            historyMergedTodayOnly={historyMergedTodayOnly}
            mergeTimeStatus={dashboard.githubMergeTimeStatus || "unavailable"}
            now={dashboard.generatedAt}
            onCopyResume={copyResumePrompt}
            onQueryChange={updateOperatorQuery}
            onOpenBatchOperations={() => openBatchDetails(operatorDeepLink.overviewFilter === "batch_repair" ? "repairs" : "all")}
            onClearDeepLink={clearOperatorConstraints}
            onShowMergedToday={showMergedToday}
            onSurfaceChange={openSurface}
            onToggle={toggleWorkItem}
            query={operatorQuery}
            repairBatchCount={repairBatchCount}
            repairWorkItemIds={repairWorkItemIds}
            selectionDisabled={requiredCoordinationUnavailable}
            surface={activeSurface}
          />
          <details className="prompt-drawer-shell">
            <summary>PR-batch prompt</summary>
            <PromptDrawer disabled={requiredCoordinationUnavailable} prompt={prompt} />
          </details>
          <details className="secondary-tools" ref={batchOperationsRef}>
            <summary>{batchDetailScope === "events" ? "Event records" : batchDetailScope === "repairs" ? "Batch repairs" : "Batch operations"}</summary>
            {batchDetailScope === "events" ? (
              <>
                <button className="secondary-action" onClick={() => setBatchDetailScope("all")} type="button">Show all batch operations</button>
                <section aria-label="Event records" className="event-list">
                  {dashboard.events.map((event) => {
                    const repo = displayAttribution(event.repo);
                    const target = displayAttribution(event.target);
                    return <article className="event-row" key={`${event.path}:${event.eventId}`}><strong>{event.type}</strong><span>{repo}{target === "unattributed" ? "" : `#${target}`}</span><span>{displayAttribution(event.batchId, "unbatched")}</span><span>{firstDisplayAttribution([event.laneName, event.agentId])}</span><time>{event.timestamp || event.path}</time></article>;
                  })}
                </section>
              </>
            ) : (
              <BatchesTab
                batches={batchDetailScope === "repairs" ? repairBatches : dashboard.batches}
                events={batchDetailScope === "repairs" ? dashboard.events.filter((event) => repairBatches.some((batch) => event.batchPath ? event.batchPath === batch.path : event.batchId === batch.batchId && Boolean(event.repo && event.repo === batch.repo))) : dashboard.events}
                onImportBatch={importBatchManifest}
                onRequestStop={stopBatch}
                operations={batchDetailScope === "repairs" ? repairOperations : dashboard.batchOperations}
              />
            )}
            {batchDetailScope === "repairs" && orphanRepairOperations.length > 0 ? (
              <section aria-label="Orphan repair operations" className="event-list">
                {orphanRepairOperations.map((operation) => <article className="event-row" key={`${operation.batchPath || operation.repo || "unscoped"}:${operation.batchId}`}><strong>{operation.controlStatus}</strong><span>{displayAttribution(operation.repo || operation.batchPath)}</span><span>{displayAttribution(operation.batchId)}</span><span>{operation.eventCount} events</span><time>{operation.latestEventAt || "time unavailable"}</time></article>)}
              </section>
            ) : null}
          </details>
          <details className="secondary-tools" ref={diagnosticsRef}>
            <summary>{diagnosticScope === "agents" ? "Agents" : diagnosticScope === "health" ? "Health" : "Machines and health"}</summary>
            {diagnosticScope !== "health" ? <MachinesTab agents={dashboard.agents} unavailableSources={unavailableSources(agentSources)} /> : null}
            {diagnosticScope !== "agents" ? <HealthTab items={dashboard.healthItems} unavailableSources={unavailableSources(healthSources)} /> : null}
          </details>
        </section>
      </div>
    </main>
  );
}
