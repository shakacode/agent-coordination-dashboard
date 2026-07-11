import { Activity, AlertTriangle, CheckCircle2, GitPullRequest, PackageOpen } from "lucide-react";
import type { CoordinationWarning, DashboardModel, HealthItem, QaValidationItem, WorkItem } from "../../shared/types";
import {
  buildOperatorRows,
  filterOperatorRowsForOverview,
  type OperatorRow,
  type OverviewOperatorFilter
} from "../operatorRows";
import { groupHealthItems, groupWarnings } from "../signalGroups";
import { SignalGroupList } from "./SignalGroups";
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

export function OverviewTab({
  dashboard,
  onOpenOperatorFilter
}: {
  dashboard: DashboardModel;
  onOpenOperatorFilter: (filter: OverviewOperatorFilter) => void;
}) {
  const readyItems = dashboard.workItems.filter((item) => item.schedulingState === "ready_for_batch");
  const startedItems = dashboard.workItems.filter((item) => item.schedulingState === "started_not_processing");
  const activeItems = dashboard.workItems.filter((item) => item.schedulingState === "in_process");
  const attentionItems = dashboard.healthItems.filter((item) => item.severity !== "info");
  const batchRepairItems = dashboard.batches.filter((batch) => batch.source === "inferred" || !batch.launchPrompt);
  const missingQa = dashboard.qaValidations.filter((item) => item.status === "missing");
  const failedQa = dashboard.qaValidations.filter((item) => item.status === "failed");
  const activeQa = dashboard.qaValidations.filter((item) => item.status === "requested" || item.status === "in_progress");
  const stoppedBatches = dashboard.batchOperations.filter((operation) => operation.controlStatus !== "running");
  const operatorRows = buildOperatorRows(dashboard);
  const overviewRows: Record<OverviewOperatorFilter, OperatorRow[]> = {
    ready_for_batch: filterOperatorRowsForOverview(operatorRows, dashboard, "ready_for_batch"),
    needs_recovery: filterOperatorRowsForOverview(operatorRows, dashboard, "needs_recovery"),
    processing_now: filterOperatorRowsForOverview(operatorRows, dashboard, "processing_now"),
    qa_attention: filterOperatorRowsForOverview(operatorRows, dashboard, "qa_attention"),
    batch_repair: filterOperatorRowsForOverview(operatorRows, dashboard, "batch_repair")
  };
  const healthGroups = groupHealthItems(attentionItems);
  const warningGroups = groupWarnings(dashboard.warnings);
  const visibleHealthGroups = healthGroups.slice(0, 6);
  const visibleWarningGroups = warningGroups.slice(0, Math.max(0, 6 - visibleHealthGroups.length));
  const overflowHealthGroups = healthGroups.slice(visibleHealthGroups.length);
  const overflowWarningGroups = warningGroups.slice(visibleWarningGroups.length);
  const overflowTypeCount = overflowHealthGroups.length + overflowWarningGroups.length;
  const renderHealth = (item: HealthItem) => (
    <>
      <div>
        <strong>{item.title}</strong>
        <span>{item.detail}</span>
      </div>
      <StatusBadge value={item.severity} />
    </>
  );
  const renderWarning = (warning: CoordinationWarning) => (
    <>
      <div>
        <strong>{warning.repo ? `${warning.repo}${warning.target ? `#${warning.target}` : ""}` : "Warning"}</strong>
        <span>{warning.message}</span>
      </div>
      <StatusBadge value={warning.severity} />
    </>
  );

  return (
    <section className="overview-view">
      <section className="summary-cards" aria-label="Coordination summary">
        <button
          aria-label={`Show ${overviewRows.ready_for_batch.length} ready for batch rows in Operator view`}
          className="summary-card"
          onClick={() => onOpenOperatorFilter("ready_for_batch")}
          type="button"
        >
          <strong>{overviewRows.ready_for_batch.length} ready</strong>
          <span>Ready to batch</span>
        </button>
        <button
          aria-label={`Show ${overviewRows.needs_recovery.length} claimed, not processing rows in Operator view`}
          className="summary-card"
          onClick={() => onOpenOperatorFilter("needs_recovery")}
          type="button"
        >
          <strong>{overviewRows.needs_recovery.length} claimed</strong>
          <span>Not processing · recover</span>
        </button>
        <button
          aria-label={`Show ${overviewRows.processing_now.length} processing now rows in Operator view`}
          className="summary-card"
          onClick={() => onOpenOperatorFilter("processing_now")}
          type="button"
        >
          <strong>{overviewRows.processing_now.length} processing</strong>
          <span>Processing now</span>
        </button>
        <button
          aria-label={`Show ${overviewRows.qa_attention.length} QA attention rows in Operator view`}
          className="summary-card"
          onClick={() => onOpenOperatorFilter("qa_attention")}
          type="button"
        >
          <strong>{overviewRows.qa_attention.length} QA attention</strong>
          <span>Missing, failed, or active</span>
        </button>
        <button
          aria-label={`Show ${overviewRows.batch_repair.length} batch repair rows in Operator view`}
          className="summary-card"
          onClick={() => onOpenOperatorFilter("batch_repair")}
          type="button"
        >
          <strong>{overviewRows.batch_repair.length} batch repairs</strong>
          <span>Manifest, prompt, or stopped batch</span>
        </button>
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
            <div className="overview-attention-groups">
              <SignalGroupList ariaLabel="Health issues grouped by type" groups={visibleHealthGroups} renderItem={renderHealth} />
              <SignalGroupList ariaLabel="Warnings grouped by type" groups={visibleWarningGroups} renderItem={renderWarning} />
              {overflowTypeCount > 0 && (
                <details className="overview-attention-overflow">
                  <summary>
                    {overflowTypeCount} more {overflowTypeCount === 1 ? "type" : "types"}
                  </summary>
                  <SignalGroupList groups={overflowHealthGroups} renderItem={renderHealth} />
                  <SignalGroupList groups={overflowWarningGroups} renderItem={renderWarning} />
                </details>
              )}
            </div>
          )}
        </article>

        <article className="panel overview-panel">
          <header className="overview-panel-header">
            <Activity size={18} aria-hidden="true" />
            <h2>Current Work</h2>
          </header>
          {[...startedItems, ...activeItems].length === 0 ? (
            <p className="empty-state">No processing or claimed-but-idle work.</p>
          ) : (
            <div className="overview-list">
              {firstItems([...activeItems, ...startedItems]).map((item) => (
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
                    <span>{batch.source === "inferred" ? "Batch plan missing" : "Prompt missing"}</span>
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
