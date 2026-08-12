import { spawn } from "node:child_process";
import type { CoordinationWarning, GitHubCiStatus, GitHubPreview } from "../../shared/types";
import type { GhRunner } from "./types";
import { isValidGitHubRepository } from "./validation";

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
  statusCheckRollup?: unknown;
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
  /** Parallel to items for target reconciliation; absent for open-list loads. */
  references?: GitHubTargetReference[];
  /** True when any underlying GitHub read failed; short-TTL caches must never reuse failed loads. */
  failed?: boolean;
  /** Reconciliation-reference cache outcomes for refresh telemetry. */
  cacheHits?: number;
  cacheMisses?: number;
}

export interface GitHubTargetReference {
  repo: string;
  target: string;
  type: GitHubPreview["type"];
  branch?: string;
  /** A trusted open-list preview enables branch-only enrichment without a redundant target lookup. */
  existingTarget?: GitHubPreview;
}

export function githubTargetReferenceKey(reference: GitHubTargetReference): string {
  return `${reference.repo}#${reference.target}:${reference.type}:${reference.branch || ""}:${reference.existingTarget ? "branch_only" : "target"}`;
}

export function isGitHubHttpNotFound(stderr: string): boolean {
  return stderr.trim().split(/\r?\n/).some((line) =>
    /^HTTP 404(?:\b|:)/i.test(line)
    || /^gh: HTTP 404(?:\b|:)/i.test(line)
    || /^gh: .+\(HTTP 404\)$/i.test(line)
  );
}

const GITHUB_LIST_LIMIT = 1000;

/**
 * Mirrors `git check-ref-format --branch` without invoking Git. Branch names
 * are untrusted coordination data, so reject them before constructing or
 * executing any GitHub CLI request.
 */
function isValidGitBranchName(branch: string): boolean {
  if (
    !branch
    || branch === "HEAD"
    || branch.startsWith("-")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("//")
    || branch.includes("..")
    || branch.includes("@{")
    || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch)
  ) {
    return false;
  }

  return branch.split("/").every((component) =>
    !component.startsWith(".") && !component.endsWith(".lock")
  );
}

export function githubApiPath(repo: string, kind: "issues" | "branches", target: string): string {
  const repoSegments = repo.split("/");
  if (!isValidGitHubRepository(repo)) {
    throw new Error(`Invalid GitHub repository: ${repo}`);
  }
  if (kind === "issues" && !/^\d+$/.test(target)) {
    throw new Error(`Invalid GitHub issue target: ${target}`);
  }
  if (kind === "branches" && !isValidGitBranchName(target)) {
    throw new Error(`Invalid GitHub branch: ${target || "empty branch name"}`);
  }
  return `repos/${repoSegments.map(encodeURIComponent).join("/")}/${kind}/${encodeURIComponent(target)}`;
}

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
    ciStatus: parseCiStatus(pr.statusCheckRollup),
    loadState: "loaded"
  }));
}

function ciValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toUpperCase() : undefined;
}

