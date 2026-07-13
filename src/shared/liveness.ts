import type { Liveness } from "./types";

interface HeartbeatLike {
  updatedAt: string;
  expiresAt: string;
}

export const DEAD_AFTER_TTL_MULTIPLIER = 4;

export function deriveHeartbeatLiveness(heartbeat: HeartbeatLike, now = new Date()): Liveness {
  const updatedAt = Date.parse(heartbeat.updatedAt);
  const expiresAt = Date.parse(heartbeat.expiresAt);

  if (!Number.isFinite(updatedAt) || !Number.isFinite(expiresAt)) {
    return "unknown";
  }

  const ttl = expiresAt - updatedAt;
  if (ttl <= 0) {
    return "dead";
  }

  const nowMs = now.getTime();
  if (nowMs < expiresAt) {
    return "live";
  }

  if (nowMs < updatedAt + DEAD_AFTER_TTL_MULTIPLIER * ttl) {
    return "stale";
  }

  return "dead";
}
