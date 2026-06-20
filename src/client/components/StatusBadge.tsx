import type { Liveness, SchedulingState } from "../../shared/types";

interface StatusBadgeProps {
  value: Liveness | SchedulingState | string;
}

const labels: Record<string, string> = {
  live: "Live",
  stale: "Stale",
  dead: "Dead",
  unknown: "Unknown",
  "no-heartbeat": "No heartbeat",
  in_process: "In process",
  started_not_processing: "Started, not processing",
  ready_for_batch: "Ready for batch",
  info: "Info",
  warning: "Warning",
  critical: "Critical"
};

export function StatusBadge({ value }: StatusBadgeProps) {
  return <span className={`status-badge status-${value}`}>{labels[value] || value}</span>;
}
