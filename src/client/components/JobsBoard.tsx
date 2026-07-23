import { JOB_BUCKETS, type JobBucketId, type JobRow } from "../coordinationView";
import type { OperatorRow } from "../operatorRows";
import type { WorkItem } from "../../shared/types";

export type JobFilter = JobBucketId | "all";

export interface JobsBoardProps {
  rows: JobRow[];
  counts: Record<JobBucketId, number>;
  activeFilter: JobFilter;
  onSetFilter: (filter: JobFilter) => void;
  onOpenRow: (row: OperatorRow, workItem?: WorkItem) => void;
  onToggleSelect?: (row: JobRow) => void;
  selectionDisabled?: boolean;
}

function JobRowButton({ row, onOpenRow, onToggleSelect, selectionDisabled }: { row: JobRow; onOpenRow: JobsBoardProps["onOpenRow"]; onToggleSelect?: JobsBoardProps["onToggleSelect"]; selectionDisabled?: boolean }) {
  const bucket = JOB_BUCKETS.find((candidate) => candidate.id === row.bucket)!;
  const rowButton = (
    <button
      className="job-row"
      onClick={() => onOpenRow(row.row, row.workItem)}
      style={{ borderLeftColor: bucket.color }}
      type="button"
    >
      <span className={`job-icon${bucket.pulse ? " pulse" : ""}`} style={{ color: row.iconColor }}>{row.icon}</span>
      <div className="job-main">
        <div className="job-title-row">
          <span className="job-target" style={{ color: row.targetColor }}>{row.targetLabel}</span>
          {row.implementationLabel && (
            <span
              className="job-target"
              title={row.implementationUrl ? `Implementation: ${row.implementationUrl}` : "Implementation pull request"}
            >
              {row.implementationLabel}
            </span>
          )}
          <span className="job-title">{row.title}</span>
        </div>
        {row.note && <div className="job-note" style={{ color: row.noteColor }}>{row.note}</div>}
      </div>
      <div className="job-where">
        {row.host && (
          <span className="host-badge" style={{ color: row.hostColor, background: `color-mix(in srgb, ${row.hostColor} 14%, transparent)` }}>{row.host}</span>
        )}
        {row.machine && <span className="job-machine">{row.machine}</span>}
        {row.batchLabel && <span className="job-batch" title={row.batchLabel}>{row.batchLabel}</span>}
      </div>
      <span className="job-right">
        <span className="lane-age">{row.age}</span>
        <span className="btn btn-secondary" style={{ fontSize: "12px", padding: "5px 11px" }}>{row.action}</span>
      </span>
    </button>
  );
  if (!row.selectable || !onToggleSelect) {
    return rowButton;
  }
  return (
    <div className="job-row-wrap">
      <label className="job-select">
        <span className="sr-only">Select {row.targetLabel} for a PR-batch prompt</span>
        <input
          checked={row.selected}
          disabled={selectionDisabled}
          onChange={() => onToggleSelect(row)}
          type="checkbox"
        />
      </label>
      {rowButton}
    </div>
  );
}

export function JobsBoard({ rows, counts, activeFilter, onSetFilter, onOpenRow, onToggleSelect, selectionDisabled }: JobsBoardProps) {
  const filters: Array<{ id: JobFilter; label: string; count: number }> = [
    { id: "all", label: "All", count: rows.length },
    ...JOB_BUCKETS.map((bucket) => ({ id: bucket.id as JobFilter, label: bucket.label, count: counts[bucket.id] }))
  ];
  const sections = JOB_BUCKETS.filter((bucket) => activeFilter === "all" || bucket.id === activeFilter)
    .map((bucket) => ({ bucket, rows: rows.filter((row) => row.bucket === bucket.id) }))
    .filter((section) => section.rows.length > 0);

  return (
    <section aria-label="Jobs" className="jobs-board">
      <div className="job-filters" role="tablist" aria-label="Job filters">
        {filters.map((filter) => (
          <button
            aria-pressed={activeFilter === filter.id}
            className={`job-filter${activeFilter === filter.id ? " active" : ""}`}
            key={filter.id}
            onClick={() => onSetFilter(filter.id)}
            type="button"
          >
            {filter.label} <span>{filter.count}</span>
          </button>
        ))}
      </div>

      {sections.length === 0 ? (
        <p className="empty-state">No jobs in this view.</p>
      ) : (
        <div className="job-sections">
          {sections.map(({ bucket, rows: sectionRows }) => (
            <div key={bucket.id}>
              <div className="job-section-head">
                <span className={`job-section-dot${bucket.pulse ? " pulse" : ""}`} style={{ background: bucket.color }} />
                <h3 style={{ color: bucket.color }}>{bucket.label}</h3>
                <span className="job-section-hint">{bucket.hint}</span>
              </div>
              <div className="job-rows">
                {sectionRows.map((row) => (
                  <JobRowButton key={row.id} onOpenRow={onOpenRow} onToggleSelect={onToggleSelect} row={row} selectionDisabled={selectionDisabled} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
