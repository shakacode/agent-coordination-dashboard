import type {
  AgentSummary,
  BatchOperation,
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
  QaValidationItem,
  QaValidationStatus,
  SchedulingState,
  WorkItem,
  MetadataSource,
  OperatorRowProvenance
} from "../../shared/types";
import { parsePrBatchLaunchPrompt } from "../../shared/batchManifest";
import { batchSignalIdentity } from "../../shared/batchSignal";
import { displayAttribution } from "../../shared/attribution";
import { isQaEventType } from "../../shared/qaEvents";
import { isOperationalWorkItem } from "../../shared/workItemSelection";
import { repoRefsFromBranch, repoRefsFromPromptHeaders, repoRefsFromText } from "../repoRefs";
import { deriveWorkItems } from "./deriveWorkItems";

const TERMINAL_STATUSES = new Set(["complete", "completed", "done", "merged", "ready"]);
const TERMINAL_EVENT_PATTERN =
  /(?:^|[._-])(complete|completed|done|merged|closed|released|stopped|cancelled|canceled)(?:$|[._-])/i;
const REDACTED_DEPENDENCY_REF = "outside saved target repositories";

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

export function hasCoordinationEvidence(item: WorkItem): boolean {
  return Boolean(item.claim || item.heartbeat || item.batchSignals?.length || item.provenance?.evidence.some((source) => ["event", "manifest", "inferred_batch"].includes(source)));
}

function workId(repo: string, target: string): string {
  return `${repo}#${target}`;
}

function displayWorkRef(repo: string | undefined, target: string | undefined): string {
  const safeRepo = displayAttribution(repo);
  const safeTarget = displayAttribution(target);
  return safeTarget === "unattributed" ? `${safeRepo} (unattributed target)` : `${safeRepo}#${safeTarget}`;
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
  batchSignals: BatchWorkSignal[],
  hasSavedBatchMembership = false
): SchedulingState {
  if (isLiveOrStale(heartbeat)) {
    return "in_process";
  }

  if (claim || heartbeat || batchSignals.length > 0 || hasSavedBatchMembership) {
    return "started_not_processing";
  }

  return "ready_for_batch";
}

function heartbeatMatchesLane(batch: BatchRecord, lane: BatchLane, heartbeat: HeartbeatRecord): boolean {
  if (heartbeat.batchId && heartbeat.batchId !== batch.batchId) {
    return false;
  }

  const sameBatch = heartbeat.batchId === batch.batchId;
  const sameTarget = Boolean(heartbeat.target && lane.targets.includes(heartbeat.target));
  const manifestRepos = heartbeat.target ? manifestReposForTarget(batch, heartbeat.target) : [];
  const sameRepo =
    manifestRepos.length > 0
      ? Boolean(heartbeat.repo && manifestRepos.includes(heartbeat.repo))
      : batch.repo
        ? heartbeat.repo === batch.repo
        : true;

  if (heartbeat.target) {
    return sameRepo && sameTarget && (!heartbeat.batchId || sameBatch);
  }

  return sameBatch && sameRepo;
}

