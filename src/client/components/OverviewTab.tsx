import { useMemo } from "react";
import { Activity, AlertTriangle, CheckCircle2, GitPullRequest, PackageOpen } from "lucide-react";
import type { CoordinationResource, CoordinationWarning, DashboardModel, HealthItem, QaValidationItem } from "../../shared/types";
import {
  buildOperatorRows,
  filterOperatorRowsByProvenance,
  filterOperatorRowsByAge,
  filterOperatorRowsForOverview,
  isTerminalRowEligibleForAgeOut,
  operatorActivityLabel,
  safeGithubUrl,
  UNKNOWN,
  type OperatorRow,
  type OverviewOperatorFilter
} from "../operatorRows";
import { groupHealthItems, groupWarnings } from "../signalGroups";
import { SignalGroupList } from "./SignalGroups";
import { StatusBadge } from "./StatusBadge";

function operatorRowTitle(row: OperatorRow): string {
  const kind = row.type === "pull_request" ? "PR" : row.type === "issue" ? "Issue" : "Target";
  return `${kind} #${row.target || UNKNOWN}: ${row.title}`;
}

function OperatorRowLink({ row }: { row: OperatorRow }) {
  const title = operatorRowTitle(row);
  const href = safeGithubUrl(row.url);
  return href ? (
    <a href={href} rel="noreferrer" target="_blank">
      <strong>{title}</strong>
    </a>
  ) : (
    <strong>{title}</strong>
  );
}

function qaValidationScope(item: QaValidationItem): string {
  const scope = item.batchId ? `${item.batchId}${item.laneName ? `:${item.laneName}` : ""}` : item.repo;
  return `${scope} (${item.status})`;
}

function firstItems<T>(items: T[], count = 6): T[] {
  return items.slice(0, count);
}

const TERMINAL_STATUS_LABELS: Record<string, string> = {
  done: "Done",
  merged: "Merged",
  closed: "Closed",
  cancelled: "Cancelled",
  archived: "Archived"
};

function TerminalStatusBadge({ status }: { status: string }) {
  const normalized = status.trim().toLowerCase();
  return (
    <span className={`status-badge status-terminal status-${normalized}`}>
      {TERMINAL_STATUS_LABELS[normalized] || status}
    </span>
  );
}

