import type { BatchEvent, ClaimRecord, HeartbeatRecord, Liveness } from "./types";

export interface LivenessSpan {
  agentId: string;
  machineId?: string;
  threadHandle?: string;
  host?: string;
  operator?: string;
  branch?: string;
  prUrl?: string;
  status: string;
  liveness: Exclude<Liveness, "unknown" | "no-heartbeat">;
  startedAt: string;
  endedAt: string;
}

export interface LivenessBoundary {
  agentId: string;
  endedAt: string;
}

export interface ClaimCustodyEvent {
  action: "acquired" | "renewed" | "released" | "taken_over" | "unknown";
  agentId: string;
  previousAgentId?: string;
  machineId?: string;
  threadHandle?: string;
  host?: string;
  operator?: string;
  generation?: number;
  timestamp?: string;
  branch?: string;
  prUrl?: string;
  /** The append-only telemetry event from which this custody transition was derived. */
  sourceEventId?: string;
  /** The source event's path, which makes caller-supplied event IDs unambiguous. */
  sourceEventPath?: string;
}

export interface PhaseSpan {
  eventId: string;
  /** The append-only event path, paired with eventId for stable provenance. */
  eventPath?: string;
  phase: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  agentId?: string;
  machineId?: string;
  threadHandle?: string;
  host?: string;
  operator?: string;
  branch?: string;
  prUrl?: string;
  message?: string;
}

export interface CustodyTimeline {
  repo: string;
  target: string;
  claims: ClaimCustodyEvent[];
  liveness: LivenessSpan[];
  phases: PhaseSpan[];
  events: BatchEvent[];
  branches: string[];
  prUrls: string[];
}

export interface BuildCustodyTimelineInput {
  repo: string;
  target: string;
  claims: ClaimRecord[];
  heartbeats: HeartbeatRecord[];
  events: BatchEvent[];
  now?: Date;
}

const DEAD_AFTER_TTL_MULTIPLIER = 4;
const TERMINAL_LIFECYCLE_PATTERN = /(?:^|[._\s-])(done|final|merged|complete(?:d)?|released|cancel(?:led|ed)?|handoff)(?:$|[._\s-])/i;
const OWNERSHIP_EVENT_TYPES = new Set([
  "claim", "claimed", "acquire", "acquired", "takeover", "renew", "renewed", "continued", "resumed", "heartbeat", "handoff", "release", "released", "lane.started", "lane.handoff"
]);

