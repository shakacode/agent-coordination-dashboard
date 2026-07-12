import { describe, expect, it } from "vitest";
import { createGitHubTargetReconciler, loadOpenGitHubItems, parseGitHubTarget, parseIssueList, parsePrList } from "./githubClient";

describe("github list parsers", () => {
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

  it("bounds GitHub target fan-out", async () => {
    let active = 0;
    let maximum = 0;
    const reconciler = createGitHubTargetReconciler({ run: async (args) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const target = args[1].split("/").at(-1);
      return { stdout: JSON.stringify({ number: Number(target), title: "Open", html_url: `https://github.com/repo/app/issues/${target}`, state: "open", labels: [] }), stderr: "", exitCode: 0 };
    } }, 60_000, 2);
    await reconciler.load([1, 2, 3, 4].map((target) => ({ repo: "repo/app", target: String(target), type: "issue" as const })));
    expect(maximum).toBe(2);
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
