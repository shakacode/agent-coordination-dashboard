export type Liveness = "live" | "stale" | "dead" | "unknown" | "no-heartbeat";
export type ClaimStatus = "active" | "released" | "unknown";
export type SchedulingState = "in_process" | "started_not_processing" | "ready_for_batch";
export type WorkItemOperatorState = "needs_attention" | "running" | "ready" | "terminal" | "archived_view";
export type WorkItemTerminalState = "done" | "closed" | "abandoned" | "superseded";
export type AttentionReasonKind = "wedged" | "blocked_user_input" | "dead_holder" | "qa_missing" | "batch_stopped" | "batch_stop_requested";
export type WorkItemType = "issue" | "pull_request" | "unknown";
export type WarningSeverity = "info" | "warning" | "critical";
export type BatchControlStatus = "running" | "stop_requested" | "stopped";
export type QaValidationStatus = "missing" | "requested" | "in_progress" | "passed" | "failed" | "unknown";
export type MetadataProvenanceState = "observed" | "inferred" | "missing" | "not_applicable";
export type MetadataSource = "claim" | "heartbeat" | "event" | "manifest" | "inferred_batch" | "github" | "dashboard";
export type OperatorRowProvenanceClassification = "observed" | "inferred" | "synthetic" | "unknown";
export type CoordinationResource = "claims" | "heartbeats" | "batches" | "events";
export type CoordinationSourceMode = "api" | "fs";
export type CoordinationSourceState = "ok" | "auth_error" | "unreachable" | "empty";

export interface CoordinationSourceStatus {
  resource: CoordinationResource;
  mode: CoordinationSourceMode;
  status: CoordinationSourceState;
  httpStatus?: number;
  checkedAt: string;
}

export interface OperatorRowProvenance {
  classification: OperatorRowProvenanceClassification;
  evidence: MetadataSource[];
}

export type MetadataProvenance =
  | { state: "observed" | "inferred"; value: string; source: MetadataSource }
  | { state: "missing"; value?: never; source?: MetadataSource }
  | { state: "not_applicable"; value?: never; source?: never };

export interface DashboardSettings {
  targetRepos: string[];
  refreshIntervalMs?: number;
}

export interface ClaimRecord {
  schemaVersion: number;
  repo: string;
  target: string;
  agentId: string;
  machineId?: string;
  threadHandle?: string;
  host?: string;
  operator?: string;
  batchId?: string;
  branch?: string;
  prUrl?: string;
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
  threadHandle?: string;
  host?: string;
  operator?: string;
  repo?: string;
  target?: string;
  batchId?: string;
  branch?: string;
  prUrl?: string;
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
  threadHandle?: string;
  host?: string;
  operator?: string;
  branch?: string;
  prUrl?: string;
}

export interface BatchTarget {
  type: WorkItemType;
  target: string;
  url?: string;
  title?: string;
  repo?: string;
}

export interface BatchReservation {
  type: WorkItemType;
  target: string;
  reason?: string;
  owner?: string;
  laneName?: string;
  repo?: string;
}

export interface BatchRecord {
  schemaVersion: number;
  batchId: string;
  repo?: string;
  objective?: string;
  targets?: BatchTarget[];
  source?: "manifest" | "inferred";
  reservations?: BatchReservation[];
  createdAt?: string;
  createdByMachine?: string;
  launchPrompt?: string;
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
  threadHandle?: string;
  host?: string;
  operator?: string;
  repo?: string;
  target?: string;
  branch?: string;
  prUrl?: string;
  status?: string;
  message?: string;
  timestamp?: string;
  path: string;
}

export interface BatchWorkSignal {
  batchId?: string;
  laneName?: string;
  status: string;
  blockedOn: string[];
  updatedAt?: string;
}

export interface QaValidationItem {
  id: string;
  repo: string;
  target: string;
  type: WorkItemType;
  title?: string;
  url?: string;
  batchId?: string;
  laneName?: string;
  status: QaValidationStatus;
  detail: string;
  latestEvent?: BatchEvent;
}

export interface BatchOperation {
  batchId: string;
  repo?: string;
  batchPath?: string;
  controlStatus: BatchControlStatus;
  eventCount: number;
  latestEventAt?: string;
  latestEventType?: string;
  stopRequestedAt?: string;
  stoppedAt?: string;
  qa: {
    total: number;
    missing: number;
    requested: number;
    inProgress: number;
    passed: number;
    failed: number;
    unknown: number;
  };
}

export interface GitHubPreview {
  repo: string;
  target: string;
  type: WorkItemType;
  /** Original coordinated identity when linked GitHub evidence points at another target. */
  coordinatedType?: WorkItemType;
  title: string;
  url: string;
  state: string;
  author?: string;
  labels: string[];
  branch?: string;
  reviewDecision?: string;
  /** Present only when GitHub supplied a trustworthy merge timestamp. */
  mergedAt?: string;
  /** Present only when GitHub supplied a trustworthy close timestamp. */
  closedAt?: string;
  /** Supporting signal only. Branch deletion never implies terminal work. */
  branchState?: "present" | "deleted" | "unknown";
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
  provenance?: OperatorRowProvenance;
  schedulingState: SchedulingState;
  /**
   * Dashboard-only presentation state. It is derived from read-only
   * coordination and GitHub preview data and never writes back to either.
   */
  operatorState?: WorkItemOperatorState;
  terminalState?: WorkItemTerminalState;
  terminalProvenance?: {
    source: "declared" | "github";
    url?: string;
  };
  attention?: {
    kind: AttentionReasonKind;
    label: string;
    action: "Copy resume prompt" | "Open PR" | "Open batch operations";
  };
  lastActivityAt?: string;
  warnings: CoordinationWarning[];
  selected: boolean;
}

export interface AgentSummary {
  agentId: string;
  machineId?: string;
  machineMetadata?: MetadataProvenance;
  heartbeat?: HeartbeatRecord;
  latestEvent?: BatchEvent;
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
  batchOperations: BatchOperation[];
  qaValidations: QaValidationItem[];
  healthItems: HealthItem[];
  warnings: CoordinationWarning[];
  sourceStatus?: CoordinationSourceStatus[];
  coordinationTokenEnvVar?: "AGENT_COORD_API_TOKEN" | "AGENT_COORD_TOKEN";
  /** Capability flag; unavailable prevents the UI from presenting a false zero merge count. */
  githubMergeTimeStatus?: "available" | "unavailable";
  /** Trustworthy only when every resolvable coordinated target was reconciled. */
  trulyOpenCount?: number;
  trulyOpenCountStatus?: "available" | "unknown";
}
