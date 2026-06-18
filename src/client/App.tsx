import { useEffect, useMemo, useState } from "react";
import { generatePrBatchPrompt } from "../shared/prompt";
import type { DashboardModel } from "../shared/types";
import { fetchDashboard } from "./api";
import { BatchesTab } from "./components/BatchesTab";
import { MachinesTab } from "./components/MachinesTab";
import { PromptDrawer } from "./components/PromptDrawer";
import { WorkTab } from "./components/WorkTab";

type Tab = "machines" | "work" | "batches";

export function App() {
  const [dashboard, setDashboard] = useState<DashboardModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("machines");

  useEffect(() => {
    fetchDashboard()
      .then(setDashboard)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Dashboard failed to load");
      });
  }, []);

  const prompt = useMemo(() => generatePrBatchPrompt(dashboard?.workItems || []), [dashboard]);

  function toggleWorkItem(id: string) {
    setDashboard((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        workItems: current.workItems.map((item) =>
          item.id === id && item.schedulingState !== "in_process" ? { ...item, selected: !item.selected } : item
        )
      };
    });
  }

  if (error) {
    return <main className="app-shell error-state">{error}</main>;
  }

  if (!dashboard) {
    return <main className="app-shell loading-state">Loading coordination dashboard...</main>;
  }

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
          <span>{dashboard.warnings.length} warnings</span>
          <span>{new Date(dashboard.generatedAt).toLocaleTimeString()}</span>
        </div>
      </header>

      {dashboard.warnings.length > 0 && (
        <section className="warnings-panel" aria-label="Coordination warnings">
          <div className="warnings-heading">Warnings</div>
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
          </nav>

          {activeTab === "machines" && <MachinesTab agents={dashboard.agents} />}
          {activeTab === "work" && <WorkTab items={dashboard.workItems} onToggle={toggleWorkItem} />}
          {activeTab === "batches" && <BatchesTab batches={dashboard.batches} />}
        </section>

        <PromptDrawer prompt={prompt} />
      </div>
    </main>
  );
}
