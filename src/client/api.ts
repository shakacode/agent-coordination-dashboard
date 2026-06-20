import type { DashboardModel, DashboardSettings } from "../shared/types";

export async function fetchDashboard(): Promise<DashboardModel> {
  const response = await fetch("/api/dashboard");
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
