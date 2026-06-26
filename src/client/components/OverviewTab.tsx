import { Activity, AlertTriangle, CheckCircle2, GitPullRequest, PackageOpen } from "lucide-react";
import type { DashboardModel, QaValidationItem, WorkItem } from "../../shared/types";
import { StatusBadge } from "./StatusBadge";

function workTitle(item: WorkItem): string {
  const kind = item.type === "pull_request" ? "PR" : item.type === "issue" ? "Issue" : "Target";
  return `${kind} #${item.target}: ${item.github?.title || "UNKNOWN title"}`;
}

function qaTitle(item: QaValidationItem): string {
  return `PR #${item.target}: ${item.title || "UNKNOWN title"}`;
}

function firstItems<T>(items: T[], count = 6): T[] {
  return items.slice(0, count);
}

export function OverviewTab({ dashboard }: { dashboard: DashboardModel }) {
  const readyItems = dashboard.workItems.filter((item) => item.schedulingState === "ready_for_batch");
  const startedItems = dashboard.workItems.filter((item) => item.schedulingState === "started_not_processing");
  const activeItems = dashboard.workItems.filter((item) => item.schedulingState === "in_process");
  const attentionItems = dashboard.healthItems.filter((item) => item.severity !== "info");
  const batchRepairItems = dashboard.batches.filter((batch) => batch.source === "inferred" || !batch.launchPrompt);
  const missingQa = dashboard.qaValidations.filter((item) => item.status === "missing");
  const failedQa = dashboard.qaValidations.filter((item) => item.status === "failed");
  const activeQa = dashboard.qaValidations.filter((item) => item.status === "requested" || item.status === "in_progress");
  const stoppedBatches = dashboard.batchOperations.filter((operation) => operation.controlStatus !== "running");

  return (
    <section className="overview-view">
      <section className="summary-cards" aria-label="Coordination summary">
        <article className="summary-card">
          <strong>{readyItems.length} ready</strong>
          <span>Ready to batch</span>
        </article>
        <article className="summary-card">
          <strong>{startedItems.length} started</strong>
          <span>Needs recovery</span>
        </article>
        <article className="summary-card">
          <strong>{activeItems.length} active</strong>
          <span>Processing now</span>
        </article>
        <article className="summary-card">
          <strong>{missingQa.length} missing QA</strong>
          <span>Separate validation</span>
        </article>
        <article className="summary-card">
          <strong>{batchRepairItems.length} batch repairs</strong>
          <span>Manifest or prompt</span>
        </article>
      </section>

      <section className="overview-grid">
        <article className="panel overview-panel">
          <header className="overview-panel-header">
            <AlertTriangle size={18} aria-hidden="true" />
            <h2>Needs Attention</h2>
          </header>
          {attentionItems.length === 0 && dashboard.warnings.length === 0 ? (
            <p className="empty-state">No warning-level coordination issues.</p>
          ) : (
            <div className="overview-list">
              {firstItems(attentionItems).map((item) => (
                <div className="overview-row" key={item.id}>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </div>
                  <StatusBadge value={item.severity} />
                </div>
              ))}
              {firstItems(dashboard.warnings, Math.max(0, 6 - attentionItems.length)).map((warning, index) => (
                <div className="overview-row" key={`${warning.message}-${index}`}>
                  <div>
                    <strong>{warning.repo ? `${warning.repo}${warning.target ? `#${warning.target}` : ""}` : "Warning"}</strong>
                    <span>{warning.message}</span>
                  </div>
                  <StatusBadge value={warning.severity} />
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="panel overview-panel">
          <header className="overview-panel-header">
            <Activity size={18} aria-hidden="true" />
            <h2>Active Now</h2>
          </header>
          {[...startedItems, ...activeItems].length === 0 ? (
            <p className="empty-state">No active or recoverable work.</p>
          ) : (
            <div className="overview-list">
              {firstItems([...startedItems, ...activeItems]).map((item) => (
                <div className="overview-row" key={item.id}>
                  <div>
                    <strong>{workTitle(item)}</strong>
                    <span>{item.claim?.agentId || item.heartbeat?.agentId || item.batchSignals?.[0]?.laneName || "Unassigned"}</span>
                  </div>
                  <StatusBadge value={item.schedulingState} />
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="panel overview-panel">
          <header className="overview-panel-header">
            <PackageOpen size={18} aria-hidden="true" />
            <h2>Batch Repair</h2>
          </header>
          {batchRepairItems.length === 0 && stoppedBatches.length === 0 ? (
            <p className="empty-state">No batch repair items.</p>
          ) : (
            <div className="overview-list">
              {firstItems(batchRepairItems).map((batch) => (
                <div className="overview-row" key={`${batch.repo || batch.path}:${batch.batchId}`}>
                  <div>
                    <strong>{batch.batchId}</strong>
                    <span>{batch.source === "inferred" ? "Batch manifest missing" : "Prompt missing"}</span>
                  </div>
                  <StatusBadge value="warning" />
                </div>
              ))}
              {firstItems(stoppedBatches, Math.max(0, 6 - batchRepairItems.length)).map((operation) => (
                <div className="overview-row" key={`${operation.repo || operation.batchPath}:${operation.batchId}`}>
                  <div>
                    <strong>{operation.batchId}</strong>
                    <span>{operation.latestEventType || operation.controlStatus}</span>
                  </div>
                  <StatusBadge value={operation.controlStatus} />
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="panel overview-panel">
          <header className="overview-panel-header">
            <CheckCircle2 size={18} aria-hidden="true" />
            <h2>QA Validation</h2>
          </header>
          {[...failedQa, ...missingQa, ...activeQa].length === 0 ? (
            <p className="empty-state">No separate QA gaps for PRs.</p>
          ) : (
            <div className="overview-list">
              {firstItems([...failedQa, ...missingQa, ...activeQa]).map((item) => (
                <div className="overview-row" key={item.id}>
                  <div>
                    <strong>{qaTitle(item)}</strong>
                    <span>{item.batchId ? `${item.batchId}${item.laneName ? `:${item.laneName}` : ""}` : item.repo}</span>
                  </div>
                  <StatusBadge value={item.status} />
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="panel overview-panel overview-wide">
          <header className="overview-panel-header">
            <GitPullRequest size={18} aria-hidden="true" />
            <h2>Ready To Batch</h2>
          </header>
          {readyItems.length === 0 ? (
            <p className="empty-state">No ready work items.</p>
          ) : (
            <div className="overview-list">
              {firstItems(readyItems, 10).map((item) => (
                <div className="overview-row" key={item.id}>
                  <div>
                    <strong>{workTitle(item)}</strong>
                    <span>{item.repo}</span>
                  </div>
                  <StatusBadge value={item.schedulingState} />
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
    </section>
  );
}
