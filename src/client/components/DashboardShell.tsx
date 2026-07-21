import { JOB_BUCKETS, type CoordinationView } from "../coordinationView";
import type { OperatorRow } from "../operatorRows";
import type { BatchCard, JobRow } from "../coordinationView";
import type { WorkItem } from "../../shared/types";
import { BatchesBoard, type BatchFilter } from "./BatchesBoard";
import { JobsBoard, type JobFilter } from "./JobsBoard";
import { MachinesBoard } from "./MachinesBoard";

export type TabId = "batches" | "jobs" | "machines";

export interface DashboardShellProps {
  view: CoordinationView;
  tab: TabId;
  onSetTab: (tab: TabId) => void;
  jobFilter: JobFilter;
  onSetJobFilter: (filter: JobFilter) => void;
  batchFilter: BatchFilter;
  onSetBatchFilter: (filter: BatchFilter) => void;
  onOpenRow: (row: OperatorRow, workItem?: WorkItem) => void;
  onOpenBatch: (card: BatchCard) => void;
  onToggleSelect?: (row: JobRow) => void;
  selectionDisabled?: boolean;
  highlightBatchId?: string | null;
}

const TABS: Array<{ id: TabId; label: string; hint?: string }> = [
  { id: "batches", label: "Batches", hint: "threads" },
  { id: "jobs", label: "Jobs", hint: "PRs & issues" },
  { id: "machines", label: "Machines" }
];

export function DashboardShell({
  view,
  tab,
  onSetTab,
  jobFilter,
  onSetJobFilter,
  batchFilter,
  onSetBatchFilter,
  onOpenRow,
  onOpenBatch,
  onToggleSelect,
  selectionDisabled,
  highlightBatchId
}: DashboardShellProps) {
  return (
    <div className="app-width">
      {tab === "jobs" && (
        <div className="lifecycle-strip" aria-label="Lifecycle buckets">
          {JOB_BUCKETS.map((bucket) => (
            <button
              aria-pressed={jobFilter === bucket.id}
              className="bucket"
              key={bucket.id}
              onClick={() => onSetJobFilter(jobFilter === bucket.id ? "all" : bucket.id)}
              style={{ borderColor: jobFilter === bucket.id ? `color-mix(in srgb, ${bucket.color} 55%, transparent)` : undefined }}
              type="button"
            >
              <span className={`bucket-dot${bucket.pulse ? " pulse" : ""}`} style={{ background: bucket.color }} />
              <span className="bucket-count" style={{ color: bucket.color }}>{view.jobCounts[bucket.id]}</span>
              <span className="bucket-text">
                <span className="bucket-label">{bucket.label}</span>
                <span className="bucket-hint">{bucket.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <nav className="tabs" aria-label="Dashboard views">
        {TABS.map((entry) => (
          <button
            aria-current={tab === entry.id ? "page" : undefined}
            className={`tab${tab === entry.id ? " active" : ""}`}
            key={entry.id}
            onClick={() => onSetTab(entry.id)}
            type="button"
          >
            {entry.label}
            {entry.hint && <small>{entry.hint}</small>}
          </button>
        ))}
      </nav>

      {tab === "batches" && (
        <BatchesBoard
          activeFilter={batchFilter}
          cards={view.batchCards}
          highlightBatchId={highlightBatchId}
          onOpenBatch={onOpenBatch}
          onOpenRow={onOpenRow}
          onSetFilter={onSetBatchFilter}
          tierCounts={view.batchTierCounts}
        />
      )}
      {tab === "jobs" && (
        <JobsBoard
          activeFilter={jobFilter}
          counts={view.jobCounts}
          onOpenRow={onOpenRow}
          onSetFilter={onSetJobFilter}
          onToggleSelect={onToggleSelect}
          rows={view.jobRows}
          selectionDisabled={selectionDisabled}
        />
      )}
      {tab === "machines" && <MachinesBoard machines={view.machines} />}
    </div>
  );
}
