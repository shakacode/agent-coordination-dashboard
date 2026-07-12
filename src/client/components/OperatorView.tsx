import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import type { DashboardModel } from "../../shared/types";
import {
  buildOperatorRows,
  filterOperatorRows,
  filterOperatorRowsByProvenance,
  filterOperatorRowsByAge,
  filterOperatorRowsForOverview,
  hasExactOperatorDeepLink,
  OVERVIEW_OPERATOR_FILTER_LABELS,
  operatorActivityLabel,
  operatorRowMatchesDeepLink,
  safeGithubUrl,
  savedOlderTerminalWorkPreference,
  SHOW_OLDER_TERMINAL_WORK_STORAGE_KEY,
  UNKNOWN,
  type OperatorDeepLink,
  type OperatorRow
} from "../operatorRows";
import { StatusBadge } from "./StatusBadge";

interface OperatorViewProps {
  dashboard: DashboardModel;
  deepLink?: OperatorDeepLink;
  onClearExactLink?: () => void;
  onQueryChange?: (query: string) => void;
  query?: string;
  onResetOverviewFilter?: () => void;
  revealOlderTerminalRows?: boolean;
  onRevealOlderTerminalRowsChange?: (reveal: boolean) => void;
}

const SHOW_DERIVED_ROWS_STORAGE_KEY = "agent-coordination-dashboard:show-derived-operator-rows";

