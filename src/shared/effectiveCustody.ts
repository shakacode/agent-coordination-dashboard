import type { WorkItem } from "./types";

type CustodyInput = Pick<WorkItem, "claim" | "heartbeat">;

/**
 * Resolve the only claim/heartbeat pair safe to treat as one custody source.
 * An active claim fences heartbeats from every other agent.
 */
export function effectiveCustody(item: CustodyInput) {
  const claim = item.claim?.status === "active" ? item.claim : undefined;
  const heartbeatConflict = Boolean(claim && item.heartbeat && item.heartbeat.agentId !== claim.agentId);
  const heartbeat = !heartbeatConflict
    ? item.heartbeat
    : undefined;
  return { claim, heartbeat, heartbeatConflict };
}