function time(value: string): number | undefined {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

/**
 * Converts heartbeat snapshots into contiguous liveness intervals. A later
 * heartbeat ends any prior interval for the same holder, so an observed gap
 * remains visible as stale/dead rather than being hidden as raw records.
 */
export function buildLivenessSpans(heartbeats: HeartbeatRecord[], now = new Date(), boundaries: LivenessBoundary[] = []): LivenessSpan[] {
  const nowMs = now.getTime();
  const byHolder = new Map<string, HeartbeatRecord[]>();
  for (const heartbeat of heartbeats) {
    // A renewed heartbeat from another chat or machine still supersedes the
    // previous liveness interval for this agent on the same target.
    const key = heartbeat.agentId;
    byHolder.set(key, [...(byHolder.get(key) || []), heartbeat]);
  }

  const spans: LivenessSpan[] = [];
  for (const records of byHolder.values()) {
    const ordered = [...records].sort((left, right) => (time(left.updatedAt) || 0) - (time(right.updatedAt) || 0));
    ordered.forEach((heartbeat, index) => {
      const startedMs = time(heartbeat.updatedAt);
      const expiresMs = time(heartbeat.expiresAt);
      if (startedMs === undefined || expiresMs === undefined || expiresMs <= startedMs || startedMs > nowMs) return;
      const nextMs = time(ordered[index + 1]?.updatedAt || "") || nowMs;
      const boundaryMs = boundaries
        .filter((boundary) => boundary.agentId === heartbeat.agentId)
        .map((boundary) => time(boundary.endedAt))
        .find((candidate): candidate is number => candidate !== undefined && candidate > startedMs);
      const endsAt = Math.min(Math.max(Math.min(nextMs, boundaryMs || nowMs), startedMs), nowMs);
      const ttl = expiresMs - startedMs;
      const deadAt = startedMs + ttl * DEAD_AFTER_TTL_MULTIPLIER;
      const details = {
        agentId: heartbeat.agentId,
        ...(heartbeat.machineId ? { machineId: heartbeat.machineId } : {}),
        ...(heartbeat.threadHandle ? { threadHandle: heartbeat.threadHandle } : {}),
        ...(heartbeat.host ? { host: heartbeat.host } : {}),
        ...(heartbeat.operator ? { operator: heartbeat.operator } : {}),
        ...(heartbeat.branch ? { branch: heartbeat.branch } : {}),
        ...(heartbeat.prUrl ? { prUrl: heartbeat.prUrl } : {}),
        status: heartbeat.status
      };
      const append = (liveness: LivenessSpan["liveness"], start: number, end: number) => {
        if (end > start) spans.push({ ...details, liveness, startedAt: iso(start), endedAt: iso(end) });
      };
      append("live", startedMs, Math.min(expiresMs, endsAt));
      append("stale", Math.min(expiresMs, endsAt), Math.min(deadAt, endsAt));
      append("dead", Math.min(deadAt, endsAt), endsAt);
    });
  }

  return spans.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
}

function optionalFields(record: Pick<ClaimRecord, "machineId" | "threadHandle" | "host" | "operator" | "branch" | "prUrl">): Omit<ClaimCustodyEvent, "action" | "agentId" | "previousAgentId" | "generation" | "timestamp"> {
  return {
    ...(record.machineId ? { machineId: record.machineId } : {}),
    ...(record.threadHandle ? { threadHandle: record.threadHandle } : {}),
    ...(record.host ? { host: record.host } : {}),
    ...(record.operator ? { operator: record.operator } : {}),
    ...(record.branch ? { branch: record.branch } : {}),
    ...(record.prUrl ? { prUrl: record.prUrl } : {})
  };
}

function optionalEventFields(event: BatchEvent): Omit<ClaimCustodyEvent, "action" | "agentId" | "previousAgentId" | "timestamp"> {
  return {
    ...(event.generation === undefined ? {} : { generation: event.generation }),
    ...(event.machineId ? { machineId: event.machineId } : {}),
    ...(event.threadHandle ? { threadHandle: event.threadHandle } : {}),
    ...(event.host ? { host: event.host } : {}),
    ...(event.operator ? { operator: event.operator } : {}),
    ...(event.branch ? { branch: event.branch } : {}),
    ...(event.prUrl ? { prUrl: event.prUrl } : {}),
    ...(event.eventId ? { sourceEventId: event.eventId } : {}),
    ...(event.path ? { sourceEventPath: event.path } : {})
  };
}

function claimTimestamp(claim: ClaimRecord): string | undefined {
  return claim.updatedAt || claim.claimedAt;
}

function validClaimTimestamp(claim: ClaimRecord): string | undefined {
  const timestamp = claimTimestamp(claim);
  return timestamp && time(timestamp) !== undefined ? timestamp : undefined;
}

function snapshotCustodyEvent(claim: ClaimRecord, action: "renewed" | "released" | "unknown"): ClaimCustodyEvent {
  const timestamp = validClaimTimestamp(claim);
  return {
    action,
    agentId: claim.agentId,
    ...(claim.generation === undefined ? {} : { generation: claim.generation }),
    ...(timestamp ? { timestamp } : {}),
    ...optionalFields(claim)
  };
}

function matchesCurrentSnapshot(event: ClaimCustodyEvent | undefined, claim: ClaimRecord): boolean {
  const timestamp = validClaimTimestamp(claim);
  return Boolean(timestamp
    && event
    && event.agentId === claim.agentId
    && event.timestamp === timestamp
    && event.generation === claim.generation
    && event.machineId === claim.machineId
    && event.threadHandle === claim.threadHandle
    && event.host === claim.host
    && event.operator === claim.operator
    && event.branch === claim.branch
    && event.prUrl === claim.prUrl);
}

function livenessBoundaries(claims: ClaimCustodyEvent[]): LivenessBoundary[] {
  let activeAgent: string | undefined;
  const boundaries: LivenessBoundary[] = [];
  for (const claim of claims) {
    const endedAt = claim.timestamp;
    if (!endedAt) continue;
    if (claim.action === "released") {
      boundaries.push({ agentId: claim.agentId, endedAt });
      if (activeAgent === claim.agentId) activeAgent = undefined;
      continue;
    }
    if (activeAgent && activeAgent !== claim.agentId) {
      boundaries.push({ agentId: activeAgent, endedAt });
    }
    activeAgent = claim.agentId;
  }
  return boundaries;
}

function isPhaseEvent(event: BatchEvent): boolean {
  const type = event.type.trim().toLowerCase();
  return type === "phase"
    || type.startsWith("phase.")
    || /^(?:plan|implement|verify|push|review)(?:[._\s-]|$)/.test(type);
}

function phaseName(event: BatchEvent): string {
  return event.status || event.type;
}

function isTerminalLifecycleEvent(event: BatchEvent): boolean {
  return TERMINAL_LIFECYCLE_PATTERN.test(event.type)
    || TERMINAL_LIFECYCLE_PATTERN.test(event.status || "")
    || /(?:^|[._\s-])handoff(?:$|[._\s-])/i.test(event.type);
}

function isRenewalEvidence(event: BatchEvent): boolean {
  return /(?:^|[._\s-])(heartbeat|renew(?:ed|al)?|continued|resumed|claim(?:ed)?|acquir(?:e|ed)|take[._\s-]?over|started)(?:$|[._\s-])/i.test(event.type)
    || (/^(?:claim|custody|lifecycle)$/i.test(event.type)
      && /^(?:acquired|takeover|renewed|continued|resumed)$/i.test(event.status || ""));
}

/**
 * Only explicit claim lifecycle telemetry may establish or transfer custody.
 * Phase, QA, review, blocked, and coordinator annotations are useful timeline
 * evidence, but their agent attribution is not an ownership assertion.
 */
function isOwnershipBearingEvent(event: BatchEvent): boolean {
  const type = event.type.trim().toLowerCase().replace(/[\s_-]+/g, ".");
  if (type === "done" || type === "lane.done") return true;
  if (OWNERSHIP_EVENT_TYPES.has(type)) return true;
  if (/^(?:claim|custody)\.(?:acquired|takeover|renewed|continued|resumed|released)$/.test(type)) return true;
  return /^(?:claim|custody|lifecycle)$/i.test(event.type)
    && /^(?:acquired|takeover|renewed|continued|resumed|released|handoff|done)$/i.test(event.status || "");
}

function isCustodyTerminalEvent(event: BatchEvent): boolean {
  if (!isOwnershipBearingEvent(event)) return false;
  const type = event.type.trim().toLowerCase().replace(/[\s_-]+/g, ".");
  return type === "done"
    || type === "lane.done"
    || /(?:^|[._\s-])(handoff|release(?:d)?)(?:$|[._\s-])/i.test(event.type)
    || (/^(?:claim|custody|lifecycle)$/i.test(event.type) && TERMINAL_LIFECYCLE_PATTERN.test(event.status || ""));
}

function isHistoricalSnapshot(claim: ClaimRecord): boolean {
  return /(?:^|\/)(?:history|events)(?:\/|$)/i.test(claim.path);
}

function custodyEvents(events: BatchEvent[], currentClaim?: ClaimRecord): ClaimCustodyEvent[] {
  const custody: ClaimCustodyEvent[] = [];
  let activeAgent: string | undefined;

  for (const event of events) {
    if (!event.agentId || !event.timestamp || time(event.timestamp) === undefined) continue;
    if (!isOwnershipBearingEvent(event)) continue;
    if (isCustodyTerminalEvent(event)) {
      if (activeAgent === event.agentId) {
        custody.push({ action: "released", agentId: event.agentId, timestamp: event.timestamp, ...optionalEventFields(event) });
        activeAgent = undefined;
      }
      continue;
    }
    if (!activeAgent) {
      custody.push({ action: "acquired", agentId: event.agentId, timestamp: event.timestamp, ...optionalEventFields(event) });
      activeAgent = event.agentId;
      continue;
    }
    if (activeAgent !== event.agentId) {
      custody.push({ action: "taken_over", agentId: event.agentId, previousAgentId: activeAgent, timestamp: event.timestamp, ...optionalEventFields(event) });
      activeAgent = event.agentId;
      continue;
    }
    if (isRenewalEvidence(event)) {
      custody.push({ action: "renewed", agentId: event.agentId, timestamp: event.timestamp, ...optionalEventFields(event) });
    }
  }

  if (!currentClaim) return custody;
  const last = custody.at(-1);
  if (currentClaim.status === "released") {
    if (!matchesCurrentSnapshot(last, currentClaim) || last?.action !== "released") {
      custody.push(snapshotCustodyEvent(currentClaim, "released"));
    }
    return custody;
  }
  if (currentClaim.status !== "active") return custody;
  if (last?.agentId === currentClaim.agentId && last.action !== "released") {
    if (!matchesCurrentSnapshot(last, currentClaim)) {
      custody.push(snapshotCustodyEvent(currentClaim, "renewed"));
    }
    return custody;
  }

  // A current snapshot proves only its present holder. Without an attributed
  // append-only event, it cannot honestly establish when or how custody began.
  custody.push(snapshotCustodyEvent(currentClaim, "unknown"));
  return custody;
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

/** Builds a read-only, target-scoped custody record from observed coordination history. */
export function buildCustodyTimeline(input: BuildCustodyTimelineInput): CustodyTimeline {
  const now = input.now || new Date();
  const matchingClaims = input.claims
    .filter((claim) => claim.repo === input.repo && claim.target === input.target && !isHistoricalSnapshot(claim))
    .sort((left, right) => (time(claimTimestamp(left) || "") || 0) - (time(claimTimestamp(right) || "") || 0));
  // Claim files are overwriteable current snapshots. Keep only the latest one;
  // append-only event telemetry is the durable ownership history.
  const currentClaim = matchingClaims.at(-1);
  const matchingHeartbeats = input.heartbeats.filter((heartbeat) => heartbeat.repo === input.repo && heartbeat.target === input.target);
  const events = input.events
    .filter((event) => event.repo === input.repo && event.target === input.target)
    .sort((left, right) => (time(left.timestamp || "") || 0) - (time(right.timestamp || "") || 0));
  const claims = custodyEvents(events, currentClaim);
  const phaseEvents = events
    .filter(isPhaseEvent)
    .filter((event) => time(event.timestamp || "") !== undefined)
    .filter((event, index, candidates) => index === 0 || phaseName(candidates[index - 1]).toLowerCase() !== phaseName(event).toLowerCase());
  const phases = phaseEvents.map((event, index) => {
    const startedAt = event.timestamp!;
    const startedMs = time(startedAt)!;
    const nextPhaseMs = time(phaseEvents[index + 1]?.timestamp || "") || now.getTime();
    const terminalMs = [
      ...events.filter((candidate) => isTerminalLifecycleEvent(candidate)).map((candidate) => candidate.timestamp),
      ...claims.filter((claim) => claim.action === "released").map((claim) => claim.timestamp)
    ]
      .map((candidate) => time(candidate || ""))
      .filter((candidate): candidate is number => candidate !== undefined && candidate > startedMs)
      .sort((left, right) => left - right)[0];
    const endedMs = Math.max(startedMs, Math.min(nextPhaseMs, terminalMs || now.getTime(), now.getTime()));
    return {
      eventId: event.eventId,
      ...(event.path ? { eventPath: event.path } : {}),
      phase: phaseName(event),
      startedAt,
      endedAt: iso(endedMs),
      durationMs: endedMs - startedMs,
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.machineId ? { machineId: event.machineId } : {}),
      ...(event.threadHandle ? { threadHandle: event.threadHandle } : {}),
      ...(event.host ? { host: event.host } : {}),
      ...(event.operator ? { operator: event.operator } : {}),
      ...(event.branch ? { branch: event.branch } : {}),
      ...(event.prUrl ? { prUrl: event.prUrl } : {}),
      ...(event.message ? { message: event.message } : {})
    } satisfies PhaseSpan;
  });

  return {
    repo: input.repo,
    target: input.target,
    claims,
    liveness: buildLivenessSpans(matchingHeartbeats, now, livenessBoundaries(claims)),
    phases,
    events,
    branches: unique([...events.map((event) => event.branch), currentClaim?.branch, ...matchingHeartbeats.map((heartbeat) => heartbeat.branch)]),
    prUrls: unique([...events.map((event) => event.prUrl), currentClaim?.prUrl, ...matchingHeartbeats.map((heartbeat) => heartbeat.prUrl)])
  };
}
