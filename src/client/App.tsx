import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { generatePrBatchPrompt } from "../shared/prompt";
import type { BatchRecord, CoordinationResource, CoordinationWarning, DashboardModel, DashboardSettings } from "../shared/types";
import { fetchDashboard, fetchSettings, requestBatchStop, saveImportedBatchManifest, saveSettings } from "./api";
import { BatchesTab } from "./components/BatchesTab";
import { HealthTab } from "./components/HealthTab";
import { MachinesTab } from "./components/MachinesTab";
import { OperatorView } from "./components/OperatorView";
import { OverviewTab } from "./components/OverviewTab";
import { PromptDrawer } from "./components/PromptDrawer";
import { SignalGroupList } from "./components/SignalGroups";
import { WorkTab } from "./components/WorkTab";
import {
  hasStructuredOperatorDeepLink,
  operatorDeepLinkFromSearchParams,
  savedOlderTerminalWorkPreference,
  SHOW_OLDER_TERMINAL_WORK_STORAGE_KEY,
  type OperatorDeepLink,
  type OverviewOperatorFilter
} from "./operatorRows";
import { groupWarnings } from "./signalGroups";

type Tab = "overview" | "operator" | "work" | "batches" | "machines" | "health";
type WorkItem = DashboardModel["workItems"][number];
const MIN_BACKGROUND_REFRESH_TIMEOUT_MS = 4000;
const BACKGROUND_REFRESH_TIMEOUT_GRACE_MS = 1000;

export function backgroundRefreshTimeoutMs(refreshIntervalMs: number): number {
  const intervalMs = Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0 ? refreshIntervalMs : 0;
  return Math.max(MIN_BACKGROUND_REFRESH_TIMEOUT_MS, intervalMs + BACKGROUND_REFRESH_TIMEOUT_GRACE_MS);
}

function readOperatorDeepLink() {
  return operatorDeepLinkFromSearchParams(new URLSearchParams(window.location.search));
}

export function operatorDeepLinkForOverviewFilter(filter: OverviewOperatorFilter, query: string): OperatorDeepLink {
  return { overviewFilter: filter, query: query || undefined };
}

