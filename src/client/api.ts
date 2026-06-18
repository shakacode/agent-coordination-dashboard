import type { DashboardModel } from "../shared/types";

export async function fetchDashboard(): Promise<DashboardModel> {
  const response = await fetch("/api/dashboard");
  if (!response.ok) {
    throw new Error(`Dashboard API failed with ${response.status}`);
  }
  return (await response.json()) as DashboardModel;
}