export function sortRecentTerminalRows(rows: OperatorRow[]): OperatorRow[] {
  const activityTime = (row: OperatorRow) => {
    const parsed = row.lastActivityAt ? Date.parse(row.lastActivityAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  return [...rows].sort((left, right) => activityTime(right) - activityTime(left));
}

export function OverviewTab({
  dashboard,
  onOpenOperatorFilter,
  revealOlderTerminalRows = false,
  onRevealOlderTerminalRowsChange
}: {
  dashboard: DashboardModel;
  onOpenOperatorFilter: (filter: OverviewOperatorFilter) => void;
  revealOlderTerminalRows?: boolean;
  onRevealOlderTerminalRowsChange?: (reveal: boolean) => void;
}) {
  const attentionItems = dashboard.healthItems.filter((item) => item.severity !== "info");
  const failedSources = (dashboard.sourceStatus || []).filter((source) =>
    ["auth_error", "unreachable"].includes(source.status)
  );
  const failedResources = new Set(failedSources.map((source) => source.resource));
  const summaryCount = (count: number, resources: readonly CoordinationResource[]) =>
    resources.some((resource) => failedResources.has(resource)) ? "—" : String(count);
  const hasUnavailableSource = (resources: readonly CoordinationResource[]) =>
    resources.some((resource) => failedResources.has(resource));
  const coordinationFailureTitle = (resources: readonly CoordinationResource[]) =>
    failedSources
      .filter((source) => resources.includes(source.resource))
      .map((source) => {
        const status = source.status === "auth_error" ? "authentication failed" : "unreachable";
        return `${source.resource}: ${status}${source.httpStatus ? ` (${source.httpStatus})` : ""}`;
      })
      .join("; ");
  const readySources = ["claims", "heartbeats", "batches"] as const;
  const claimedSources = ["claims", "heartbeats", "batches", "events"] as const;
  const processingSources = ["claims", "heartbeats"] as const;
  const qaSources = ["batches", "events"] as const;
  const batchRepairSources = ["batches", "events"] as const;
  const qaAttentionValidations = dashboard.qaValidations.filter((item) =>
    ["failed", "missing", "requested", "in_progress"].includes(item.status)
  );
  const { overviewRows, terminalRows, hiddenTerminalCount } = useMemo(() => {
    const allOperatorRows = buildOperatorRows(dashboard);
    const operatorRows = filterOperatorRowsByProvenance(allOperatorRows, false);
    const ageOut = filterOperatorRowsByAge(operatorRows, dashboard.generatedAt);
    const batchRepairRows = filterOperatorRowsForOverview(allOperatorRows, dashboard, "batch_repair");
    const batchRepairAgeOut = filterOperatorRowsByAge(batchRepairRows, dashboard.generatedAt);
    const visibleOperatorRows = revealOlderTerminalRows ? operatorRows : ageOut.visibleRows;
    const rowsFor = (filter: OverviewOperatorFilter) => {
      const filtered = filterOperatorRowsForOverview(
        filter === "batch_repair" ? allOperatorRows : visibleOperatorRows,
        dashboard,
        filter
      );
      return filter === "batch_repair"
        ? filterOperatorRowsByAge(filtered, dashboard.generatedAt, revealOlderTerminalRows).visibleRows
        : filtered;
    };
    return {
      overviewRows: {
        ready_for_batch: rowsFor("ready_for_batch"),
        needs_recovery: rowsFor("needs_recovery"),
        processing_now: rowsFor("processing_now"),
        qa_attention: rowsFor("qa_attention"),
        batch_repair: rowsFor("batch_repair")
      } as Record<OverviewOperatorFilter, OperatorRow[]>,
      terminalRows: sortRecentTerminalRows(visibleOperatorRows.filter(isTerminalRowEligibleForAgeOut)),
      hiddenTerminalCount: new Set([...ageOut.hiddenRows, ...batchRepairAgeOut.hiddenRows].map((row) => row.id)).size
    };
  }, [dashboard, revealOlderTerminalRows]);
  const healthGroups = groupHealthItems(attentionItems);
  const warningGroups = groupWarnings(dashboard.warnings);
  const visibleHealthGroups = healthGroups.slice(0, 6);
  const visibleWarningGroups = warningGroups.slice(0, Math.max(0, 6 - visibleHealthGroups.length));
  const overflowHealthGroups = healthGroups.slice(visibleHealthGroups.length);
  const overflowWarningGroups = warningGroups.slice(visibleWarningGroups.length);
  const overflowTypeCount = overflowHealthGroups.length + overflowWarningGroups.length;
  const qaPresentationRows = overviewRows.qa_attention.map((row) => ({
    row,
    validations: qaAttentionValidations.filter((item) => row.repo === item.repo && row.target === item.target)
  }));
  const currentPresentationRows = [
    ...overviewRows.processing_now.map((row) => ({ row, status: "in_process" })),
    ...overviewRows.needs_recovery.map((row) => ({ row, status: "started_not_processing" }))
  ];
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
      <label className="operator-retention-filter">
        <input
          aria-label="Show older terminal work"
          checked={revealOlderTerminalRows}
          onChange={(event) => onRevealOlderTerminalRowsChange?.(event.target.checked)}
          type="checkbox"
        />
        <span>Show older terminal work</span>
        <small>
          {revealOlderTerminalRows
            ? `Showing ${hiddenTerminalCount} older terminal ${hiddenTerminalCount === 1 ? "row" : "rows"}`
            : `${hiddenTerminalCount} older terminal ${hiddenTerminalCount === 1 ? "row" : "rows"} hidden`}
        </small>
      </label>
      <section className="summary-cards" aria-label="Coordination summary">
        <button
          aria-label={`Show ${summaryCount(overviewRows.ready_for_batch.length, readySources)} ready for batch rows in Operator view`}
          className="summary-card"
          onClick={() => onOpenOperatorFilter("ready_for_batch")}
          type="button"
        >
          <strong title={coordinationFailureTitle(readySources) || undefined}>
            {summaryCount(overviewRows.ready_for_batch.length, readySources)} ready
          </strong>
          <span>Ready to batch</span>
        </button>
        <button
          aria-label={`Show ${summaryCount(overviewRows.needs_recovery.length, claimedSources)} claimed, not processing rows in Operator view`}
          className="summary-card"
          onClick={() => onOpenOperatorFilter("needs_recovery")}
          type="button"
        >
          <strong title={coordinationFailureTitle(claimedSources) || undefined}>
            {summaryCount(overviewRows.needs_recovery.length, claimedSources)} claimed
          </strong>
          <span>Not processing · recover</span>
        </button>
        <button
          aria-label={`Show ${summaryCount(overviewRows.processing_now.length, processingSources)} processing now rows in Operator view`}
          className="summary-card"
          onClick={() => onOpenOperatorFilter("processing_now")}
          type="button"
        >
          <strong title={coordinationFailureTitle(processingSources) || undefined}>
            {summaryCount(overviewRows.processing_now.length, processingSources)} processing
          </strong>
          <span>Processing now</span>
        </button>
        <button
          aria-label={`Show ${summaryCount(overviewRows.qa_attention.length, qaSources)} QA needs attention rows in Operator view`}
          className="summary-card"
          onClick={() => onOpenOperatorFilter("qa_attention")}
          type="button"
        >
          <strong title={coordinationFailureTitle(qaSources) || undefined}>
            {summaryCount(overviewRows.qa_attention.length, qaSources)} QA needs attention
          </strong>
          <span>Missing, failed, or active</span>
        </button>
        <button
          aria-label={`Show ${summaryCount(overviewRows.batch_repair.length, batchRepairSources)} batch repairs in Operator view`}
          className="summary-card"
          onClick={() => onOpenOperatorFilter("batch_repair")}
          type="button"
        >
          <strong title={coordinationFailureTitle(batchRepairSources) || undefined}>
            {summaryCount(overviewRows.batch_repair.length, batchRepairSources)} batch repairs
          </strong>
          <span>Manifest, prompt, or stopped batch</span>
        </button>
      </section>

      <section className="overview-grid">
        {terminalRows.length > 0 && (
          <article className="panel overview-panel overview-wide">
            <header className="overview-panel-header">
              <CheckCircle2 size={18} aria-hidden="true" />
              <h2>Recent Terminal Work</h2>
            </header>
            <div className="overview-list">
              {firstItems(terminalRows, 10).map((row) => (
                <div className="overview-row" key={row.id}>
                  <div>
                    <OperatorRowLink row={row} />
                    <span>{row.lastActivityAge === UNKNOWN ? "Activity UNKNOWN" : `${row.lastActivityAge} ago`}</span>
                  </div>
                  <TerminalStatusBadge status={row.retentionStatus} />
                </div>
              ))}
            </div>
          </article>
        )}
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
          {currentPresentationRows.length === 0 ? (
            <p className="empty-state" title={coordinationFailureTitle(claimedSources) || undefined}>
              {hasUnavailableSource(claimedSources)
                ? "Current Work coordination data is unavailable."
                : "No processing or claimed-but-idle work."}
            </p>
          ) : (
            <div className="overview-list">
              {firstItems(currentPresentationRows).map(({ row, status }) => (
                <div className="overview-row" key={`${status}:${row.id}`}>
                  <div>
                    <OperatorRowLink row={row} />
                    <span>{row.agentId || row.laneName || "Unassigned"}</span>
                  </div>
                  <StatusBadge value={status} />
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
          {overviewRows.batch_repair.length === 0 ? (
            <p className="empty-state" title={coordinationFailureTitle(batchRepairSources) || undefined}>
              {hasUnavailableSource(batchRepairSources)
                ? "Batch Repair coordination data is unavailable."
                : "No batch repair items."}
            </p>
          ) : (
            <div className="overview-list">
              {firstItems(overviewRows.batch_repair).map((row) => (
                <div className="overview-row" key={row.id}>
                  <div>
                    <strong>{row.batchId || UNKNOWN}</strong>
                    <span>{row.title}</span>
                  </div>
                  <span className={`status-badge status-${row.activityStatus}`}>{operatorActivityLabel(row.activityStatus)}</span>
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
          {qaPresentationRows.length === 0 ? (
            <p className="empty-state" title={coordinationFailureTitle(qaSources) || undefined}>
              {hasUnavailableSource(qaSources)
                ? "QA Validation coordination data is unavailable."
                : "No separate QA gaps for PRs."}
            </p>
          ) : (
            <div className="overview-list">
              {firstItems(qaPresentationRows).map(({ row, validations }) => (
                <div className="overview-row" key={row.id}>
                  <div>
                    <OperatorRowLink row={row} />
                    <span>{validations.map(qaValidationScope).join(" · ")}</span>
                  </div>
                  <div className="overview-row-statuses">
                    {Array.from(new Set(validations.map((item) => item.status))).map((status) => (
                      <StatusBadge key={status} value={status} />
                    ))}
                  </div>
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
          {overviewRows.ready_for_batch.length === 0 ? (
            <p className="empty-state" title={coordinationFailureTitle(readySources) || undefined}>
              {hasUnavailableSource(readySources)
                ? "Ready To Batch coordination data is unavailable."
                : "No ready work items."}
            </p>
          ) : (
            <div className="overview-list">
              {firstItems(overviewRows.ready_for_batch, 10).map((row) => (
                <div className="overview-row" key={row.id}>
                  <div>
                    <OperatorRowLink row={row} />
                    <span>{row.repo}</span>
                  </div>
                  <StatusBadge value="ready_for_batch" />
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
    </section>
  );
}