function writeOperatorLocation(deepLink: OperatorDeepLink, query: string, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  for (const key of ["batch", "lane", "repo", "target", "operatorFilter", "q"]) {
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
  const [operatorDeepLink, setOperatorDeepLink] = useState(readOperatorDeepLink);
  const [operatorQuery, setOperatorQuery] = useState(operatorDeepLink.query || "");
  const [activeTab, setActiveTab] = useState<Tab>(() =>
    operatorDeepLink.query || hasStructuredOperatorDeepLink(operatorDeepLink) ? "operator" : "overview"
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [revealOlderTerminalRows, setRevealOlderTerminalRows] = useState(savedOlderTerminalWorkPreference);
  const backgroundLoadInFlight = useRef(false);
  const userActionInFlightCount = useRef(0);
  const userActionQueue = useRef<Promise<void>>(Promise.resolve());
  const dashboardRequestVersion = useRef(0);

  const prompt = useMemo(() => generatePrBatchPrompt(dashboard?.workItems || []), [dashboard]);
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
    try {
      window.localStorage.setItem(SHOW_OLDER_TERMINAL_WORK_STORAGE_KEY, String(revealOlderTerminalRows));
    } catch {
      // The in-memory App preference still works when browser storage is unavailable.
    }
  }, [revealOlderTerminalRows]);

  useEffect(() => {
    function restoreLocation() {
      const nextDeepLink = readOperatorDeepLink();
      setOperatorDeepLink(nextDeepLink);
      setOperatorQuery(nextDeepLink.query || "");
      setActiveTab((currentTab) => {
        if (currentTab !== "overview" && currentTab !== "operator") {
          return currentTab;
        }
        return nextDeepLink.query || hasStructuredOperatorDeepLink(nextDeepLink) ? "operator" : "overview";
      });
    }
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
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

  function openOverviewFilter(filter: OverviewOperatorFilter) {
    const nextDeepLink = operatorDeepLinkForOverviewFilter(filter, operatorQuery);
    setOperatorDeepLink(nextDeepLink);
    setActiveTab("operator");
    writeOperatorLocation(nextDeepLink, operatorQuery, "push");
  }

  function resetOverviewFilter() {
    const nextDeepLink = { ...operatorDeepLink, overviewFilter: undefined };
    setOperatorDeepLink(nextDeepLink);
    writeOperatorLocation(nextDeepLink, operatorQuery, "push");
  }

  function clearExactOperatorLink() {
    const nextDeepLink = {
      ...operatorDeepLink,
      batchId: undefined,
      laneName: undefined,
      repo: undefined,
      target: undefined
    };
    setOperatorDeepLink(nextDeepLink);
    writeOperatorLocation(nextDeepLink, operatorQuery, "push");
  }

  function updateOperatorQuery(query: string) {
    setOperatorQuery(query);
    const nextDeepLink = { ...operatorDeepLink, query: query || undefined };
    setOperatorDeepLink(nextDeepLink);
    writeOperatorLocation(nextDeepLink, query, "replace");
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
  const requiredResources = ["claims", "heartbeats", "batches"] as const;
  const allRequiredSourcesFailed = requiredResources.every((resource) => failedResources.has(resource));
  const coordinationDegraded = hasAuthenticationFailure || allRequiredSourcesFailed;
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
  const agentSources = ["claims", "heartbeats"] as const;
  const eventSources = ["events"] as const;
  const healthSources = ["claims", "heartbeats", "batches", "events"] as const;
  const warningsHeading = warningLabel === "warnings" ? "Warnings" : "Notices";
  const warningGroups = groupWarnings(dashboard.warnings);
  const visibleWarningGroups = warningGroups.slice(0, 3);
  const overflowWarningGroups = warningGroups.slice(3);
  const renderWarning = (warning: CoordinationWarning) => {
    const context = warning.repo ? `${warning.repo}${warning.target ? `#${warning.target}` : ""}` : undefined;
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
            · {dashboard.workItems.length} open or coordinated items
          </p>
        </div>
        <div className="summary-strip">
          <span title={failedSourceDetails(agentSources) || undefined}>
            {coordinationCount(dashboard.agents.length, agentSources)} agents
          </span>
          <span title={failedSourceDetails(eventSources) || undefined}>
            {coordinationCount(dashboard.events.length, eventSources)} events
          </span>
          <span title={failedSourceDetails(healthSources) || undefined}>
            {coordinationCount(dashboard.healthItems.length, healthSources)} health
          </span>
          <span>
            {dashboard.warnings.length} {warningLabel}
          </span>
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
                Coordination backend unreachable{degradedHttpStatus ? ` (${degradedHttpStatus})` : ""} — showing GitHub data only
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
        <section className="warnings-panel" aria-label={`Coordination ${warningLabel}`}>
          <div className="warnings-panel-summary">
            <span className="warnings-heading">{warningsHeading}</span>
            <span>
              {dashboard.warnings.length} {warningLabel}
            </span>
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
          <nav className="tabs" aria-label="Dashboard views">
            <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")} type="button">
              Overview
            </button>
            <button className={activeTab === "operator" ? "active" : ""} onClick={() => setActiveTab("operator")} type="button">
              Operator
            </button>
            <button className={activeTab === "work" ? "active" : ""} onClick={() => setActiveTab("work")} type="button">
              Work
            </button>
            <button className={activeTab === "batches" ? "active" : ""} onClick={() => setActiveTab("batches")} type="button">
              Batches
            </button>
            <button className={activeTab === "machines" ? "active" : ""} onClick={() => setActiveTab("machines")} type="button">
              Machines
            </button>
            <button className={activeTab === "health" ? "active" : ""} onClick={() => setActiveTab("health")} type="button">
              Health
            </button>
          </nav>

          {activeTab === "overview" && (
            <OverviewTab
              dashboard={dashboard}
              onOpenOperatorFilter={openOverviewFilter}
              onRevealOlderTerminalRowsChange={setRevealOlderTerminalRows}
              revealOlderTerminalRows={revealOlderTerminalRows}
            />
          )}
          {activeTab === "operator" && (
            <OperatorView
              dashboard={dashboard}
              deepLink={operatorDeepLink}
              onClearExactLink={clearExactOperatorLink}
              onQueryChange={updateOperatorQuery}
              onResetOverviewFilter={resetOverviewFilter}
              query={operatorQuery}
              onRevealOlderTerminalRowsChange={setRevealOlderTerminalRows}
              revealOlderTerminalRows={revealOlderTerminalRows}
            />
          )}
          {activeTab === "work" && <WorkTab items={dashboard.workItems} onToggle={toggleWorkItem} />}
          {activeTab === "machines" && <MachinesTab agents={dashboard.agents} />}
          {activeTab === "batches" && (
            <BatchesTab
              batches={dashboard.batches}
              events={dashboard.events}
              onImportBatch={importBatchManifest}
              onRequestStop={stopBatch}
              operations={dashboard.batchOperations}
            />
          )}
          {activeTab === "health" && <HealthTab items={dashboard.healthItems} />}
          <details className="prompt-drawer-shell">
            <summary>PR-batch prompt</summary>
            <PromptDrawer prompt={prompt} />
          </details>
        </section>
      </div>
    </main>
  );
}
