import type { WorkItem } from "./types";

export function fallbackTimelineWorkItem(repo: string, target: string): WorkItem {
  return {
    id: `${repo}#${target}`,
    repo,
    target,
    type: "unknown",
    schedulingState: "started_not_processing",
    provenance: { classification: "unknown", evidence: [] },
    warnings: [],
    selected: false
  };
}
