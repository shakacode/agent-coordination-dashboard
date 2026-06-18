import type {
  AgentSummary,
  BatchRecord,
  ClaimRecord,
  CoordinationWarning,
  DashboardModel,
  GitHubPreview,
  HeartbeatRecord,
  SchedulingState,
  WorkItem
} from "../../shared/types";

const TERMINAL_STATUSES = new Set(["complete", "completed", "done", "merged", "ready"]);

interface BuildInput {
  stateRoot: string;
  targetRepos: string[];
  claims: ClaimRecord[];
  heartbeats: HeartbeatRecord[];
  batches: BatchRecord[];
  githubItems: GitHubPreview[];
  warnings: CoordinationWarning[];
  now: Date;
}

function workId(repo: string, target: string): string {
  return `${repo}#${target}`;
}

function isLiveOrStale(heartbeat: HeartbeatRecord | undefined): boolean {
  return Boolean(heartbeat && ["live", "stale"].includes(heartbeat.liveness));
}

function classifyWork(claim: ClaimRecord | undefined, heartbeat: HeartbeatRecord | undefined): SchedulingState {
  if (isLiveOrStale(heartbeat)) {
    return "in_process";
  }

  if (claim || heartbeat) {
    return "started_not_processing";
  }

  return "ready_for_batch";
}

function warningsForWork(
  repo: string,
  target: string,
  claim: ClaimRecord | undefined,
  heartbeat: HeartbeatRecord | undefined,
  workHeartbeats: HeartbeatRecord[],
  claimAgentHeartbeat: HeartbeatRecord | undefined,
  schedulingState: SchedulingState
): CoordinationWarning[] {
  const warnings: CoordinationWarning[] = [];

  if (claim && claimAgentHeartbeat && (claimAgentHeartbeat.repo !== repo || claimAgentHeartbeat.target !== target)) {
    warnings.push({
      severity: "warning",
      repo,
      target,
      agentId: claim.agentId,
      message: `Claim holder heartbeat currently points at ${claimAgentHeartbeat.repo || "UNKNOWN repo"}#${
        claimAgentHeartbeat.target || "UNKNOWN target"
      }.`
    });
  }

  for (const otherHeartbeat of workHeartbeats.filter((item) => claim && item.agentId !== claim.agentId)) {
    warnings.push({
      severity: "warning",
      repo,
      target,
      agentId: otherHeartbeat.agentId,
      message: `Work has a heartbeat from ${otherHeartbeat.agentId} but the claim is held by ${claim?.agentId}.`
    });
  }

  if (workHeartbeats.length > 1) {
    warnings.push({
      severity: "warning",
      repo,
      target,
      message: `Work has ${workHeartbeats.length} heartbeat records for the same target.`
    });
  }

  if (schedulingState === "started_not_processing") {
    warnings.push({
      severity: "warning",
      repo,
      target,
      agentId: claim?.agentId || heartbeat?.agentId,
      message: "Work was started but the holder is not currently live or stale."
    });
  } else if (claim?.status === "active" && !heartbeat) {
    warnings.push({
        severity: "warning",
        repo,
        target,
        agentId: claim.agentId,
        message: "Active claim has no matching heartbeat."
    });
  }

  return warnings;
}

export function buildDashboardModel(input: BuildInput): DashboardModel {
  const currentClaims = input.claims.filter((claim) => claim.status !== "released");
  const heartbeatsByAgent = new Map(input.heartbeats.map((heartbeat) => [heartbeat.agentId, heartbeat]));
  const heartbeatsByWork = new Map<string, HeartbeatRecord[]>();
  for (const heartbeat of input.heartbeats) {
    if (heartbeat.repo && heartbeat.target) {
      const id = workId(heartbeat.repo, heartbeat.target);
      heartbeatsByWork.set(id, [...(heartbeatsByWork.get(id) || []), heartbeat]);
    }
  }
  const previewsByWork = new Map(input.githubItems.map((item) => [workId(item.repo, item.target), item]));
  const claimsByWork = new Map(currentClaims.map((claim) => [workId(claim.repo, claim.target), claim]));
  const workKeys = new Set<string>([...claimsByWork.keys(), ...previewsByWork.keys()]);

  for (const heartbeat of input.heartbeats) {
    if (heartbeat.repo && heartbeat.target) {
      workKeys.add(workId(heartbeat.repo, heartbeat.target));
    }
  }

  const workItems: WorkItem[] = Array.from(workKeys)
    .sort()
    .map((id) => {
      const hashIndex = id.lastIndexOf("#");
      const repo = id.slice(0, hashIndex);
      const target = id.slice(hashIndex + 1);
      const claim = claimsByWork.get(id);
      const workHeartbeats = heartbeatsByWork.get(id) || [];
      const claimAgentHeartbeat = claim ? heartbeatsByAgent.get(claim.agentId) : undefined;
      const heartbeat =
        (claim && workHeartbeats.find((item) => item.agentId === claim.agentId)) ||
        workHeartbeats.find(isLiveOrStale) ||
        workHeartbeats[0];
      const github = previewsByWork.get(id);
      const schedulingState = classifyWork(claim, heartbeat);
      const warnings = warningsForWork(repo, target, claim, heartbeat, workHeartbeats, claimAgentHeartbeat, schedulingState);

      return {
        id,
        repo,
        target,
        type: github?.type || "unknown",
        claim,
        heartbeat,
        github,
        schedulingState,
        warnings,
        selected: false
      };
    });

  const workByAgent = new Map<string, WorkItem[]>();
  for (const item of workItems) {
    const agentIds = new Set([item.claim?.agentId, item.heartbeat?.agentId].filter((agentId): agentId is string => Boolean(agentId)));
    for (const agentId of agentIds) {
      workByAgent.set(agentId, [...(workByAgent.get(agentId) || []), item]);
    }
  }

  const agentIds = new Set<string>([
    ...currentClaims.map((claim) => claim.agentId),
    ...input.heartbeats.map((heartbeat) => heartbeat.agentId)
  ]);
  const agents: AgentSummary[] = Array.from(agentIds)
    .sort()
    .map((agentId) => {
      const heartbeat = heartbeatsByAgent.get(agentId);
      const claims = currentClaims.filter((claim) => claim.agentId === agentId);
      const currentWork = workByAgent.get(agentId) || [];
      const warnings = currentWork.flatMap((item) => item.warnings);

      return {
        agentId,
        heartbeat,
        claims,
        currentWork,
        liveness: heartbeat?.liveness || "no-heartbeat",
        warnings
      };
    });

  const laneStatusByRef = new Map<string, string>();
  for (const batch of input.batches) {
    for (const lane of batch.lanes) {
      const heartbeat = heartbeatsByAgent.get(lane.owner);
      laneStatusByRef.set(`${batch.batchId}:${lane.name}`, heartbeat?.status || lane.status);
    }
  }

  const batches = input.batches.map((batch) => ({
    ...batch,
    lanes: batch.lanes.map((lane) => {
      const heartbeat = heartbeatsByAgent.get(lane.owner);
      return {
        ...lane,
        status: heartbeat?.status || lane.status,
        liveness: heartbeat?.liveness || "no-heartbeat",
        blockedOn: lane.dependsOn.filter((dependency) => !TERMINAL_STATUSES.has(laneStatusByRef.get(dependency) || ""))
      };
    })
  }));

  return {
    generatedAt: input.now.toISOString(),
    stateRoot: input.stateRoot,
    targetRepos: input.targetRepos,
    agents,
    workItems,
    batches,
    warnings: [...input.warnings, ...workItems.flatMap((item) => item.warnings)]
  };
}
