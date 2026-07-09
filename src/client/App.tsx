import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { generatePrBatchPrompt } from "../shared/prompt";
import type { BatchRecord, DashboardModel, DashboardSettings } from "../shared/types";
import { fetchDashboard, fetchSettings, requestBatchStop, saveImportedBatchManifest, saveSettings } from "./api";
import { BatchesTab } from "./components/BatchesTab";
import { HealthTab } from "./components/HealthTab";
import { MachinesTab } from "./components/MachinesTab";
import { OperatorView } from "./components/OperatorView";
import { OverviewTab } from "./components/OverviewTab";
import { PromptDrawer } from "./components/PromptDrawer";
import { WorkTab } from "./components/WorkTab";
import { operatorDeepLinkFromSearchParams } from "./operatorRows";

type Tab = "overview" | "work" | "batches" | "machines" | "health";
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
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const backgroundLoadInFlight = useRef(false);
  const userActionInFlightCount = useRef(0);
  const userActionQueue = useRef<Promise<void>>(Promise.resolve());
  const dashboardRequestVersion = useRef(0);

  const prompt = useMemo(() => generatePrBatchPrompt(dashboard?.workItems || []), [dashboard]);
  const operatorDeepLink = useMemo(readOperatorDeepLink, []);

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
  const warningsHeading = warningLabel === "warnings" ? "Warnings" : "Notices";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Agent Coordination</h1>
          <p>Coordination workspace · {dashboard.workItems.length} open or coordinated items</p>
          <details className="state-root-details">
            <summary>State root</summary>
            <code>{dashboard.stateRoot}</code>
          </details>
        </div>
        <div className="summary-strip">
          <span>{dashboard.agents.length} agents</span>
          <span>{dashboard.events.length} events</span>
          <span>{dashboard.healthItems.length} health</span>
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

      <section className="repo-filter" aria-label="Target repositories">
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
      </section>

      {dashboard.warnings.length > 0 && (
        <section className="warnings-panel" aria-label={`Coordination ${warningLabel}`}>
          <div className="warnings-heading">{warningsHeading}</div>
          <ul>
            {dashboard.warnings.map((warning, index) => (
              <li key={`${warning.message}-${index}`}>
                <strong>{warning.severity}</strong>
                <span>{warning.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="dashboard-layout">
        <section className="content-region">
          <OperatorView dashboard={dashboard} deepLink={operatorDeepLink} />

          <nav className="tabs" aria-label="Dashboard views">
            <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")} type="button">
              Overview
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

          {activeTab === "overview" && <OverviewTab dashboard={dashboard} />}
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
        </section>

        <PromptDrawer prompt={prompt} />
      </div>
    </main>
  );
}