function ciEntryStatus(entry: unknown): GitHubCiStatus {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "unknown";
  const record = entry as Record<string, unknown>;
  const values = [record.conclusion, record.status, record.state].map(ciValue).filter((value): value is string => Boolean(value));
  if (values.some((value) => ["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(value))) return "failing";
  if (values.some((value) => ["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING", "REQUESTED"].includes(value))) return "pending";
  if (values.some((value) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(value))) return "passing";
  return "unknown";
}

/** Classifies GitHub's mixed check-run/status-context rollup without inferring readiness. */
export function parseCiStatus(rollup: unknown): GitHubCiStatus {
  if (!Array.isArray(rollup) || rollup.length === 0) return "unknown";
  const statuses = rollup.map(ciEntryStatus);
  if (statuses.includes("failing")) return "failing";
  if (statuses.includes("pending")) return "pending";
  return statuses.every((status) => status === "passing") ? "passing" : "unknown";
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
    ciStatus: "unknown",
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
    ciStatus: "unknown",
    loadState: "loaded"
  };
}

const GRAPHQL_RECONCILIATION_BATCH_SIZE = 50;

interface GraphQlIssueOrPullRequest {
  __typename?: "Issue" | "PullRequest";
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
  author?: GhAuthor | null;
  labels?: { nodes?: GhLabel[] } | null;
}

interface GraphQlResponse {
  data?: { repository?: Record<string, GraphQlIssueOrPullRequest | { name?: string } | null> | null };
  errors?: Array<{ message?: string; path?: unknown[] }>;
}

function includedResponseBody(stdout: string): string {
  if (!/^HTTP\//i.test(stdout)) return stdout;
  const separator = stdout.search(/\r?\n\r?\n/);
  return separator < 0 ? "" : stdout.slice(separator).replace(/^\r?\n\r?\n/, "");
}

function parseGraphQlTarget(repo: string, node: GraphQlIssueOrPullRequest): GitHubPreview {
  if (!node.number || !node.title || !node.url || !node.state || !node.__typename) {
    throw new Error("GitHub GraphQL target omitted required fields");
  }
  const mergedAt = node.__typename === "PullRequest" ? node.mergedAt || undefined : undefined;
  return {
    repo,
    target: String(node.number),
    type: node.__typename === "PullRequest" ? "pull_request" : "issue",
    title: node.title,
    url: node.url,
    state: mergedAt ? "MERGED" : node.state.toUpperCase(),
    author: node.author?.login,
    labels: labelNames(node.labels?.nodes),
    ...(mergedAt ? { mergedAt } : {}),
    ...(node.closedAt ? { closedAt: node.closedAt } : {}),
    ciStatus: "unknown",
    loadState: "loaded"
  };
}

type TargetLookup = { preview?: GitHubPreview; warning?: CoordinationWarning; failed: boolean };
type BranchLookup = { branchState?: GitHubPreview["branchState"]; warning?: CoordinationWarning; failed: boolean };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; readonly settled: boolean };
type GraphQlOperation =
  | { kind: "target"; repo: string; reference: GitHubTargetReference; deferred: Deferred<TargetLookup> }
  | { kind: "branch"; repo: string; reference: GitHubTargetReference; deferred: Deferred<BranchLookup> };

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let settled = false;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return {
    promise,
    get settled() { return settled; },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }
  };
}

function staggeredCacheExpiry(now: number, ttlMs: number, key: string): number {
  const spreadMs = Math.max(0, Math.floor(ttlMs));
  if (spreadMs <= 1) return now + ttlMs;

  // Stable FNV-1a plus an avalanche step gives sequential target ids a broad,
  // deterministic distribution. A full-TTL spread keeps the configured TTL as
  // the minimum freshness window while preventing process-wide expiry bursts.
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return now + ttlMs + ((hash >>> 0) % spreadMs);
}

