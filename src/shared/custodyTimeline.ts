import type { BatchEvent, ClaimRecord, HeartbeatRecord, Liveness } from "./types";

export interface LivenessSpan {
  agentId: string;
  machineId?: string;
  threadHandle?: string;
  host?: string;
  operator?: string;
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
}

export interface PhaseSpan {
  eventId: string;
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
const TERMINAL_LIFECYCLE_PATTERN = /(?:^|[._\s-])(final|merged|complete(?:d)?|released|cancel(?:led|ed)?)(?:$|[._\s-])/i;

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

function optionalEventFields(event: BatchEvent): Omit<ClaimCustodyEvent, "action" | "agentId" | "previousAgentId" | "generation" | "timestamp"> {
  return {
    ...(event.machineId ? { machineId: event.machineId } : {}),
    ...(event.threadHandle ? { threadHandle: event.threadHandle } : {}),
    ...(event.host ? { host: event.host } : {}),
    ...(event.operator ? { operator: event.operator } : {}),
    ...(event.branch ? { branch: event.branch } : {}),
    ...(event.prUrl ? { prUrl: event.prUrl } : {})
  };
}

function claimTimestamp(claim: ClaimRecord): string | undefined {
  return claim.updatedAt || claim.claimedAt;
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
  return event.type.toLowerCase() === "phase" || /\b(plan|implement|verify|push|review)/i.test(event.status || "");
}

function isTerminalLifecycleEvent(event: BatchEvent): boolean {
  return TERMINAL_LIFECYCLE_PATTERN.test(event.type)
    || TERMINAL_LIFECYCLE_PATTERN.test(event.status || "")
    || /(?:^|[._\s-])handoff(?:$|[._\s-])/i.test(event.type);
}

function isRenewalEvidence(event: BatchEvent): boolean {
  return /(?:^|[._\s-])(heartbeat|renew(?:ed|al)?|continued|claim(?:ed)?|started)(?:$|[._\s-])/i.test(event.type);
}

function isHistoricalSnapshot(claim: ClaimRecord): boolean {
  return /(?:^|\/)(?:history|events)(?:\/|$)/i.test(claim.path);
}

function custodyEvents(events: BatchEvent[], currentClaim?: ClaimRecord): ClaimCustodyEvent[] {
  const custody: ClaimCustodyEvent[] = [];
  let activeAgent: string | undefined;

  for (const event of events) {
    if (!event.agentId || !event.timestamp || time(event.timestamp) === undefined) continue;
    if (isTerminalLifecycleEvent(event)) {
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

  if (!currentClaim || currentClaim.status !== "active") return custody;
  const last = custody.at(-1);
  if (last?.agentId === currentClaim.agentId && last.action !== "released") {
    Object.assign(last, {
      ...(last.generation === undefined && currentClaim.generation !== undefined ? { generation: currentClaim.generation } : {}),
      ...Object.fromEntries(Object.entries(optionalFields(currentClaim)).filter(([key]) => last[key as keyof ClaimCustodyEvent] === undefined))
    });
    return custody;
  }

  // A current snapshot proves only its present holder. Without an attributed
  // append-only event, it cannot honestly establish when or how custody began.
  custody.push({
    action: "unknown",
    agentId: currentClaim.agentId,
    ...(currentClaim.generation === undefined ? {} : { generation: currentClaim.generation }),
    ...(claimTimestamp(currentClaim) && time(claimTimestamp(currentClaim)!) !== undefined ? { timestamp: claimTimestamp(currentClaim) } : {}),
    ...optionalFields(currentClaim)
  });
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
  const phaseEvents = events.filter(isPhaseEvent).filter((event) => time(event.timestamp || "") !== undefined);
  const phases = phaseEvents.map((event, index) => {
    const startedAt = event.timestamp!;
    const startedMs = time(startedAt)!;
    const nextPhaseMs = time(phaseEvents[index + 1]?.timestamp || "") || now.getTime();
    const terminalMs = events
      .filter((candidate) => isTerminalLifecycleEvent(candidate))
      .map((candidate) => time(candidate.timestamp || ""))
      .find((candidate): candidate is number => candidate !== undefined && candidate > startedMs);
    const endedMs = Math.max(startedMs, Math.min(nextPhaseMs, terminalMs || now.getTime(), now.getTime()));
    return {
      eventId: event.eventId,
      phase: event.status || event.type,
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
