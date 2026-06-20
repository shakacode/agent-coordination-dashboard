import type {
  AgentSummary,
  BatchEvent,
  BatchLane,
  BatchRecord,
  BatchWorkSignal,
  ClaimRecord,
  CoordinationWarning,
  DashboardModel,
  GitHubPreview,
  HeartbeatRecord,
  HealthItem,
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
  events?: BatchEvent[];
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

function batchScope(batch: BatchRecord): string {
  return batch.repo || batch.path;
}

function laneKey(batch: BatchRecord, lane: BatchLane): string {
  return `${batchScope(batch)}:${laneRef(batch, lane)}`;
}

function dependencyKey(batch: BatchRecord, dependency: string): string {
  return `${batchScope(batch)}:${dependency}`;
}

function isLiveOrStale(heartbeat: HeartbeatRecord | undefined): boolean {
  return Boolean(heartbeat && ["live", "stale"].includes(heartbeat.liveness));
}

function classifyWork(
  claim: ClaimRecord | undefined,
  heartbeat: HeartbeatRecord | undefined,
  batchSignals: BatchWorkSignal[]
): SchedulingState {
  if (isLiveOrStale(heartbeat)) {
    return "in_process";
  }

  if (claim || heartbeat || batchSignals.length > 0) {
    return "started_not_processing";
  }

  return "ready_for_batch";
}

function heartbeatMatchesLane(batch: BatchRecord, lane: BatchLane, heartbeat: HeartbeatRecord): boolean {
  if (heartbeat.batchId && heartbeat.batchId !== batch.batchId) {
    return false;
  }

  const sameBatch = heartbeat.batchId === batch.batchId;
  const sameRepo = batch.repo ? heartbeat.repo === batch.repo : true;
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

function timestampValue(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function healthItem(input: Omit<HealthItem, "id">): HealthItem {
  const parts = [
    input.category,
    input.severity,
    input.machineId,
    input.agentId,
    input.repo,
    input.target,
    input.batchId,
    input.laneName,
    input.title
  ].filter(Boolean);
  return {
    id: parts.join(":"),
    ...input
  };
}

function batchTargets(batch: BatchRecord): Set<string> {
  return new Set(batch.lanes.flatMap((lane) => lane.targets));
}

function eventMatchesBatch(
  event: BatchEvent,
  batch: BatchRecord,
  inferredRepoForBatchTarget: (batchId: string, target: string) => string | undefined
): boolean {
  if (!event.batchId || event.batchId !== batch.batchId) {
    return false;
  }

  if (!event.repo) {
    return false;
  }

  if (event.repo && batch.repo) {
    return event.repo === batch.repo;
  }

  if (event.repo && !batch.repo) {
    if (!event.target || !batchTargets(batch).has(event.target)) {
      return false;
    }
    return inferredRepoForBatchTarget(batch.batchId, event.target) === event.repo;
  }

  return false;
}

function inferredBatchPath(repo: string, batchId: string): string {
  return `inferred-batches/${repo.replace("/", "__")}/${batchId}.json`;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function inferBatchesFromSignals(claims: ClaimRecord[], heartbeats: HeartbeatRecord[], manifestedBatches: BatchRecord[]): BatchRecord[] {
  const manifestedRepoBatchKeys = new Set(
    manifestedBatches.filter((batch) => batch.repo).map((batch) => `${batch.repo}:${batch.batchId}`)
  );
  const lanesByBatch = new Map<
    string,
    {
      batchId: string;
      repo: string;
      lanesByOwner: Map<string, { targets: string[]; status: string; updatedAt?: string }>;
    }
  >();

  function signalHasManifest(signal: { batchId: string; repo: string; target: string }): boolean {
    if (manifestedRepoBatchKeys.has(`${signal.repo}:${signal.batchId}`)) {
      return true;
    }

    return manifestedBatches.some(
      (batch) =>
        batch.batchId === signal.batchId &&
        !batch.repo &&
        batch.lanes.some((lane) => lane.targets.includes(signal.target))
    );
  }

  function addSignal(signal: { batchId?: string; repo?: string; target?: string; agentId: string; status: string; updatedAt?: string }) {
    if (!signal.batchId || !signal.repo || !signal.target || signalHasManifest(signal as { batchId: string; repo: string; target: string })) {
      return;
    }

    const batchKey = `${signal.repo}:${signal.batchId}`;
    const batch = lanesByBatch.get(batchKey) || {
      batchId: signal.batchId,
      repo: signal.repo,
      lanesByOwner: new Map<string, { targets: string[]; status: string; updatedAt?: string }>()
    };
    const lane = batch.lanesByOwner.get(signal.agentId) || { targets: [], status: signal.status, updatedAt: signal.updatedAt };
    lane.targets = uniqueSorted([...lane.targets, signal.target]);
    if (!lane.updatedAt || timestampValue(signal.updatedAt) > timestampValue(lane.updatedAt)) {
      lane.status = signal.status;
      lane.updatedAt = signal.updatedAt;
    }
    batch.lanesByOwner.set(signal.agentId, lane);
    lanesByBatch.set(batchKey, batch);
  }

  for (const claim of claims) {
    addSignal({
      agentId: claim.agentId,
      batchId: claim.batchId,
      repo: claim.repo,
      target: claim.target,
      status: claim.status,
      updatedAt: claim.updatedAt
    });
  }
  for (const heartbeat of heartbeats) {
    addSignal({
      agentId: heartbeat.agentId,
      batchId: heartbeat.batchId,
      repo: heartbeat.repo,
      target: heartbeat.target,
      status: heartbeat.status,
      updatedAt: heartbeat.updatedAt
    });
  }

  return Array.from(lanesByBatch.values())
    .sort((left, right) => `${left.repo}:${left.batchId}`.localeCompare(`${right.repo}:${right.batchId}`))
    .map((batch) => ({
      schemaVersion: 1,
      batchId: batch.batchId,
      repo: batch.repo,
      source: "inferred",
      updatedAt: Array.from(batch.lanesByOwner.values())
        .map((lane) => lane.updatedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1),
      path: inferredBatchPath(batch.repo, batch.batchId),
      lanes: Array.from(batch.lanesByOwner.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([owner, lane]) => ({
          name: owner,
          owner,
          targets: lane.targets,
          dependsOn: [],
          status: lane.status,
          liveness: "no-heartbeat",
          blockedOn: []
        }))
    }));
}

function scopedInputWarning(warning: CoordinationWarning, targetRepoSet: Set<string>): CoordinationWarning | undefined {
  if (warning.repo) {
    return targetRepoSet.has(warning.repo) ? warning : undefined;
  }

  const directoryRead = warning.message.match(/^Could not read coordination directory ([^:]+):/);
  if (directoryRead && ["claims", "heartbeats", "batches", "events", "history", "."].includes(directoryRead[1])) {
    return warning;
  }

  const malformed = warning.message.match(/^Malformed JSON in (heartbeats|batches|events|history)\//);
  if (malformed) {
    return {
      severity: warning.severity,
      message: `Malformed JSON in an unscoped ${malformed[1]} record.`
    };
  }

  return undefined;
}

function warningsForWork(
  repo: string,
  target: string,
  claim: ClaimRecord | undefined,
  heartbeat: HeartbeatRecord | undefined,
  workHeartbeats: HeartbeatRecord[],
  claimAgentHeartbeat: HeartbeatRecord | undefined,
  batchSignals: BatchWorkSignal[],
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

  for (const signal of batchSignals) {
    warnings.push({
      severity: "warning",
      repo,
      target,
      message: `Work is already scheduled in batch ${signal.batchId}:${signal.laneName} (${signal.status}).`
    });
    if (signal.blockedOn.length > 0) {
      warnings.push({
        severity: "warning",
        repo,
        target,
        message: `Batch lane ${signal.batchId}:${signal.laneName} is blocked on ${signal.blockedOn.join(", ")}.`
      });
    }
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
  const inputEvents = input.events || [];
  const scopeWarnings: CoordinationWarning[] = [];
  const nonReleasedClaims = input.claims.filter((claim) => claim.status !== "released");
  const currentClaims = nonReleasedClaims.filter((claim) => targetRepoSet.has(claim.repo));
  const repoScopedHeartbeats = input.heartbeats.filter((heartbeat) => Boolean(heartbeat.repo && targetRepoSet.has(heartbeat.repo)));
  const scopedGithubItems = input.githubItems.filter((item) => targetRepoSet.has(item.repo));
  const repoScopedBatchTargets = new Set([
    ...currentClaims
      .filter((claim) => Boolean(claim.batchId))
      .map((claim) => `${claim.batchId}:${claim.target}`),
    ...repoScopedHeartbeats
      .filter((heartbeat) => Boolean(heartbeat.batchId && heartbeat.target))
      .map((heartbeat) => `${heartbeat.batchId}:${heartbeat.target}`)
  ]);
  const reposByBatchTarget = new Map<string, Set<string>>();
  for (const claim of currentClaims) {
    if (claim.batchId) {
      const key = `${claim.batchId}:${claim.target}`;
      reposByBatchTarget.set(key, new Set([...(reposByBatchTarget.get(key) || []), claim.repo]));
    }
  }
  for (const heartbeat of repoScopedHeartbeats) {
    if (heartbeat.batchId && heartbeat.target && heartbeat.repo) {
      const key = `${heartbeat.batchId}:${heartbeat.target}`;
      reposByBatchTarget.set(key, new Set([...(reposByBatchTarget.get(key) || []), heartbeat.repo]));
    }
  }
  function uniqueRepoForBatchTarget(batchId: string, target: string): string | undefined {
    const repos = reposByBatchTarget.get(`${batchId}:${target}`);
    return repos?.size === 1 ? Array.from(repos)[0] : undefined;
  }
  const scopedManifestBatchesRaw = input.batches.flatMap((batch) => {
    if (batch.repo) {
      return targetRepoSet.has(batch.repo) ? [{ ...batch, source: batch.source || "manifest" }] : [];
    }

    const lanes = batch.lanes
      .map((lane) => ({
        ...lane,
        targets: lane.targets.filter(
          (target) => repoScopedBatchTargets.has(`${batch.batchId}:${target}`) && Boolean(uniqueRepoForBatchTarget(batch.batchId, target))
        )
      }))
      .filter((lane) => lane.targets.length > 0);

    return lanes.length > 0
      ? [
          {
            ...batch,
            source: batch.source || "manifest",
            lanes
          }
        ]
      : [];
  });
  const inferredBatches = inferBatchesFromSignals(currentClaims, repoScopedHeartbeats, scopedManifestBatchesRaw);
  const sourceBatches = [...scopedManifestBatchesRaw, ...inferredBatches];
  const scopedLaneRefs = new Set(sourceBatches.flatMap((batch) => batch.lanes.map((lane) => laneKey(batch, lane))));
  const scopedBatches = sourceBatches.map((batch) => ({
    ...batch,
    lanes: batch.lanes.map((lane) => {
      const keptDependencies = lane.dependsOn.filter((dependency) => scopedLaneRefs.has(dependencyKey(batch, dependency)));
      const hasHiddenDependencies = lane.dependsOn.some((dependency) => !scopedLaneRefs.has(dependencyKey(batch, dependency)));
      return {
        ...lane,
        dependsOn: hasHiddenDependencies ? [...keptDependencies, REDACTED_DEPENDENCY_REF] : keptDependencies
      };
    })
  }));
  const repoLessScopedBatchOwners = new Set(
    scopedBatches.filter((batch) => !batch.repo).flatMap((batch) => batch.lanes.map((lane) => `${batch.batchId}:${lane.owner}`))
  );
  const repoLessScopedBatchOwnerTargets = new Set(
    scopedBatches
      .filter((batch) => !batch.repo)
      .flatMap((batch) => batch.lanes.flatMap((lane) => lane.targets.map((target) => `${batch.batchId}:${lane.owner}:${target}`)))
  );
  const scopedHeartbeats = input.heartbeats.filter((heartbeat) => {
    if (heartbeat.repo) {
      return targetRepoSet.has(heartbeat.repo);
    }
    if (!heartbeat.batchId || !repoLessScopedBatchOwners.has(`${heartbeat.batchId}:${heartbeat.agentId}`)) {
      return false;
    }
    return heartbeat.target ? repoLessScopedBatchOwnerTargets.has(`${heartbeat.batchId}:${heartbeat.agentId}:${heartbeat.target}`) : true;
  });
  const batchesById = new Map<string, BatchRecord[]>();
  for (const batch of scopedBatches) {
    batchesById.set(batch.batchId, [...(batchesById.get(batch.batchId) || []), batch]);
  }
  const scopedEvents = inputEvents
    .flatMap((event) => {
      const batchId = event.batchId;
      if (!batchId) {
        return event.repo && targetRepoSet.has(event.repo) ? [event] : [];
      }
      const batchesWithSameId = batchesById.get(batchId) || [];
      const matchingBatches = batchesWithSameId.filter((batch) =>
        eventMatchesBatch(event, batch, uniqueRepoForBatchTarget)
      );
      if (matchingBatches.length > 0) {
        return matchingBatches.map((batch) => ({ ...event, batchPath: batch.path }));
      }
      return event.repo && targetRepoSet.has(event.repo) ? [event] : [];
    })
    .sort((left, right) => timestampValue(right.timestamp) - timestampValue(left.timestamp) || left.path.localeCompare(right.path));
  const scopedInputWarnings = input.warnings
    .map((warning) => scopedInputWarning(warning, targetRepoSet))
    .filter((warning): warning is CoordinationWarning => Boolean(warning));

  appendSkippedWarning(scopeWarnings, nonReleasedClaims.length - currentClaims.length, "claim records");
  appendSkippedWarning(scopeWarnings, input.heartbeats.length - scopedHeartbeats.length, "heartbeat records");
  appendSkippedWarning(scopeWarnings, input.batches.length - scopedManifestBatchesRaw.length, "batch records");
  appendSkippedWarning(scopeWarnings, inputEvents.length - scopedEvents.length, "batch history records");
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

      laneHeartbeatByRef.set(laneKey(batch, lane), heartbeat);
      laneStatusByRef.set(laneKey(batch, lane), heartbeat?.status || lane.status);
    }
  }

  const batches = scopedBatches.map((batch) => ({
    ...batch,
    lanes: batch.lanes.map((lane) => {
      const heartbeat = laneHeartbeatByRef.get(laneKey(batch, lane));
      return {
        ...lane,
        status: heartbeat?.status || lane.status,
        liveness: heartbeat?.liveness || "no-heartbeat",
        blockedOn: lane.dependsOn.filter((dependency) => !TERMINAL_STATUSES.has(laneStatusByRef.get(dependencyKey(batch, dependency)) || ""))
      };
    })
  }));

  const batchSignalsByWork = new Map<string, BatchWorkSignal[]>();
  for (const batch of batches) {
    for (const lane of batch.lanes) {
      for (const target of lane.targets) {
        const repo = batch.repo || uniqueRepoForBatchTarget(batch.batchId, target);
        if (!repo) {
          continue;
        }
        const id = workId(repo, target);
        batchSignalsByWork.set(id, [
          ...(batchSignalsByWork.get(id) || []),
          {
            batchId: batch.batchId,
            laneName: lane.name,
            status: lane.status,
            blockedOn: lane.blockedOn
          }
        ]);
      }
    }
  }
  const workKeys = new Set<string>([...claimsByWork.keys(), ...previewsByWork.keys(), ...batchSignalsByWork.keys()]);

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
      const batchSignals = batchSignalsByWork.get(id) || [];
      const heartbeat =
        (claim && workHeartbeats.find((item) => item.agentId === claim.agentId && isLiveOrStale(item))) ||
        workHeartbeats.find(isLiveOrStale) ||
        (claim && workHeartbeats.find((item) => item.agentId === claim.agentId)) ||
        workHeartbeats[0];
      const github = previewsByWork.get(id);
      const schedulingState = classifyWork(claim, heartbeat, batchSignals);
      const warnings = warningsForWork(repo, target, claim, heartbeat, workHeartbeats, claimAgentHeartbeat, batchSignals, schedulingState);

      return {
        id,
        repo,
        target,
        type: github?.type || "unknown",
        claim,
        heartbeat,
        batchSignals,
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
      const machineId = heartbeat?.machineId || claims.find((item) => item.machineId)?.machineId;

      return {
        agentId,
        machineId,
        heartbeat,
        claims,
        currentWork,
        liveness: heartbeat?.liveness || "no-heartbeat",
        warnings
      };
    });

  const healthItems: HealthItem[] = [];
  for (const heartbeat of scopedHeartbeats) {
    if (!heartbeat.machineId) {
      healthItems.push(
        healthItem({
          severity: "warning",
          category: "machine",
          title: "Heartbeat missing machine id",
          detail: `${heartbeat.agentId} does not report machine_id, so machine ownership cannot be shown reliably.`,
          agentId: heartbeat.agentId,
          repo: heartbeat.repo,
          target: heartbeat.target,
          batchId: heartbeat.batchId
        })
      );
    }
  }

  for (const claim of currentClaims) {
    if (!claim.machineId) {
      healthItems.push(
        healthItem({
          severity: "info",
          category: "machine",
          title: "Claim missing machine id",
          detail: `${claim.agentId} claimed ${claim.repo}#${claim.target} without machine_id.`,
          agentId: claim.agentId,
          repo: claim.repo,
          target: claim.target,
          batchId: claim.batchId
        })
      );
    }

    if (claim.status === "active" && !heartbeatsByWork.get(workId(claim.repo, claim.target))?.some((item) => item.agentId === claim.agentId)) {
      healthItems.push(
        healthItem({
          severity: "warning",
          category: "heartbeat",
          title: "Active claim has no matching heartbeat",
          detail: `${claim.agentId} holds ${claim.repo}#${claim.target}, but no heartbeat currently points at that work.`,
          machineId: claim.machineId,
          agentId: claim.agentId,
          repo: claim.repo,
          target: claim.target,
          batchId: claim.batchId
        })
      );
    }
  }

  for (const item of workItems) {
    if (item.schedulingState === "started_not_processing") {
      healthItems.push(
        healthItem({
          severity: "warning",
          category: item.batchSignals?.length ? "batch" : "heartbeat",
          title: "Work started but not currently processing",
          detail: `${item.repo}#${item.target} has coordination state but no live/stale holder.`,
          machineId: item.heartbeat?.machineId || item.claim?.machineId,
          agentId: item.heartbeat?.agentId || item.claim?.agentId,
          repo: item.repo,
          target: item.target,
          batchId: item.batchSignals?.[0]?.batchId,
          laneName: item.batchSignals?.[0]?.laneName
        })
      );
    }
  }

  const eventsByBatchPath = new Map<string, BatchEvent[]>();
  for (const event of scopedEvents) {
    if (event.batchPath) {
      eventsByBatchPath.set(event.batchPath, [...(eventsByBatchPath.get(event.batchPath) || []), event]);
    }
  }

  for (const batch of batches) {
    if (batch.source === "inferred") {
      healthItems.push(
        healthItem({
          severity: "warning",
          category: "batch",
          title: "Batch manifest missing",
          detail: `${batch.batchId} was inferred from claim/heartbeat batch_id fields because no retained batch manifest was found.`,
          repo: batch.repo,
          batchId: batch.batchId
        })
      );
    }

    if (!eventsByBatchPath.has(batch.path)) {
      healthItems.push(
        healthItem({
          severity: "info",
          category: "history",
          title: "Batch has no history events",
          detail:
            batch.source === "inferred"
              ? `${batch.batchId} has inferred lanes, but no events/history records were found.`
              : `${batch.batchId} has a batch file, but no events/history records were found.`,
          repo: batch.repo,
          batchId: batch.batchId
        })
      );
    }

    for (const lane of batch.lanes) {
      if (lane.liveness === "no-heartbeat" && !TERMINAL_STATUSES.has(lane.status)) {
        healthItems.push(
          healthItem({
            severity: "warning",
            category: "batch",
            title: "Batch lane has no heartbeat",
            detail: `${batch.batchId}:${lane.name} is ${lane.status}, but owner ${lane.owner} has no matching heartbeat.`,
            repo: batch.repo,
            batchId: batch.batchId,
            laneName: lane.name,
            agentId: lane.owner
          })
        );
      }
    }
  }

  return {
    generatedAt: input.now.toISOString(),
    stateRoot: input.stateRoot,
    targetRepos: input.targetRepos,
    agents,
    workItems,
    batches,
    events: scopedEvents,
    healthItems,
    warnings: [...scopedInputWarnings, ...scopeWarnings, ...workItems.flatMap((item) => item.warnings), ...batchWarnings]
  };
}
