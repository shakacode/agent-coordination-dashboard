import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { generatePrBatchPrompt } from "../shared/prompt";
import type { DashboardModel, DashboardSettings } from "../shared/types";
import { fetchDashboard, fetchSettings, saveSettings } from "./api";
import { BatchesTab } from "./components/BatchesTab";
import { HealthTab } from "./components/HealthTab";
import { MachinesTab } from "./components/MachinesTab";
import { PromptDrawer } from "./components/PromptDrawer";
import { WorkTab } from "./components/WorkTab";

type Tab = "machines" | "work" | "batches" | "health";

export function App() {
  const [dashboard, setDashboard] = useState<DashboardModel | null>(null);
  const [settings, setSettings] = useState<DashboardSettings | null>(null);
  const [repoDraft, setRepoDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("machines");
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    void loadDashboard();
  }, []);

  const prompt = useMemo(() => generatePrBatchPrompt(dashboard?.workItems || []), [dashboard]);

  async function loadDashboard() {
    setError(null);
    setIsRefreshing(true);
    try {
      const loadedSettings = await fetchSettings();
      setSettings(loadedSettings);
      setDashboard(await fetchDashboard());
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Dashboard failed to load");
    } finally {
      setIsRefreshing(false);
    }
  }

  async function persistRepos(nextRepos: string[]) {
    setError(null);
    setIsRefreshing(true);
    try {
      const saved = await saveSettings({ targetRepos: nextRepos });
      setSettings(saved);
      setDashboard(await fetchDashboard());
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Settings failed to save");
    } finally {
      setIsRefreshing(false);
    }
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
          item.id === id && item.schedulingState !== "in_process" && !item.batchSignals?.length
            ? { ...item, selected: !item.selected }
            : item
        )
      };
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
          <p>
            {dashboard.stateRoot} · {dashboard.workItems.length} open or coordinated items
          </p>
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
          <nav className="tabs" aria-label="Dashboard views">
            <button className={activeTab === "machines" ? "active" : ""} onClick={() => setActiveTab("machines")} type="button">
              Machines
            </button>
            <button className={activeTab === "work" ? "active" : ""} onClick={() => setActiveTab("work")} type="button">
              Work
            </button>
            <button className={activeTab === "batches" ? "active" : ""} onClick={() => setActiveTab("batches")} type="button">
              Batches
            </button>
            <button className={activeTab === "health" ? "active" : ""} onClick={() => setActiveTab("health")} type="button">
              Health
            </button>
          </nav>

          {activeTab === "machines" && <MachinesTab agents={dashboard.agents} />}
          {activeTab === "work" && <WorkTab items={dashboard.workItems} onToggle={toggleWorkItem} />}
          {activeTab === "batches" && <BatchesTab batches={dashboard.batches} events={dashboard.events} />}
          {activeTab === "health" && <HealthTab items={dashboard.healthItems} />}
        </section>

        <PromptDrawer prompt={prompt} />
      </div>
    </main>
  );
}