function savedDerivedRowsPreference(): boolean {
  try {
    return window.localStorage.getItem(SHOW_DERIVED_ROWS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function display(value: string | undefined): string {
  return value?.trim() || UNKNOWN;
}

function workLabel(row: OperatorRow): string {
  if (!row.target) {
    return row.source === "batch" ? "Batch" : "Batch lane";
  }
  if (row.type === "pull_request") {
    return `PR #${row.target}`;
  }
  if (row.type === "issue") {
    return `Issue #${row.target}`;
  }
  return `Target #${row.target}`;
}

function WorkLink({ row }: { row: OperatorRow }) {
  const href = safeGithubUrl(row.url);
  const content = (
    <>
      <strong>{workLabel(row)}</strong>
      <span>{row.title}</span>
    </>
  );
  if (!href) {
    return <div className="operator-work-main">{content}</div>;
  }
  return (
    <a className="operator-work-main" href={href} rel="noreferrer" target="_blank">
      {content}
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}

function MetadataStack({ primary, secondary }: { primary?: string; secondary?: string }) {
  return (
    <div className="operator-stack">
      <strong>{display(primary)}</strong>
      <span>{display(secondary)}</span>
    </div>
  );
}

function batchDetail(row: OperatorRow): string {
  const hints = [
    row.dependencies.length > 0 ? `deps ${row.dependencies.join(", ")}` : "",
    row.blockedOn.length > 0 ? `blocked ${row.blockedOn.join(", ")}` : ""
  ].filter(Boolean);
  return hints.length > 0 ? hints.join(" · ") : UNKNOWN;
}

function PrLink({ row }: { row: OperatorRow }) {
  const prUrl = safeGithubUrl(row.prUrl);
  if (!prUrl) {
    return null;
  }
  return (
    <a className="operator-pr-link" href={prUrl} rel="noreferrer" target="_blank">
      PR
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}

function WarningSummary({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) {
    return <span className="operator-ok">OK</span>;
  }
  const label = warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`;
  return (
    <details className="operator-warning-summary">
      <summary>{label}</summary>
      <ul>
        {warnings.map((warning, index) => (
          <li key={`${warning}-${index}`}>{warning}</li>
        ))}
      </ul>
    </details>
  );
}

const METADATA_LABELS: Array<[keyof OperatorRow["metadata"], string]> = [
  ["owner", "Owner"],
  ["thread", "Thread"],
  ["host", "Host"],
  ["machine", "Machine"],
  ["branch", "Branch"],
  ["prUrl", "PR URL"],
  ["batch", "Batch"],
  ["activity", "Activity"]
];

function metadataStateText(row: OperatorRow, key: keyof OperatorRow["metadata"], label: string): string {
  const metadata = row.metadata[key];
  const state = metadata.state.replace("_", " ");
  const source = metadata.source?.replace("_", " ");
  return `${label}: ${state}${source ? ` from ${source}` : ""}`;
}

function MetadataDisclosure({ row }: { row: OperatorRow }) {
  const evidence = row.provenance.evidence.length > 0
    ? row.provenance.evidence.map((source) => source.replace("_", " ")).join(", ")
    : UNKNOWN;
  return (
    <details className="operator-metadata-disclosure">
      <summary>Metadata provenance</summary>
      <ul>
        <li>Row provenance: {row.provenance.classification}</li>
        <li>Row evidence: {evidence}</li>
        {METADATA_LABELS.map(([key, label]) => (
          <li key={key}>{metadataStateText(row, key, label)}</li>
        ))}
      </ul>
    </details>
  );
}

function StateCounts({ rows }: { rows: OperatorRow[] }) {
  const counts = rows.reduce<Record<string, number>>((memo, row) => {
    memo[row.operatorState] = (memo[row.operatorState] || 0) + 1;
    return memo;
  }, {});
  const orderedStates = ["wedged", "blocked", "dead", "stale", "paused", "running", "ready", "done", "unknown"];
  return (
    <>
      {orderedStates
        .filter((state) => counts[state])
        .map((state) => (
          <span className={`status-badge status-${state}`} key={state}>
            {counts[state]} {state}
          </span>
        ))}
      {Object.keys(counts).length === 0 ? <span>0 unknown</span> : null}
    </>
  );
}

export function OperatorView({
  dashboard,
  deepLink,
  onClearExactLink,
  onQueryChange,
  onResetOverviewFilter,
  revealOlderTerminalRows: controlledRevealOlderTerminalRows,
  onRevealOlderTerminalRowsChange,
  query: controlledQuery
}: OperatorViewProps) {
  const allRows = useMemo(() => buildOperatorRows(dashboard), [dashboard]);
  const [showDerivedRows, setShowDerivedRows] = useState(savedDerivedRowsPreference);
  const [localRevealOlderTerminalRows, setLocalRevealOlderTerminalRows] = useState(savedOlderTerminalWorkPreference);
  const revealOlderTerminalRows = controlledRevealOlderTerminalRows ?? localRevealOlderTerminalRows;
  const summaryFilterUsesOrdinaryWork = Boolean(deepLink?.overviewFilter && deepLink.overviewFilter !== "batch_repair");
  const includeDerivedRows = deepLink?.overviewFilter === "batch_repair"
    ? true
    : showDerivedRows && !summaryFilterUsesOrdinaryWork;
  const scopedAllRows = useMemo(
    () => filterOperatorRowsForOverview(allRows, dashboard, deepLink?.overviewFilter),
    [allRows, dashboard, deepLink?.overviewFilter]
  );
  const hiddenDerivedRowCount =
    scopedAllRows.length - filterOperatorRowsByProvenance(scopedAllRows, false).length;
  const [localQuery, setLocalQuery] = useState(deepLink?.query || "");
  const query = controlledQuery ?? localQuery;

  useEffect(() => {
    if (controlledQuery === undefined) {
      setLocalQuery(deepLink?.query || "");
    }
  }, [controlledQuery, deepLink?.query]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SHOW_DERIVED_ROWS_STORAGE_KEY, String(showDerivedRows));
    } catch {
      // Storage can be unavailable in restricted browser contexts; the in-memory control still works.
    }
  }, [showDerivedRows]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SHOW_OLDER_TERMINAL_WORK_STORAGE_KEY, String(revealOlderTerminalRows));
    } catch {
      // Storage can be unavailable; the App-owned in-memory preference still works.
    }
  }, [revealOlderTerminalRows]);

  function updateRevealOlderTerminalRows(value: boolean) {
    if (onRevealOlderTerminalRowsChange) {
      onRevealOlderTerminalRowsChange(value);
    } else {
      setLocalRevealOlderTerminalRows(value);
    }
  }

  function updateQuery(value: string) {
    if (onQueryChange) {
      onQueryChange(value);
    } else {
      setLocalQuery(value);
    }
  }

  const hasExactLink = hasExactOperatorDeepLink(deepLink);
  const scopedProvenanceRows = useMemo(
    () => filterOperatorRowsByProvenance(scopedAllRows, includeDerivedRows),
    [includeDerivedRows, scopedAllRows]
  );
  const ageOutScope = useMemo(
    () => filterOperatorRowsByAge(scopedProvenanceRows, dashboard.generatedAt),
    [dashboard.generatedAt, scopedProvenanceRows]
  );
  const overviewRows = useMemo(
    () => filterOperatorRowsByAge(scopedProvenanceRows, dashboard.generatedAt, revealOlderTerminalRows).visibleRows,
    [dashboard.generatedAt, revealOlderTerminalRows, scopedProvenanceRows]
  );
  const linkedRows = useMemo(
    () => (hasExactLink ? overviewRows.filter((row) => operatorRowMatchesDeepLink(row, deepLink)) : overviewRows),
    [deepLink, hasExactLink, overviewRows]
  );
  const visibleRows = useMemo(() => filterOperatorRows(linkedRows, query, dashboard.targetRepos), [dashboard.targetRepos, linkedRows, query]);
  const noExactLinkMatch = hasExactLink && linkedRows.length === 0;
  const noOverviewFilterMatch = Boolean(deepLink?.overviewFilter && overviewRows.length === 0);

  return (
    <section className="operator-view" aria-label="Operator view">
      <header className="operator-header">
        <div>
          <h2>Operator View</h2>
          <div className="operator-counts">
            <span>{overviewRows.length} rows</span>
            <StateCounts rows={overviewRows} />
          </div>
        </div>
        <label className="search-field operator-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Search operator rows"
            onChange={(event) => updateQuery(event.target.value)}
            placeholder="Search"
            value={query}
          />
        </label>
      </header>

      <label className="operator-provenance-filter">
        <input
          aria-label="Show inferred and synthetic rows"
          checked={includeDerivedRows}
          disabled={summaryFilterUsesOrdinaryWork || deepLink?.overviewFilter === "batch_repair"}
          onChange={(event) => setShowDerivedRows(event.target.checked)}
          type="checkbox"
        />
        <span>Show inferred and synthetic rows</span>
        {!includeDerivedRows && hiddenDerivedRowCount > 0 ? (
          <small>
            {hiddenDerivedRowCount} inferred or synthetic {hiddenDerivedRowCount === 1 ? "row" : "rows"} hidden
          </small>
        ) : null}
        {summaryFilterUsesOrdinaryWork ? <small>Overview summary filters use observed and UNKNOWN rows only.</small> : null}
        {deepLink?.overviewFilter === "batch_repair" ? (
          <small>Batch repair includes diagnostic inferred and synthetic evidence.</small>
        ) : null}
      </label>

      <label className="operator-retention-filter">
        <input
          aria-label="Show older terminal work"
          checked={revealOlderTerminalRows}
          onChange={(event) => updateRevealOlderTerminalRows(event.target.checked)}
          type="checkbox"
        />
        <span>Show older terminal work</span>
        <small>
          {revealOlderTerminalRows
            ? `Showing ${ageOutScope.hiddenRows.length} older terminal ${ageOutScope.hiddenRows.length === 1 ? "row" : "rows"}`
            : `${ageOutScope.hiddenRows.length} older terminal ${ageOutScope.hiddenRows.length === 1 ? "row" : "rows"} hidden`}
        </small>
      </label>

      {deepLink?.overviewFilter && (
        <div className="operator-filter" role="status">
          <span>
            Active filter: <strong>{OVERVIEW_OPERATOR_FILTER_LABELS[deepLink.overviewFilter]}</strong>
          </span>
          <button onClick={onResetOverviewFilter} type="button">
            Reset filter
          </button>
        </div>
      )}

      {noExactLinkMatch || noOverviewFilterMatch ? (
        <div className="empty-state">
          <p>
            No loaded row matches
            {noExactLinkMatch
              ? " this link"
              : deepLink?.overviewFilter
                ? ` the ${OVERVIEW_OPERATOR_FILTER_LABELS[deepLink.overviewFilter]} filter`
                : " this link"}.
          </p>
          {noExactLinkMatch ? (
            <button onClick={onClearExactLink} type="button">
              Clear link
            </button>
          ) : (
            deepLink?.overviewFilter && (
              <button aria-label="Reset filter and show all operator rows" onClick={onResetOverviewFilter} type="button">
                Reset filter
              </button>
            )
          )}
        </div>
      ) : visibleRows.length === 0 ? (
        <p className="empty-state">No operator rows match.</p>
      ) : (
        <div className="operator-table-wrap">
          <table className="operator-table">
            <thead>
              <tr>
                <th>State</th>
                <th>Work</th>
                <th>Owner / Thread</th>
                <th>Batch / Branch</th>
                <th>Activity</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const highlighted = operatorRowMatchesDeepLink(row, deepLink);
                return (
                  <tr className={highlighted ? "operator-row-highlight" : ""} key={row.id}>
                    <td>
                      <div className="operator-state">
                        <StatusBadge value={row.operatorState} />
                        <span>
                          {row.livenessAge === UNKNOWN
                            ? display(row.liveness === "none" ? undefined : row.liveness)
                            : `${row.liveness} · ${row.livenessAge}`}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="operator-work">
                        <WorkLink row={row} />
                        <div className="operator-work-meta">
                          <span>{row.repo}</span>
                          <WarningSummary warnings={row.warnings} />
                        </div>
                      </div>
                    </td>
                    <td>
                      <MetadataStack
                        primary={[row.operator, row.host, row.machineId].filter(Boolean).join(" / ")}
                        secondary={[row.threadHandle, row.agentId].filter(Boolean).join(" / ")}
                      />
                      <MetadataDisclosure row={row} />
                    </td>
                    <td>
                      <MetadataStack
                        primary={[row.batchId, row.laneName].filter(Boolean).join(" / ")}
                        secondary={[row.branch, batchDetail(row)].filter((item) => item && item !== UNKNOWN).join(" · ")}
                      />
                      <PrLink row={row} />
                    </td>
                    <td>
                      <div className="operator-stack">
                        <strong>{operatorActivityLabel(display(row.activityStatus))}</strong>
                        <span>{row.lastActivityAge === UNKNOWN ? UNKNOWN : `${row.lastActivityAge} ago`}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
