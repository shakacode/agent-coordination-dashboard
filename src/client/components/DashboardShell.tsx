import { useMemo } from "react";
import {
  BATCH_TIERS,
  JOB_BUCKETS,
  canonicalHostName,
  observedLaneHost,
  type CoordinationView
} from "../coordinationView";
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
  const { jobRows, jobCounts, batchCards, batchTierCounts, machines } = useMemo(() => {
    const matchesFleet = (host?: string, machine?: string) =>
      (!fleetFilter.host || canonicalHostName(host) === fleetFilter.host)
      && (!fleetFilter.machine || machine === fleetFilter.machine);
    const filteredJobs = view.jobRows.filter((row) => matchesFleet(row.row.host, row.row.machineId));
    const filteredJobCounts = JOB_BUCKETS.reduce((counts, bucket) => {
      counts[bucket.id] = filteredJobs.filter((row) => row.bucket === bucket.id).length;
      return counts;
    }, {} as CoordinationView["jobCounts"]);
    const filteredBatches = view.batchCards.filter((card) => {
      if (!fleetFilter.host && !fleetFilter.machine) return true;
      const observedHosts = card.lanes
        .map((lane) => observedLaneHost(lane.row))
        .filter((host): host is string => Boolean(host));
      const laneMatch = card.lanes.some((lane) =>
        matchesFleet(observedHosts.length > 0 ? observedLaneHost(lane.row) : lane.host, lane.machine)
      );
      if (laneMatch) return true;
      if (fleetFilter.host && observedHosts.length > 0) return false;
      if (fleetFilter.machine && card.lanes.some((lane) => Boolean(lane.machine))) return false;
      return matchesFleet(card.host, card.machine);
    });
    const filteredBatchCounts = BATCH_TIERS.reduce((counts, tier) => {
      counts[tier.id] = filteredBatches.filter((card) => card.tier === tier.id).length;
      return counts;
    }, {} as CoordinationView["batchTierCounts"]);
    const filteredMachines = view.machines
      .filter((machine) => !fleetFilter.machine || machine.id === fleetFilter.machine)
      .map((machine) => ({
        ...machine,
        hosts: machine.hosts.filter((host) => !fleetFilter.host || canonicalHostName(host.name) === fleetFilter.host)
      }))
      .filter((machine) => machine.hosts.length > 0);
    return {
      jobRows: filteredJobs,
      jobCounts: filteredJobCounts,
      batchCards: filteredBatches,
      batchTierCounts: filteredBatchCounts,
      machines: filteredMachines
    };
  }, [fleetFilter.host, fleetFilter.machine, view]);

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
