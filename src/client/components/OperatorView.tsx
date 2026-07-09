import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import type { DashboardModel } from "../../shared/types";
import {
  buildOperatorRows,
  filterOperatorRows,
  hasStructuredOperatorDeepLink,
  operatorRowMatchesDeepLink,
  UNKNOWN,
  type OperatorDeepLink,
  type OperatorRow
} from "../operatorRows";
import { StatusBadge } from "./StatusBadge";

interface OperatorViewProps {
  dashboard: DashboardModel;
  deepLink?: OperatorDeepLink;
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

function BranchPr({ row }: { row: OperatorRow }) {
  const prUrl = safeGithubUrl(row.prUrl);
  return (
    <div className="operator-stack">
      <strong>{display(row.branch)}</strong>
      {prUrl ? (
        <a href={prUrl} rel="noreferrer" target="_blank">
          PR
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      ) : (
        <span>{UNKNOWN}</span>
      )}
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) {
    return <span className="operator-ok">OK</span>;
  }
  return (
    <ul className="operator-warning-list">
      {warnings.map((warning, index) => (
        <li key={`${warning}-${index}`}>{warning}</li>
      ))}
    </ul>
  );
}

function stateCounts(rows: OperatorRow[]): string {
  const counts = rows.reduce<Record<string, number>>((memo, row) => {
    memo[row.operatorState] = (memo[row.operatorState] || 0) + 1;
    return memo;
  }, {});
  return Object.entries(counts)
    .map(([state, count]) => `${count} ${state}`)
    .join(" · ");
}

export function OperatorView({ dashboard, deepLink }: OperatorViewProps) {
  const rows = useMemo(() => buildOperatorRows(dashboard), [dashboard]);
  const [query, setQuery] = useState(deepLink?.query || "");

  useEffect(() => {
    setQuery(deepLink?.query || "");
  }, [deepLink?.query]);

  const hasStructuredLink = hasStructuredOperatorDeepLink(deepLink);
  const linkedRows = useMemo(
    () => (hasStructuredLink ? rows.filter((row) => operatorRowMatchesDeepLink(row, deepLink)) : rows),
    [deepLink, hasStructuredLink, rows]
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
            <span>{stateCounts(rows) || "0 unknown"}</span>
          </div>
        </div>
        <label className="search-field operator-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Search operator rows"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            value={query}
          />
        </label>
      </header>

      {noStructuredLinkMatch ? (
        <p className="empty-state">No loaded row matches this link.</p>
      ) : visibleRows.length === 0 ? (
        <p className="empty-state">No operator rows match.</p>
      ) : (
        <div className="operator-table-wrap">
          <table className="operator-table">
            <thead>
              <tr>
                <th>State</th>
                <th>Work</th>
                <th>Owner</th>
                <th>Thread</th>
                <th>Batch</th>
                <th>Activity</th>
                <th>Branch/PR</th>
                <th>Warnings</th>
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
                        <span>{row.livenessAge === UNKNOWN ? display(row.liveness) : `${row.liveness} · ${row.livenessAge}`}</span>
                      </div>
                    </td>
                    <td>
                      <div className="operator-work">
                        <WorkLink row={row} />
                        <span>{row.repo}</span>
                      </div>
                    </td>
                    <td>
                      <MetadataStack primary={row.operator} secondary={[row.host, row.machineId].filter(Boolean).join(" / ")} />
                    </td>
                    <td>
                      <MetadataStack primary={row.threadHandle} secondary={row.agentId} />
                    </td>
                    <td>
                      <MetadataStack
                        primary={[row.batchId, row.laneName].filter(Boolean).join(" / ")}
                        secondary={batchDetail(row)}
                      />
                    </td>
                    <td>
                      <div className="operator-stack">
                        <strong>{display(row.activityStatus)}</strong>
                        <span>{row.lastActivityAge === UNKNOWN ? UNKNOWN : `${row.lastActivityAge} ago`}</span>
                      </div>
                    </td>
                    <td>
                      <BranchPr row={row} />
                    </td>
                    <td>
                      <Warnings warnings={row.warnings} />
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
