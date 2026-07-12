import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubTargetReconciler, githubApiPath, loadOpenGitHubItems, parseGitHubTarget, parseIssueList, parsePrList } from "./githubClient";

describe("github list parsers", () => {
  afterEach(() => vi.useRealTimers());
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
    expect(closedPullRequest).not.toHaveProperty("mergedAt");
  });

  it("constructs GitHub API paths from validated owner and repository segments", () => {
    expect(githubApiPath("shaka-code/agent_coordination.dashboard", "issues", "45")).toBe("repos/shaka-code/agent_coordination.dashboard/issues/45");
    expect(githubApiPath("repo/app", "branches", "feature/work?#x")).toBe("repos/repo/app/branches/feature%2Fwork%3F%23x");
    expect(() => githubApiPath("repo/app/../../secret", "issues", "45")).toThrow(/repository/i);
    expect(() => githubApiPath("repo/app", "issues", "45/../../secret")).toThrow(/issue target/i);
  });

  it("rejects hostile target references without invoking gh", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const result = await createGitHubTargetReconciler({ run }).load([
      { repo: "repo/app/../../secret", target: "45/../../token", type: "issue" }
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({ state: "UNKNOWN", loadState: "unknown" });
    expect(result.warnings[0].message).toMatch(/repository|target/i);
  });

  it("coalesces and caches target reconciliation while foreground refresh can bypass it", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconciler = createGitHubTargetReconciler({ run: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { stdout: JSON.stringify({ number: 43, title: "Open", html_url: "https://github.com/repo/app/issues/43", state: "open", labels: [] }), stderr: "", exitCode: 0 };
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

  it("records branch deletion only as supporting evidence", async () => {
    let calls = 0;
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      calls += 1;
      return args[1].includes("/branches/")
      ? { stdout: "", stderr: "HTTP 404: Branch not found", exitCode: 1 }
      : { stdout: JSON.stringify({ number: 45, title: "Still open", html_url: "https://github.com/repo/app/issues/45", state: "open", labels: [] }), stderr: "", exitCode: 0 };
    } });
    const reference = { repo: "repo/app", target: "45", type: "issue" as const, branch: "feature/work" };
    const result = await reconciler.load([reference]);
    await reconciler.load([reference]);
    expect(result.items[0]).toMatchObject({ state: "OPEN", loadState: "loaded", branchState: "deleted" });
    expect(result.warnings).toEqual([]);
    expect(calls).toBe(2);
  });

  it("keeps branch lookup failures UNKNOWN without discarding trustworthy target state", async () => {
    const reconciler = createGitHubTargetReconciler({ run: async (args) => args[1].includes("/branches/")
      ? { stdout: "", stderr: "auth required", exitCode: 1 }
      : { stdout: JSON.stringify({ number: 45, title: "Still open", html_url: "https://github.com/repo/app/issues/45", state: "open", labels: [] }), stderr: "", exitCode: 0 } });
    const result = await reconciler.load([{ repo: "repo/app", target: "45", type: "issue", branch: "feature/work" }]);
    expect(result.items[0]).toMatchObject({ state: "OPEN", loadState: "loaded", branchState: "unknown" });
    expect(result.warnings[0].message).toContain("auth required");
  });

  it("performs branch-only reconciliation without repeating an already-loaded target lookup", async () => {
    const calls: string[][] = [];
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      calls.push(args);
      return { stdout: "{}", stderr: "", exitCode: 0 };
    } });
    const existingTarget = { repo: "repo/app", target: "45", type: "issue" as const, title: "Open issue", url: "https://github.com/repo/app/issues/45", state: "OPEN", labels: [], loadState: "loaded" as const };
    const reference = { repo: "repo/app", target: "45", type: "issue" as const, branch: "feature/work", existingTarget };
    const result = await reconciler.load([reference]);
    const refreshedIdentity = await reconciler.load([{ ...reference, existingTarget: { ...existingTarget, title: "Fresh open title" } }]);
    expect(calls).toEqual([["api", "repos/repo/app/branches/feature%2Fwork"]]);
    expect(result.items).toEqual([{ ...existingTarget, branchState: "present" }]);
    expect(refreshedIdentity.items).toEqual([{ ...existingTarget, title: "Fresh open title", branchState: "present" }]);
  });

  it("bounds GitHub target fan-out", async () => {
    let active = 0;
    let maximum = 0;
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (args[1].includes("/branches/")) return { stdout: "{}", stderr: "", exitCode: 0 };
      const target = args[1].split("/").at(-1);
      return { stdout: JSON.stringify({ number: Number(target), title: "Open", html_url: `https://github.com/repo/app/issues/${target}`, state: "open", labels: [] }), stderr: "", exitCode: 0 };
    } }, 60_000, 2);
    await reconciler.load([1, 2, 3, 4].map((target) => ({ repo: "repo/app", target: String(target), type: "issue" as const, branch: `feature/${target}` })));
    expect(maximum).toBe(2);
  });

  it("coalesces one target lookup while preserving distinct branch lookups", async () => {
    const calls: string[] = [];
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      calls.push(args[1]);
      if (args[1].includes("/branches/feature%2Fa")) return { stdout: "", stderr: "HTTP 404", exitCode: 1 };
      if (args[1].includes("/branches/")) return { stdout: "{}", stderr: "", exitCode: 0 };
      return { stdout: JSON.stringify({ number: 54, title: "Merged", html_url: "https://github.com/repo/app/pull/54", state: "closed", pull_request: { merged_at: "2026-07-12T10:00:00Z" }, labels: [] }), stderr: "", exitCode: 0 };
    } });
    const result = await reconciler.load([
      { repo: "repo/app", target: "54", type: "pull_request", branch: "feature/a" },
      { repo: "repo/app", target: "54", type: "pull_request", branch: "feature/b" }
    ]);
    expect(calls.filter((call) => call.includes("/issues/54"))).toHaveLength(1);
    expect(calls.filter((call) => call.includes("/branches/"))).toHaveLength(2);
    expect(result.items.map((item) => item.branchState)).toEqual(["deleted", "present"]);
  });

  it("prunes expired cache entries and caps live entries deterministically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00Z"));
    let calls = 0;
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      calls += 1;
      const target = args[1].split("/").at(-1);
      return { stdout: JSON.stringify({ number: Number(target), title: "Open", html_url: `https://github.com/repo/app/issues/${target}`, state: "open", labels: [] }), stderr: "", exitCode: 0 };
    } }, 10, 8, 2);
    const reference = (target: string) => ({ repo: "repo/app", target, type: "issue" as const });
    await reconciler.load([reference("1"), reference("2")]);
    expect(reconciler.cacheSize()).toBe(2);
    await reconciler.load([reference("3")]);
    expect(reconciler.cacheSize()).toBe(2);
    await reconciler.load([reference("1")]);
    expect(calls).toBe(4);
    vi.advanceTimersByTime(11);
    await reconciler.load([reference("4")]);
    expect(reconciler.cacheSize()).toBe(1);
  });

  it("coalesces an active target lookup after TTL expiry and refreshes only after settlement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00Z"));
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconciler = createGitHubTargetReconciler({ run: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { stdout: JSON.stringify({ number: 45, title: "Open", html_url: "https://github.com/repo/app/issues/45", state: "open", labels: [] }), stderr: "", exitCode: 0 };
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
  });

  it("surfaces GitHub command failures as warnings", async () => {
    const result = await loadOpenGitHubItems("shakacode/react_on_rails", {
      run: async () => ({ stdout: "", stderr: "auth required", exitCode: 1 })
    });

    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0].message).toContain("auth required");
  });
});
