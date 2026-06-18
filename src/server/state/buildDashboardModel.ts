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

function classifyWork(claim: ClaimRecord | undefined, heartbeat: HeartbeatRecord | undefined): SchedulingState {
  if (claim?.status === "active" && heartbeat && ["live", "stale"].includes(heartbeat.liveness)) {
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
  schedulingState: SchedulingState
): CoordinationWarning[] {
  if (schedulingState === "started_not_processing") {
    return [
      {
        severity: "warning",
        repo,
        target,
        agentId: claim?.agentId || heartbeat?.agentId,
        message: "Work was started but the holder is not currently live or stale."
      }
    ];
  }

  if (claim?.status === "active" && !heartbeat) {
    return [
      {
        severity: "warning",
        repo,
        target,
        agentId: claim.agentId,
        message: "Active claim has no matching heartbeat."
      }
    ];
  }

  return [];
}

export function buildDashboardModel(input: BuildInput): DashboardModel {
  const heartbeatsByAgent = new Map(input.heartbeats.map((heartbeat) => [heartbeat.agentId, heartbeat]));
  const previewsByWork = new Map(input.githubItems.map((item) => [workId(item.repo, item.target), item]));
  const claimsByWork = new Map(input.claims.map((claim) => [workId(claim.repo, claim.target), claim]));
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
      const heartbeat = claim
        ? heartbeatsByAgent.get(claim.agentId)
        : input.heartbeats.find((item) => item.repo === repo && item.target === target);
      const github = previewsByWork.get(id);
      const schedulingState = classifyWork(claim, heartbeat);
      const warnings = warningsForWork(repo, target, claim, heartbeat, schedulingState);

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
        selected: schedulingState === "ready_for_batch"
      };
    });

  const workByAgent = new Map<string, WorkItem[]>();
  for (const item of workItems) {
    const agentId = item.claim?.agentId || item.heartbeat?.agentId;
    if (!agentId) {
      continue;
    }
    workByAgent.set(agentId, [...(workByAgent.get(agentId) || []), item]);
  }

  const agentIds = new Set<string>([
    ...input.claims.map((claim) => claim.agentId),
    ...input.heartbeats.map((heartbeat) => heartbeat.agentId)
  ]);
  const agents: AgentSummary[] = Array.from(agentIds)
    .sort()
    .map((agentId) => {
      const heartbeat = heartbeatsByAgent.get(agentId);
      const claims = input.claims.filter((claim) => claim.agentId === agentId);
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