// The concurrency cap bounds simultaneous `gh api graphql` processes. Each
// process carries up to 50 target/branch fields, so request count is bounded by
// chunks rather than growing one-for-one with historical coordination records.
export function createGitHubTargetReconciler(runner: GhRunner = childProcessGhRunner, ttlMs = 60_000, maxConcurrency = 24, maxCacheEntries = 2_000) {
  type CacheEntry<T> = { expiresAt: number; promise: Promise<T>; settled: boolean };
  const cache = new Map<string, CacheEntry<GitHubLoadResult>>();
  const targetCache = new Map<string, CacheEntry<TargetLookup>>();
  const queue: Array<() => void> = [];
  let activeLoads = 0;

  function prune<T>(candidate: Map<string, CacheEntry<T>>, now: number) {
    for (const [key, entry] of candidate) {
      if (entry.settled && entry.expiresAt <= now) candidate.delete(key);
    }
    while (candidate.size > Math.max(1, maxCacheEntries)) {
      let oldestSettled: string | undefined;
      for (const [key, entry] of candidate) {
        if (entry.settled) {
          oldestSettled = key;
          break;
        }
      }
      if (!oldestSettled) break;
      candidate.delete(oldestSettled);
    }
  }

  function schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        activeLoads += 1;
        const releaseSlot = () => {
          activeLoads -= 1;
          queue.shift()?.();
        };
        try {
          void task().then(resolve, reject).finally(releaseSlot);
        } catch (error) {
          releaseSlot();
          reject(error);
        }
      };
      if (activeLoads < Math.max(1, maxConcurrency)) start();
      else queue.push(start);
    });
  }

  function graphQlErrorForAlias(response: GraphQlResponse, alias: string): string | undefined {
    if (response.errors === undefined) return undefined;
    if (!Array.isArray(response.errors)) throw new Error("GitHub GraphQL returned malformed errors");
    const error = response.errors.find((candidate) => candidate.path?.includes(alias))
      || response.errors.find((candidate) => !Array.isArray(candidate.path) || candidate.path.length === 0 || candidate.path.at(-1) === "repository");
    return error ? error.message || "GitHub GraphQL query failed" : undefined;
  }

  async function executeChunkUnsafe(operations: GraphQlOperation[], activeRunner: GhRunner): Promise<void> {
    const [owner, name] = operations[0].repo.split("/");
    const declarations = ["$owner:String!", "$name:String!"];
    const fields: string[] = [];
    const variables: string[] = ["-f", `owner=${owner}`, "-f", `name=${name}`];
    operations.forEach((operation, index) => {
      if (operation.kind === "target") {
        declarations.push(`$target${index}:Int!`);
        variables.push("-F", `target${index}=${operation.reference.target}`);
        fields.push(`target${index}:issueOrPullRequest(number:$target${index}){__typename ... on Issue{number title url state closedAt author{login} labels(first:100){nodes{name}}} ... on PullRequest{number title url state closedAt mergedAt author{login} labels(first:100){nodes{name}}}}`);
      } else {
        declarations.push(`$branch${index}:String!`);
        variables.push("-f", `branch${index}=refs/heads/${operation.reference.branch}`);
        fields.push(`branch${index}:ref(qualifiedName:$branch${index}){name}`);
      }
    });
    const query = `query(${declarations.join(",")}){repository(owner:$owner,name:$name){${fields.join(" ")}}}`;
    const estimatedGraphQlCost = operations.reduce((total, operation) => total + (operation.kind === "target" ? 2 : 1), 0);
    let result: Awaited<ReturnType<GhRunner["run"]>>;
    try {
      result = await schedule(() => activeRunner.run(
        ["api", "graphql", "--include", "-f", `query=${query}`, ...variables],
        { estimatedGraphQlCost }
      ));
    } catch (error) {
      result = { stdout: "", stderr: error instanceof Error ? error.message : "GitHub GraphQL request failed", exitCode: 1 };
    }

    let response: GraphQlResponse | undefined;
    if (result.exitCode === 0) {
      try {
        response = JSON.parse(includedResponseBody(result.stdout)) as GraphQlResponse;
      } catch {
        response = undefined;
      }
    }

    operations.forEach((operation, index) => {
      const alias = `${operation.kind}${index}`;
      const error = response ? graphQlErrorForAlias(response, alias) : undefined;
      const node = response?.data?.repository?.[alias];
      if (operation.kind === "target") {
        if (result.exitCode !== 0 || !response || !node || error) {
          operation.deferred.resolve({
            failed: true,
            warning: {
              severity: "warning",
              repo: operation.repo,
              target: operation.reference.target,
              message: `GitHub target reconciliation failed for ${operation.repo}#${operation.reference.target}: ${error || result.stderr || (response ? "target not found" : "unreadable GraphQL response")}`
            }
          });
          return;
        }
        try {
          operation.deferred.resolve({ preview: parseGraphQlTarget(operation.repo, node as GraphQlIssueOrPullRequest), failed: false });
        } catch (parseError) {
          operation.deferred.resolve({
            failed: true,
            warning: {
              severity: "warning",
              repo: operation.repo,
              target: operation.reference.target,
              message: `GitHub target reconciliation returned unreadable GraphQL data for ${operation.repo}#${operation.reference.target}: ${parseError instanceof Error ? parseError.message : "unknown error"}`
            }
          });
        }
        return;
      }
      if (result.exitCode !== 0 || !response || error || !response.data?.repository) {
        operation.deferred.resolve({
          branchState: "unknown",
          failed: true,
          warning: {
            severity: "warning",
            repo: operation.repo,
            target: operation.reference.target,
            message: `GitHub branch lookup failed for ${operation.repo}:${operation.reference.branch}: ${error || result.stderr || "unreadable GraphQL response"}`
          }
        });
      } else {
        operation.deferred.resolve({ branchState: node ? "present" : "deleted", failed: false });
      }
    });
  }

  function settleChunkFailure(operations: GraphQlOperation[], error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    for (const operation of operations) {
      if (operation.deferred.settled) continue;
      if (operation.kind === "target") {
        operation.deferred.resolve({
          failed: true,
          warning: {
            severity: "warning",
            repo: operation.repo,
            target: operation.reference.target,
            message: `GitHub target reconciliation failed for ${operation.repo}#${operation.reference.target}: ${message}`
          }
        });
      } else {
        operation.deferred.resolve({
          branchState: "unknown",
          failed: true,
          warning: {
            severity: "warning",
            repo: operation.repo,
            target: operation.reference.target,
            message: `GitHub branch lookup failed for ${operation.repo}:${operation.reference.branch}: ${message}`
          }
        });
      }
    }
  }

  async function executeChunk(operations: GraphQlOperation[], activeRunner: GhRunner): Promise<void> {
    try {
      await executeChunkUnsafe(operations, activeRunner);
    } catch (error) {
      settleChunkFailure(operations, error);
    } finally {
      settleChunkFailure(operations, new Error("GitHub GraphQL batch ended without a result"));
    }
  }

  function executeOperations(operations: GraphQlOperation[], activeRunner: GhRunner) {
    const byRepo = new Map<string, GraphQlOperation[]>();
    for (const operation of operations) {
      byRepo.set(operation.repo, [...(byRepo.get(operation.repo) || []), operation]);
    }
    for (const repoOperations of byRepo.values()) {
      for (let index = 0; index < repoOperations.length; index += GRAPHQL_RECONCILIATION_BATCH_SIZE) {
        const chunk = repoOperations.slice(index, index + GRAPHQL_RECONCILIATION_BATCH_SIZE);
        void executeChunk(chunk, activeRunner).catch((error) => {
          // executeChunk is deliberately detached so target cache entries can
          // share its work. Keep the boundary rejection-safe as a final guard.
          settleChunkFailure(chunk, error);
        });
      }
    }
  }

  function unavailableTarget(reference: GitHubTargetReference, branchState?: GitHubPreview["branchState"]): GitHubPreview {
    return {
      repo: reference.repo,
      target: reference.target,
      type: reference.type,
      title: "GitHub state unavailable",
      url: "",
      state: "UNKNOWN",
      labels: [],
      ...(branchState ? { branchState } : {}),
      loadState: "unknown"
    };
  }

  return {
    async load(references: GitHubTargetReference[], options: { bypassCache?: boolean; runner?: GhRunner } = {}): Promise<GitHubLoadResult> {
      const seenReferences = new Set<string>();
      const unique = references.filter((reference) => {
        const key = githubTargetReferenceKey(reference);
        if (seenReferences.has(key)) return false;
        seenReferences.add(key);
        return true;
      });
      const now = Date.now();
      let cacheHits = 0;
      let cacheMisses = 0;
      prune(cache, now);
      prune(targetCache, now);
      const operations: GraphQlOperation[] = [];
      const resultPromises = unique.map((reference) => {
        const key = githubTargetReferenceKey(reference);
        const existing = cache.get(key);
        if (!options.bypassCache && existing && (!existing.settled || existing.expiresAt > now)) {
          cacheHits += 1;
          return existing.promise;
        }
        cacheMisses += 1;
        if (options.bypassCache) {
          cache.delete(key);
          targetCache.delete(`${reference.repo}#${reference.target}:${reference.type}`);
        }

        try {
          githubApiPath(reference.repo, "issues", reference.target);
        } catch (error) {
          return Promise.resolve({
            items: [unavailableTarget(reference)],
            warnings: [{ severity: "warning" as const, repo: reference.repo, target: reference.target, message: error instanceof Error ? error.message : "Invalid GitHub target reference" }],
            failed: true
          });
        }

        let branchPromise: Promise<BranchLookup> = Promise.resolve({ failed: false });
        if (reference.branch) {
          try {
            githubApiPath(reference.repo, "branches", reference.branch);
            const branchDeferred = deferred<BranchLookup>();
            operations.push({ kind: "branch", repo: reference.repo, reference, deferred: branchDeferred });
            branchPromise = branchDeferred.promise;
          } catch (error) {
            branchPromise = Promise.resolve({
              branchState: "unknown",
              failed: true,
              warning: { severity: "warning", repo: reference.repo, target: reference.target, message: error instanceof Error ? error.message : "Invalid GitHub branch reference" }
            });
          }
        }

        let targetPromise: Promise<TargetLookup>;
        if (reference.existingTarget) {
          targetPromise = Promise.resolve({ preview: reference.existingTarget, failed: false });
        } else {
          const targetKey = `${reference.repo}#${reference.target}:${reference.type}`;
          const existingTarget = targetCache.get(targetKey);
          if (!options.bypassCache && existingTarget && (!existingTarget.settled || existingTarget.expiresAt > now)) {
            targetPromise = existingTarget.promise;
          } else {
            const targetDeferred = deferred<TargetLookup>();
            const targetEntry: CacheEntry<TargetLookup> = { expiresAt: staggeredCacheExpiry(now, ttlMs, targetKey), promise: targetDeferred.promise, settled: false };
            targetCache.set(targetKey, targetEntry);
            operations.push({ kind: "target", repo: reference.repo, reference, deferred: targetDeferred });
            void targetDeferred.promise.then((lookup) => {
              targetEntry.settled = true;
              if (lookup.failed && targetCache.get(targetKey) === targetEntry) targetCache.delete(targetKey);
              prune(targetCache, Date.now());
            }, () => {
              targetEntry.settled = true;
              if (targetCache.get(targetKey) === targetEntry) targetCache.delete(targetKey);
            });
            targetPromise = targetDeferred.promise;
          }
        }

        const promise = Promise.all([targetPromise, branchPromise]).then(([target, branch]): GitHubLoadResult => {
          const warnings = [target.warning, branch.warning].filter((warning): warning is CoordinationWarning => Boolean(warning));
          const failed = target.failed || branch.failed;
          return {
            items: [target.preview ? { ...target.preview, ...(branch.branchState ? { branchState: branch.branchState } : {}) } : unavailableTarget(reference, branch.branchState)],
            warnings,
            ...(failed ? { failed: true } : {})
          };
        });
        const entry: CacheEntry<GitHubLoadResult> = { expiresAt: staggeredCacheExpiry(now, ttlMs, key), promise, settled: false };
        cache.set(key, entry);
        void promise.then((result) => {
          entry.settled = true;
          const reusable = !result.failed && result.items.every((item) => item.loadState !== "unknown" && item.branchState !== "unknown");
          if (!reusable && cache.get(key) === entry) cache.delete(key);
          prune(cache, Date.now());
        }, () => {
          entry.settled = true;
          if (cache.get(key) === entry) cache.delete(key);
        });
        return promise;
      });

      executeOperations(operations, options.runner || runner);
      const results = await Promise.all(resultPromises);
      return {
        // Branch-only results may come from a cache entry created for an older
        // open-list snapshot. Reapply only the cached supporting branch signal
        // to the caller's current canonical target so target truth never goes stale.
        items: results.flatMap((result, index) => unique[index].existingTarget
          ? result.items.map((item) => ({ ...unique[index].existingTarget!, ...(item.branchState ? { branchState: item.branchState } : {}) }))
          : result.items),
        warnings: results.flatMap((result) => result.warnings),
        references: unique,
        cacheHits,
        cacheMisses,
        ...(results.some((result) => result.failed || result.items.some((item) => item.loadState === "unknown")) ? { failed: true } : {})
      };
    },
    cacheSize: () => cache.size
  };
}

export async function loadOpenGitHubItems(
  repo: string,
  runner: GhRunner = childProcessGhRunner
): Promise<GitHubLoadResult> {
  const warnings: CoordinationWarning[] = [];
  let failedSources = 0;

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
      failedSources += 1;
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
      failedSources += 1;
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
    loadKind("pr", "number,title,url,state,author,labels,headRefName,reviewDecision,statusCheckRollup", parsePrList),
    loadKind("issue", "number,title,url,state,author,labels", parseIssueList)
  ]);

  return {
    items: [...prs, ...issues],
    warnings,
    // A truncated-but-successful list stays cacheable with its warning visible;
    // failed reads must be retried live by any caller-side cache.
    ...(failedSources > 0 ? { failed: true } : {})
  };
}
