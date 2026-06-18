import { spawn } from "node:child_process";
import type { CoordinationWarning, GitHubPreview } from "../../shared/types";
import type { GhRunner } from "./types";

interface GhAuthor {
  login?: string;
}

interface GhLabel {
  name?: string;
}

interface GhPr {
  number: number;
  title: string;
  url: string;
  state: string;
  author?: GhAuthor;
  labels?: GhLabel[];
  headRefName?: string;
  reviewDecision?: string;
}

interface GhIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  author?: GhAuthor;
  labels?: GhLabel[];
}

interface GitHubLoadResult {
  items: GitHubPreview[];
  warnings: CoordinationWarning[];
}

const GITHUB_LIST_LIMIT = 1000;

export const childProcessGhRunner: GhRunner = {
  run(args) {
    return new Promise((resolve) => {
      const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        resolve({ stdout, stderr: error.message, exitCode: 1 });
      });
      child.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code || 0 });
      });
    });
  }
};

function labelNames(labels: GhLabel[] | undefined): string[] {
  return (labels || []).map((label) => label.name).filter((name): name is string => Boolean(name));
}

export function parsePrList(repo: string, stdout: string): GitHubPreview[] {
  const prs = JSON.parse(stdout) as GhPr[];
  return prs.map((pr) => ({
    repo,
    target: String(pr.number),
    type: "pull_request",
    title: pr.title,
    url: pr.url,
    state: pr.state,
    author: pr.author?.login,
    labels: labelNames(pr.labels),
    branch: pr.headRefName,
    reviewDecision: pr.reviewDecision,
    loadState: "loaded"
  }));
}

export function parseIssueList(repo: string, stdout: string): GitHubPreview[] {
  const issues = JSON.parse(stdout) as GhIssue[];
  return issues.map((issue) => ({
    repo,
    target: String(issue.number),
    type: "issue",
    title: issue.title,
    url: issue.url,
    state: issue.state,
    author: issue.author?.login,
    labels: labelNames(issue.labels),
    loadState: "loaded"
  }));
}

export async function loadOpenGitHubItems(
  repo: string,
  runner: GhRunner = childProcessGhRunner
): Promise<GitHubLoadResult> {
  const warnings: CoordinationWarning[] = [];

  async function loadKind(
    kind: "pr" | "issue",
    fields: string,
    parse: (repo: string, stdout: string) => GitHubPreview[]
  ): Promise<GitHubPreview[]> {
    const result = await runner.run([
      kind,
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(GITHUB_LIST_LIMIT),
      "--json",
      fields
    ]);

    if (result.exitCode !== 0) {
      warnings.push({
        severity: "warning",
        repo,
        message: `GitHub ${kind} list failed for ${repo}: ${result.stderr || `exit ${result.exitCode}`}`
      });
      return [];
    }

    try {
      const items = parse(repo, result.stdout);
      if (items.length >= GITHUB_LIST_LIMIT) {
        warnings.push({
          severity: "warning",
          repo,
          message: `GitHub ${kind} list for ${repo} reached the ${GITHUB_LIST_LIMIT} item limit and may be truncated.`
        });
      }
      return items;
    } catch (error) {
      warnings.push({
        severity: "warning",
        repo,
        message: `GitHub ${kind} list returned unreadable JSON for ${repo}: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      });
      return [];
    }
  }

  const [prs, issues] = await Promise.all([
    loadKind("pr", "number,title,url,state,author,labels,headRefName,reviewDecision", parsePrList),
    loadKind("issue", "number,title,url,state,author,labels", parseIssueList)
  ]);

  return {
    items: [...prs, ...issues],
    warnings
  };
}
