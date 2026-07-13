import type { WorkItem } from "./types";

type OperatorCommandItem = Pick<WorkItem, "repo" | "target" | "claim" | "heartbeat" | "github" | "batchSignals">;

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TARGET = /^\d+$/;
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/;

function safe(value: unknown, pattern = VALUE): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function quote(value: string): string {
  return `'${value}'`;
}

function context(item: OperatorCommandItem) {
  const claim = item.claim?.status === "active" ? item.claim : undefined;
  const heartbeatMatchesClaim = !claim || item.heartbeat?.agentId === claim.agentId;
  const heartbeat = heartbeatMatchesClaim ? item.heartbeat : undefined;
  return {
    repo: safe(item.repo, REPO),
    target: safe(item.target, TARGET),
    thread: safe(claim?.threadHandle || heartbeat?.threadHandle),
    batch: safe(claim?.batchId || heartbeat?.batchId || item.batchSignals?.[0]?.batchId),
    branch: safe(claim?.branch || heartbeat?.branch || (item.github?.loadState === "loaded" ? item.github.branch : undefined)),
    phase: safe(heartbeat?.status || item.batchSignals?.[0]?.status)
  };
}

/** Keep this contract aligned with pr-batch's saved-handoff continuation rules. */
export function resumeCommandPrompt(item: OperatorCommandItem): string {
  const { repo, target, thread, batch, branch, phase } = context(item);
  const route = repo && target ? `${repo}#${target}` : "the selected work item";
  return [
    "$pr-batch",
    `Resume the existing lane for ${route}.`,
    `Thread handle: ${thread || "UNKNOWN"}`,
    `Batch: ${batch || "UNKNOWN"}`,
    `Branch: ${branch || "UNKNOWN"}`,
    `Last phase: ${phase || "UNKNOWN"}`,
    "Verify current coordination state and custody before edits. Continue in the owning task when available."
  ].join("\n");
}

/** agent-coord performs a dead-holder takeover when a new claimant uses claim. */
export function takeoverCommand(item: OperatorCommandItem): string {
  const { repo, target, batch, branch } = context(item);
  const requiredAgentId = '"${AGENT_COORD_AGENT_ID:?Set AGENT_COORD_AGENT_ID}"';
  if (!repo || !target) return `agent-coord claim --agent-id ${requiredAgentId} --repo REPLACE_WITH_OWNER_REPO --target REPLACE_WITH_TARGET`;
  return [
    "agent-coord claim",
    `--agent-id ${requiredAgentId}`,
    `--repo ${quote(repo)}`,
    `--target ${quote(target)}`,
    batch ? `--batch-id ${quote(batch)}` : undefined,
    branch ? `--branch ${quote(branch)}` : undefined
  ].filter(Boolean).join(" ");
}
