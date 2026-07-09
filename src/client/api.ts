import type { BatchRecord, DashboardModel, DashboardSettings } from "../shared/types";

export async function fetchDashboard(options: { fresh?: boolean } = {}): Promise<DashboardModel> {
  const response = await fetch(
    "/api/dashboard",
    options.fresh
      ? {
          headers: { "X-Dashboard-Refresh": "foreground" }
        }
      : undefined
  );
  if (!response.ok) {
    throw new Error(`Dashboard API failed with ${response.status}`);
  }
  return (await response.json()) as DashboardModel;
}

export async function fetchSettings(): Promise<DashboardSettings> {
  const response = await fetch("/api/settings");
  if (!response.ok) {
    throw new Error(`Settings API failed with ${response.status}`);
  }
  return (await response.json()) as DashboardSettings;
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