function appendSkippedWarning(warnings: CoordinationWarning[], count: number, label: string) {
  if (count > 0) {
    warnings.push({
      severity: "info",
      message: `Skipped ${count} ${label} outside saved target repositories.`
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

function normalizedMetadataValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function compareEventRecency(left: BatchEvent, right: BatchEvent): number {
  const timestampDifference = timestampValue(right.timestamp) - timestampValue(left.timestamp);
  if (timestampDifference !== 0) {
    return timestampDifference;
  }
  const leftLine = left.path.match(/^(.*):(\d+)$/);
  const rightLine = right.path.match(/^(.*):(\d+)$/);
  if (leftLine && rightLine && leftLine[1] === rightLine[1]) {
    return Number(rightLine[2]) - Number(leftLine[2]);
  }
  return right.path.localeCompare(left.path);
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

function targetIdentity(input: { type?: string; target: string; repo?: string }, fallbackRepo?: string): string {
  return `${input.repo || fallbackRepo || "UNKNOWN"}:${input.type || "unknown"}#${input.target}`;
}

function manifestTargetIdentities(batch: BatchRecord): Set<string> {
  if (batch.targets && batch.targets.length > 0) {
    return new Set(batch.targets.map((target) => targetIdentity(target, batch.repo)));
  }
  return new Set(
    batch.lanes.flatMap((lane) => lane.targets.map((target) => targetIdentity({ type: "unknown", target }, batch.repo)))
  );
}

function promptTargetHealth(batch: BatchRecord): { title: "Prompt parse failed" | "Prompt target mismatch"; detail: string } | undefined {
  if (!batch.launchPrompt) {
    return undefined;
  }

  let promptTargets: Set<string>;
  try {
    const parsedPrompt = parsePrBatchLaunchPrompt(batch.launchPrompt);
    promptTargets = new Set(parsedPrompt.targets.map((target) => targetIdentity(target, parsedPrompt.repo || batch.repo)));
  } catch (error) {
    return {
      title: "Prompt parse failed",
      detail: `${displayAttribution(batch.batchId)} saved coordination prompt could not be parsed: ${
        error instanceof Error ? error.message : "unknown error"
      }.`
    };
  }
  const batchManifestTargets = manifestTargetIdentities(batch);
  const promptOnly = Array.from(promptTargets)
    .filter((target) => !batchManifestTargets.has(target))
    .sort();
  const manifestOnly = Array.from(batchManifestTargets)
    .filter((target) => !promptTargets.has(target))
    .sort();

  if (promptOnly.length === 0 && manifestOnly.length === 0) {
    return undefined;
  }

  return {
    title: "Prompt target mismatch",
    detail: `${displayAttribution(batch.batchId)} saved coordination prompt and batch plan targets differ: ${[
      promptOnly.length > 0 ? `prompt has ${promptOnly.join(", ")}` : "",
      manifestOnly.length > 0 ? `plan has ${manifestOnly.join(", ")}` : ""
    ]
      .filter(Boolean)
      .join("; ")}.`
  };
}

function eventText(event: BatchEvent): string {
  return [event.type, event.status, event.message].filter(Boolean).join(" ").toLowerCase();
}

function eventStructuredText(event: BatchEvent): string {
  return [event.type, event.status].filter(Boolean).join(" ").toLowerCase();
}

function isStopRequestEvent(event: BatchEvent): boolean {
  const structured = eventStructuredText(event);
  if (/\b(batch[._-]stopped|stopped|cancelled|canceled)\b/.test(structured)) {
    return false;
  }
  return structured.includes("stop_requested") || structured.includes("stop requested") || structured.includes("cancel_requested");
}

function isStoppedEvent(event: BatchEvent): boolean {
  const structured = eventStructuredText(event);
  if (/\b(batch[._-]stopped|stopped|cancelled|canceled)\b/.test(structured)) {
    return true;
  }
  return false;
}

function isQaEvent(event: BatchEvent): boolean {
  return isQaEventType(event.type);
}

function scopedBatchEvent(event: BatchEvent, batch: BatchRecord): BatchEvent {
  const attached = { ...event, batchPath: batch.path };
  if (!event.repo && !event.target) {
    return {
      eventId: `${batch.batchId}:redacted:${event.type}:${event.timestamp || event.eventId}`,
      type: event.type,
      batchId: event.batchId,
      batchPath: batch.path,
      status: event.status,
      timestamp: event.timestamp,
      path: batch.path,
      message: "Unscoped batch-level event details hidden by dashboard scoping."
    };
  }
  return attached;
}

function qaStatusFromEvent(event: BatchEvent): QaValidationStatus {
  const structured = eventStructuredText(event);
  if (/(^|[._\-\s])(fail|failed|failure|blocked|needs_changes|changes_requested)($|[._\-\s])/.test(structured)) {
    return "failed";
  }
  if (/(^|[._\-\s])(pass|passed|validated|complete|completed|done|ready)($|[._\-\s])/.test(structured)) {
    return "passed";
  }
  if (/(^|[._\-\s])(start|started|in_progress|running|validating)($|[._\-\s])/.test(structured)) {
    return "in_progress";
  }
  if (/(^|[._\-\s])(request|requested|queued|pending)($|[._\-\s])/.test(structured)) {
    return "requested";
  }
  const value = eventText(event);
  if (/\b(fail|failed|failure|blocked|needs_changes|changes_requested)\b/.test(value)) {
    return "failed";
  }
  if (/\b(pass|passed|validated|complete|completed|done|ready)\b/.test(value)) {
    return "passed";
  }
  if (/\b(start|started|in_progress|running|validating)\b/.test(value)) {
    return "in_progress";
  }
  if (/\b(request|requested|queued|pending)\b/.test(value)) {
    return "requested";
  }
  return "unknown";
}

function qaDetail(status: QaValidationStatus, event: BatchEvent | undefined): string {
  if (!event) {
    return "No separate QA validation event found.";
  }
  const timestamp = event.timestamp ? ` at ${event.timestamp}` : "";
  if (status === "passed") {
    return `Latest separate QA validation passed${timestamp}.`;
  }
  if (status === "failed") {
    return `Latest separate QA validation failed${timestamp}.`;
  }
  if (status === "in_progress") {
    return `Separate QA validation is in progress${timestamp}.`;
  }
  if (status === "requested") {
    return `Separate QA validation was requested${timestamp}.`;
  }
  return `Latest separate QA validation status is unknown${timestamp}.`;
}

function emptyQaCounts(): BatchOperation["qa"] {
  return {
    total: 0,
    missing: 0,
    requested: 0,
    inProgress: 0,
    passed: 0,
    failed: 0,
    unknown: 0
  };
}

function repoRefsFromPrompt(value: string | undefined): string[] {
  return Array.from(new Set([...repoRefsFromText(value), ...repoRefsFromPromptHeaders(value)]));
}

interface OperatorMetadata {
  threadHandle?: string;
  host?: string;
  operator?: string;
  branch?: string;
  prUrl?: string;
}

function repoRefsFromOperatorMetadata(metadata: OperatorMetadata): string[] {
  return [
    ...repoRefsFromText(metadata.threadHandle),
    ...repoRefsFromText(metadata.host),
    ...repoRefsFromText(metadata.operator),
    ...repoRefsFromBranch(metadata.branch),
    ...repoRefsFromText(metadata.prUrl)
  ];
}

function hasOutOfScopeRepoRef(refs: string[], targetRepoSet: Set<string>): boolean {
  return refs.some((repo) => !targetRepoSet.has(repo));
}

function redactOutOfScopeOperatorMetadata<T extends OperatorMetadata>(metadata: T, targetRepoSet: Set<string>): T {
  const redacted = { ...metadata };
  if (hasOutOfScopeRepoRef(repoRefsFromText(redacted.threadHandle), targetRepoSet)) {
    delete redacted.threadHandle;
  }
  if (hasOutOfScopeRepoRef(repoRefsFromText(redacted.host), targetRepoSet)) {
    delete redacted.host;
  }
  if (hasOutOfScopeRepoRef(repoRefsFromText(redacted.operator), targetRepoSet)) {
    delete redacted.operator;
  }
  if (hasOutOfScopeRepoRef(repoRefsFromBranch(redacted.branch), targetRepoSet)) {
    delete redacted.branch;
  }
  if (hasOutOfScopeRepoRef(repoRefsFromText(redacted.prUrl), targetRepoSet)) {
    delete redacted.prUrl;
  }
  return redacted;
}

function hasOutOfScopeMetadata(batch: BatchRecord, targetRepoSet: Set<string>): boolean {
  const explicitRepos = [
    ...(batch.targets || []).map((target) => target.repo),
    ...(batch.targets || []).flatMap((target) => [...repoRefsFromText(target.url), ...repoRefsFromText(target.title)]),
    ...batch.lanes.flatMap((lane) => [
      ...repoRefsFromText(lane.name),
      ...repoRefsFromText(lane.owner),
      ...repoRefsFromText(lane.status),
      ...repoRefsFromOperatorMetadata(lane),
      ...lane.dependsOn.flatMap((dependency) => repoRefsFromText(dependency)),
      ...lane.blockedOn.flatMap((blockedOn) => repoRefsFromText(blockedOn))
    ]),
    ...(batch.reservations || []).map((reservation) => reservation.repo),
    ...(batch.reservations || []).flatMap((reservation) => [
      ...repoRefsFromText(reservation.reason),
      ...repoRefsFromText(reservation.owner),
      ...repoRefsFromText(reservation.laneName)
    ]),
    ...repoRefsFromText(batch.objective),
    ...repoRefsFromText(batch.launchPrompt),
    ...repoRefsFromPrompt(batch.launchPrompt)
  ].filter((repo): repo is string => Boolean(repo));

  return explicitRepos.some((repo) => !targetRepoSet.has(repo));
}

function hasOutOfScopeIdentity(batch: BatchRecord, targetRepoSet: Set<string>): boolean {
  const refs = [...repoRefsFromText(batch.batchId), ...repoRefsFromText(batch.path)];
  return refs.some((repo) => !targetRepoSet.has(repo));
}

function laneHasOutOfScopeMetadata(lane: BatchLane, targetRepoSet: Set<string>): boolean {
  const refs = [
    ...repoRefsFromText(lane.name),
    ...repoRefsFromText(lane.owner),
    ...repoRefsFromText(lane.status),
    ...repoRefsFromOperatorMetadata(lane),
    ...lane.dependsOn.flatMap((dependency) => repoRefsFromText(dependency)),
    ...lane.blockedOn.flatMap((blockedOn) => repoRefsFromText(blockedOn))
  ];
  return refs.some((repo) => !targetRepoSet.has(repo));
}

function safeScopedTargetNumbers(batch: BatchRecord, targetRepoSet: Set<string>): Set<string> {
  const groups = new Map<string, { hasOutOfScope: boolean }>();
  for (const target of batch.targets || []) {
    const group = groups.get(target.target) || { hasOutOfScope: false };
    const metadataRepos = [...repoRefsFromText(target.url), ...repoRefsFromText(target.title)];
    const hasOutOfScopeMetadataRepo = metadataRepos.some((repo) => !targetRepoSet.has(repo));
    const effectiveRepo = target.repo || batch.repo;
    if ((effectiveRepo && !targetRepoSet.has(effectiveRepo)) || hasOutOfScopeMetadataRepo) {
      group.hasOutOfScope = true;
    }
    groups.set(target.target, group);
  }
  return new Set(
    Array.from(groups.entries())
      .filter(([, group]) => !group.hasOutOfScope)
      .map(([target]) => target)
  );
}

function uniqueManifestRepoForTarget(batch: BatchRecord, target: string): string | undefined {
  const repos = new Set(manifestReposForTarget(batch, target));
  return repos.size === 1 ? Array.from(repos)[0] : undefined;
}

function manifestReposForTarget(batch: BatchRecord, target: string): string[] {
  return Array.from(
    new Set(
      (batch.targets || [])
        .filter((batchTarget) => batchTarget.target === target)
        .map((batchTarget) => batchTarget.repo || batch.repo)
        .filter((repo): repo is string => Boolean(repo))
    )
  );
}

function batchContainsRepo(batch: BatchRecord, repo: string): boolean {
  return batch.repo === repo || Boolean((batch.targets || []).some((target) => target.repo === repo));
}

function explicitBatchTargetRepoMatch(batch: BatchRecord, target: string, repo: string): boolean | undefined {
  const explicitRepos = (batch.targets || [])
    .filter((batchTarget) => batchTarget.target === target)
    .map((batchTarget) => batchTarget.repo || batch.repo)
    .filter((targetRepo): targetRepo is string => Boolean(targetRepo));
  if (explicitRepos.length === 0) {
    return undefined;
  }
  return explicitRepos.includes(repo);
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
    if (!batch.repo && !event.target && (isStopRequestEvent(event) || isStoppedEvent(event))) {
      return true;
    }
    return false;
  }

  if (event.repo && batch.repo) {
    if (!event.target && (isStopRequestEvent(event) || isStoppedEvent(event))) {
      return event.repo === batch.repo || Boolean((batch.targets || []).some((target) => target.repo === event.repo));
    }
    if (event.target) {
      const explicitMatch = explicitBatchTargetRepoMatch(batch, event.target, event.repo);
      if (explicitMatch !== undefined) {
        return explicitMatch;
      }
      if (!batchTargets(batch).has(event.target)) {
        return false;
      }
      const targetRepo = uniqueManifestRepoForTarget(batch, event.target);
      if (targetRepo) {
        return event.repo === targetRepo;
      }
    }
    return event.repo === batch.repo;
  }

  if (event.repo && !batch.repo) {
    if (!event.target) {
      return (
        (isStopRequestEvent(event) || isStoppedEvent(event)) &&
        Boolean((batch.targets || []).some((target) => target.repo === event.repo))
      );
    }
    const explicitMatch = explicitBatchTargetRepoMatch(batch, event.target, event.repo);
    if (explicitMatch !== undefined) {
      return explicitMatch;
    }
    if (!batchTargets(batch).has(event.target)) {
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
    manifestedBatches.flatMap((batch) =>
      Array.from(new Set([batch.repo, ...(batch.targets || []).map((target) => target.repo)].filter(Boolean))).map(
        (repo) => `${repo}:${batch.batchId}`
      )
    )
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
      targets: Array.from(batch.lanesByOwner.values()).flatMap((lane) =>
        lane.targets.map((target) => ({
          type: "unknown" as const,
          target
        }))
      ),
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

  if (
    warning.message.startsWith("Invalid AGENT_COORD_API_URL:") ||
    warning.message.startsWith("AGENT_COORD_API_TOKEN is required") ||
    warning.message.startsWith("Could not read coordination API ") ||
    /^Malformed coordination API (claims|heartbeats|batches|events) entry at index \d+$/.test(warning.message)
  ) {
    return warning;
  }

  const malformedApiRecord = warning.message.match(/^Malformed coordination API (claims|heartbeats|batches|events) record /);
  if (malformedApiRecord) {
    return {
      severity: warning.severity,
      message: `Malformed coordination API in an unscoped ${malformedApiRecord[1]} record.`
    };
  }

  const directoryRead = warning.message.match(/^Could not read coordination directory ([^:]+):/);
  if (directoryRead && ["claims", "heartbeats", "batches", "events", "history", "."].includes(directoryRead[1])) {
    return warning;
  }

  if (warning.message.startsWith("No coordination state found at ")) {
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
      message: `Claim holder heartbeat currently points at ${displayAttribution(claimAgentHeartbeat.repo)}${
        displayAttribution(claimAgentHeartbeat.target) === "unattributed" ? " (unattributed target)" : `#${claimAgentHeartbeat.target}`
      }.`
    });
  }

  for (const otherHeartbeat of workHeartbeats.filter((item) => claim && item.agentId !== claim.agentId)) {
    warnings.push({
      severity: "warning",
      repo,
      target,
      agentId: otherHeartbeat.agentId,
      message: `Work has a heartbeat from ${displayAttribution(otherHeartbeat.agentId)} but the claim is held by ${displayAttribution(claim?.agentId)}.`
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
      message: `Work is already scheduled in ${batchSignalIdentity(signal)} (${signal.status}).`
    });
    if (signal.blockedOn.length > 0) {
      warnings.push({
        severity: "warning",
        repo,
        target,
        message: `${batchSignalIdentity(signal)} is blocked on ${signal.blockedOn.join(", ")}.`
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
  const sanitizedClaims = nonReleasedClaims.map((claim) => redactOutOfScopeOperatorMetadata(claim, targetRepoSet));
  const sanitizedHeartbeats = input.heartbeats.map((heartbeat) => redactOutOfScopeOperatorMetadata(heartbeat, targetRepoSet));
  const sanitizedEvents = inputEvents.map((event) => redactOutOfScopeOperatorMetadata(event, targetRepoSet));
  const currentClaims = sanitizedClaims.filter((claim) => targetRepoSet.has(claim.repo));
  const repoScopedHeartbeats = sanitizedHeartbeats.filter((heartbeat) => Boolean(heartbeat.repo && targetRepoSet.has(heartbeat.repo)));
  const scopedGithubItems = input.githubItems.filter((item) => targetRepoSet.has(item.repo));
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
  for (const batch of input.batches) {
    if (!batch.repo) {
      for (const target of batch.targets || []) {
        if (target.repo && targetRepoSet.has(target.repo)) {
          const key = `${batch.batchId}:${target.target}`;
          reposByBatchTarget.set(key, new Set([...(reposByBatchTarget.get(key) || []), target.repo]));
        }
      }
    }
  }
  function uniqueRepoForBatchTarget(batchId: string, target: string): string | undefined {
    const repos = reposByBatchTarget.get(`${batchId}:${target}`);
    return repos?.size === 1 ? Array.from(repos)[0] : undefined;
  }
  const scopedManifestBatchesRaw = input.batches.flatMap((batch) => {
    if (hasOutOfScopeIdentity(batch, targetRepoSet)) {
      return [];
    }
    if (batch.repo) {
      const batchRepoInScope = targetRepoSet.has(batch.repo);
      const hasInScopeTargetRepo = Boolean((batch.targets || []).some((target) => target.repo && targetRepoSet.has(target.repo)));
      if (!batchRepoInScope && !hasInScopeTargetRepo) {
        return [];
      }
      const unsafeMetadata = !batchRepoInScope || hasOutOfScopeMetadata(batch, targetRepoSet);
      const safeTargets = safeScopedTargetNumbers(batch, targetRepoSet);
      const targets = (batch.targets || []).filter(
        (target) => safeTargets.has(target.target) && (!target.repo || targetRepoSet.has(target.repo))
      );
      const keptTargets = new Set(targets.map((target) => target.target));
      const structuredTargetNumbers = new Set((batch.targets || []).map((target) => target.target));
      const lanes =
        batch.targets && batch.targets.length > 0
          ? batch.lanes
              .filter((lane) => !laneHasOutOfScopeMetadata(lane, targetRepoSet))
              .map((lane) => ({
                ...lane,
                targets: lane.targets.filter(
                  (target) => keptTargets.has(target) || (batchRepoInScope && !structuredTargetNumbers.has(target))
                )
              }))
              .filter((lane) => lane.targets.length > 0)
          : batch.lanes.filter((lane) => !laneHasOutOfScopeMetadata(lane, targetRepoSet));
      return [
        {
          ...batch,
          repo: batchRepoInScope ? batch.repo : undefined,
          objective: unsafeMetadata ? undefined : batch.objective,
          targets,
          reservations: (batch.reservations || []).filter((reservation) =>
            reservation.repo ? targetRepoSet.has(reservation.repo) : !unsafeMetadata
          ),
          launchPrompt: unsafeMetadata ? undefined : batch.launchPrompt,
          source: batch.source || "manifest",
          lanes
        }
      ];
    }

    const safeTargets = batch.targets && batch.targets.length > 0 ? safeScopedTargetNumbers(batch, targetRepoSet) : undefined;
    const lanes = batch.lanes
      .filter((lane) => !laneHasOutOfScopeMetadata(lane, targetRepoSet))
      .map((lane) => ({
        ...lane,
        targets: lane.targets.filter(
          (target) =>
            (!safeTargets || safeTargets.has(target)) &&
            (manifestReposForTarget(batch, target).some((repo) => targetRepoSet.has(repo)) ||
              Boolean(uniqueRepoForBatchTarget(batch.batchId, target)))
        )
      }))
      .filter((lane) => lane.targets.length > 0);
    const keptTargets = new Set(lanes.flatMap((lane) => lane.targets));
    const targets = (batch.targets || []).filter((target) => {
      if (safeTargets && !safeTargets.has(target.target)) {
        return false;
      }
      if (target.repo) {
        return targetRepoSet.has(target.repo);
      }
      return keptTargets.has(target.target) && Boolean(uniqueRepoForBatchTarget(batch.batchId, target.target));
    });
    const reservations = (batch.reservations || []).filter((reservation) => Boolean(reservation.repo && targetRepoSet.has(reservation.repo)));
    const unsafeMetadata = hasOutOfScopeMetadata(batch, targetRepoSet);

    return lanes.length > 0 || targets.length > 0
      ? [
          {
            ...batch,
            objective: unsafeMetadata ? undefined : batch.objective,
            targets,
            reservations,
            launchPrompt: unsafeMetadata ? undefined : batch.launchPrompt,
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
  const scopedHeartbeats = sanitizedHeartbeats.filter((heartbeat) => {
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
  const scopedEvents = sanitizedEvents
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
        return matchingBatches.map((batch) => scopedBatchEvent(event, batch));
      }
      if (batchesWithSameId.length > 0) {
        return [];
      }
      return event.repo && targetRepoSet.has(event.repo) ? [event] : [];
    })
    .sort(compareEventRecency);
  const eventsByWork = new Map<string, BatchEvent[]>();
  const eventsByAgent = new Map<string, BatchEvent[]>();
  for (const event of scopedEvents) {
    if (event.repo && event.target) {
      const id = workId(event.repo, event.target);
      eventsByWork.set(id, [...(eventsByWork.get(id) || []), event]);
    }
    if (event.agentId) {
      const agentEvents = eventsByAgent.get(event.agentId);
      if (agentEvents) {
        agentEvents.push(event);
      } else {
        eventsByAgent.set(event.agentId, [event]);
      }
    }
  }
  const nonterminalEventWorkKeys = new Set(
    Array.from(eventsByWork.entries())
      .filter(([, events]) => {
        const lifecycleEvent = events.find((event) => !isQaEventType(event.type));
        return Boolean(
          lifecycleEvent &&
            !TERMINAL_EVENT_PATTERN.test(lifecycleEvent.type) &&
            !TERMINAL_EVENT_PATTERN.test(lifecycleEvent.status || "")
        );
      })
      .map(([id]) => id)
  );
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
      if (ownerHeartbeat && !heartbeat) {
        batchWarnings.push({
          severity: "warning",
          repo: batch.repo || (input.targetRepos.length === 1 ? input.targetRepos[0] : undefined),
          agentId: lane.owner,
          message: `Lane ${displayAttribution(batch.batchId)}:${displayAttribution(lane.name)} owner heartbeat points at ${displayAttribution(ownerHeartbeat.repo)}${
            displayAttribution(ownerHeartbeat.target) === "unattributed" ? " (unattributed target)" : `#${ownerHeartbeat.target}`
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
  const batchTargetsByWork = new Map<string, NonNullable<BatchRecord["targets"]>[number]>();
  const batchEvidenceByWork = new Map<string, MetadataSource[]>();
  const savedBatchMembershipByWork = new Set<string>();
  for (const batch of batches) {
    for (const target of batch.targets || []) {
      const repo = target.repo || batch.repo || uniqueRepoForBatchTarget(batch.batchId, target.target);
      if (repo) {
        const id = workId(repo, target.target);
        batchTargetsByWork.set(id, target);
        const source: MetadataSource = batch.source === "inferred" ? "inferred_batch" : "manifest";
        if (source === "manifest") {
          savedBatchMembershipByWork.add(id);
        }
        const existingEvidence = batchEvidenceByWork.get(id) || [];
        if (!existingEvidence.includes(source)) {
          batchEvidenceByWork.set(id, [...existingEvidence, source]);
        }
      }
    }
    for (const lane of batch.lanes) {
      for (const target of lane.targets) {
        const manifestRepos = new Set(manifestReposForTarget(batch, target));
        const repos =
          manifestRepos.size > 0
            ? Array.from(manifestRepos)
            : [batch.repo || uniqueRepoForBatchTarget(batch.batchId, target)].filter(
                (repo): repo is string => Boolean(repo)
              );
        if (repos.length === 0) {
          continue;
        }
        for (const repo of repos) {
          const id = workId(repo, target);
          const source: MetadataSource = batch.source === "inferred" ? "inferred_batch" : "manifest";
          const existingEvidence = batchEvidenceByWork.get(id) || [];
          if (!existingEvidence.includes(source)) {
            batchEvidenceByWork.set(id, [...existingEvidence, source]);
          }
          batchSignalsByWork.set(id, [
            ...(batchSignalsByWork.get(id) || []),
            {
              batchId: batch.batchId,
              laneName: lane.name,
              status: lane.status,
              blockedOn: lane.blockedOn,
              updatedAt: batch.updatedAt
            }
          ]);
        }
      }
    }
  }
  for (const [id, workEvents] of eventsByWork) {
    if (!nonterminalEventWorkKeys.has(id)) continue;
    const identityEvents = workEvents.filter((candidate) =>
      (candidate.batchId || candidate.laneName)
      && !TERMINAL_EVENT_PATTERN.test(candidate.type)
      && !TERMINAL_EVENT_PATTERN.test(candidate.status || "")
    );
    const existing = batchSignalsByWork.get(id) || [];
    const eventSignals = identityEvents.flatMap((event) => {
      if ([...existing].some((signal) => signal.batchId === event.batchId && signal.laneName === event.laneName)) return [];
      return [{
        ...(event.batchId ? { batchId: event.batchId } : {}),
        ...(event.laneName ? { laneName: event.laneName } : {}),
        status: event.status || event.type,
        blockedOn: [],
        updatedAt: event.timestamp
      }];
    }).filter((signal, index, signals) => signals.findIndex((candidate) => candidate.batchId === signal.batchId && candidate.laneName === signal.laneName) === index);
    if (eventSignals.length > 0) batchSignalsByWork.set(id, [...existing, ...eventSignals]);
    const evidence = batchEvidenceByWork.get(id) || [];
    if (identityEvents.length > 0 && !evidence.includes("event")) batchEvidenceByWork.set(id, [...evidence, "event"]);
  }
  const workKeys = new Set<string>([
    ...claimsByWork.keys(),
    ...previewsByWork.keys(),
    ...batchTargetsByWork.keys(),
    ...batchSignalsByWork.keys(),
    ...nonterminalEventWorkKeys
  ]);

  for (const heartbeat of scopedHeartbeats) {
    if (heartbeat.repo && heartbeat.target) {
      workKeys.add(workId(heartbeat.repo, heartbeat.target));
    }
  }

  let workItems: WorkItem[] = Array.from(workKeys)
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
      const batchTarget = batchTargetsByWork.get(id);
      const eventRecovery = !claim && !heartbeat && batchSignals.length === 0 && nonterminalEventWorkKeys.has(id);
      const schedulingState = eventRecovery
        ? "started_not_processing"
        : classifyWork(claim, heartbeat, batchSignals, savedBatchMembershipByWork.has(id));
      const warnings = warningsForWork(repo, target, claim, heartbeat, workHeartbeats, claimAgentHeartbeat, batchSignals, schedulingState);
      const evidence: MetadataSource[] = [];
      if (claim) evidence.push("claim");
      if (heartbeat) evidence.push("heartbeat");
      if ((eventsByWork.get(id) || []).length > 0) evidence.push("event");
      if (github) evidence.push("github");
      for (const source of batchEvidenceByWork.get(id) || []) {
        if (!evidence.includes(source)) evidence.push(source);
      }
      const hasObservedEvidence = Boolean(claim || heartbeat || (eventsByWork.get(id) || []).length > 0 || github?.loadState === "loaded");
      const hasInferredEvidence = (batchEvidenceByWork.get(id) || []).length > 0;
      const provenance: OperatorRowProvenance = {
        classification: hasObservedEvidence ? "observed" : hasInferredEvidence ? "inferred" : "unknown",
        evidence
      };

      return {
        id,
        repo,
        target,
        type: github?.coordinatedType || github?.type || batchTarget?.type || "unknown",
        claim,
        heartbeat,
        batchSignals,
        github,
        provenance,
        schedulingState,
        warnings,
        selected: false
      };
    });

  const preDerivationQaValidations: QaValidationItem[] = workItems
    .filter((item) => item.type === "pull_request")
    .flatMap((item) => {
      const signals = item.batchSignals && item.batchSignals.length > 0 ? item.batchSignals : [undefined];
      return signals.map((batchSignal) => {
        const latestEvent = scopedEvents
          .filter(
            (event) =>
              event.repo === item.repo &&
              event.target === item.target &&
              isQaEvent(event) &&
              (!batchSignal || event.batchId === batchSignal.batchId)
          )
          .sort(compareEventRecency)[0];
        const status = latestEvent ? qaStatusFromEvent(latestEvent) : "missing";
        const id = batchSignal ? `${item.id}:${batchSignal.batchId}:${batchSignal.laneName}` : item.id;

        return {
          id,
          repo: item.repo,
          target: item.target,
          type: item.type,
          title: item.github?.title || batchTargetsByWork.get(item.id)?.title,
          url: item.github?.url || batchTargetsByWork.get(item.id)?.url,
          batchId: batchSignal?.batchId,
          laneName: batchSignal?.laneName,
          status,
          detail: qaDetail(status, latestEvent),
          latestEvent
        };
      });
    });

  const preDerivationBatchOperations: BatchOperation[] = batches.map((batch) => {
    const batchEvents = scopedEvents.filter((event) =>
      event.batchPath ? event.batchPath === batch.path : event.batchId === batch.batchId && (!batch.repo || event.repo === batch.repo)
    );
    const latestEvent = batchEvents[0];
    const stopEvents = batchEvents.filter((event) => isStopRequestEvent(event) || isStoppedEvent(event));
    const latestStopEvent = stopEvents.sort(compareEventRecency)[0];
    const controlStatus = latestStopEvent
      ? isStoppedEvent(latestStopEvent)
        ? "stopped"
        : "stop_requested"
      : "running";
    const qa = emptyQaCounts();
    for (const validation of preDerivationQaValidations.filter((item) => item.batchId === batch.batchId && batchContainsRepo(batch, item.repo))) {
      qa.total += 1;
      if (validation.status === "in_progress") {
        qa.inProgress += 1;
      } else {
        qa[validation.status] += 1;
      }
    }

    return {
      batchId: batch.batchId,
      repo: batch.repo,
      batchPath: batch.path,
      controlStatus,
      eventCount: batchEvents.length,
      latestEventAt: latestEvent?.timestamp,
      latestEventType: latestEvent?.type,
      stopRequestedAt: stopEvents.filter(isStopRequestEvent).sort(compareEventRecency)[0]?.timestamp,
      stoppedAt: stopEvents.filter(isStoppedEvent).sort(compareEventRecency)[0]?.timestamp,
      qa
    };
  });

  workItems = deriveWorkItems({
    workItems,
    events: scopedEvents,
    qaValidations: preDerivationQaValidations,
    batchOperations: preDerivationBatchOperations,
    batches,
    now: input.now
  });
  workItems = workItems.map((item) => isOperationalWorkItem(item) ? item : { ...item, warnings: [] });
  const workItemsById = new Map(workItems.map((item) => [item.id, item]));
  const operationalWorkIds = new Set(workItems.filter(isOperationalWorkItem).map((item) => item.id));
  const qaValidations = preDerivationQaValidations.filter((validation) =>
    operationalWorkIds.has(workId(validation.repo, validation.target))
  );
  const batchOperations = preDerivationBatchOperations.map((operation) => {
    const batch = batches.find((candidate) =>
      operation.batchPath ? candidate.path === operation.batchPath : candidate.batchId === operation.batchId
    );
    const qa = emptyQaCounts();
    for (const validation of qaValidations.filter((item) =>
      item.batchId === operation.batchId && (!batch || batchContainsRepo(batch, item.repo))
    )) {
      qa.total += 1;
      if (validation.status === "in_progress") {
        qa.inProgress += 1;
      } else {
        qa[validation.status] += 1;
      }
    }
    return { ...operation, qa };
  });
  const nonterminalWorkItems = workItems.filter((item) => !item.terminalState);
  const hasUnreconciledCoordinatedWork = nonterminalWorkItems.some((item) => {
    return hasCoordinationEvidence(item) && item.github?.loadState !== "loaded";
  });

  const workByAgent = new Map<string, WorkItem[]>();
  for (const item of workItems) {
    const eventAgentId = eventsByWork.get(item.id)?.find((event) => event.agentId)?.agentId;
    const coordinationAgentIds = [item.claim?.agentId, item.heartbeat?.agentId].filter(
      (agentId): agentId is string => Boolean(agentId)
    );
    const agentIds = new Set(coordinationAgentIds.length > 0 ? coordinationAgentIds : eventAgentId ? [eventAgentId] : []);
    for (const agentId of agentIds) {
      workByAgent.set(agentId, [...(workByAgent.get(agentId) || []), item]);
    }
  }

  const agentIds = new Set<string>([
    ...currentClaims.map((claim) => claim.agentId),
    ...scopedHeartbeats.map((heartbeat) => heartbeat.agentId),
    ...scopedEvents.map((event) => event.agentId).filter((agentId): agentId is string => Boolean(agentId))
  ]);
  const agents: AgentSummary[] = Array.from(agentIds)
    .sort()
    .map((agentId) => {
      const heartbeat = heartbeatsByAgent.get(agentId);
      const claims = currentClaims.filter((claim) => claim.agentId === agentId);
      const agentEvents = eventsByAgent.get(agentId) || [];
      const latestEvent = agentEvents[0];
      const heartbeatMachineId = normalizedMetadataValue(heartbeat?.machineId);
      const claimWithMachine = claims.find((claim) => normalizedMetadataValue(claim.machineId));
      const claimMachineId = normalizedMetadataValue(claimWithMachine?.machineId);
      const eventWithMachine = agentEvents.find((event) => normalizedMetadataValue(event.machineId));
      const eventMachineId = normalizedMetadataValue(eventWithMachine?.machineId);
      const currentWork = workByAgent.get(agentId) || [];
      const warnings = currentWork.flatMap((item) => item.warnings);
      const machineId = heartbeatMachineId || claimMachineId || eventMachineId;
      const machineMetadata = heartbeatMachineId
        ? { value: heartbeatMachineId, state: "observed" as const, source: "heartbeat" as const }
        : claimMachineId
          ? { value: claimMachineId, state: "observed" as const, source: "claim" as const }
          : eventMachineId
            ? { value: eventMachineId, state: "observed" as const, source: "event" as const }
            : heartbeat
              ? { state: "missing" as const, source: "heartbeat" as const }
              : { state: "not_applicable" as const };

      return {
        agentId,
        machineId,
        machineMetadata,
        heartbeat,
        latestEvent,
        claims,
        currentWork,
        liveness: heartbeat?.liveness || "no-heartbeat",
        warnings
      };
    });

  const healthItems: HealthItem[] = [];
  for (const agent of agents) {
    const heartbeatWorkItem = agent.heartbeat?.repo && agent.heartbeat.target
      ? workItemsById.get(workId(agent.heartbeat.repo, agent.heartbeat.target))
      : undefined;
    if (
      agent.machineMetadata?.state === "missing"
      && agent.heartbeat
      && (!heartbeatWorkItem || isOperationalWorkItem(heartbeatWorkItem))
    ) {
      healthItems.push(
        healthItem({
          severity: "warning",
          category: "machine",
          title: "Heartbeat missing machine id",
          detail: `${displayAttribution(agent.agentId)} does not report machine_id, so machine ownership cannot be shown reliably.`,
          agentId: agent.agentId,
          repo: agent.heartbeat.repo,
          target: agent.heartbeat.target,
          batchId: agent.heartbeat.batchId
        })
      );
    }
  }

  for (const claim of currentClaims) {
    const item = workItemsById.get(workId(claim.repo, claim.target));
    if (
      item
      && isOperationalWorkItem(item)
      && claim.status === "active"
      && !heartbeatsByWork.get(workId(claim.repo, claim.target))?.some((heartbeat) => heartbeat.agentId === claim.agentId)
    ) {
      healthItems.push(
        healthItem({
          severity: "warning",
          category: "heartbeat",
          title: "Active claim has no matching heartbeat",
          detail: `${displayAttribution(claim.agentId)} holds ${displayWorkRef(claim.repo, claim.target)}, but no heartbeat currently points at that work.`,
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
    if (isOperationalWorkItem(item) && item.schedulingState === "started_not_processing") {
      healthItems.push(
        healthItem({
          severity: "warning",
          category: item.batchSignals?.length ? "batch" : "heartbeat",
          title: "Work started but not currently processing",
          detail: `${displayWorkRef(item.repo, item.target)} has coordination state but no live/stale holder.`,
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
          title: "Batch plan missing",
          detail: `${displayAttribution(batch.batchId)} was inferred from coordination records because no saved batch plan was found.`,
          repo: batch.repo,
          batchId: batch.batchId
        })
      );
    } else if (!batch.launchPrompt) {
      healthItems.push(
        healthItem({
          severity: "warning",
          category: "batch",
          title: "Prompt missing",
          detail: `${displayAttribution(batch.batchId)} has a saved batch plan, but no coordination prompt was saved.`,
          repo: batch.repo,
          batchId: batch.batchId
        })
      );
    } else {
      const promptHealth = promptTargetHealth(batch);
      if (promptHealth) {
        healthItems.push(
          healthItem({
            severity: "warning",
            category: "batch",
            title: promptHealth.title,
            detail: promptHealth.detail,
            repo: batch.repo,
            batchId: batch.batchId
          })
        );
      }
    }

    if (!eventsByBatchPath.has(batch.path)) {
      healthItems.push(
        healthItem({
          severity: "info",
          category: "history",
          title: "Batch has no history events",
          detail:
            batch.source === "inferred"
              ? `${displayAttribution(batch.batchId)} has inferred lanes, but no events/history records were found.`
              : `${displayAttribution(batch.batchId)} has a saved batch plan, but no events/history records were found.`,
          repo: batch.repo,
          batchId: batch.batchId
        })
      );
    }

    for (const lane of batch.lanes) {
      const laneWorkItems = workItems.filter((item) =>
        batchContainsRepo(batch, item.repo)
        && item.batchSignals?.some((signal) => signal.batchId === batch.batchId && signal.laneName === lane.name)
      );
      const hasOperationalLaneWork = laneWorkItems.length === 0 || laneWorkItems.some(isOperationalWorkItem);
      if (lane.liveness === "no-heartbeat" && !TERMINAL_STATUSES.has(lane.status) && hasOperationalLaneWork) {
        healthItems.push(
          healthItem({
            severity: "warning",
            category: "batch",
            title: "Batch lane has no heartbeat",
            detail: `${displayAttribution(batch.batchId)}:${displayAttribution(lane.name)} is ${lane.status}, but owner ${displayAttribution(lane.owner)} has no matching heartbeat.`,
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
    batchOperations,
    qaValidations,
    healthItems,
    warnings: [...scopedInputWarnings, ...scopeWarnings, ...workItems.flatMap((item) => item.warnings), ...batchWarnings],
    githubMergeTimeStatus: "unavailable",
    ...(hasUnreconciledCoordinatedWork ? {} : { trulyOpenCount: nonterminalWorkItems.length }),
    trulyOpenCountStatus: hasUnreconciledCoordinatedWork ? "unknown" : "available"
  };
}
