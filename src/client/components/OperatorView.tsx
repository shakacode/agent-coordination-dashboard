import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import type { DashboardModel } from "../../shared/types";
import {
  buildOperatorRows,
  filterOperatorRows,
  filterOperatorRowsForOverview,
  hasStructuredOperatorDeepLink,
  OVERVIEW_OPERATOR_FILTER_LABELS,
  operatorRowMatchesDeepLink,
  UNKNOWN,
  type OperatorDeepLink,
  type OperatorRow
} from "../operatorRows";
import { StatusBadge } from "./StatusBadge";

interface OperatorViewProps {
  dashboard: DashboardModel;
  deepLink?: OperatorDeepLink;
  onQueryChange?: (query: string) => void;
  query?: string;
  onResetOverviewFilter?: () => void;
}

function safeGithubUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      return undefined;
    }
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length !== 4 || !["pull", "issues"].includes(pathParts[2]) || !/^\d+$/.test(pathParts[3])) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function display(value: string | undefined): string {
  return value?.trim() || UNKNOWN;
}

function workLabel(row: OperatorRow): string {
  if (!row.target) {
    return "Batch lane";
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

export function OperatorView({ dashboard, deepLink, onQueryChange, onResetOverviewFilter, query: controlledQuery }: OperatorViewProps) {
  const rows = useMemo(() => buildOperatorRows(dashboard), [dashboard]);
  const [localQuery, setLocalQuery] = useState(deepLink?.query || "");
  const query = controlledQuery ?? localQuery;

  useEffect(() => {
    if (controlledQuery === undefined) {
      setLocalQuery(deepLink?.query || "");
    }
  }, [controlledQuery, deepLink?.query]);

  function updateQuery(value: string) {
    if (onQueryChange) {
      onQueryChange(value);
    } else {
      setLocalQuery(value);
    }
  }

  const hasStructuredLink = hasStructuredOperatorDeepLink(deepLink);
  const overviewRows = useMemo(
    () => filterOperatorRowsForOverview(rows, dashboard, deepLink?.overviewFilter),
    [dashboard, deepLink?.overviewFilter, rows]
  );
  const linkedRows = useMemo(
    () => (hasStructuredLink ? overviewRows.filter((row) => operatorRowMatchesDeepLink(row, deepLink)) : overviewRows),
    [deepLink, hasStructuredLink, overviewRows]
  );
  const visibleRows = useMemo(() => filterOperatorRows(linkedRows, query, dashboard.targetRepos), [dashboard.targetRepos, linkedRows, query]);
  const noStructuredLinkMatch = hasStructuredLink && linkedRows.length === 0;

  return (
    <section className="operator-view" aria-label="Operator view">
      <header className="operator-header">
        <div>
          <h2>Operator View</h2>
          <div className="operator-counts">
            <span>{rows.length} rows</span>
            <StateCounts rows={rows} />
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

      {noStructuredLinkMatch ? (
        <div className="empty-state">
          <p>
            No loaded row matches
            {deepLink?.overviewFilter ? ` the ${OVERVIEW_OPERATOR_FILTER_LABELS[deepLink.overviewFilter]} filter` : " this link"}.
          </p>
          {deepLink?.overviewFilter && (
            <button onClick={onResetOverviewFilter} type="button">
              Reset filter
            </button>
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
                        <strong>{display(row.activityStatus)}</strong>
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
