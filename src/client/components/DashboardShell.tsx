import { BATCH_TIERS, JOB_BUCKETS, canonicalHostName, type CoordinationView } from "../coordinationView";
import type { OperatorRow } from "../operatorRows";
import type { BatchCard, JobRow } from "../coordinationView";
import type { WorkItem } from "../../shared/types";
import { BatchesBoard, type BatchFilter } from "./BatchesBoard";
import { JobsBoard, type JobFilter } from "./JobsBoard";
import { MachinesBoard, type MachineFilter } from "./MachinesBoard";

export type TabId = "batches" | "jobs" | "machines";
export type FleetFilter = MachineFilter;

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
  onOpenBatchById: (batchId: string, batchPath?: string, repo?: string) => void;
  onFind: (query: string) => void;
  fleetFilter: FleetFilter;
  onSetFleetFilter: (filter: FleetFilter) => void;
  onToggleSelect?: (row: JobRow) => void;
  selectionDisabled?: boolean;
  highlightBatchIdentity?: string | null;
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
  onOpenBatchById,
  onFind,
  fleetFilter,
  onSetFleetFilter,
  onToggleSelect,
  selectionDisabled,
  highlightBatchIdentity
}: DashboardShellProps) {
  const matchesFleet = (host?: string, machine?: string) =>
    (!fleetFilter.host || canonicalHostName(host) === fleetFilter.host)
    && (!fleetFilter.machine || machine === fleetFilter.machine);
  const jobRows = view.jobRows.filter((row) => matchesFleet(row.row.host, row.row.machineId));
  const jobCounts = JOB_BUCKETS.reduce((counts, bucket) => {
    counts[bucket.id] = jobRows.filter((row) => row.bucket === bucket.id).length;
    return counts;
  }, {} as CoordinationView["jobCounts"]);
  const batchCards = view.batchCards.filter((card) => {
    if (!fleetFilter.host && !fleetFilter.machine) return true;
    return card.lanes.some((lane) => matchesFleet(lane.host, lane.machine))
      || matchesFleet(card.host, card.machine);
  });
  const batchTierCounts = BATCH_TIERS.reduce((counts, tier) => {
    counts[tier.id] = batchCards.filter((card) => card.tier === tier.id).length;
    return counts;
  }, {} as CoordinationView["batchTierCounts"]);
  const machines = view.machines
    .filter((machine) => !fleetFilter.machine || machine.id === fleetFilter.machine)
    .map((machine) => ({
      ...machine,
      hosts: machine.hosts.filter((host) => !fleetFilter.host || canonicalHostName(host.name) === fleetFilter.host)
    }))
    .filter((machine) => machine.hosts.length > 0);

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
              <span className="bucket-count" style={{ color: bucket.color }}>{jobCounts[bucket.id]}</span>
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
          cards={batchCards}
          highlightBatchIdentity={highlightBatchIdentity}
          onOpenBatch={onOpenBatch}
          onOpenRow={onOpenRow}
          onSetFilter={onSetBatchFilter}
          tierCounts={batchTierCounts}
        />
      )}
      {tab === "jobs" && (
        <JobsBoard
          activeFilter={jobFilter}
          counts={jobCounts}
          onOpenRow={onOpenRow}
          onSetFilter={onSetJobFilter}
          onToggleSelect={onToggleSelect}
          rows={jobRows}
          selectionDisabled={selectionDisabled}
        />
      )}
      {tab === "machines" && (
        <MachinesBoard
          machines={machines}
          onFilter={onSetFleetFilter}
          onFind={onFind}
          onOpenBatch={onOpenBatchById}
          onOpenRow={onOpenRow}
        />
      )}
    </div>
  );
}
