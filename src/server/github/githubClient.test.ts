import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubTargetReconciler, githubApiPath, githubTargetReferenceKey, isGitHubHttpNotFound, loadOpenGitHubItems, parseCiStatus, parseGitHubTarget, parseIssueList, parsePrList } from "./githubClient";
import { createGitHubRequestGovernor } from "./githubQuotaGuard";

function graphQlResult(
  args: string[],
  options: {
    target?: (target: string, alias: string) => Record<string, unknown> | null;
    branch?: (branch: string, alias: string) => "present" | "deleted" | { error: string };
  } = {}
) {
  const repository: Record<string, unknown> = {};
  const errors: Array<{ message: string; path: string[] }> = [];
  for (const argument of args) {
    const target = argument.match(/^(target\d+)=(\d+)$/);
    if (target) {
      repository[target[1]] = options.target?.(target[2], target[1]) ?? {
        __typename: "Issue",
        number: Number(target[2]),
        title: `Issue ${target[2]}`,
        url: `https://github.com/repo/app/issues/${target[2]}`,
        state: "OPEN",
        labels: { nodes: [] }
      };
    }
    const branch = argument.match(/^(branch\d+)=(.+)$/);
    if (branch) {
      const branchName = branch[2].replace(/^refs\/heads\//, "");
      const value = options.branch?.(branchName, branch[1]) ?? "present";
      if (typeof value === "object") {
        repository[branch[1]] = null;
        errors.push({ message: value.error, path: ["repository", branch[1]] });
      } else {
        repository[branch[1]] = value === "present" ? { name: branchName } : null;
      }
    }
  }
  return {
    stdout: JSON.stringify({ data: { repository }, ...(errors.length > 0 ? { errors } : {}) }),
    stderr: "",
    exitCode: 0
  };
}

describe("github list parsers", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["fails if any check definitively fails", [{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "FAILURE" }], "failing"],
    ["is pending for queued checks", [{ status: "QUEUED" }, { conclusion: "SUCCESS" }], "pending"],
    ["passes only recognized completed checks", [{ conclusion: "SUCCESS" }, { state: "NEUTRAL" }, { conclusion: "SKIPPED" }], "passing"],
    ["is unknown for absent checks", undefined, "unknown"],
    ["is unknown for unrecognized checks", [{ status: "COMPLETED" }], "unknown"]
  ])("parses heterogeneous CI rollups conservatively: %s", (_label, rollup, expected) => {
    expect(parseCiStatus(rollup)).toBe(expected);
  });

  it("preserves parsed CI status on open PR previews", () => {
    const preview = parsePrList("repo/app", JSON.stringify([{
      number: 45, title: "Open", url: "https://github.com/repo/app/pull/45", state: "OPEN", labels: [],
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
    }]))[0];
    expect(preview.ciStatus).toBe("passing");
  });
  it("normalizes merged PR and closed issue target responses", () => {
    expect(parseGitHubTarget("repo/app", JSON.stringify({
      number: 43, title: "Merged", html_url: "https://github.com/repo/app/pull/43", state: "closed", closed_at: "2026-07-12T11:00:00Z",
      user: { login: "maintainer" }, labels: [{ name: "feature" }], pull_request: { merged_at: "2026-07-12T10:59:00Z" }
    }))).toMatchObject({ target: "43", type: "pull_request", state: "MERGED", mergedAt: "2026-07-12T10:59:00Z", closedAt: "2026-07-12T11:00:00Z", loadState: "loaded" });

    expect(parseGitHubTarget("repo/app", JSON.stringify({
      number: 44, title: "Closed", html_url: "https://github.com/repo/app/issues/44", state: "closed", closed_at: "2026-07-12T09:00:00Z",
      user: { login: "maintainer" }, labels: []
    }))).toMatchObject({ target: "44", type: "issue", state: "CLOSED", closedAt: "2026-07-12T09:00:00Z", loadState: "loaded" });

    const closedPullRequest = parseGitHubTarget("repo/app", JSON.stringify({
      number: 45, title: "Closed PR", html_url: "https://github.com/repo/app/pull/45", state: "closed", closed_at: "2026-07-12T08:00:00Z",
      labels: [], pull_request: { merged_at: null }
    }));
    expect(closedPullRequest).toMatchObject({ target: "45", type: "pull_request", state: "CLOSED", loadState: "loaded" });
    expect(closedPullRequest.ciStatus).toBe("unknown");
    expect(closedPullRequest).not.toHaveProperty("mergedAt");
  });

  it("constructs GitHub API paths from validated owner and repository segments", () => {
    expect(githubApiPath("shaka-code/agent_coordination.dashboard", "issues", "45")).toBe("repos/shaka-code/agent_coordination.dashboard/issues/45");
    expect(githubApiPath("repo/app", "branches", "feature/work-#x")).toBe("repos/repo/app/branches/feature%2Fwork-%23x");
    expect(() => githubApiPath("repo/app/../../secret", "issues", "45")).toThrow(/repository/i);
    expect(() => githubApiPath("../app", "issues", "45")).toThrow(/repository/i);
    expect(() => githubApiPath("repo/...", "issues", "45")).toThrow(/repository/i);
    expect(() => githubApiPath("repo/app", "issues", "45/../../secret")).toThrow(/issue target/i);
    expect(() => githubApiPath("repo/app", "branches", "feature/../secret")).toThrow(/branch/i);
    expect(() => githubApiPath("repo/app", "branches", "feature/foo..bar")).toThrow(/branch/i);
  });

  it.each([
    "",
    "-leading-dash",
    "/leading-slash",
    "trailing-slash/",
    "trailing-dot.",
    "double//slash",
    "double..dot",
    "feature/@{upstream}",
    "feature/control\u0001char",
    "feature/delete\u007fchar",
    "feature/has space",
    "feature/tilde~name",
    "feature/caret^name",
    "feature/colon:name",
    "feature/question?name",
    "feature/star*name",
    "feature/[bracket",
    "feature/back\\slash",
    ".hidden",
    "feature/.hidden",
    "feature/branch.lock",
    "HEAD"
  ])("rejects a branch Git would reject: %j", (branch) => {
    expect(() => githubApiPath("repo/app", "branches", branch)).toThrow(/branch/i);
  });

  it.each([
    "main",
    "codex/issue-45",
    "release/v1.2.3",
    "feature/-nested-dash",
    "feature/dotted.name",
    "feature/hash#name",
    "feature/foo.locked",
    "@"
  ])("accepts a common branch Git accepts: %j", (branch) => {
    expect(githubApiPath("repo/app", "branches", branch)).toBe(`repos/repo/app/branches/${encodeURIComponent(branch)}`);
  });

  it("reconciles valid targets while keeping every invalid branch UNKNOWN without a branch lookup", async () => {
    const run = vi.fn(async (args: string[]) => graphQlResult(args, { target: (target) => ({
      __typename: "PullRequest", number: Number(target), title: "Merged", url: `https://github.com/repo/app/pull/${target}`,
      state: "MERGED", mergedAt: "2026-07-12T10:00:00Z", labels: { nodes: [] }
    }) }));
    const invalidBranches = ["-leading", "feature/.hidden", "feature/branch.lock", "feature/has space", "feature/@{upstream}"];
    const result = await createGitHubTargetReconciler({ run }).load(invalidBranches.map((branch, index) => ({
      repo: "repo/app",
      target: String(100 + index),
      type: "issue" as const,
      branch
    })));

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].join(" ")).not.toContain("ref(qualifiedName:");
    expect(result.items).toHaveLength(invalidBranches.length);
    expect(result.items.every((item) => item.state === "MERGED" && item.loadState === "loaded" && item.branchState === "unknown")).toBe(true);
    expect(result.warnings).toHaveLength(invalidBranches.length);
    expect(result.warnings.every((warning) => /branch/i.test(warning.message))).toBe(true);
  });

  it("preserves trusted target evidence when only its branch reference is invalid", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const existingTarget = {
      repo: "repo/app",
      target: "45",
      type: "issue" as const,
      title: "Open issue",
      url: "https://github.com/repo/app/issues/45",
      state: "OPEN",
      author: "maintainer",
      labels: ["feature"],
      loadState: "loaded" as const
    };

    const result = await createGitHubTargetReconciler({ run }).load([{
      repo: "repo/app",
      target: "45",
      type: "issue",
      branch: "feature/has space",
      existingTarget
    }]);

    expect(run).not.toHaveBeenCalled();
    expect(result.items).toEqual([{ ...existingTarget, branchState: "unknown" }]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ repo: "repo/app", target: "45", message: expect.stringMatching(/branch/i) })
    ]);
  });

  it("rejects hostile target references without invoking gh", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const result = await createGitHubTargetReconciler({ run }).load([
      { repo: "../app", target: "45", type: "issue" },
      { repo: "repo/...", target: "46", type: "issue" },
      { repo: "repo/app", target: "47/../../secret", type: "issue", branch: "feature/../secret" }
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(result.items).toEqual([
      expect.objectContaining({ repo: "../app", target: "45", state: "UNKNOWN", loadState: "unknown" }),
      expect.objectContaining({ repo: "repo/...", target: "46", state: "UNKNOWN", loadState: "unknown" }),
      expect.objectContaining({ repo: "repo/app", target: "47/../../secret", state: "UNKNOWN", loadState: "unknown" })
    ]);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.map((warning) => warning.message)).toEqual([
      expect.stringMatching(/repository/i),
      expect.stringMatching(/repository/i),
      expect.stringMatching(/issue target/i)
    ]);
  });

  it("coalesces and caches target reconciliation while foreground refresh can bypass it", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      calls += 1;
      if (calls === 1) await gate;
      return graphQlResult(args);
    } }, 60_000);
    const refs = [{ repo: "repo/app", target: "43", type: "issue" as const }];
    const first = reconciler.load(refs);
    const second = reconciler.load(refs);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    await reconciler.load(refs);
    expect(calls).toBe(1);
    await reconciler.load(refs, { bypassCache: true });
    expect(calls).toBe(2);
  });

  it("returns honest UNKNOWN target evidence when GitHub is unavailable", async () => {
    const reconciler = createGitHubTargetReconciler({ run: async () => ({ stdout: "", stderr: "auth required", exitCode: 1 }) });
    const result = await reconciler.load([{ repo: "repo/app", target: "43", type: "unknown" }]);
    expect(result.items).toEqual([expect.objectContaining({ repo: "repo/app", target: "43", state: "UNKNOWN", loadState: "unknown" })]);
    expect(result.warnings[0].message).toContain("auth required");
  });

  it("fetches target and branch evidence in one GraphQL batch", async () => {
    const run = vi.fn(async (args: string[]) => graphQlResult(args));
    const reconciler = createGitHubTargetReconciler({ run });
    const result = await reconciler.load([{ repo: "repo/app", target: "45", type: "issue", branch: "feature/work" }]);
    expect(result.items[0]).toMatchObject({ state: "OPEN", loadState: "loaded", branchState: "present" });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].join(" ")).toContain("issueOrPullRequest");
    expect(run.mock.calls[0][0].join(" ")).toContain("ref(qualifiedName:");
    expect(run.mock.calls[0][0]).toContain("branch0=refs/heads/feature/work");
  });

  it("records branch deletion only as supporting evidence", async () => {
    let calls = 0;
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      calls += 1;
      return graphQlResult(args, { branch: () => "deleted" });
    } });
    const reference = { repo: "repo/app", target: "45", type: "issue" as const, branch: "feature/work" };
    const result = await reconciler.load([reference]);
    await reconciler.load([reference]);
    expect(result.items[0]).toMatchObject({ state: "OPEN", loadState: "loaded", branchState: "deleted" });
    expect(result.warnings).toEqual([]);
    expect(calls).toBe(1);
  });

  it("keeps branch lookup failures UNKNOWN without discarding trustworthy target state", async () => {
    const reconciler = createGitHubTargetReconciler({ run: async (args) => graphQlResult(args, { branch: () => ({ error: "auth required" }) }) });
    const result = await reconciler.load([{ repo: "repo/app", target: "45", type: "issue", branch: "feature/work" }]);
    expect(result.items[0]).toMatchObject({ state: "OPEN", loadState: "loaded", branchState: "unknown" });
    expect(result.warnings[0].message).toContain("auth required");
  });

  it("reuses a successful target lookup while retrying an isolated branch failure", async () => {
    const run = vi.fn(async (args: string[]) => graphQlResult(args, { branch: () => ({ error: "temporary branch lookup failure" }) }));
    const reconciler = createGitHubTargetReconciler({ run });
    const reference = { repo: "repo/app", target: "45", type: "issue" as const, branch: "feature/work" };

    await reconciler.load([reference]);
    const retried = await reconciler.load([reference]);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.filter(([args]) => args.join(" ").includes("issueOrPullRequest"))).toHaveLength(1);
    expect(run.mock.calls.filter(([args]) => args.join(" ").includes("ref(qualifiedName:"))).toHaveLength(2);
    expect(retried.items[0]).toMatchObject({ state: "OPEN", loadState: "loaded", branchState: "unknown" });
  });

  it.each([
    "HTTP 404",
    "HTTP 404: Branch not found",
    "gh: HTTP 404: Not Found",
    "gh: Branch not found (HTTP 404)",
    "gh: Not Found (HTTP 404)\n"
  ])("recognizes an actual gh HTTP 404 response: %j", (stderr) => {
    expect(isGitHubHttpNotFound(stderr)).toBe(true);
  });

  it.each([
    "dependency returned 404 while gh authentication failed",
    "warning: cached status was HTTP 404 yesterday",
    "request failed with status 404"
  ])("does not infer branch deletion from unrelated 404 text: %j", (stderr) => {
    expect(isGitHubHttpNotFound(stderr)).toBe(false);
  });

  it("keeps unrelated stderr containing 404 as UNKNOWN branch evidence", async () => {
    const reconciler = createGitHubTargetReconciler({ run: async (args) => graphQlResult(args, {
      branch: () => ({ error: "dependency returned 404 while gh authentication failed" })
    }) });
    const result = await reconciler.load([{ repo: "repo/app", target: "45", type: "issue", branch: "feature/work" }]);
    expect(result.items[0]).toMatchObject({ state: "OPEN", branchState: "unknown" });
    expect(result.warnings[0].message).toContain("dependency returned 404");
  });

  it("performs branch-only reconciliation without repeating an already-loaded target lookup", async () => {
    const calls: string[][] = [];
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      calls.push(args);
      return graphQlResult(args);
    } });
    const existingTarget = { repo: "repo/app", target: "45", type: "issue" as const, title: "Open issue", url: "https://github.com/repo/app/issues/45", state: "OPEN", labels: [], ciStatus: "passing" as const, loadState: "loaded" as const };
    const reference = { repo: "repo/app", target: "45", type: "issue" as const, branch: "feature/work", existingTarget };
    const result = await reconciler.load([reference]);
    const refreshedIdentity = await reconciler.load([{ ...reference, existingTarget: { ...existingTarget, title: "Fresh open title" } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].join(" ")).toContain("ref(qualifiedName:");
    expect(calls[0].join(" ")).not.toContain("issueOrPullRequest");
    expect(result.items).toEqual([{ ...existingTarget, branchState: "present" }]);
    expect(refreshedIdentity.items).toEqual([{ ...existingTarget, title: "Fresh open title", branchState: "present" }]);
  });

  it("bounds concurrent GitHub GraphQL batches", async () => {
    let active = 0;
    let maximum = 0;
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return graphQlResult(args);
    } }, 60_000, 2);
    await reconciler.load(Array.from({ length: 120 }, (_, index) => ({ repo: "repo/app", target: String(index + 1), type: "issue" as const })));
    expect(maximum).toBe(2);
  });

  it("reconciles 500 cold targets with bounded GraphQL batches instead of one REST request per target", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] !== "api" || args[1] !== "graphql") {
        return { stdout: "", stderr: `unexpected unbatched request: ${args.join(" ")}`, exitCode: 1 };
      }
      const targets = args
        .filter((argument) => /^target\d+=\d+$/.test(argument))
        .map((argument) => argument.split("=")[1]);
      return {
        stdout: JSON.stringify({
          data: {
            repository: Object.fromEntries(targets.map((target, index) => [
              `target${index}`,
              {
                __typename: "Issue",
                number: Number(target),
                title: `Issue ${target}`,
                url: `https://github.com/repo/app/issues/${target}`,
                state: "OPEN",
                labels: { nodes: [] }
              }
            ]))
          }
        }),
        stderr: "",
        exitCode: 0
      };
    });
    const references = Array.from({ length: 500 }, (_, index) => ({
      repo: "repo/app",
      target: String(index + 1),
      type: "issue" as const
    }));

    const result = await createGitHubTargetReconciler({ run }).load(references);

    expect(run.mock.calls.length).toBeLessThanOrEqual(10);
    expect(run.mock.calls.every(([args]) => args[0] === "api" && args[1] === "graphql")).toBe(true);
    expect(result.items).toHaveLength(500);
    expect(result.items.every((item) => item.loadState === "loaded")).toBe(true);
    expect(result.failed).toBeUndefined();
  });

  it("stagger-refreshes 500 targets across two expiry windows while simultaneous clients share each refresh", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-11T03:00:00Z");
    vi.setSystemTime(startedAt);
    const run = vi.fn(async (args: string[]) => graphQlResult(args));
    const reconciler = createGitHubTargetReconciler({ run }, 1_000);
    const references = Array.from({ length: 500 }, (_, index) => ({
      repo: "repo/app",
      target: String(index + 1),
      type: "issue" as const
    }));

    await reconciler.load(references);
    expect(run).toHaveBeenCalledTimes(10);

    const refreshCallsByTick: Array<{ elapsed: number; calls: number }> = [];
    for (let elapsed = 1_000; elapsed <= 4_000; elapsed += 100) {
      vi.setSystemTime(startedAt + elapsed);
      const callsBefore = run.mock.calls.length;
      await Promise.all(Array.from({ length: 4 }, () => reconciler.load(references)));
      refreshCallsByTick.push({ elapsed, calls: run.mock.calls.length - callsBefore });
    }

    const firstWindowCalls = refreshCallsByTick
      .filter(({ elapsed }) => elapsed < 2_000)
      .reduce((total, { calls }) => total + calls, 0);
    const secondWindowCalls = refreshCallsByTick
      .filter(({ elapsed }) => elapsed >= 2_000 && elapsed < 4_000)
      .reduce((total, { calls }) => total + calls, 0);
    expect({
      firstWindowCalls,
      secondWindowCalls,
      maximumCallsInOneTick: Math.max(...refreshCallsByTick.map(({ calls }) => calls))
    }).toEqual({
      firstWindowCalls: 9,
      secondWindowCalls: 16,
      maximumCallsInOneTick: 2
    });
  });

  it("keeps a 500-target fixture within the refresh request ceiling", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("user")) {
        return {
          stdout: `HTTP/2.0 200 OK\nx-ratelimit-remaining: 5000\nx-ratelimit-reset: ${Date.parse("2026-08-11T04:00:00Z") / 1000}\n\n{}`,
          stderr: "",
          exitCode: 0
        };
      }
      return graphQlResult(args);
    });
    const governor = createGitHubRequestGovernor({ run }, {
      hourlyRequestBudget: 1_000,
      perRefreshRequestLimit: 25,
      safetyThreshold: 100,
      probeIntervalMs: 60_000,
      fallbackCooldownMs: 30_000,
      now: () => Date.parse("2026-08-11T03:00:00Z")
    });
    const refresh = governor.beginRefresh("dashboard");
    const references = Array.from({ length: 500 }, (_, index) => ({ repo: "repo/app", target: String(index + 1), type: "issue" as const }));

    const result = await createGitHubTargetReconciler().load(references, { runner: refresh.runner });

    expect(run).toHaveBeenCalledTimes(11);
    expect(result.items.filter((item) => item.loadState === "loaded")).toHaveLength(500);
    expect(result.items.filter((item) => item.loadState === "unknown")).toHaveLength(0);
    expect(result.failed).toBeUndefined();
    expect(refresh.status({ targetCount: references.length })).toMatchObject({
      state: "available",
      reason: "none",
      requestsExecuted: 11,
      requestsBlocked: 0
    });
  });

  it("retries an UNKNOWN target after the quota reset instead of reusing failed cache entries", async () => {
    vi.useFakeTimers();
    let nowMs = Date.parse("2026-08-11T03:00:00Z");
    const resetMs = nowMs + 1_000;
    vi.setSystemTime(new Date(nowMs));
    const run = vi.fn()
      .mockResolvedValueOnce({
        stdout: `HTTP/2.0 200 OK\nx-ratelimit-remaining: 0\nx-ratelimit-reset: ${resetMs / 1000}\n\n{}`,
        stderr: "",
        exitCode: 0
      })
      .mockResolvedValueOnce({
        stdout: `HTTP/2.0 200 OK\nx-ratelimit-remaining: 5000\nx-ratelimit-reset: ${(resetMs + 3_600_000) / 1000}\n\n{}`,
        stderr: "",
        exitCode: 0
      })
      .mockResolvedValueOnce({
        stdout: [
          "HTTP/2.0 200 OK",
          "x-ratelimit-remaining: 4999",
          `x-ratelimit-reset: ${(resetMs + 3_600_000) / 1000}`,
          "",
          JSON.stringify({ data: { repository: { target0: {
            __typename: "Issue", number: 45, title: "Recovered", url: "https://github.com/repo/app/issues/45", state: "OPEN", labels: { nodes: [] }
          } } } })
        ].join("\n"),
        stderr: "",
        exitCode: 0
      });
    const governor = createGitHubRequestGovernor({ run }, {
      hourlyRequestBudget: 100,
      perRefreshRequestLimit: 10,
      safetyThreshold: 100,
      probeIntervalMs: 60_000,
      fallbackCooldownMs: 30_000,
      now: () => nowMs
    });
    const reconciler = createGitHubTargetReconciler(undefined, 15 * 60 * 1000);
    const reference = { repo: "repo/app", target: "45", type: "issue" as const };

    const exhausted = await reconciler.load([reference], { runner: governor.beginRefresh("dashboard").runner });
    expect(exhausted).toMatchObject({ failed: true, items: [{ loadState: "unknown" }] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(reconciler.cacheSize()).toBe(0);

    nowMs = resetMs + 1;
    vi.setSystemTime(new Date(nowMs));
    const recoveredRefresh = governor.beginRefresh("dashboard");
    const recovered = await reconciler.load([reference], { runner: recoveredRefresh.runner });

    expect(run).toHaveBeenCalledTimes(3);
    expect(recovered.failed).toBeUndefined();
    expect(recovered.items[0]).toMatchObject({ title: "Recovered", loadState: "loaded", state: "OPEN" });
    expect(recoveredRefresh.status()).toMatchObject({ state: "available", requestsExecuted: 2, requestsBlocked: 0 });
    expect(reconciler.cacheSize()).toBe(1);

    await reconciler.load([reference], { runner: governor.beginRefresh("dashboard").runner });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("coalesces one target lookup while preserving distinct branch lookups", async () => {
    const calls: string[][] = [];
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      calls.push(args);
      return graphQlResult(args, {
        target: (target) => ({
          __typename: "PullRequest", number: Number(target), title: "Merged", url: `https://github.com/repo/app/pull/${target}`,
          state: "MERGED", mergedAt: "2026-07-12T10:00:00Z", labels: { nodes: [] }
        }),
        branch: (branch) => branch === "feature/a" ? "deleted" : "present"
      });
    } });
    const result = await reconciler.load([
      { repo: "repo/app", target: "54", type: "pull_request", branch: "feature/a" },
      { repo: "repo/app", target: "54", type: "pull_request", branch: "feature/b" }
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].filter((argument) => /^target\d+=54$/.test(argument))).toHaveLength(1);
    expect(calls[0].filter((argument) => /^branch\d+=refs\/heads\/feature\/(?:a|b)$/.test(argument))).toHaveLength(2);
    expect(result.items.map((item) => item.branchState)).toEqual(["deleted", "present"]);
  });

  it("includes target type in reconciliation identity, dedupe, and caches", async () => {
    const calls: string[][] = [];
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      calls.push(args);
      return graphQlResult(args);
    } });
    const issue = { repo: "repo/app", target: "45", type: "issue" as const };
    const pullRequest = { repo: "repo/app", target: "45", type: "pull_request" as const };

    expect(githubTargetReferenceKey(issue)).not.toBe(githubTargetReferenceKey(pullRequest));
    const result = await reconciler.load([issue, pullRequest]);

    expect(result.references).toEqual([issue, pullRequest]);
    expect(calls).toHaveLength(1);
    expect(calls[0].filter((argument) => /^target\d+=45$/.test(argument))).toHaveLength(2);
  });

  it("prunes expired cache entries and caps live entries deterministically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00Z"));
    let calls = 0;
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      calls += 1;
      return graphQlResult(args);
    } }, 10, 8, 2);
    const reference = (target: string) => ({ repo: "repo/app", target, type: "issue" as const });
    await reconciler.load([reference("1"), reference("2")]);
    expect(reconciler.cacheSize()).toBe(2);
    await reconciler.load([reference("3")]);
    expect(reconciler.cacheSize()).toBe(2);
    await reconciler.load([reference("1")]);
    expect(calls).toBe(3);
    vi.advanceTimersByTime(20);
    await reconciler.load([reference("4")]);
    expect(reconciler.cacheSize()).toBe(1);
    expect(calls).toBe(4);
  });

  it("coalesces an active target lookup after TTL expiry and refreshes only after settlement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00Z"));
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      calls += 1;
      if (calls === 1) await gate;
      return graphQlResult(args);
    } }, 0);
    const reference = { repo: "repo/app", target: "45", type: "issue" as const };
    const first = reconciler.load([reference]);
    vi.advanceTimersByTime(1);
    const second = reconciler.load([reference]);
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([expect.anything(), expect.anything()]);
    await reconciler.load([reference]);
    expect(calls).toBe(2);
  });
  it("normalizes open PRs", () => {
    const previews = parsePrList(
      "shakacode/react_on_rails",
      JSON.stringify([
        {
          number: 4005,
          title: "Fix FOUC",
          url: "https://github.com/shakacode/react_on_rails/pull/4005",
          state: "OPEN",
          author: { login: "justin" },
          labels: [{ name: "ci" }],
          headRefName: "jg-codex/fouc",
          reviewDecision: "CHANGES_REQUESTED"
        }
      ])
    );

    expect(previews[0]).toMatchObject({
      repo: "shakacode/react_on_rails",
      target: "4005",
      type: "pull_request",
      title: "Fix FOUC",
      branch: "jg-codex/fouc",
      reviewDecision: "CHANGES_REQUESTED"
    });
  });

  it("normalizes open issues", () => {
    const previews = parseIssueList(
      "shakacode/react_on_rails",
      JSON.stringify([
        {
          number: 4010,
          title: "Investigate hydration",
          url: "https://github.com/shakacode/react_on_rails/issues/4010",
          state: "OPEN",
          author: { login: "maintainer" },
          labels: [{ name: "bug" }]
        }
      ])
    );

    expect(previews[0]).toMatchObject({
      repo: "shakacode/react_on_rails",
      target: "4010",
      type: "issue",
      labels: ["bug"]
    });
  });

  it("requests an explicit high limit for GitHub lists", async () => {
    const calls: string[][] = [];
    const result = await loadOpenGitHubItems("shakacode/react_on_rails", {
      run: async (args) => {
        calls.push(args);
        return { stdout: "[]", stderr: "", exitCode: 0 };
      }
    });

    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls.every((args) => args.includes("--limit"))).toBe(true);
    expect(calls.every((args) => args[args.indexOf("--limit") + 1] === "1000")).toBe(true);
    const prArgs = calls.find((args) => args[0] === "pr")!;
    expect(prArgs[prArgs.indexOf("--json") + 1]).toContain("statusCheckRollup");
  });

  it("surfaces GitHub command failures as warnings", async () => {
    const result = await loadOpenGitHubItems("shakacode/react_on_rails", {
      run: async () => ({ stdout: "", stderr: "auth required", exitCode: 1 })
    });

    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0].message).toContain("auth required");
    expect(result.failed).toBe(true);
  });

  it("marks partially failed open-list loads while keeping clean loads cacheable", async () => {
    const partial = await loadOpenGitHubItems("shakacode/react_on_rails", {
      run: async (args) => args[0] === "issue"
        ? { stdout: "not json", stderr: "", exitCode: 0 }
        : { stdout: "[]", stderr: "", exitCode: 0 }
    });
    expect(partial.failed).toBe(true);
    expect(partial.warnings[0].message).toContain("unreadable JSON");

    const clean = await loadOpenGitHubItems("shakacode/react_on_rails", {
      run: async () => ({ stdout: "[]", stderr: "", exitCode: 0 })
    });
    expect(clean.failed).toBeUndefined();
  });

  it("keeps truncated-but-successful open lists cacheable with their warning visible", async () => {
    const issues = Array.from({ length: 1000 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      url: `https://github.com/shakacode/react_on_rails/issues/${index + 1}`,
      state: "OPEN",
      labels: []
    }));
    const result = await loadOpenGitHubItems("shakacode/react_on_rails", {
      run: async (args) => ({ stdout: args[0] === "issue" ? JSON.stringify(issues) : "[]", stderr: "", exitCode: 0 })
    });

    expect(result.items).toHaveLength(1000);
    expect(result.warnings[0].message).toContain("may be truncated");
    expect(result.failed).toBeUndefined();
  });
});
