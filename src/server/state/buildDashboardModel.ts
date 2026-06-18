import type {
  AgentSummary,
  BatchLane,
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
const REDACTED_DEPENDENCY_REF = "outside TARGET_REPOS";

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

function laneRef(batch: BatchRecord, lane: BatchLane): string {
  return `${batch.batchId}:${lane.name}`;
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

function heartbeatMatchesLane(batch: BatchRecord, lane: BatchLane, heartbeat: HeartbeatRecord): boolean {
  if (heartbeat.batchId && heartbeat.batchId !== batch.batchId) {
    return false;
  }

  const sameBatch = heartbeat.batchId === batch.batchId;
  const sameRepo = !batch.repo || !heartbeat.repo || heartbeat.repo === batch.repo;
  const sameTarget = Boolean(heartbeat.target && lane.targets.includes(heartbeat.target));

  if (heartbeat.target) {
    return sameRepo && sameTarget && (!heartbeat.batchId || sameBatch);
  }

  return sameBatch && sameRepo;
}

function appendSkippedWarning(warnings: CoordinationWarning[], count: number, label: string) {
  if (count > 0) {
    warnings.push({
      severity: "info",
      message: `Skipped ${count} ${label} outside TARGET_REPOS.`
    });
  }
}

function safeUnscopedWarning(warning: CoordinationWarning): boolean {
  return /^Could not read coordination directory (claims|heartbeats|batches|\.)(:|$)/.test(warning.message);
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
  const targetRepoSet = new Set(input.targetRepos);
  const scopeWarnings: CoordinationWarning[] = [];
  const nonReleasedClaims = input.claims.filter((claim) => claim.status !== "released");
  const currentClaims = nonReleasedClaims.filter((claim) => targetRepoSet.has(claim.repo));
  const repoScopedHeartbeats = input.heartbeats.filter((heartbeat) => Boolean(heartbeat.repo && targetRepoSet.has(heartbeat.repo)));
  const scopedGithubItems = input.githubItems.filter((item) => targetRepoSet.has(item.repo));
  const knownScopedTargets = new Set([
    ...currentClaims.map((claim) => claim.target),
    ...repoScopedHeartbeats.map((heartbeat) => heartbeat.target).filter((target): target is string => Boolean(target)),
    ...scopedGithubItems.map((item) => item.target)
  ]);
  const scopedBatchesRaw = input.batches.flatMap((batch) => {
    if (batch.repo) {
      return targetRepoSet.has(batch.repo) ? [batch] : [];
    }

    if (input.targetRepos.length !== 1) {
      return [];
    }

    const lanes = batch.lanes
      .map((lane) => ({
        ...lane,
        targets: lane.targets.filter((target) => knownScopedTargets.has(target))
      }))
      .filter((lane) => lane.targets.length > 0);

    return lanes.length > 0
      ? [
          {
            ...batch,
            lanes
          }
        ]
      : [];
  });
  const scopedLaneRefs = new Set(scopedBatchesRaw.flatMap((batch) => batch.lanes.map((lane) => laneRef(batch, lane))));
  const scopedBatches = scopedBatchesRaw.map((batch) => ({
    ...batch,
    lanes: batch.lanes.map((lane) => {
      const keptDependencies = lane.dependsOn.filter((dependency) => scopedLaneRefs.has(dependency));
      const hasHiddenDependencies = lane.dependsOn.some((dependency) => !scopedLaneRefs.has(dependency));
      return {
        ...lane,
        dependsOn: hasHiddenDependencies ? [...keptDependencies, REDACTED_DEPENDENCY_REF] : keptDependencies
      };
    })
  }));
  const scopedBatchIds = new Set(scopedBatches.map((batch) => batch.batchId));
  const scopedBatchOwners = new Set(scopedBatches.flatMap((batch) => batch.lanes.map((lane) => `${batch.batchId}:${lane.owner}`)));
  const scopedHeartbeats = input.heartbeats.filter((heartbeat) => {
    if (heartbeat.repo) {
      return targetRepoSet.has(heartbeat.repo);
    }
    return Boolean(heartbeat.batchId && scopedBatchIds.has(heartbeat.batchId) && scopedBatchOwners.has(`${heartbeat.batchId}:${heartbeat.agentId}`));
  });
  const scopedInputWarnings = input.warnings.filter(
    (warning) => Boolean(warning.repo && targetRepoSet.has(warning.repo)) || (!warning.repo && safeUnscopedWarning(warning))
  );

  appendSkippedWarning(scopeWarnings, nonReleasedClaims.length - currentClaims.length, "claim records");
  appendSkippedWarning(scopeWarnings, input.heartbeats.length - scopedHeartbeats.length, "heartbeat records");
  appendSkippedWarning(scopeWarnings, input.batches.length - scopedBatches.length, "batch records");
  appendSkippedWarning(scopeWarnings, input.githubItems.length - scopedGithubItems.length, "GitHub preview records");
  appendSkippedWarning(scopeWarnings, input.warnings.length - scopedInputWarnings.length, "warning records");

  const heartbeatsByAgent = new Map(scopedHeartbeats.map((heartbeat) => [heartbeat.agentId, heartbeat]));
  const heartbeatsByWork = new Map<string, HeartbeatRecord[]>();
  for (const heartbeat of scopedHeartbeats) {
    if (heartbeat.repo && heartbeat.target) {
      const id = workId(heartbeat.repo, heartbeat.target);
      heartbeatsByWork.set(id, [...(heartbeatsByWork.get(id) || []), heartbeat]);
    }
  }
  const previewsByWork = new Map(scopedGithubItems.map((item) => [workId(item.repo, item.target), item]));
  const claimsByWork = new Map(currentClaims.map((claim) => [workId(claim.repo, claim.target), claim]));
  const workKeys = new Set<string>([...claimsByWork.keys(), ...previewsByWork.keys()]);

  for (const heartbeat of scopedHeartbeats) {
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
        (claim && workHeartbeats.find((item) => item.agentId === claim.agentId && isLiveOrStale(item))) ||
        workHeartbeats.find(isLiveOrStale) ||
        (claim && workHeartbeats.find((item) => item.agentId === claim.agentId)) ||
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
    ...scopedHeartbeats.map((heartbeat) => heartbeat.agentId)
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
  const laneHeartbeatByRef = new Map<string, HeartbeatRecord | undefined>();
  const batchWarnings: CoordinationWarning[] = [];
  for (const batch of scopedBatches) {
    for (const lane of batch.lanes) {
      const ownerHeartbeat = heartbeatsByAgent.get(lane.owner);
      const heartbeat = ownerHeartbeat && heartbeatMatchesLane(batch, lane, ownerHeartbeat) ? ownerHeartbeat : undefined;
      const ref = laneRef(batch, lane);

      if (ownerHeartbeat && !heartbeat) {
        batchWarnings.push({
          severity: "warning",
          repo: batch.repo || (input.targetRepos.length === 1 ? input.targetRepos[0] : undefined),
          agentId: lane.owner,
          message: `Lane ${ref} owner heartbeat points at ${ownerHeartbeat.repo || "UNKNOWN repo"}#${
            ownerHeartbeat.target || "UNKNOWN target"
          } and was not applied.`
        });
      }

      laneHeartbeatByRef.set(ref, heartbeat);
      laneStatusByRef.set(ref, heartbeat?.status || lane.status);
    }
  }

  const batches = scopedBatches.map((batch) => ({
    ...batch,
    lanes: batch.lanes.map((lane) => {
      const heartbeat = laneHeartbeatByRef.get(laneRef(batch, lane));
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
    warnings: [...scopedInputWarnings, ...scopeWarnings, ...workItems.flatMap((item) => item.warnings), ...batchWarnings]
  };
}
