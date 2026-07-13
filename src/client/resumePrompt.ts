import type { WorkItem } from "../shared/types";

type ResumePromptItem = Pick<WorkItem, "repo" | "target" | "claim" | "heartbeat" | "github">;

const REPO_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TARGET_IDENTIFIER = /^\d+$/;
const BRANCH_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isPromptIdentifier(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

export function resumePrompt(item: ResumePromptItem): string {
  const branch = (item.claim?.status === "active" ? item.claim.branch : undefined)
    || item.heartbeat?.branch
    || (item.github?.loadState === "loaded" ? item.github.branch : undefined);
  const hasSafeRoute = isPromptIdentifier(item.repo, REPO_IDENTIFIER)
    && isPromptIdentifier(item.target, TARGET_IDENTIFIER);
  const route = hasSafeRoute ? `${item.repo}#${item.target}` : "the selected work item";
  const safeBranch = hasSafeRoute && isPromptIdentifier(branch, BRANCH_IDENTIFIER)
    ? ` on ${branch}`
    : "";

  return `$pr-batch\nResume ${route}${safeBranch}. Verify current coordination state before edits.`;
}
