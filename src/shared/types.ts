export type Liveness = "live" | "stale" | "dead" | "unknown" | "no-heartbeat";
export type ClaimStatus = "active" | "released" | "unknown";
export type SchedulingState = "in_process" | "started_not_processing" | "ready_for_batch";
export type WorkItemType = "issue" | "pull_request" | "unknown";
export type WarningSeverity = "info" | "warning" | "critical";

export interface DashboardSettings {
  targetRepos: string[];
}

export interface ClaimRecord {
  schemaVersion: number;
  repo: string;
  target: string;
  agentId: string;
  machineId?: string;
  batchId?: string;
  branch?: string;
  status: ClaimStatus;
  claimedAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  path: string;
}

export interface HeartbeatRecord {
  schemaVersion: number;
  agentId: string;
  machineId?: string;
  repo?: string;
  target?: string;
  batchId?: string;
  branch?: string;
  status: string;
  updatedAt: string;
  expiresAt: string;
  path: string;
  liveness: Liveness;
}

export interface BatchLane {
  name: string;
  owner: string;
  targets: string[];
  dependsOn: string[];
  status: string;
  liveness: Liveness;
  blockedOn: string[];
}

export interface BatchRecord {
  schemaVersion: number;
  batchId: string;
  repo?: string;
  source?: "manifest" | "inferred";
  lanes: BatchLane[];
  updatedAt?: string;
  path: string;
}

export interface BatchEvent {
  eventId: string;
  type: string;
  batchId?: string;
  batchPath?: string;
  laneName?: string;
  machineId?: string;
  agentId?: string;
  repo?: string;
  target?: string;
  status?: string;
  message?: string;
  timestamp?: string;
  path: string;
}

export interface BatchWorkSignal {
  batchId: string;
  laneName: string;
  status: string;
  blockedOn: string[];
}

export interface GitHubPreview {
  repo: string;
  target: string;
  type: WorkItemType;
  title: string;
  url: string;
  state: string;
  author?: string;
  labels: string[];
  branch?: string;
  reviewDecision?: string;
  loadState: "loaded" | "unknown";
}

export interface CoordinationWarning {
  severity: WarningSeverity;
  message: string;
  agentId?: string;
  repo?: string;
  target?: string;
}

export interface WorkItem {
  id: string;
  repo: string;
  target: string;
  type: WorkItemType;
  claim?: ClaimRecord;
  heartbeat?: HeartbeatRecord;
  batchSignals?: BatchWorkSignal[];
  github?: GitHubPreview;
  schedulingState: SchedulingState;
  warnings: CoordinationWarning[];
  selected: boolean;
}

export interface AgentSummary {
  agentId: string;
  machineId?: string;
  heartbeat?: HeartbeatRecord;
  claims: ClaimRecord[];
  currentWork: WorkItem[];
  liveness: Liveness;
  warnings: CoordinationWarning[];
}

export interface HealthItem {
  id: string;
  severity: WarningSeverity;
  category: "machine" | "heartbeat" | "claim" | "batch" | "history" | "repo" | "state";
  title: string;
  detail: string;
  machineId?: string;
  agentId?: string;
  repo?: string;
  target?: string;
  batchId?: string;
  laneName?: string;
}

export interface DashboardModel {
  generatedAt: string;
  stateRoot: string;
  targetRepos: string[];
  agents: AgentSummary[];
  workItems: WorkItem[];
  batches: BatchRecord[];
  events: BatchEvent[];
  healthItems: HealthItem[];
  warnings: CoordinationWarning[];
}
