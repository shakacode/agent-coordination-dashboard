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

export interface ClaimCustodyEvent {
  action: "acquired" | "renewed" | "released" | "taken_over";
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
export function buildLivenessSpans(heartbeats: HeartbeatRecord[], now = new Date()): LivenessSpan[] {
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
      const endsAt = Math.min(Math.max(nextMs, startedMs), nowMs);
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

function claimTimestamp(claim: ClaimRecord): string | undefined {
  return claim.updatedAt || claim.claimedAt;
}

function isPhaseEvent(event: BatchEvent): boolean {
  return event.type.toLowerCase() === "phase" || /\b(plan|implement|verify|push|review)/i.test(event.status || "");
}

function isTerminalLifecycleEvent(event: BatchEvent): boolean {
  return TERMINAL_LIFECYCLE_PATTERN.test(event.type) || TERMINAL_LIFECYCLE_PATTERN.test(event.status || "");
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

/** Builds a read-only, target-scoped custody record from observed coordination history. */
export function buildCustodyTimeline(input: BuildCustodyTimelineInput): CustodyTimeline {
  const now = input.now || new Date();
  const matchingClaims = input.claims
    .filter((claim) => claim.repo === input.repo && claim.target === input.target)
    .sort((left, right) => (time(claimTimestamp(left) || "") || 0) - (time(claimTimestamp(right) || "") || 0));
  let previousActiveAgent: string | undefined;
  const claims = matchingClaims.map((claim) => {
    const timestamp = claimTimestamp(claim);
    const action = claim.status === "released"
      ? "released"
      : previousActiveAgent && previousActiveAgent !== claim.agentId
        ? "taken_over"
        : previousActiveAgent === claim.agentId
          ? "renewed"
          : "acquired";
    const event: ClaimCustodyEvent = {
      action,
      agentId: claim.agentId,
      ...(action === "taken_over" ? { previousAgentId: previousActiveAgent } : {}),
      ...(claim.generation === undefined ? {} : { generation: claim.generation }),
      ...(timestamp ? { timestamp } : {}),
      ...optionalFields(claim)
    };
    if (claim.status === "released") {
      previousActiveAgent = undefined;
    } else {
      previousActiveAgent = claim.agentId;
    }
    return event;
  });
  const matchingHeartbeats = input.heartbeats.filter((heartbeat) => heartbeat.repo === input.repo && heartbeat.target === input.target);
  const events = input.events
    .filter((event) => event.repo === input.repo && event.target === input.target)
    .sort((left, right) => (time(left.timestamp || "") || 0) - (time(right.timestamp || "") || 0));
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
    liveness: buildLivenessSpans(matchingHeartbeats, now),
    phases,
    events,
    branches: unique([...matchingClaims.map((claim) => claim.branch), ...matchingHeartbeats.map((heartbeat) => heartbeat.branch), ...events.map((event) => event.branch)]),
    prUrls: unique([...matchingClaims.map((claim) => claim.prUrl), ...matchingHeartbeats.map((heartbeat) => heartbeat.prUrl), ...events.map((event) => event.prUrl)])
  };
}
