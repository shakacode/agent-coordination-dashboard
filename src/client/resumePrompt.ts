import type { WorkItem } from "../shared/types";

type ResumePromptItem = Pick<WorkItem, "repo" | "target" | "claim" | "heartbeat" | "github">;

export function resumePrompt(item: ResumePromptItem): string {
  const branch = (item.claim?.status === "active" ? item.claim.branch : undefined)
    || item.heartbeat?.branch
    || (item.github?.loadState === "loaded" ? item.github.branch : undefined);
  return `$pr-batch\nResume ${item.repo}#${item.target}${branch ? ` on ${branch}` : ""}. Verify current coordination state before edits.`;
}
