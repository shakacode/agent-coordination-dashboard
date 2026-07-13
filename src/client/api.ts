import type { CustodyTimeline } from "../shared/custodyTimeline";
import type { BatchRecord, CoordinationSourceStatus, CoordinationWarning, DashboardAnnotation, DashboardModel, DashboardSettings, WorkItem } from "../shared/types";

export interface ItemTimelineResponse extends CustodyTimeline {
  item?: WorkItem;
  sourceStatus: CoordinationSourceStatus[];
  warnings: CoordinationWarning[];
}

export async function fetchDashboard(options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<DashboardModel> {
  const response = await fetch(
    "/api/dashboard",
    options.fresh || options.signal
      ? {
          headers: options.fresh ? { "X-Dashboard-Refresh": "foreground" } : undefined,
          signal: options.signal
        }
      : undefined
  );
  if (!response.ok) {
    throw new Error(`Dashboard API failed with ${response.status}`);
  }
  return (await response.json()) as DashboardModel;
}

export async function fetchSettings(options: { signal?: AbortSignal } = {}): Promise<DashboardSettings> {
  const response = await fetch("/api/settings", options.signal ? { signal: options.signal } : undefined);
  if (!response.ok) {
    throw new Error(`Settings API failed with ${response.status}`);
  }
  return (await response.json()) as DashboardSettings;
}

export async function fetchItemTimeline(repo: string, target: string, options: { signal?: AbortSignal } = {}): Promise<ItemTimelineResponse> {
  const response = await fetch(`/api/item/${encodeURIComponent(repo)}/${encodeURIComponent(target)}`, options.signal ? { signal: options.signal } : undefined);
  if (!response.ok) {
    throw new Error(`Work item API failed with ${response.status}`);
  }
  return (await response.json()) as ItemTimelineResponse;
}

export async function saveSettings(settings: DashboardSettings): Promise<DashboardSettings> {
  const response = await fetch("/api/settings", {
    body: JSON.stringify(settings),
    headers: { "Content-Type": "application/json" },
    method: "PUT"
  });
  if (!response.ok) {
    throw new Error(`Settings API failed with ${response.status}`);
  }
  return (await response.json()) as DashboardSettings;
}

export async function saveImportedBatchManifest(manifest: Partial<BatchRecord>): Promise<{ path: string }> {
  const response = await fetch("/api/batches/import", {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST"
  });
  if (!response.ok) {
    throw new Error(`Batch plan import failed with ${response.status}`);
  }
  return (await response.json()) as { path: string };
}

export async function requestBatchStop(input: { batchId: string; repo?: string; reason?: string }): Promise<{ path: string }> {
  const response = await fetch("/api/batches/stop", {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST"
  });
  if (!response.ok) {
    throw new Error(`Batch stop request failed with ${response.status}`);
  }
  return (await response.json()) as { path: string };
}

export async function saveAnnotation(input: { repo: string; target: string; kind: "dismiss" | "snooze"; until?: string }): Promise<DashboardAnnotation> {
  const response = await fetch("/api/annotations", {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST"
  });
  if (!response.ok) throw new Error(`Annotation save failed with ${response.status}`);
  return (await response.json()) as DashboardAnnotation;
}

export async function deleteAnnotation(input: { repo: string; target: string }): Promise<void> {
  const response = await fetch("/api/annotations", {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "DELETE"
  });
  if (!response.ok) throw new Error(`Annotation removal failed with ${response.status}`);
}
