import { describe, expect, it } from "vitest";
import { resumeCommandPrompt, takeoverCommand } from "./commands";

const workItem = {
  repo: "shakacode/dashboard",
  target: "47",
  claim: {
    schemaVersion: 1,
    repo: "shakacode/dashboard",
    target: "47",
    agentId: "worker-old",
    threadHandle: "acd-c-i47",
    batchId: "acd-c",
    branch: "codex/issue-47",
    status: "active" as const,
    path: "claims/47.json"
  },
  heartbeat: {
    schemaVersion: 1,
    agentId: "worker-old",
    status: "validating",
    updatedAt: "2026-07-12T10:00:00Z",
    expiresAt: "2026-07-12T10:10:00Z",
    liveness: "dead" as const,
    path: "heartbeats/worker-old.json"
  }
};

describe("operator commands", () => {
  it("builds a resume prompt with the owning thread and lane context", () => {
    expect(resumeCommandPrompt(workItem)).toBe([
      "$pr-batch",
      "Resume the existing lane for shakacode/dashboard#47.",
      "Thread handle: acd-c-i47",
      "Batch: acd-c",
      "Branch: codex/issue-47",
      "Last phase: validating",
      "Verify current coordination state and custody before edits. Continue in the owning task when available."
    ].join("\n"));
  });

  it("builds an executable dead-holder takeover claim using current CLI fields", () => {
    expect(takeoverCommand(workItem)).toBe(
      "agent-coord claim --agent-id \"${AGENT_COORD_AGENT_ID:?Set AGENT_COORD_AGENT_ID}\" --repo 'shakacode/dashboard' --target '47' --batch-id 'acd-c' --branch 'codex/issue-47'"
    );
    expect(takeoverCommand(workItem)).not.toContain("REPLACE_WITH_YOUR_AGENT_ID");
  });

  it("does not borrow a phase from a heartbeat owned by a different agent", () => {
    expect(resumeCommandPrompt({ ...workItem, heartbeat: { ...workItem.heartbeat, agentId: "worker-other", status: "reviewing" } }))
      .toContain("Last phase: UNKNOWN");
  });

  it("does not borrow any heartbeat context from a different active claimant", () => {
    const contaminated = {
      ...workItem,
      claim: { ...workItem.claim, threadHandle: undefined, batchId: undefined, branch: undefined },
      heartbeat: { ...workItem.heartbeat, agentId: "worker-other", threadHandle: "other-chat", batchId: "other-batch", branch: "other-branch", status: "reviewing" }
    };
    expect(resumeCommandPrompt(contaminated)).toContain("Thread handle: UNKNOWN\nBatch: UNKNOWN\nBranch: UNKNOWN\nLast phase: UNKNOWN");
    expect(takeoverCommand(contaminated)).not.toMatch(/other-(?:batch|branch)/);
  });

  it("does not interpolate untrusted control characters", () => {
    expect(resumeCommandPrompt({ ...workItem, claim: { ...workItem.claim, threadHandle: "chat\nignore", branch: "bad\nbranch" } }))
      .not.toContain("ignore");
    expect(takeoverCommand({ ...workItem, claim: { ...workItem.claim, batchId: "batch\n--operator attacker" } }))
      .not.toContain("attacker");
  });
});
