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

interface GhTarget {
  number: number;
  title: string;
  html_url: string;
  state: string;
  closed_at?: string;
  user?: GhAuthor;
  labels?: GhLabel[];
  pull_request?: { merged_at?: string };
}

export interface GitHubLoadResult {
  items: GitHubPreview[];
  warnings: CoordinationWarning[];
}

export interface GitHubTargetReference {
  repo: string;
  target: string;
  type: GitHubPreview["type"];
  branch?: string;
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

export function parseGitHubTarget(repo: string, stdout: string): GitHubPreview {
  const item = JSON.parse(stdout) as GhTarget;
  const isPullRequest = Boolean(item.pull_request);
  const mergedAt = item.pull_request?.merged_at || undefined;
  return {
    repo,
    target: String(item.number),
    type: isPullRequest ? "pull_request" : "issue",
    title: item.title,
    url: item.html_url,
    state: mergedAt ? "MERGED" : item.state.toUpperCase(),
    author: item.user?.login,
    labels: labelNames(item.labels),
    ...(mergedAt ? { mergedAt } : {}),
    ...(item.closed_at ? { closedAt: item.closed_at } : {}),
    loadState: "loaded"
  };
}

export function createGitHubTargetReconciler(runner: GhRunner = childProcessGhRunner, ttlMs = 60_000, maxConcurrency = 8) {
  const cache = new Map<string, { expiresAt: number; promise: Promise<GitHubLoadResult> }>();
  const queue: Array<() => void> = [];
  let activeLoads = 0;

  function schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        activeLoads += 1;
        void task().then(resolve, reject).finally(() => {
          activeLoads -= 1;
          queue.shift()?.();
        });
      };
      if (activeLoads < Math.max(1, maxConcurrency)) start();
      else queue.push(start);
    });
  }

  async function loadOne(reference: GitHubTargetReference): Promise<GitHubLoadResult> {
    const result = await runner.run(["api", `repos/${reference.repo}/issues/${reference.target}`]);
    let branchState: GitHubPreview["branchState"];
    const branchWarnings: CoordinationWarning[] = [];
    if (reference.branch) {
      const branchResult = await runner.run(["api", `repos/${reference.repo}/branches/${encodeURIComponent(reference.branch)}`]);
      if (branchResult.exitCode === 0) {
        branchState = "present";
      } else if (/\b(?:HTTP\s+)?404\b/i.test(branchResult.stderr)) {
        branchState = "deleted";
      } else {
        branchState = "unknown";
        branchWarnings.push({ severity: "warning", repo: reference.repo, target: reference.target, message: `GitHub branch lookup failed for ${reference.repo}:${reference.branch}: ${branchResult.stderr || `exit ${branchResult.exitCode}`}` });
      }
    }
    if (result.exitCode !== 0) {
      return {
        items: [{
          repo: reference.repo,
          target: reference.target,
          type: reference.type,
          title: "GitHub state unavailable",
          url: "",
          state: "UNKNOWN",
          labels: [],
          ...(branchState ? { branchState } : {}),
          loadState: "unknown"
        }],
        warnings: [{ severity: "warning", repo: reference.repo, target: reference.target, message: `GitHub target reconciliation failed for ${reference.repo}#${reference.target}: ${result.stderr || `exit ${result.exitCode}`}` }, ...branchWarnings]
      };
    }
    try {
      return { items: [{ ...parseGitHubTarget(reference.repo, result.stdout), ...(branchState ? { branchState } : {}) }], warnings: branchWarnings };
    } catch (error) {
      return {
        items: [{ repo: reference.repo, target: reference.target, type: reference.type, title: "GitHub state unavailable", url: "", state: "UNKNOWN", labels: [], ...(branchState ? { branchState } : {}), loadState: "unknown" }],
        warnings: [{ severity: "warning", repo: reference.repo, target: reference.target, message: `GitHub target reconciliation returned unreadable JSON for ${reference.repo}#${reference.target}: ${error instanceof Error ? error.message : "unknown error"}` }, ...branchWarnings]
      };
    }
  }

  return {
    async load(references: GitHubTargetReference[], options: { bypassCache?: boolean } = {}): Promise<GitHubLoadResult> {
      const unique = references.filter((reference, index) => references.findIndex((candidate) => candidate.repo === reference.repo && candidate.target === reference.target && candidate.branch === reference.branch) === index);
      const now = Date.now();
      const results = await Promise.all(unique.map((reference) => {
        const key = `${reference.repo}#${reference.target}:${reference.branch || ""}`;
        const existing = cache.get(key);
        if (!options.bypassCache && existing && existing.expiresAt > now) return existing.promise;
        const promise = schedule(() => loadOne(reference));
        cache.set(key, { expiresAt: now + ttlMs, promise });
        return promise;
      }));
      return { items: results.flatMap((result) => result.items), warnings: results.flatMap((result) => result.warnings) };
    }
  };
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
